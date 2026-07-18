/**
 * Capture State Management
 * @module features/capture/state
 */

import { createStore } from '../../shared/store.js';
import { createDefaultSettings } from './core.js';

/**
 * Initialize capture state
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 * @returns {import('./types.js').CaptureState}
 */
export function initCaptureState(settings = {}) {
  const mergedSettings = { ...createDefaultSettings(), ...settings };

  return {
    isCapturing: false,
    isSharing: false,
    stream: null,
    settings: mergedSettings,
    error: null,
    stats: {
      frameCount: 0,
      duration: 0,
      memoryMB: 0,
      fps: mergedSettings.fps,
    },
  };
}

/**
 * Start capturing
 * @param {import('./types.js').CaptureState} state
 * @param {MediaStream} stream
 * @returns {import('./types.js').CaptureState}
 */
export function startCapture(state, stream) {
  return {
    ...state,
    isCapturing: true,
    isSharing: true,
    stream,
    error: null,
  };
}

/**
 * Stop capturing
 * @param {import('./types.js').CaptureState} state
 * @returns {import('./types.js').CaptureState}
 */
export function stopCapture(state) {
  return {
    ...state,
    isCapturing: false,
    isSharing: false,
    stream: null,
  };
}

/**
 * Update settings
 * @param {import('./types.js').CaptureState} state
 * @param {Partial<import('./types.js').CaptureSettings>} settings
 * @returns {import('./types.js').CaptureState}
 */
export function updateSettings(state, settings) {
  const newSettings = { ...state.settings, ...settings };

  // Settings are disabled during sharing, so changing the capture cadence
  // also resets the worker-derived counters for the next session.
  if (settings.fps !== undefined || settings.bufferDuration !== undefined) {
    return {
      ...state,
      settings: newSettings,
      stats: {
        frameCount: 0,
        duration: 0,
        memoryMB: 0,
        fps: newSettings.fps,
      },
    };
  }

  return {
    ...state,
    settings: newSettings,
  };
}

/**
 * Set error state
 * @param {import('./types.js').CaptureState} state
 * @param {string} error
 * @returns {import('./types.js').CaptureState}
 */
export function setError(state, error) {
  return {
    ...state,
    error,
    isCapturing: false,
  };
}

/**
 * Create a capture store
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 * @returns {ReturnType<typeof createStore<import('./types.js').CaptureState>>}
 */
export function createCaptureStore(settings) {
  return createStore(initCaptureState(settings));
}
