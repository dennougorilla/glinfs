/**
 * User Settings Management
 * Provides persistent storage for all user preferences across the application
 */

const STORAGE_KEY = 'glinfs_user_settings';

/** Effective clip queue limit when unset and queued clips are compressed (#92) */
export const CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED = 10;

/** Effective clip queue limit when unset and queued clips stay raw (#92) */
export const CLIP_QUEUE_LIMIT_DEFAULT_RAW = 3;

/**
 * The only clipQueueLimit default ever shipped by v0.5.0-0.5.3 — and the
 * number still STORED for "auto", so those builds keep reading 10
 * @see decodeStoredCapture
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
 *   values outside 1-30 clamped) by app-store's getClipQueueLimit(). Stored
 *   in a form older builds can read (see decodeStoredCapture).
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

/*
 * Stored form of the "auto" clip queue limit (#92). In memory, auto is
 * clipQueueLimit: null. On disk it must stay readable by OLDER builds that
 * share this localStorage key (a tab opened before a deploy, or a rollback):
 * v0.5.x reads Number(clipQueueLimit) clamped to 1-30, so a stored null would
 * silently become a 1-clip queue there. Therefore:
 *
 *   auto      -> { clipQueueLimit: 10, clipQueueLimitMode: 'auto' }
 *   explicit  -> { clipQueueLimit: n,  clipQueueLimitMode: 'explicit' }
 *
 * Old builds see exactly the 10 they always defaulted to. The mode lives
 * INSIDE capture because old builds round-trip unknown capture keys (they
 * spread parsed.capture) but drop unknown top-level keys.
 *
 * Reading: only 'explicit' makes a stored 10 explicit. A 10 with mode 'auto'
 * or with no mode at all is auto:
 * - no mode = written by v0.5.0-0.5.3, which could not tell a deliberate 10
 *   from its default (saveSettings persists the WHOLE merged object, so
 *   changing any other setting materialized clipQueueLimit: 10). Treating it
 *   as explicit would pin raw-fallback platforms at 10 raw clips (~35 GiB at
 *   1080p); as auto it resolves to 10 where clips compress and 3 where they
 *   stay raw. Anyone who really wants 10 re-selects it (then 'explicit').
 * - an old build that resets the capture category drops the mode and writes
 *   its default 10 — correctly read back as auto.
 * Any other number is a user choice, whatever the mode says (e.g. an older
 * tab changed the limit to 5 under a stale 'auto' mode).
 */

/**
 * Decode stored capture prefs into the in-memory shape (pure: re-running it
 * on an unsaved legacy blob gives the same result; the new stored form is
 * written by the next saveSettings).
 * @param {any} capture - JSON-parsed stored capture prefs
 * @returns {any}
 */
function decodeStoredCapture(capture) {
  if (!capture || typeof capture !== 'object') return capture;
  const { clipQueueLimitMode, ...prefs } = capture;
  if (
    clipQueueLimitMode !== 'explicit' &&
    prefs.clipQueueLimit === LEGACY_CLIP_QUEUE_LIMIT_DEFAULT
  ) {
    prefs.clipQueueLimit = null;
  }
  return prefs;
}

/**
 * Encode in-memory capture prefs into their stored form (see above)
 * @param {CaptureSettingsPrefs} capture
 * @returns {Object}
 */
function encodeCaptureForStorage(capture) {
  const auto = capture?.clipQueueLimit === null || capture?.clipQueueLimit === undefined;
  return {
    ...capture,
    clipQueueLimit: auto ? LEGACY_CLIP_QUEUE_LIMIT_DEFAULT : capture.clipQueueLimit,
    clipQueueLimitMode: auto ? 'auto' : 'explicit',
  };
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

    const parsed = JSON.parse(stored);

    // Merge with defaults to handle new settings added in updates
    return {
      capture: { ...DEFAULT_SETTINGS.capture, ...decodeStoredCapture(parsed.capture) },
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
      JSON.stringify({ ...settings, capture: encodeCaptureForStorage(settings.capture) }),
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
