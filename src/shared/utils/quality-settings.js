/**
 * Quality Settings - Device-adaptive thumbnail quality
 * @module shared/utils/quality-settings
 */

/**
 * @typedef {'low' | 'standard' | 'high' | 'ultra'} QualityPreset
 */

/**
 * @typedef {Object} ThumbnailSizes
 * @property {number} timeline - Timeline thumbnail max dimension (px)
 * @property {number} gridMax - FrameGrid maximum thumbnail size (px)
 * @property {number} gridDefault - FrameGrid default thumbnail size (px)
 * @property {number} gridMin - FrameGrid minimum thumbnail size (px)
 */

/** Quality preset configurations */
const QUALITY_PRESETS = {
  low: {
    timeline: 60,
    gridMax: 160,
    gridDefault: 80,
    gridMin: 40,
  },
  standard: {
    timeline: 80,
    gridMax: 240,
    gridDefault: 120,
    gridMin: 60,
  },
  high: {
    timeline: 120,
    gridMax: 320,
    gridDefault: 160,
    gridMin: 80,
  },
  ultra: {
    timeline: 160,
    gridMax: 400,
    gridDefault: 200,
    gridMin: 100,
  },
};

/** localStorage key for user preference */
const STORAGE_KEY = 'thumbnailQuality';

/**
 * Detect device memory in GB
 * @returns {number} Device memory in GB (defaults to 4 if unavailable)
 */
function getDeviceMemory() {
  // @ts-ignore - navigator.deviceMemory is Chrome-only
  return navigator.deviceMemory || 4;
}

/**
 * Get quality preset based on device specs
 * User preference in localStorage takes priority over auto-detection
 * @returns {QualityPreset}
 */
export function getQualityPreset() {
  // Check user preference first
  try {
    const userPref = localStorage.getItem(STORAGE_KEY);
    if (userPref && userPref in QUALITY_PRESETS) {
      return /** @type {QualityPreset} */ (userPref);
    }
  } catch {
    // localStorage may be unavailable (private browsing, etc.)
  }

  // Auto-detect based on device memory
  const memory = getDeviceMemory();

  if (memory <= 2) return 'low';
  if (memory <= 4) return 'standard';
  if (memory <= 8) return 'high';
  return 'ultra';
}

/**
 * Get thumbnail sizes for current quality preset
 * @param {QualityPreset} [preset] - Override preset (uses auto-detected if not provided)
 * @returns {ThumbnailSizes}
 */
export function getThumbnailSizes(preset) {
  const activePreset = preset || getQualityPreset();
  return QUALITY_PRESETS[activePreset] || QUALITY_PRESETS.standard;
}

/**
 * Set user's quality preference
 * @param {QualityPreset} preset - Desired quality preset
 */
export function setQualityPreset(preset) {
  if (!(preset in QUALITY_PRESETS)) {
    throw new Error(`Invalid quality preset: ${preset}`);
  }
  try {
    localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Clear user's quality preference (revert to auto-detection)
 */
export function clearQualityPreset() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Get all available presets with their configurations
 * @returns {Record<QualityPreset, ThumbnailSizes>}
 */
export function getAvailablePresets() {
  return { ...QUALITY_PRESETS };
}
