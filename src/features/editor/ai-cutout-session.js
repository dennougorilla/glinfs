/**
 * AI cutout session of one editor mount
 * @module features/editor/ai-cutout-session
 *
 * Runs the analysis of the selection through the shared segmentation
 * manager (the model and its worker outlive the editor, so the export and a
 * later editor mount reuse them) and keeps the preview's final masks in step
 * with the probability masks and the AI parameters:
 *
 * - ONE AbortController for final-mask builds: any AI parameter or pick
 *   change aborts the build in flight and starts a new one; new
 *   probability masks (analysis progress) only queue a rerun after the
 *   current build, debounced, so a long analysis never starves the preview.
 * - The previous final masks stay in use until a new build lands (dropping
 *   them would flash every frame unkeyed while the build runs).
 * - Everything reports through `setStatus` (editor store) and
 *   `onMaskSource`; after dispose() nothing is written anywhere.
 */

import { isAiCutoutActive } from '../../shared/edits/model.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import {
  buildClipMaskSource,
  describeAnalysisError,
  estimateRemainingMs,
  getBuildParamsKey,
  getSharedFinalMaskCache,
  isAbortError,
  isWasmAllowed,
  peekClipMaskSource,
  setWasmAllowed,
} from './ai-cutout.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('../../shared/masks/final-masks.js').MaskSource} MaskSource */
/** @typedef {import('./types.js').AiCutoutStatus} AiCutoutStatus */

/** Debounce of mask-store driven rebuilds (analysis progress) */
export const STORE_REBUILD_DELAY_MS = 200;

/**
 * @typedef {Object} AiCutoutSessionOptions
 * @property {() => import('./types.js').EditorState | null} getState
 * @property {(patch: Partial<AiCutoutStatus>) => void} setStatus
 * @property {(source: MaskSource) => void} [onMaskSource] - New final masks to draw
 * @property {() => void} [onMasksChanged] - Probability masks were added/removed (debounced)
 * @property {() => string | undefined} getClipId - Mask store group of the clip
 * @property {import('../ai-cutout/segmentation-manager.js').SegmentationManager} manager
 * @property {import('../ai-cutout/mask-store.js').MaskStore} maskStore
 * @property {ReturnType<typeof getSharedFinalMaskCache>} [cache]
 * @property {() => number} [now]
 */

/**
 * @param {AiCutoutSessionOptions} options
 */
export function createAiCutoutSession(options) {
  const {
    getState,
    setStatus,
    onMaskSource,
    onMasksChanged,
    getClipId,
    manager,
    maskStore,
    cache = getSharedFinalMaskCache(),
    now = () => performance.now(),
  } = options;

  let disposed = false;
  /** @type {MaskSource | null} */
  let maskSource = null;
  /** @type {AbortController | null} */
  let analysisController = null;
  /** @type {AbortController | null} */
  let buildController = null;
  /** @type {string | null} */
  let buildKey = null;
  let rebuildAfterBuild = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let storeTimer = null;

  /** @param {Partial<AiCutoutStatus>} patch */
  const report = (patch) => {
    if (!disposed) setStatus(patch);
  };

  /** @param {MaskSource} source */
  const publish = (source) => {
    if (disposed || source === maskSource) return;
    maskSource = source;
    report({ maskVersion: source.version });
    onMaskSource?.(source);
  };

  const abortBuild = () => {
    buildController?.abort();
    buildController = null;
    buildKey = null;
    rebuildAfterBuild = false;
    report({ building: false });
  };

  /**
   * Bring the final masks up to date with the clip's probability masks and
   * the current AI parameters (no-op while the AI method is off)
   */
  const requestBuild = () => {
    if (disposed) return;
    const state = getState();
    if (!state?.clip || !isAiCutoutActive(state.edits.background)) {
      abortBuild();
      return;
    }
    const frames = state.clip.frames;
    const ai = state.edits.background.ai;
    const memo = peekClipMaskSource({ frames, ai, maskStore, cache });
    if (memo) {
      abortBuild();
      publish(memo);
      return;
    }
    const key = getBuildParamsKey(frames, ai);
    if (buildController && key === buildKey) {
      // Same parameters, more masks: rerun once this build is done
      rebuildAfterBuild = true;
      return;
    }
    // Parameters or picks changed: the build in flight is worthless
    buildController?.abort();
    const controller = new AbortController();
    buildController = controller;
    buildKey = key;
    rebuildAfterBuild = false;
    report({ building: true });
    buildClipMaskSource({ frames, ai, maskStore, cache, signal: controller.signal }).then(
      (source) => {
        if (buildController !== controller) return;
        buildController = null;
        buildKey = null;
        report({ building: false });
        publish(source);
        if (rebuildAfterBuild) {
          rebuildAfterBuild = false;
          requestBuild();
        }
      },
      (error) => {
        if (buildController !== controller) return;
        buildController = null;
        buildKey = null;
        report({ building: false });
        if (!isAbortError(error)) {
          console.error('[AI cutout] Building the final masks failed:', error);
        }
      },
    );
  };

  const unsubscribeStore = maskStore.subscribe((change) => {
    if (disposed) return;
    report({ storeVersion: change.version });
    if (storeTimer !== null) return;
    storeTimer = setTimeout(() => {
      storeTimer = null;
      if (disposed) return;
      onMasksChanged?.();
      requestBuild();
    }, STORE_REBUILD_DELAY_MS);
  });

  /** Check for a WebGPU adapter once and report it */
  const checkCapabilities = async () => {
    try {
      const { webgpu } = await manager.getCapabilities();
      report({ webgpu, wasmAllowed: isWasmAllowed() });
    } catch {
      report({ webgpu: false, wasmAllowed: isWasmAllowed() });
    }
  };

  /**
   * Analyze frames that have no mask yet (the selection). Finished masks are
   * kept on cancel or failure; a second call only does the rest.
   * @param {Frame[]} frames
   * @returns {Promise<void>}
   */
  const analyze = async (frames) => {
    if (disposed || analysisController) return;
    const controller = new AbortController();
    analysisController = controller;
    const clipId = getClipId();
    if (clipId !== undefined) maskStore.touchClip(clipId);
    /** @type {number | null} */
    let analyzingSince = null;
    report({
      phase: 'starting',
      error: null,
      notice: '',
      needsWasmChoice: false,
      framesDone: 0,
      framesTotal: 0,
      loadedBytes: 0,
      totalBytes: 0,
      remainingMs: null,
    });
    try {
      const result = await manager.analyzeFrames(frames, {
        signal: controller.signal,
        clipId,
        allowWasm: isWasmAllowed(),
        onProgress(progress) {
          if (disposed || analysisController !== controller) return;
          if (progress.phase === 'analyzing' && analyzingSince === null) {
            analyzingSince = now();
          }
          report({
            phase: progress.phase,
            backend: progress.backend,
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
            fromCache: progress.fromCache,
            framesDone: progress.framesDone,
            framesTotal: progress.framesTotal,
            remainingMs:
              progress.phase === 'analyzing'
                ? estimateRemainingMs({
                    framesDone: progress.framesDone,
                    framesTotal: progress.framesTotal,
                    elapsedMs: now() - /** @type {number} */ (analyzingSince),
                    backend: progress.backend,
                  })
                : null,
          });
        },
      });
      report({
        phase: 'idle',
        backend: result.backend,
        notice:
          result.analyzed > 0
            ? `Analyzed ${result.analyzed} frame${result.analyzed === 1 ? '' : 's'}.`
            : 'These frames were already analyzed.',
      });
    } catch (error) {
      if (isAbortError(error)) {
        report({
          phase: 'idle',
          notice: 'Analysis cancelled. Finished frames are kept; Analyze continues with the rest.',
        });
      } else if (
        /** @type {any} */ (error)?.code === SegmentationErrorCode.WEBGPU_UNAVAILABLE &&
        !isWasmAllowed()
      ) {
        report({ phase: 'idle', needsWasmChoice: true, webgpu: false });
      } else {
        report({ phase: 'error', error: describeAnalysisError(error) });
      }
    } finally {
      if (analysisController === controller) analysisController = null;
      requestBuild();
    }
  };

  return {
    analyze,
    checkCapabilities,
    requestBuild,

    /** Stop the running analysis (finished masks stay) */
    cancel() {
      analysisController?.abort();
    },

    /**
     * The explicit "Run without WebGPU (very slow)" choice, then analyze
     * @param {Frame[]} frames
     */
    allowWasmAndAnalyze(frames) {
      setWasmAllowed(true);
      report({ wasmAllowed: true, needsWasmChoice: false });
      return analyze(frames);
    },

    /** @returns {boolean} An analysis is running */
    get analyzing() {
      return analysisController !== null;
    },

    /** Final masks the preview draws (may lag the parameters while a build runs) */
    get maskSource() {
      return maskSource;
    },

    /** Abort everything; the session writes nothing afterwards */
    dispose() {
      analysisController?.abort();
      analysisController = null;
      buildController?.abort();
      buildController = null;
      if (storeTimer !== null) {
        clearTimeout(storeTimer);
        storeTimer = null;
      }
      unsubscribeStore();
      disposed = true;
      maskSource = null;
    },
  };
}
