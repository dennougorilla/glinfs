/**
 * Export State Management
 * @module features/export/state
 */

import { createStore } from '../../shared/store.js';
import { createDefaultSettings, estimateSize, getCroppedDimensions } from './core.js';

/**
 * Initialize preview state
 * @returns {import('./types.js').PreviewState}
 */
function initPreviewState() {
  return {
    isPlaying: true,
  };
}

/**
 * Initialize export state
 * @returns {import('./types.js').ExportState}
 */
export function initExportState() {
  return {
    isDialogOpen: false,
    settings: createDefaultSettings(),
    job: null,
    estimatedSizeMB: 0,
    encoderStatus: 'gifenc-js',
    preview: initPreviewState(),
  };
}

/**
 * Open export dialog with clip data
 * @param {import('./types.js').ExportState} state
 * @param {import('../editor/types.js').Clip} clip
 * @param {import('../editor/types.js').CropArea | null} crop
 * @returns {import('./types.js').ExportState}
 */
export function openDialog(state, clip, crop) {
  const frame = clip.frames[0];
  const dims = getCroppedDimensions(frame, crop);
  const frameCount = clip.selectedRange.end - clip.selectedRange.start + 1;

  const estimatedBytes = estimateSize({
    frameCount,
    width: dims.width,
    height: dims.height,
    quality: state.settings.quality,
    dithering: state.settings.dithering,
    frameSkip: state.settings.frameSkip,
    encoderPreset: state.settings.encoderPreset,
  });

  return {
    ...state,
    isDialogOpen: true,
    estimatedSizeMB: estimatedBytes / (1024 * 1024),
  };
}

/**
 * Close export dialog
 * @param {import('./types.js').ExportState} state
 * @returns {import('./types.js').ExportState}
 */
export function closeDialog(state) {
  return {
    ...state,
    isDialogOpen: false,
    job: null,
  };
}

/**
 * Update export settings
 * @param {import('./types.js').ExportState} state
 * @param {Partial<import('./types.js').ExportSettings>} settings
 * @param {{ frameCount: number, width: number, height: number }} dimensions
 * @returns {import('./types.js').ExportState}
 */
export function updateSettings(state, settings, dimensions) {
  const newSettings = { ...state.settings, ...settings };

  const estimatedBytes = estimateSize({
    frameCount: dimensions.frameCount,
    width: dimensions.width,
    height: dimensions.height,
    quality: newSettings.quality,
    dithering: newSettings.dithering,
    frameSkip: newSettings.frameSkip,
    encoderPreset: newSettings.encoderPreset,
  });

  return {
    ...state,
    settings: newSettings,
    estimatedSizeMB: estimatedBytes / (1024 * 1024),
  };
}

/**
 * Create a new encoding job
 * @param {number} totalFrames
 * @param {import('./encoders/types.js').EncoderId} encoder
 * @returns {import('./types.js').EncodingJob}
 */
export function createEncodingJob(totalFrames, encoder) {
  return {
    id: crypto.randomUUID(),
    status: 'preparing',
    progress: 0,
    currentFrame: 0,
    totalFrames,
    startTime: Date.now(),
    estimatedRemaining: null,
    encoder,
    result: null,
    error: null,
  };
}

/**
 * Start encoding job
 * @param {import('./types.js').ExportState} state
 * @param {import('./types.js').EncodingJob} job
 * @returns {import('./types.js').ExportState}
 */
export function startEncoding(state, job) {
  return {
    ...state,
    job: {
      ...job,
      status: 'encoding',
    },
  };
}

/**
 * Update job progress
 * @param {import('./types.js').ExportState} state
 * @param {{ percent: number, current: number, estimatedRemaining?: number }} progress
 * @returns {import('./types.js').ExportState}
 */
export function updateProgress(state, progress) {
  if (!state.job) return state;

  return {
    ...state,
    job: {
      ...state.job,
      progress: progress.percent,
      currentFrame: progress.current,
      estimatedRemaining: progress.estimatedRemaining ?? state.job.estimatedRemaining,
    },
  };
}

/**
 * Complete encoding
 * @param {import('./types.js').ExportState} state
 * @param {Blob} result
 * @returns {import('./types.js').ExportState}
 */
export function completeEncoding(state, result) {
  if (!state.job) return state;

  return {
    ...state,
    job: {
      ...state.job,
      status: 'complete',
      progress: 100,
      result,
    },
  };
}

/**
 * Handle encoding error
 * @param {import('./types.js').ExportState} state
 * @param {string} error
 * @returns {import('./types.js').ExportState}
 */
export function failEncoding(state, error) {
  if (!state.job) return state;

  return {
    ...state,
    job: {
      ...state.job,
      status: 'error',
      error,
    },
  };
}

/**
 * Cancel encoding
 * @param {import('./types.js').ExportState} state
 * @returns {import('./types.js').ExportState}
 */
export function cancelEncodingState(state) {
  if (!state.job) return state;

  return {
    ...state,
    job: {
      ...state.job,
      status: 'error',
      error: 'Encoding cancelled by user',
    },
  };
}

/**
 * Reset export state after completion
 * @param {import('./types.js').ExportState} state
 * @returns {import('./types.js').ExportState}
 */
export function resetExport(state) {
  return {
    ...state,
    job: null,
  };
}

/**
 * Set encoder status
 * @param {import('./types.js').ExportState} state
 * @param {import('./encoders/types.js').EncoderId | 'unavailable'} status
 * @returns {import('./types.js').ExportState}
 */
export function setEncoderStatus(state, status) {
  return {
    ...state,
    encoderStatus: status,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW STATE ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Toggle preview playback state
 * @param {import('./types.js').ExportState} state
 * @returns {import('./types.js').ExportState}
 */
export function togglePreviewPlaying(state) {
  return {
    ...state,
    preview: {
      ...state.preview,
      isPlaying: !state.preview.isPlaying,
    },
  };
}

/**
 * Set preview playing state
 * @param {import('./types.js').ExportState} state
 * @param {boolean} isPlaying
 * @returns {import('./types.js').ExportState}
 */
export function setPreviewPlaying(state, isPlaying) {
  return {
    ...state,
    preview: {
      ...state.preview,
      isPlaying,
    },
  };
}

/**
 * Create export store
 * @returns {ReturnType<typeof createStore<import('./types.js').ExportState>>}
 */
export function createExportStore() {
  return createStore(initExportState());
}
