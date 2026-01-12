/**
 * Loading Feature Entry Point
 * @module features/loading
 *
 * Shows a loading screen with progress during scene detection.
 * Used as an intermediate step between Capture and Editor when
 * scene detection is enabled.
 */

import { emit } from '../../shared/bus.js';
import { getClipPayload, setClipPayload } from '../../shared/app-store.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { navigate } from '../../shared/router.js';
import { createSceneDetectionManager } from '../scene-detection/manager.js';
import { renderLoadingScreen, updateProgress } from './ui.js';

/** @type {import('../scene-detection/manager.js').SceneDetectionManager | null} */
let sceneDetectionManager = null;

/** @type {boolean} */
let isNavigating = false;

/**
 * Initialize loading feature
 * @returns {() => void} Cleanup function
 */
export function initLoading() {
  const container = qsRequired('#main-content');
  const clipPayload = getClipPayload();

  // Reset navigation flag
  isNavigating = false;

  // If no clipPayload or scene detection not enabled, redirect to editor
  if (!clipPayload || !clipPayload.sceneDetectionEnabled) {
    navigate('/editor');
    return () => {};
  }

  // Render loading screen
  const cleanup = renderLoadingScreen(container);

  // Start scene detection
  runSceneDetection(container, clipPayload);

  return () => {
    cleanup();
    // Cancel detection if navigating away
    if (sceneDetectionManager && !isNavigating) {
      sceneDetectionManager.dispose();
      sceneDetectionManager = null;
    }
  };
}

/**
 * Run scene detection and navigate to editor when complete
 * @param {HTMLElement} container
 * @param {import('../../shared/app-store.js').ClipPayload} clipPayload
 */
async function runSceneDetection(container, clipPayload) {
  sceneDetectionManager = createSceneDetectionManager();

  try {
    await sceneDetectionManager.init();

    const result = await sceneDetectionManager.detect(clipPayload.frames, {
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
      onProgress: (progress) => {
        updateProgress(container, progress.percent);
      },
    });

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
    isNavigating = true;
    navigate('/editor');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.log('[Loading] Scene detection cancelled');
    } else {
      console.error('[Loading] Scene detection error:', error);
      emit('loading:detection-error', {
        error: error instanceof Error ? error.message : 'Detection failed',
      });

      // Navigate to editor even on error (without scenes)
      isNavigating = true;
      navigate('/editor');
    }
  } finally {
    if (sceneDetectionManager) {
      sceneDetectionManager.dispose();
      sceneDetectionManager = null;
    }
  }
}
