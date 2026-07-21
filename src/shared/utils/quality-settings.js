/**
 * Quality Settings - Device-adaptive thumbnail quality
 * @module shared/utils/quality-settings
 */

// user-settings.js has no dependency on this module (verified: it does not
// import quality-settings.js), so this static import cannot form a cycle.
import { loadSettings } from '../user-settings.js';

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

/**
 * Detect device memory in GB
 * @returns {number} Device memory in GB (defaults to 4 if unavailable)
 */
function getDeviceMemory() {
  // @ts-expect-error - navigator.deviceMemory is Chrome-only
  return navigator.deviceMemory || 4;
}

/**
 * Get quality preset based on device specs
 * The settings screen's preference (stored in the `glinfs_user_settings` blob
 * and read via user-settings.js's loadSettings()) takes priority over
 * auto-detection. 'auto' (the default) and any legacy raw-key preference
 * fall through to auto-detection.
 * @returns {QualityPreset}
 */
export function getQualityPreset() {
  // The settings screen's preference (user-settings blob) is the single
  // source of truth. 'auto' — the default — means device auto-detection.
  // There is deliberately no fallback to the old raw 'thumbnailQuality'
  // localStorage key: nothing ever wrote it (its writer had zero callers),
  // and honoring it would let a stale value override an explicit Auto.
  try {
    const { thumbnailQuality } = loadSettings();
    if (thumbnailQuality && thumbnailQuality in QUALITY_PRESETS) {
      return /** @type {QualityPreset} */ (thumbnailQuality);
    }
  } catch {
    // user-settings/localStorage may be unavailable
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
 * Get all available presets with their configurations
 * @returns {Record<QualityPreset, ThumbnailSizes>}
 */
export function getAvailablePresets() {
  return { ...QUALITY_PRESETS };
}
