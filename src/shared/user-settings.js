/**
 * User Settings Management
 * Provides persistent storage for all user preferences across the application
 */

const STORAGE_KEY = 'glinfs_user_settings';

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
    label: 'キャプチャ設定',
    settings: {
      fps: {
        label: 'フレームレート (FPS)',
        type: 'select',
        options: [
          { value: 15, label: '15 FPS' },
          { value: 30, label: '30 FPS' },
          { value: 60, label: '60 FPS' },
        ],
      },
      bufferDuration: {
        label: 'バッファサイズ (秒)',
        type: 'range',
        min: 5,
        max: 60,
        step: 5,
      },
      sceneDetection: {
        label: 'シーン自動検出',
        type: 'boolean',
      },
    },
  },
  export: {
    label: 'エクスポート設定',
    settings: {
      quality: {
        label: '品質',
        type: 'range',
        min: 0.1,
        max: 1.0,
        step: 0.1,
        format: (v) => `${Math.round(v * 100)}%`,
      },
      frameSkip: {
        label: 'フレームスキップ',
        type: 'select',
        options: [
          { value: 1, label: 'なし (1)' },
          { value: 2, label: '2フレームごと' },
          { value: 3, label: '3フレームごと' },
          { value: 4, label: '4フレームごと' },
          { value: 5, label: '5フレームごと' },
        ],
      },
      playbackSpeed: {
        label: '再生速度',
        type: 'range',
        min: 0.25,
        max: 4.0,
        step: 0.25,
        format: (v) => `${v}x`,
      },
      dithering: {
        label: 'ディザリング',
        type: 'boolean',
      },
      loopCount: {
        label: 'ループ回数',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        format: (v) => (v === 0 ? '無限' : `${v}回`),
      },
      openInNewTab: {
        label: '新規タブで開く',
        type: 'boolean',
      },
      encoderPreset: {
        label: 'エンコーダープリセット',
        type: 'select',
        options: [
          { value: 'quality', label: '高品質' },
          { value: 'balanced', label: 'バランス' },
          { value: 'fast', label: '高速' },
        ],
      },
      encoderId: {
        label: 'エンコーダー',
        type: 'select',
        options: [
          { value: 'gifenc-js', label: 'gifenc-js' },
          { value: 'gifsicle-wasm', label: 'gifsicle-wasm' },
        ],
      },
    },
  },
  thumbnailQuality: {
    label: 'サムネイル品質',
    type: 'select',
    options: [
      { value: 'auto', label: '自動' },
      { value: 'low', label: '低' },
      { value: 'standard', label: '標準' },
      { value: 'high', label: '高' },
      { value: 'ultra', label: '最高' },
    ],
  },
};

/**
 * Load user settings from localStorage
 * @returns {UserSettings}
 */
export function loadSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_SETTINGS };
    }

    const parsed = JSON.parse(stored);

    // Merge with defaults to handle new settings added in updates
    return {
      capture: { ...DEFAULT_SETTINGS.capture, ...parsed.capture },
      export: { ...DEFAULT_SETTINGS.export, ...parsed.export },
      thumbnailQuality: parsed.thumbnailQuality || DEFAULT_SETTINGS.thumbnailQuality,
    };
  } catch (error) {
    console.error('Failed to load user settings:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save user settings to localStorage
 * @param {UserSettings} settings
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
  saveSettings({ ...DEFAULT_SETTINGS });
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
  return { ...DEFAULT_SETTINGS };
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
  listeners.forEach(callback => {
    try {
      callback(settings);
    } catch (error) {
      console.error('Settings change listener error:', error);
    }
  });
}
