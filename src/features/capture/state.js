/**
 * Capture State Management
 * @module features/capture/state
 */

import { createStore } from '../../shared/store.js';
import { createBuffer, addFrame, calculateStats, createDefaultSettings, clearBuffer } from './core.js';

/**
 * Initialize capture state
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 * @returns {import('./types.js').CaptureState}
 */
export function initCaptureState(settings = {}) {
  const mergedSettings = { ...createDefaultSettings(), ...settings };
  const maxFrames = mergedSettings.fps * mergedSettings.bufferDuration;

  return {
    isCapturing: false,
    isSharing: false,
    stream: null,
    buffer: createBuffer(maxFrames),
    settings: mergedSettings,
    error: null,
    stats: {
      frameCount: 0,
      duration: 0,
      memoryMB: 0,
      fps: mergedSettings.fps,
    },
    clips: [],
    clipCount: 0,
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
 * Add a frame to state
 * @param {import('./types.js').CaptureState} state
 * @param {import('./types.js').Frame} frame
 * @returns {import('./types.js').CaptureState}
 */
export function addFrameToState(state, frame) {
  const newBuffer = addFrame(state.buffer, frame);
  const newStats = calculateStats(newBuffer, state.settings.fps);

  return {
    ...state,
    buffer: newBuffer,
    stats: newStats,
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

  // If fps or bufferDuration changed, recreate buffer
  if (settings.fps !== undefined || settings.bufferDuration !== undefined) {
    const maxFrames = newSettings.fps * newSettings.bufferDuration;
    // Clear old buffer to release VideoFrame resources before creating new one
    clearBuffer(state.buffer);
    return {
      ...state,
      settings: newSettings,
      buffer: createBuffer(maxFrames),
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
 * Clear error state
 * @param {import('./types.js').CaptureState} state
 * @returns {import('./types.js').CaptureState}
 */
export function clearError(state) {
  return {
    ...state,
    error: null,
  };
}

/**
 * Add clip created during recording
 * @param {import('./types.js').CaptureState} state
 * @param {import('./types.js').ClipExtractionResult} clip
 * @returns {import('./types.js').CaptureState}
 */
export function addClipDuringRecording(state, clip) {
  return {
    ...state,
    clips: [...state.clips, clip],
    clipCount: state.clipCount + 1,
  };
}

/**
 * Clear all clips from the current session
 * @param {import('./types.js').CaptureState} state
 * @returns {import('./types.js').CaptureState}
 */
export function clearSessionClips(state) {
  return {
    ...state,
    clips: [],
    clipCount: 0,
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
