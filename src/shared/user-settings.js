/**
 * User Settings Management
 * Provides persistent storage for all user preferences across the application
 */

const STORAGE_KEY = 'glinfs_user_settings';

/**
 * Persisted schema version. Stored alongside the settings (never returned by
 * loadSettings) so migrations run exactly once per stored blob.
 * - 1 (absent): up to v0.5.3
 * - 2: capture.clipQueueLimit null means "auto" (#92 raw-fallback default)
 */
const SCHEMA_VERSION = 2;

/** Effective clip queue limit when unset and queued clips are compressed (#92) */
export const CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED = 10;

/** Effective clip queue limit when unset and queued clips stay raw (#92) */
export const CLIP_QUEUE_LIMIT_DEFAULT_RAW = 3;

/**
 * The only clipQueueLimit default ever shipped before schema 2 (v0.5.0-0.5.3)
 * @see migrateStoredSettings
 */
const LEGACY_CLIP_QUEUE_LIMIT_DEFAULT = 10;

/**
 * @typedef {Object} UserSettings
 * @property {CaptureSettingsPrefs} capture - Capture settings
 * @property {ExportSettingsPrefs} export - Export settings
 * @property {string} thumbnailQuality - Thumbnail quality preset
 */

/**
 * @typedef {Object} CaptureSettingsPrefs
 * @property {15|30|60} fps - Frames per second
 * @property {number} bufferDuration - Buffer duration in seconds (5-60)
 * @property {boolean} sceneDetection - Auto scene detection enabled
 * @property {boolean} backgroundCapture - Keep the frame-grab loop running while
 *   navigated away from /capture, instead of pausing it (default true)
 * @property {number|null} clipQueueLimit - Maximum clips held in the clip
 *   queue (1-30). The active clip is not counted — it lives outside the
 *   queue and can never be evicted by it. null = "auto" (the default): the
 *   EFFECTIVE limit then depends on the platform (#92) —
 *   CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED when queued clips are WebCodecs-
 *   compressed (~50-100x smaller than raw), CLIP_QUEUE_LIMIT_DEFAULT_RAW when
 *   they fall back to raw frames (~3.5 GiB per default 1080p clip). A number
 *   is an explicit user choice and is never overridden. Resolved (and stored
 *   values outside 1-30 clamped) by app-store's getClipQueueLimit().
 * @property {number} captureResolutionLimit - Maximum long edge of captured
 *   frames in pixels; 0 = native resolution. Frames are downscaled at grab
 *   time (#96) — Retina fullscreen at native is ~24 MB per raw frame.
 * @property {number} memoryBudgetMB - Total budget for frame memory
 *   (ring buffer + active clip + queue), conservatively estimated at raw
 *   RGBA w*h*4. The buffer is clamped to a share of it and clip creation is
 *   refused beyond it (#96).
 */

/**
 * @typedef {Object} ExportSettingsPrefs
 * @property {number} quality - Color quantization quality (0.1-1.0)
 * @property {1|2|3|4|5} frameSkip - Frame skip rate
 * @property {number} playbackSpeed - Playback speed multiplier (0.25-4.0)
 * @property {boolean} dithering - Dithering enabled
 * @property {number} loopCount - Loop count (0 = infinite)
 * @property {boolean} openInNewTab - Open result in new tab
 * @property {'quality'|'balanced'|'fast'} encoderPreset - Encoder quality preset
 * @property {'gifenc-js'|'gifsicle-wasm'} encoderId - Encoder to use
 */

/**
 * Default user settings
 * @type {UserSettings}
 */
const DEFAULT_SETTINGS = {
  capture: {
    fps: 30,
    bufferDuration: 15,
    sceneDetection: true,
    backgroundCapture: true,
    clipQueueLimit: null,
    captureResolutionLimit: 1920,
    memoryBudgetMB: 4000,
  },
  export: {
    quality: 0.8,
    frameSkip: 1,
    playbackSpeed: 1.0,
    dithering: true,
    loopCount: 0,
    openInNewTab: false,
    encoderPreset: 'balanced',
    encoderId: 'gifenc-js',
  },
  thumbnailQuality: 'auto', // 'auto' | 'low' | 'standard' | 'high' | 'ultra'
};

/**
 * Settings metadata for UI display
 */
export const SETTINGS_METADATA = {
  capture: {
    label: 'Capture',
    settings: {
      fps: {
        label: 'Frame Rate',
        type: 'select',
        options: [
          { value: 15, label: '15 FPS' },
          { value: 30, label: '30 FPS' },
          { value: 60, label: '60 FPS' },
        ],
      },
      bufferDuration: {
        label: 'Buffer Duration',
        type: 'range',
        min: 5,
        max: 60,
        step: 5,
        format: (v) => `${v}s`,
      },
      sceneDetection: {
        label: 'Scene Detection',
        type: 'boolean',
      },
      backgroundCapture: {
        label: 'Keep recording while editing',
        type: 'boolean',
      },
      clipQueueLimit: {
        label: 'Clip Queue Limit',
        type: 'range',
        min: 1,
        max: 30,
        step: 1,
        // null (auto) renders at the platform's effective default — the
        // settings UI resolves it, since this module cannot see the codec
        autoDefault: true,
        format: (v) => `${v} clip${v === 1 ? '' : 's'}`,
      },
      captureResolutionLimit: {
        label: 'Capture Resolution Limit',
        type: 'select',
        options: [
          { value: 1280, label: '1280px' },
          { value: 1920, label: '1920px (recommended)' },
          { value: 2560, label: '2560px' },
          { value: 0, label: 'Native (no limit)' },
        ],
      },
      memoryBudgetMB: {
        label: 'Memory Budget',
        type: 'range',
        min: 500,
        max: 16000,
        step: 500,
        format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} GB` : `${v} MB`),
      },
    },
  },
  export: {
    label: 'Export',
    settings: {
      quality: {
        label: 'Quality',
        type: 'range',
        min: 0.1,
        max: 1.0,
        step: 0.1,
        format: (v) => `${Math.round(v * 100)}%`,
      },
      frameSkip: {
        label: 'Frame Skip',
        type: 'select',
        options: [
          { value: 1, label: 'None (1)' },
          { value: 2, label: 'Every 2nd frame' },
          { value: 3, label: 'Every 3rd frame' },
          { value: 4, label: 'Every 4th frame' },
          { value: 5, label: 'Every 5th frame' },
        ],
      },
      playbackSpeed: {
        label: 'Playback Speed',
        type: 'range',
        min: 0.25,
        max: 4.0,
        step: 0.25,
        format: (v) => `${v}x`,
      },
      dithering: {
        label: 'Dithering',
        type: 'boolean',
      },
      loopCount: {
        label: 'Loop Count',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        format: (v) => (v === 0 ? 'Infinite' : `${v}x`),
      },
      openInNewTab: {
        label: 'Open in New Tab',
        type: 'boolean',
      },
      encoderPreset: {
        label: 'Encoder Preset',
        type: 'select',
        options: [
          { value: 'quality', label: 'Quality' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'fast', label: 'Fast' },
        ],
      },
      encoderId: {
        label: 'Encoder',
        type: 'select',
        options: [
          { value: 'gifenc-js', label: 'gifenc-js' },
          { value: 'gifsicle-wasm', label: 'gifsicle-wasm' },
        ],
      },
    },
  },
  thumbnailQuality: {
    label: 'Thumbnail Quality',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'low', label: 'Low' },
      { value: 'standard', label: 'Standard' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
    ],
  },
};

/**
 * Deep copy of the default settings.
 * A shallow copy would share the nested capture/export objects, letting
 * callers (e.g. updateSetting) mutate DEFAULT_SETTINGS itself.
 * @returns {UserSettings}
 */
function cloneDefaults() {
  return {
    capture: { ...DEFAULT_SETTINGS.capture },
    export: { ...DEFAULT_SETTINGS.export },
    thumbnailQuality: DEFAULT_SETTINGS.thumbnailQuality,
  };
}

/**
 * Bring a stored settings blob up to SCHEMA_VERSION (pure; the migrated form
 * is persisted by the next saveSettings, and re-running it on an unsaved
 * legacy blob gives the same result).
 *
 * Schema 1 -> 2: a stored clipQueueLimit equal to the old default (10)
 * becomes null ("auto"). Schema 1 had no way to tell a deliberate 10 from the
 * default — saveSettings persists the WHOLE merged object, so changing any
 * other setting materialized clipQueueLimit: 10 — and treating it as
 * explicit would pin raw-fallback platforms at 10 raw clips (~35 GiB at
 * 1080p). Demoting it to auto is safe in both directions: compressed
 * platforms still resolve to 10, raw ones drop to 3, and anyone who really
 * wants 10 re-selects it (stored as explicit from then on). Any other stored
 * value was necessarily a user choice and is kept.
 *
 * @param {any} parsed - JSON-parsed stored settings
 * @returns {any}
 */
function migrateStoredSettings(parsed) {
  const version = Number(parsed?.schemaVersion) || 1;
  if (version < 2 && parsed?.capture?.clipQueueLimit === LEGACY_CLIP_QUEUE_LIMIT_DEFAULT) {
    return { ...parsed, capture: { ...parsed.capture, clipQueueLimit: null } };
  }
  return parsed;
}

/**
 * Load user settings from localStorage
 * @returns {UserSettings}
 */
export function loadSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return cloneDefaults();
    }

    const parsed = migrateStoredSettings(JSON.parse(stored));

    // Merge with defaults to handle new settings added in updates
    return {
      capture: { ...DEFAULT_SETTINGS.capture, ...parsed.capture },
      export: { ...DEFAULT_SETTINGS.export, ...parsed.export },
      thumbnailQuality: parsed.thumbnailQuality || DEFAULT_SETTINGS.thumbnailQuality,
    };
  } catch (error) {
    console.error('Failed to load user settings:', error);
    return cloneDefaults();
  }
}

/**
 * Save user settings to localStorage
 * @param {UserSettings} settings
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...settings, schemaVersion: SCHEMA_VERSION }),
    );
  } catch (error) {
    console.error('Failed to save user settings:', error);
  }
}

/**
 * Update a specific setting
 * @param {string} category - 'capture' | 'export' | 'thumbnailQuality'
 * @param {string} key - Setting key
 * @param {any} value - New value
 */
export function updateSetting(category, key, value) {
  const settings = loadSettings();

  if (category === 'thumbnailQuality') {
    settings.thumbnailQuality = value;
  } else if (settings[category]) {
    settings[category][key] = value;
  }

  saveSettings(settings);
  notifyListeners();
}

/**
 * Reset all settings to defaults
 */
export function resetSettings() {
  saveSettings(cloneDefaults());
  notifyListeners();
}

/**
 * Reset a specific category to defaults
 * @param {string} category - 'capture' | 'export'
 */
export function resetCategory(category) {
  const settings = loadSettings();
  if (settings[category]) {
    settings[category] = { ...DEFAULT_SETTINGS[category] };
    saveSettings(settings);
    notifyListeners();
  }
}

/**
 * Get default settings
 * @returns {UserSettings}
 */
export function getDefaultSettings() {
  return cloneDefaults();
}

// Change notification system
const listeners = new Set();

/**
 * Subscribe to settings changes
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function onSettingsChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Notify all listeners of settings change
 */
function notifyListeners() {
  const settings = loadSettings();
  listeners.forEach((callback) => {
    try {
      callback(settings);
    } catch (error) {
      console.error('Settings change listener error:', error);
    }
  });
}
