/**
 * Geometry Utilities
 * @module shared/utils/geometry
 */

/**
 * Get effective dimensions considering optional crop area
 * Returns crop dimensions if crop is provided, otherwise returns source dimensions
 *
 * @param {{ width: number, height: number }} source - Source dimensions (frame or image)
 * @param {{ width: number, height: number } | null} crop - Optional crop area
 * @returns {{ width: number, height: number }} Effective dimensions
 */
export function getEffectiveDimensions(source, crop) {
  if (crop) {
    return {
      width: crop.width,
      height: crop.height,
    };
  }
  return {
    width: source.width,
    height: source.height,
  };
}

/**
 * Fit dimensions within a maximum long-edge, preserving aspect ratio.
 *
 * Used to cap capture resolution at grab time: Retina displays hand
 * getDisplayMedia physical-resolution frames (~24 MB each as raw RGBA at
 * 3024x1964), which no GIF needs and which can exhaust system memory once
 * a ring buffer holds hundreds of them (#96).
 *
 * Never upscales. Results are rounded down to even numbers so downstream
 * encoders never see odd dimensions.
 *
 * @param {number} width - Source width in pixels
 * @param {number} height - Source height in pixels
 * @param {number} maxEdge - Maximum allowed long edge; 0 disables the limit
 * @returns {{ width: number, height: number, scaled: boolean }}
 */
export function fitWithinLongEdge(width, height, maxEdge) {
  const longEdge = Math.max(width, height);
  if (!maxEdge || longEdge <= maxEdge) {
    return { width, height, scaled: false };
  }

  const scale = maxEdge / longEdge;
  const even = (v) => Math.max(2, Math.floor((v * scale) / 2) * 2);
  return { width: even(width), height: even(height), scaled: true };
}
