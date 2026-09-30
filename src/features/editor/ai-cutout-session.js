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
 *   While an analysis runs those reruns start at most every
 *   ANALYSIS_REBUILD_INTERVAL_MS, and once more when it ends.
 * - The previous final masks stay in use until a new build lands (dropping
 *   them would flash every frame unkeyed while the build runs).
 * - Everything reports through `setStatus` (editor store) and
 *   `onMaskSource`; after dispose() nothing is written anywhere.
 * - preload() prepares the clip's model at idle time when it is already
 *   downloaded (and the "Prepare downloaded models" setting is on), so
 *   Analyze starts at once. It never downloads (the manager loads with
 *   `cacheOnly`); the session stays loaded after this mount, like one an
 *   analysis loaded, until the reset path frees the worker.
 * - `models` in the status says per model whether it is ready, downloaded
 *   or still to download (refreshed when a session loads or goes away and
 *   after each analysis).
 */

import { isAiCutoutActive } from '../../shared/edits/model.js';
import { loadSettings } from '../../shared/user-settings.js';
import { isModelCached as isModelCachedDefault } from '../ai-cutout/model-cache.js';
import { getModelIds } from '../ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { resolveModelSpec } from '../ai-cutout/segmentation-manager.js';
import {
  buildClipMaskSource,
  describeAnalysisError,
  estimateRemainingMs,
  getAiModelId,
  getBuildParamsKey,
  getSharedFinalMaskCache,
  isAbortError,
  isWasmAllowed,
  isWasmChoiceError,
  peekClipMaskSource,
  setWasmAllowed,
} from './ai-cutout.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('../../shared/masks/final-masks.js').MaskSource} MaskSource */
/** @typedef {import('./types.js').AiCutoutStatus} AiCutoutStatus */

/** Debounce of mask-store driven rebuilds (analysis progress) */
export const STORE_REBUILD_DELAY_MS = 200;

/**
 * While an analysis runs, mask-store driven rebuilds start at most this
 * often: each one rebuilds the whole clip, and new masks arrive every
 * frame
 */
export const ANALYSIS_REBUILD_INTERVAL_MS = 1500;

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
 * @property {(modelId: string) => Promise<boolean>} [isModelCached] - Its current
 *   file is in Cache Storage
 * @property {() => boolean} [shouldPreload] - The "Prepare downloaded models
 *   when the editor opens" setting
 * @property {(task: () => void) => void} [scheduleIdle] - Runs `task` when the
 *   page is idle (requestIdleCallback, else a timeout)
 */

/**
 * Run a task when the page is idle (a timeout where requestIdleCallback is
 * missing, e.g. Safari)
 * @param {() => void} task
 */
function scheduleIdleDefault(task) {
  const ric = /** @type {any} */ (globalThis).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(task, { timeout: 2000 });
  } else {
    setTimeout(task, 200);
  }
}

/** @returns {boolean} */
function shouldPreloadDefault() {
  try {
    return loadSettings().aiCutout?.preloadModels !== false;
  } catch {
    return true;
  }
}

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
    isModelCached = (modelId) =>
      isModelCachedDefault(modelId, { getSha256: (id) => resolveModelSpec(id).sha256 }),
    shouldPreload = shouldPreloadDefault,
    scheduleIdle = scheduleIdleDefault,
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
  /**
   * Runs for ANALYSIS_REBUILD_INTERVAL_MS after a build started during an
   * analysis; store-driven rebuilds wait for it
   * @type {ReturnType<typeof setTimeout> | null}
   */
  let cooldownTimer = null;
  let buildAfterCooldown = false;

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

  const clearCooldown = () => {
    if (cooldownTimer !== null) clearTimeout(cooldownTimer);
    cooldownTimer = null;
    buildAfterCooldown = false;
  };

  /**
   * New probability masks: rebuild, but while an analysis runs start at
   * most one build per ANALYSIS_REBUILD_INTERVAL_MS
   */
  const requestStoreBuild = () => {
    if (disposed) return;
    if (analysisController && cooldownTimer !== null) {
      buildAfterCooldown = true;
      return;
    }
    requestBuild();
  };

  /** A build started during an analysis: hold store-driven ones off for a while */
  const startCooldown = () => {
    if (cooldownTimer !== null) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (!buildAfterCooldown) return;
      buildAfterCooldown = false;
      requestStoreBuild();
    }, ANALYSIS_REBUILD_INTERVAL_MS);
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
    const clipId = getClipId();
    const memo = peekClipMaskSource({ frames, ai, maskStore, clipId, cache });
    if (memo) {
      abortBuild();
      publish(memo);
      return;
    }
    const key = getBuildParamsKey(frames, ai, clipId);
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
    if (analysisController) startCooldown();
    buildClipMaskSource({ frames, ai, maskStore, clipId, cache, signal: controller.signal }).then(
      (source) => {
        if (buildController !== controller) return;
        buildController = null;
        buildKey = null;
        report({ building: false });
        publish(source);
        if (rebuildAfterBuild) {
          rebuildAfterBuild = false;
          requestStoreBuild();
        }
      },
      (error) => {
        if (buildController !== controller) return;
        buildController = null;
        buildKey = null;
        report({ building: false });
        if (!isAbortError(error)) {
          console.error('[AI cutout] Building the final masks failed:', error);
        } else if (!controller.signal.aborted) {
          // Another caller of the shared cache superseded this build (not a
          // change on this screen): build again so the preview catches up
          setTimeout(requestBuild, 0);
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
      requestStoreBuild();
    }, STORE_REBUILD_DELAY_MS);
  });

  /** Bumped by every refreshModels call: only the latest one reports */
  let modelsSeq = 0;

  /**
   * Report per model whether it is ready (session loaded), downloaded or
   * still to download
   * @returns {Promise<void>}
   */
  const refreshModels = async () => {
    if (disposed) return;
    const seq = ++modelsSeq;
    const ids = getModelIds();
    const cached = await Promise.all(ids.map((id) => isModelCached(id).catch(() => null)));
    if (disposed || seq !== modelsSeq) return;
    /** @type {Record<string, import('./types.js').ModelAvailability>} */
    const models = {};
    ids.forEach((id, i) => {
      models[id] = manager.getReadyInfo?.(id)
        ? 'ready'
        : cached[i] === null
          ? 'unknown'
          : cached[i]
            ? 'cached'
            : 'missing';
    });
    report({ models });
  };

  const unsubscribeModels = manager.onModelStateChange?.(() => void refreshModels()) ?? (() => {});

  /**
   * Prepare the clip's model in the background when it is downloaded
   * already: at idle time, never a download, nothing while an analysis
   * runs or the AI method is off.
   * @returns {Promise<boolean>} A preload was started and its session is ready
   */
  const preload = async () => {
    if (disposed || !shouldPreload()) return false;
    const state = getState();
    if (state?.edits.background.method !== 'ai') return false;
    const modelId = getAiModelId(state.edits.background.ai);
    if (manager.getReadyInfo?.(modelId)) return true;
    if (!(await isModelCached(modelId).catch(() => false))) return false;
    await new Promise((resolve) => scheduleIdle(() => resolve(undefined)));
    if (disposed || analysisController) return false;
    // The model may have changed while waiting for idle time
    const current = getState();
    if (!current || getAiModelId(current.edits.background.ai) !== modelId) return false;
    if (current.edits.background.method !== 'ai') return false;
    return (await manager.preloadModel?.(modelId, { allowWasm: isWasmAllowed() })) ?? false;
  };

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
   * Analyze frames that have no mask yet from the clip's model (the
   * selection). Finished masks are kept on cancel or failure; a second call
   * only does the rest.
   * @param {Frame[]} frames
   * @returns {Promise<void>}
   */
  const analyze = async (frames) => {
    if (disposed || analysisController) return;
    const controller = new AbortController();
    analysisController = controller;
    const clipId = getClipId();
    const modelId = getAiModelId(getState()?.edits.background.ai);
    if (clipId !== undefined) maskStore.touchClip(clipId, modelId);
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
        modelId,
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
        // A retry that ran on WebGPU after all: the model works there
        ...(result.backend === 'webgpu' ? { webgpuModelFailed: false } : {}),
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
      } else if (isWasmChoiceError(error) && !isWasmAllowed()) {
        // No WebGPU at all concerns the page; a model that failed on the
        // adapter concerns that model only (the other one may run there)
        const modelFailed =
          /** @type {any} */ (error).code === SegmentationErrorCode.WEBGPU_MODEL_FAILED;
        report({
          phase: 'idle',
          needsWasmChoice: true,
          webgpuModelFailed: modelFailed,
          ...(modelFailed ? {} : { webgpu: false }),
        });
      } else {
        report({ phase: 'error', error: describeAnalysisError(error) });
      }
    } finally {
      if (analysisController === controller) analysisController = null;
      // Catch up with every mask now, not at the end of the cooldown
      clearCooldown();
      requestBuild();
      // The model may have been downloaded (or its session released)
      void refreshModels();
    }
  };

  return {
    analyze,
    checkCapabilities,
    preload,
    refreshModels,
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
      clearCooldown();
      unsubscribeStore();
      unsubscribeModels();
      disposed = true;
      maskSource = null;
    },
  };
}
