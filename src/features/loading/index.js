/**
 * Loading Feature Entry Point
 * @module features/loading
 *
 * Shows a loading screen with progress during scene detection.
 * Used as an intermediate step between Capture and Editor when
 * scene detection is enabled.
 */

import { getClipPayload, setClipPayload } from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { navigate } from '../../shared/router.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { createSceneDetectionManager } from '../scene-detection/manager.js';
import { renderLoadingScreen, updateProgress } from './ui.js';

/**
 * Per-init session state. Scoped to each initLoading() call (NOT module
 * level) so that re-entrant navigation — /loading being mounted again
 * before the previous run's async detection finished — cannot dispose or
 * navigate on behalf of another session.
 * @typedef {Object} LoadingSession
 * @property {import('../scene-detection/manager.js').SceneDetectionManager} manager
 * @property {boolean} cancelled - Set when this session's cleanup ran
 */

/**
 * Initialize loading feature
 * @returns {() => void} Cleanup function
 */
export function initLoading() {
  const container = qsRequired('#main-content');
  const clipPayload = getClipPayload();

  // If no clipPayload or scene detection not enabled, redirect to editor
  if (!clipPayload?.sceneDetectionEnabled) {
    navigate('/editor');
    return () => {};
  }

  // Render loading screen
  const uiCleanup = renderLoadingScreen(container);

  /** @type {LoadingSession} */
  const session = {
    manager: createSceneDetectionManager(),
    cancelled: false,
  };

  // Start scene detection
  runSceneDetection(container, clipPayload, session);

  return () => {
    uiCleanup();
    session.cancelled = true;
    // Safe even after runSceneDetection's own dispose — dispose() is idempotent
    session.manager.dispose();
  };
}

/**
 * Run scene detection and navigate to editor when complete
 * @param {HTMLElement} container
 * @param {import('../../shared/app-store.js').ClipPayload} clipPayload
 * @param {LoadingSession} session
 */
async function runSceneDetection(container, clipPayload, session) {
  try {
    await session.manager.init();

    const result = await session.manager.detect(clipPayload.frames, {
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
      onProgress: (progress) => {
        if (!session.cancelled) {
          updateProgress(container, progress.percent);
        }
      },
    });

    // User already navigated elsewhere — don't overwrite the payload or
    // hijack their navigation with a redirect to /editor
    if (session.cancelled) {
      console.log('[Loading] Scene detection finished after cancellation; discarding result');
      return;
    }

    console.log('[Loading] Scene detection completed:', result.scenes.length, 'scenes');

    // Update clipPayload with scenes
    setClipPayload({
      ...clipPayload,
      scenes: result.scenes,
    });

    emit('loading:detection-complete', {
      sceneCount: result.scenes.length,
      processingTimeMs: result.processingTimeMs,
    });

    // Navigate to editor
    navigate('/editor');
  } catch (error) {
    if (session.cancelled || (error instanceof DOMException && error.name === 'AbortError')) {
      console.log('[Loading] Scene detection cancelled');
    } else {
      console.error('[Loading] Scene detection error:', error);
      emit('loading:detection-error', {
        error: error instanceof Error ? error.message : 'Detection failed',
      });

      // Navigate to editor even on error (without scenes)
      navigate('/editor');
    }
  } finally {
    session.manager.dispose();
  }
}
