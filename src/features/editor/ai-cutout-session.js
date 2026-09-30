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
 * - Interactive mode (an AI slider is being dragged, see setInteractive):
 *   a parameter change publishes a draft MaskSource at once, which computes
 *   only the frames the preview draws (createClipDraftMaskSource), instead
 *   of restarting a whole-clip build on every input event (the preview
 *   would stay frozen until the drag ends, then jump). Leaving the mode
 *   runs the full build; the draft stays on screen until it lands.
 * - `building` is reported only for builds that run longer than
 *   BUILDING_STATUS_DELAY_MS, so fast rebuilds never flash a status.
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
 * - Click to select (a SAM model): "analyze" means tracking the clicks
 *   (the edits' picks) through the selection, the frame on screen first
 *   (manager.analyzeClick); without a click it only loads the model. The
 *   frames where tracking lost the object are reported as `lostFrames`.
 *   The editor calls analyzeNow again whenever the clicks or Whole / Part
 *   change (a running tracking stops and starts over; embeddings the
 *   worker already has make that cheap), and clearClickMasks when the
 *   last click goes.
 */

import { isAiCutoutActive } from '../../shared/edits/model.js';
import { loadSettings } from '../../shared/user-settings.js';
import { isModelCached as isModelCachedDefault } from '../ai-cutout/model-cache.js';
import { getModelIds, isSamModelId } from '../ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { maskKey, resolveModelSpec } from '../ai-cutout/segmentation-manager.js';
import {
  buildClipMaskSource,
  createClipDraftMaskSource,
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
 * A final-mask build reports `building` (the UI's "updating" indicator)
 * only once it has run this long: most rebuilds finish sooner, and a status
 * that flashes on and off with every change reads as flicker
 */
export const BUILDING_STATUS_DELAY_MS = 300;

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
      isModelCachedDefault(modelId, { getFiles: (id) => resolveModelSpec(id).files }),
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
  /** An AI slider is being dragged: publish drafts, no full builds */
  let interactive = false;
  /**
   * The last full build published (a draft's pick selection follows it)
   * @type {MaskSource | null}
   */
  let fullSource = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let buildingTimer = null;
  /**
   * Frames to analyze once the running analysis has stopped (restart)
   * @type {Frame[] | null}
   */
  let queuedFrames = null;

  /** @param {Partial<AiCutoutStatus>} patch */
  const report = (patch) => {
    if (!disposed) setStatus(patch);
  };

  /** @param {MaskSource} source */
  const publish = (source) => {
    if (disposed || source === maskSource) return;
    maskSource = source;
    if (!(/** @type {any} */ (source).draft)) fullSource = source;
    report({ maskVersion: source.version });
    onMaskSource?.(source);
  };

  /** Report `building` only if the build is still running after a moment */
  const startBuildingStatus = () => {
    if (buildingTimer !== null) return;
    buildingTimer = setTimeout(() => {
      buildingTimer = null;
      if (buildController) report({ building: true });
    }, BUILDING_STATUS_DELAY_MS);
  };

  const endBuildingStatus = () => {
    if (buildingTimer !== null) clearTimeout(buildingTimer);
    buildingTimer = null;
    report({ building: false });
  };

  const abortBuild = () => {
    buildController?.abort();
    buildController = null;
    buildKey = null;
    rebuildAfterBuild = false;
    endBuildingStatus();
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
    if (interactive) {
      // Dragging: only the frames on screen, now (see createClipDraftMaskSource)
      abortBuild();
      publish(createClipDraftMaskSource({ frames, ai, maskStore, base: fullSource }));
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
    startBuildingStatus();
    if (analysisController) startCooldown();
    buildClipMaskSource({ frames, ai, maskStore, clipId, cache, signal: controller.signal }).then(
      (source) => {
        if (buildController !== controller) return;
        buildController = null;
        buildKey = null;
        endBuildingStatus();
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
        endBuildingStatus();
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
    const startState = getState();
    const modelId = getAiModelId(startState?.edits.background.ai);
    const click = isSamModelId(modelId);
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
      ...(click ? { lostFrames: [] } : {}),
    });
    /** @param {import('../ai-cutout/segmentation-manager.js').AnalysisProgress} progress */
    const onProgress = (progress) => {
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
    };
    try {
      if (click) {
        const ai = startState?.edits.background.ai;
        const result = await manager.analyzeClick(startState?.clip?.frames ?? [], {
          signal: controller.signal,
          clipId,
          modelId,
          allowWasm: isWasmAllowed(),
          range: startState?.selectedRange ?? { start: 0, end: -1 },
          currentFrame: startState?.currentFrame ?? 0,
          picks: ai?.picks ?? [],
          scope: ai?.clickScope ?? 'whole',
          onProgress,
        });
        report({
          phase: 'idle',
          backend: result.backend,
          ...(result.backend === 'webgpu' ? { webgpuModelFailed: false } : {}),
          lostFrames: result.lost,
          notice:
            result.anchors === 0
              ? ''
              : `Tracked ${result.tracked} frame${result.tracked === 1 ? '' : 's'}.`,
        });
        return;
      }
      const result = await manager.analyzeFrames(frames, {
        signal: controller.signal,
        clipId,
        modelId,
        allowWasm: isWasmAllowed(),
        onProgress,
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
        report(
          queuedFrames
            ? { phase: 'starting', notice: '' }
            : {
                phase: 'idle',
                notice: click
                  ? 'Tracking stopped. Finished frames are kept.'
                  : 'Analysis cancelled. Finished frames are kept.',
              },
        );
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
      const next = queuedFrames;
      queuedFrames = null;
      if (next && !disposed) void analyze(next);
    }
  };

  /**
   * Click to select: drop the clip's click masks (the last click went) and
   * the lost-frame notes; a running tracking stops
   */
  const clearClickMasks = () => {
    if (disposed) return;
    const state = getState();
    const modelId = getAiModelId(state?.edits.background.ai);
    if (!isSamModelId(modelId)) return;
    queuedFrames = null;
    analysisController?.abort();
    for (const frame of state?.clip?.frames ?? []) maskStore.delete(maskKey(frame, modelId));
    report({ lostFrames: [], notice: '' });
  };

  /**
   * Analyze these frames now, in this order (the frame on screen first):
   * a running analysis (e.g. with the model just switched away from) is
   * stopped first, its finished masks kept
   * @param {Frame[]} frames
   */
  const analyzeNow = (frames) => {
    if (disposed) return;
    if (analysisController) {
      queuedFrames = frames;
      // Click to select while its model still loads: the load has no click
      // to track and ends by itself; stopping it would drop the download
      const loading = !['analyzing', 'idle', 'error'].includes(getState()?.aiCutout?.phase ?? '');
      const click = isSamModelId(getAiModelId(getState()?.edits.background.ai));
      if (!(click && loading)) analysisController.abort();
      return;
    }
    void analyze(frames);
  };

  return {
    analyze,
    analyzeNow,
    checkCapabilities,
    clearClickMasks,
    preload,
    refreshModels,
    requestBuild,

    /**
     * Enter/leave interactive mode (an AI slider is being dragged): while
     * on, parameter changes publish per-frame drafts instead of full
     * builds; turning it off runs the full build for the final values
     * @param {boolean} on
     */
    setInteractive(on) {
      if (disposed || interactive === on) return;
      interactive = on;
      if (!on) requestBuild();
    },

    /** @returns {boolean} Interactive mode is on */
    get interactive() {
      return interactive;
    },

    /** Stop the running analysis (finished masks stay) */
    cancel() {
      queuedFrames = null;
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
      queuedFrames = null;
      analysisController?.abort();
      analysisController = null;
      buildController?.abort();
      buildController = null;
      if (storeTimer !== null) {
        clearTimeout(storeTimer);
        storeTimer = null;
      }
      clearCooldown();
      if (buildingTimer !== null) clearTimeout(buildingTimer);
      buildingTimer = null;
      unsubscribeStore();
      unsubscribeModels();
      disposed = true;
      maskSource = null;
      fullSource = null;
    },
  };
}
