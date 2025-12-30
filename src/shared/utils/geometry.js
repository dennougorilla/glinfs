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
