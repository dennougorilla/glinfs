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
 * - Tracked objects (the edits' `ai.objects`, any model): syncObjects()
 *   tracks every object whose clicks or Whole / Part changed, or that has
 *   selection frames without a mask (a new mount, evicted masks), one at a
 *   time through manager.analyzeObject, and drops the masks of deleted
 *   objects. A change to the object being tracked stops that run and
 *   starts it over. An object is tracked automatically at most once per
 *   (clicks, selection): frames where tracking lost it stay without a mask
 *   until a click re-anchors it, instead of being retried in a loop.
 *   Progress goes to `objectTracking`, lost frames to `objectLost`.
 */

import { isAiCutoutActive } from '../../shared/edits/model.js';
import { suggestCleanups } from '../../shared/masks/cleanup-suggestions.js';
import { loadSettings } from '../../shared/user-settings.js';
import { isModelCached as isModelCachedDefault } from '../ai-cutout/model-cache.js';
import { getModelIds, isSamModelId } from '../ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { orderCandidatesBySize } from '../ai-cutout/sam-prompts.js';
import {
  frameKey,
  maskKey,
  objectMaskKey,
  resolveModelSpec,
} from '../ai-cutout/segmentation-manager.js';
import {
  buildClipMaskSource,
  countUntrackedObjectFrames,
  createClipDraftMaskSource,
  describeAnalysisError,
  estimateRemainingMs,
  getAiModelId,
  getBuildParamsKey,
  getClipProbSource,
  getObjectCoverage,
  getObjectSignature,
  getSharedFinalMaskCache,
  isAbortError,
  isColourObject,
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

export { getObjectSignature };

/**
 * A click that starts a tracking run holds whole-clip builds until its
 * first answer, at most this long (see expectAnswer)
 */
export const EXPECT_ANSWER_MAX_MS = 2000;

/**
 * The clean-up suggestion pass starts this long after a full build lands
 * (a quick change of mind aborts it before it starts)
 */
export const SUGGESTIONS_DELAY_MS = 500;

/**
 * Run `task` once the preview has painted what was just published: the
 * editor draws on the animation frame after its (throttled) store update,
 * so wait two frames, then a task; soon where there are no animation frames
 * @param {() => void} task
 */
function afterNextPaint(task) {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(task, 0)));
  } else {
    setTimeout(task, 0);
  }
}

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
  /** The model the running analysis uses @type {string | null} */
  let analysisModelId = null;
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

  /** Coverage of the tracked fix-ups last reported (skip identical reports) */
  let coverageKey = '';

  /**
   * Report how far each tracked fix-up reaches through the selection (the
   * chips' rings and the status line read it)
   */
  const reportCoverage = () => {
    if (disposed) return;
    const state = getState();
    const frames = state?.clip?.frames;
    if (!state || !frames) return;
    const objects = state.edits?.background?.ai?.objects ?? [];
    const range = state.selectedRange ?? { start: 0, end: frames.length - 1 };
    const { perObject, short } = getObjectCoverage(frames, range, objects, {
      maskStore,
    });
    const key = `${short}|${Object.entries(perObject)
      .map(([id, c]) => `${id}:${c.covered}/${c.selection}`)
      .join(',')}`;
    if (key === coverageKey) return;
    coverageKey = key;
    report({ objectCoverage: perObject, objectShort: short });
  };

  /** @param {MaskSource} source */
  const publish = (source) => {
    if (disposed || source === maskSource) return;
    maskSource = source;
    if (!(/** @type {any} */ (source).draft)) {
      fullSource = source;
      scheduleSuggestions(source);
      report({ colourLevels: source.colourLevels ?? {} });
    }
    report({ maskVersion: source.version });
    onMaskSource?.(source);
  };

  /** @type {AbortController | null} */
  let suggestController = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let suggestTimer = null;

  /** Stop the suggestion pass (a new one starts with the next build) */
  const abortSuggestions = () => {
    if (suggestTimer !== null) clearTimeout(suggestTimer);
    suggestTimer = null;
    suggestController?.abort();
    suggestController = null;
  };

  /**
   * Find the clean-up suggestions of a full build, a moment after it lands
   * @param {MaskSource} source
   */
  const scheduleSuggestions = (source) => {
    abortSuggestions();
    suggestTimer = setTimeout(() => {
      suggestTimer = null;
      const state = getState();
      const frames = state?.clip?.frames;
      if (disposed || !state || !frames || maskSource !== source) return;
      const { ai } = state.edits.background;
      const controller = new AbortController();
      suggestController = controller;
      // Measured where picks and clean-up act (before Fit and the objects)
      suggestCleanups({
        frameCount: frames.length,
        getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
        ai,
        keyOf: (f) => frameKey(frames[f]),
        signal: controller.signal,
      }).then(
        (suggestions) => {
          if (suggestController !== controller) return;
          suggestController = null;
          report({ cleanupSuggestions: suggestions });
        },
        (error) => {
          if (suggestController === controller) suggestController = null;
          if (!isAbortError(error))
            console.error('[AI cutout] Clean-up suggestions failed:', error);
        },
      );
    }, SUGGESTIONS_DELAY_MS);
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
    reportCoverage();
    if (expectTimer !== null) {
      buildAfterAnswer = true;
      return;
    }
    const state = getState();
    if (!state?.clip || !isAiCutoutActive(state.edits.background)) {
      abortBuild();
      abortSuggestions();
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
      reportCoverage();
      requestStoreBuild();
    }, STORE_REBUILD_DELAY_MS);
  });

  /** Bumped by every refreshModels call: only the latest one reports */
  let modelsSeq = 0;
  /** @type {Promise<void>} The latest refreshModels call */
  let latestModels = Promise.resolve();

  /**
   * Report per model whether it is ready (session loaded), downloaded or
   * still to download. A call that a later one supersedes resolves only
   * when the latest one has reported, so `await refreshModels()` always
   * means the status holds the current availability (#187).
   * @returns {Promise<void>}
   */
  const refreshModels = () => {
    if (disposed) return Promise.resolve();
    const seq = ++modelsSeq;
    const run = (async () => {
      const ids = getModelIds();
      const cached = await Promise.all(ids.map((id) => isModelCached(id).catch(() => null)));
      if (disposed) return;
      if (seq !== modelsSeq) {
        await latestModels;
        return;
      }
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
    })();
    latestModels = run;
    return run;
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
    analysisModelId = modelId;
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
    let firstMaskShown = false;
    const onProgress = (progress) => {
      if (disposed || analysisController !== controller) return;
      if (progress.phase === 'analyzing' && analyzingSince === null) {
        analyzingSince = now();
      }
      if (click && !firstMaskShown && progress.framesDone > 0) {
        // The clicked frame's mask: show it now, not after the store debounce
        // and the rebuild cooldown of a running analysis
        firstMaskShown = true;
        clearCooldown();
        requestBuild();
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
          // Stopped for new clicks: the next run redoes the masks at once
          superseded: () => queuedFrames !== null,
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
      if (analysisController === controller) {
        analysisController = null;
        analysisModelId = null;
      }
      // Catch up with every mask now, not at the end of the cooldown
      clearCooldown();
      requestBuild();
      // The model may have been downloaded (or its session released)
      void refreshModels();
      const next = queuedFrames;
      queuedFrames = null;
      if (next && !disposed) {
        void analyze(next);
      } else if (!disposed) {
        // The selection's frames have their base masks: the objects' next
        syncObjects();
      }
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
      // Click to select while its own model still loads: the load has no
      // click to track and ends by itself; stopping it would drop the
      // download. A load of another model (switched away from) stops.
      const loading = !['analyzing', 'idle', 'error'].includes(getState()?.aiCutout?.phase ?? '');
      const modelId = getAiModelId(getState()?.edits.background.ai);
      const sameClickLoad = isSamModelId(modelId) && analysisModelId === modelId;
      if (!(sameClickLoad && loading)) analysisController.abort();
      return;
    }
    void analyze(frames);
  };

  // ------------------------------------------------------------------
  // Tracked objects
  // ------------------------------------------------------------------

  /** @type {AbortController | null} */
  let objectController = null;
  /** The object being tracked @type {{ id: string, signature: string, runKey: string } | null} */
  let objectRun = null;
  /** Objects to track after the running one, in order @type {string[]} */
  let objectQueue = [];
  /** Per object: the signature its masks were made with @type {Map<string, string>} */
  const objectSignatures = new Map();
  /**
   * Per object: the (signature, selection) of its last finished run, so a
   * lost frame does not make it track again by itself
   * @type {Map<string, string>}
   */
  const objectRuns = new Map();
  /** @type {Record<string, number[]>} */
  let objectLost = {};
  /**
   * Per fix-up: the tracker's answers on its clicked frame, small to large
   * (what the picker steps through; kept for this mount only)
   * @type {Map<string, { frame: number, answers: import('../../shared/masks/final-masks.js').ProbMask[] }>}
   */
  const objectAnswers = new Map();
  let answersVersion = 0;

  /**
   * @param {import('../../shared/edits/model.js').CutoutObject} object
   * @param {{ start: number, end: number }} range
   * @returns {string}
   */
  const runKeyOf = (object, range) => `${getObjectSignature(object)}|${range.start}-${range.end}`;

  /**
   * @param {string} id
   * @returns {import('../../shared/edits/model.js').CutoutObject | undefined}
   */
  const findObject = (id) => getState()?.edits.background.ai.objects?.find((o) => o.id === id);

  /** @param {Record<string, number[]>} next */
  const reportLost = (next) => {
    objectLost = next;
    report({ objectLost: next });
  };

  /**
   * Drop every mask of an object (it was deleted)
   * @param {string} id
   */
  const dropObjectMasks = (id) => {
    for (const frame of getState()?.clip?.frames ?? []) maskStore.delete(objectMaskKey(frame, id));
    manager.dropObjectSeeds?.(id);
  };

  /** A whole-clip build waiting for the draft to be painted first */
  let draftBuildRequest = 0;

  /**
   * A Keep / Remove click is about to start a tracking run: builds wait for
   * its first answer (then the draft is shown and the build follows), at
   * most EXPECT_ANSWER_MAX_MS. A build started on the click itself only
   * rebuilt the whole clip with the masks the run is about to redo, and
   * held the main thread while the answer arrived.
   * @type {ReturnType<typeof setTimeout> | null}
   */
  let expectTimer = null;
  let buildAfterAnswer = false;

  const stopExpecting = () => {
    if (expectTimer !== null) clearTimeout(expectTimer);
    expectTimer = null;
    const wanted = buildAfterAnswer;
    buildAfterAnswer = false;
    return wanted;
  };

  /**
   * Publish a draft of the current parameters and masks at once (the frame
   * on screen is computed when drawn), then the whole-clip build once the
   * draft has been painted: a build started at once holds the main thread
   * for its first slice and replaced the draft before it was ever drawn
   * (measured: the next paint came 156 ms later, with the build's masks). A
   * build in flight started before the new masks is dropped, so it cannot
   * replace the draft with older masks.
   */
  const showDraftNow = () => {
    if (disposed) return;
    const state = getState();
    if (!state?.clip || !isAiCutoutActive(state.edits.background)) return;
    stopExpecting();
    abortBuild();
    clearCooldown();
    publish(
      createClipDraftMaskSource({
        frames: state.clip.frames,
        ai: state.edits.background.ai,
        maskStore,
        base: fullSource,
      }),
    );
    const request = ++draftBuildRequest;
    afterNextPaint(() => {
      if (request === draftBuildRequest) requestBuild();
    });
  };

  /**
   * Prepare the tracker (MobileSAM) ahead of the first tracked fix-up, e.g.
   * when Keep or Remove is turned on: only when it is downloaded already
   * (never a download), and not while another model is busy
   * @returns {Promise<boolean>} Its session is ready
   */
  const preloadTracker = async () => {
    if (disposed) return false;
    if (manager.getReadyInfo?.('click')) return true;
    if (!(await isModelCached('click').catch(() => false))) return false;
    if (disposed) return false;
    const ready =
      (await manager.preloadModel?.('click', { allowWasm: isWasmAllowed() }).catch(() => false)) ??
      false;
    void refreshModels();
    return ready;
  };

  /** Track the next queued object that still exists (one at a time) */
  const runNextObject = async () => {
    if (disposed || objectController) return;
    let object;
    while (objectQueue.length > 0 && !object)
      object = findObject(/** @type {string} */ (objectQueue.shift()));
    const state = getState();
    if (!object || !state?.clip || !isAiCutoutActive(state.edits.background)) {
      report({ objectTracking: null });
      return;
    }
    const controller = new AbortController();
    objectController = controller;
    const signature = getObjectSignature(object);
    const range = state.selectedRange;
    const runKey = runKeyOf(object, range);
    const { id } = object;
    objectRun = { id, signature, runKey };
    objectSignatures.set(id, signature);
    const clipId = getClipId();
    report({ objectTracking: { id, phase: 'starting', framesDone: 0, framesTotal: 0 } });
    let firstMaskShown = false;
    try {
      const result = await manager.analyzeObject(state.clip.frames, {
        objectId: id,
        signal: controller.signal,
        clipId,
        allowWasm: isWasmAllowed(),
        range,
        // The frame on screen first when it is in the selection
        currentFrame: state.currentFrame,
        clicks: object.clicks,
        boxes: object.boxes ?? [],
        scope: object.scope,
        candidate: typeof object.candidate === 'number' ? object.candidate : null,
        onAnswers: (frame, candidates) => {
          if (disposed || objectController !== controller) return;
          objectAnswers.set(id, {
            frame,
            answers: orderCandidatesBySize(candidates).map((c) => ({
              data: c.data,
              width: c.width,
              height: c.height,
            })),
          });
          answersVersion += 1;
          report({ objectAnswersVersion: answersVersion });
        },
        tag: signature,
        superseded: () => objectQueue.includes(id),
        onProgress: (progress) => {
          if (disposed || objectController !== controller) return;
          if (!firstMaskShown && progress.framesDone > 0) {
            // The clicked frame's object: show it now, from a draft that
            // computes only the frames drawn (a few ms), not after a
            // whole-clip build; the full build follows
            firstMaskShown = true;
            showDraftNow();
          }
          report({
            objectTracking: {
              id,
              phase: progress.phase,
              framesDone: progress.framesDone,
              framesTotal: progress.framesTotal,
              loadedBytes: progress.loadedBytes,
              totalBytes: progress.totalBytes,
              fromCache: progress.fromCache,
            },
          });
        },
      });
      objectRuns.set(id, runKey);
      reportLost({ ...objectLost, [id]: result.lost });
    } catch (error) {
      if (!isAbortError(error)) {
        const choice = isWasmChoiceError(error) && !isWasmAllowed();
        // Not again by itself for these clicks and this selection, unless
        // it waits for the CPU choice (taking it tracks the object)
        if (!choice) objectRuns.set(id, runKey);
        if (choice) {
          const modelFailed =
            /** @type {any} */ (error).code === SegmentationErrorCode.WEBGPU_MODEL_FAILED;
          report({
            needsWasmChoice: true,
            webgpuModelFailed: modelFailed,
            ...(modelFailed ? {} : { webgpu: false }),
          });
        } else {
          report({ phase: 'error', error: describeAnalysisError(error) });
        }
      }
    } finally {
      if (objectController === controller) {
        objectController = null;
        objectRun = null;
      }
      stopExpecting();
      clearCooldown();
      requestBuild();
      reportCoverage();
      void refreshModels();
      if (!disposed) {
        if (objectQueue.length > 0) {
          void runNextObject();
        } else {
          report({ objectTracking: null });
        }
      }
    }
  };

  /**
   * Bring the tracked objects' masks in line with the edits: track each
   * object whose clicks or Whole / Part changed (stopping its run in
   * flight), or that has selection frames without a mask and was not
   * tracked for these clicks and this selection yet (`force`: also then,
   * e.g. the Track button); drop deleted objects' masks.
   * @param {{ force?: boolean }} [options]
   */
  const syncObjects = ({ force = false } = {}) => {
    if (disposed) return;
    const state = getState();
    if (!state?.clip) return;
    const objects = state.edits.background.ai.objects ?? [];
    const ids = new Set(objects.map((o) => o.id));
    // Deleted objects
    for (const id of [...objectSignatures.keys()]) {
      if (ids.has(id)) continue;
      objectSignatures.delete(id);
      objectRuns.delete(id);
      objectAnswers.delete(id);
      objectQueue = objectQueue.filter((queued) => queued !== id);
      if (objectRun?.id === id) objectController?.abort();
      dropObjectMasks(id);
      if (id in objectLost) {
        const { [id]: _gone, ...rest } = objectLost;
        reportLost(rest);
      }
    }
    if (!isAiCutoutActive(state.edits.background)) return;
    for (const object of objects) {
      if (isColourObject(object)) {
        // Not tracked: a run of it stops; its tracked masks and lost frames
        // stay for a return to Whole / Part (readers skip a Colour fix-up's
        // lost frames)
        objectQueue = objectQueue.filter((queued) => queued !== object.id);
        if (objectRun?.id === object.id) objectController?.abort();
        continue;
      }
      const signature = getObjectSignature(object);
      const known = objectSignatures.get(object.id);
      // A new mount: the stored masks were made with these clicks
      if (known === undefined) objectSignatures.set(object.id, signature);
      const changed = known !== undefined && known !== signature;
      const runKey = runKeyOf(object, state.selectedRange);
      const running = objectRun?.id === object.id;
      if (running && objectRun?.runKey === runKey && !force) continue;
      const untracked =
        countUntrackedObjectFrames(state.clip.frames, state.selectedRange, object, maskStore, {
          retryLost: force,
        }) > 0;
      const tried = objectRuns.get(object.id) === runKey;
      if (!changed && !(untracked && (force || !tried))) continue;
      if (changed) {
        objectSignatures.set(object.id, signature);
        // Frames outside the selection keep no mask of the old clicks or
        // scope: tracking redoes only the selection, and a later wider
        // selection must see them as untracked
        state.clip.frames.forEach((frame, f) => {
          if (f < state.selectedRange.start || f > state.selectedRange.end) {
            maskStore.delete(objectMaskKey(frame, object.id));
          }
        });
        if (object.id in objectLost) {
          const { [object.id]: _old, ...rest } = objectLost;
          reportLost(rest);
        }
      }
      if (!objectQueue.includes(object.id)) {
        // Changed clicks go first: the user is looking at that object
        objectQueue = changed ? [object.id, ...objectQueue] : [...objectQueue, object.id];
      }
      if (running) objectController?.abort();
    }
    void runNextObject();
  };

  return {
    analyze,
    analyzeNow,
    checkCapabilities,
    clearClickMasks,
    syncObjects,
    preload,
    preloadTracker,
    refreshModels,

    /**
     * A fix-up's answers on its clicked frame, small to large (null: none
     * kept, e.g. after a reload)
     * @param {string} id
     * @returns {{ frame: number, answers: import('../../shared/masks/final-masks.js').ProbMask[] } | null}
     */
    getObjectAnswers(id) {
      return objectAnswers.get(id) ?? null;
    },

    /**
     * A Keep / Remove click is about to (re)track a fix-up: hold whole-clip
     * builds until its first answer (shown from a draft), or for at most
     * EXPECT_ANSWER_MAX_MS
     */
    expectAnswer() {
      if (disposed) return;
      if (expectTimer !== null) clearTimeout(expectTimer);
      expectTimer = setTimeout(() => {
        if (stopExpecting()) requestBuild();
      }, EXPECT_ANSWER_MAX_MS);
    },
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

    /** Stop the running analysis and object tracking (finished masks stay) */
    cancel() {
      queuedFrames = null;
      analysisController?.abort();
      objectQueue = [];
      objectController?.abort();
    },

    /** @returns {boolean} A tracked object is being tracked */
    get trackingObject() {
      return objectController !== null;
    },

    /**
     * The explicit "Run without WebGPU (very slow)" choice, then analyze
     * @param {Frame[]} frames
     */
    allowWasmAndAnalyze(frames) {
      setWasmAllowed(true);
      report({ wasmAllowed: true, needsWasmChoice: false });
      const done = analyze(frames);
      // Objects that waited for this choice
      syncObjects();
      return done;
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
      abortSuggestions();
      queuedFrames = null;
      analysisController?.abort();
      objectQueue = [];
      objectController?.abort();
      objectController = null;
      objectRun = null;
      analysisController = null;
      analysisModelId = null;
      buildController?.abort();
      buildController = null;
      if (storeTimer !== null) {
        clearTimeout(storeTimer);
        storeTimer = null;
      }
      clearCooldown();
      stopExpecting();
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
