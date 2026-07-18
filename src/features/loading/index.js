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

/** @type {import('../scene-detection/manager.js').SceneDetectionManager | null} */
let sceneDetectionManager = null;

/** Incremented to invalidate async work from a previous loading route mount. */
let detectionRunId = 0;

/**
 * Initialize loading feature
 * @returns {() => void} Cleanup function
 */
export function initLoading() {
  const container = qsRequired('#main-content');
  const clipPayload = getClipPayload();
  const runId = ++detectionRunId;

  // If no clipPayload or scene detection not enabled, redirect to editor
  if (!clipPayload?.sceneDetectionEnabled) {
    navigate('/editor');
    return () => {};
  }

  // Render loading screen
  const cleanup = renderLoadingScreen(container);
  const manager = createSceneDetectionManager();
  sceneDetectionManager = manager;

  // Start scene detection
  runSceneDetection(container, clipPayload, runId, manager);

  return () => {
    if (detectionRunId === runId) {
      detectionRunId++;
    }
    cleanup();
    manager.dispose();
    if (sceneDetectionManager === manager) {
      sceneDetectionManager = null;
    }
  };
}

/**
 * Run scene detection and navigate to editor when complete
 * @param {HTMLElement} container
 * @param {import('../../shared/app-store.js').ClipPayload} clipPayload
 * @param {number} runId - Loading route mount that owns this operation
 * @param {import('../scene-detection/manager.js').SceneDetectionManager} manager
 */
async function runSceneDetection(container, clipPayload, runId, manager) {
  const isCurrentRun = () => detectionRunId === runId;

  try {
    await manager.init();

    if (!isCurrentRun()) return;

    const result = await manager.detect(clipPayload.frames, {
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
      onProgress: (progress) => {
        if (isCurrentRun()) {
          updateProgress(container, progress.percent);
        }
      },
    });

    if (!isCurrentRun()) return;

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
    if (!isCurrentRun()) return;

    if (error instanceof DOMException && error.name === 'AbortError') {
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
    manager.dispose();
    if (sceneDetectionManager === manager) {
      sceneDetectionManager = null;
    }
  }
}
