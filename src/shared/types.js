/**
 * Shared Type Definitions
 * @module shared/types
 */

/**
 * Validation result structure
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string[]} errors - List of error messages
 */

/**
 * Point coordinates
 * @typedef {Object} Point
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 */

/**
 * Rectangle
 * @typedef {Object} Rect
 * @property {number} x - Left offset
 * @property {number} y - Top offset
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * Dimensions
 * @typedef {Object} Dimensions
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * Cross-feature clip payload (capture -> editor)
 * @typedef {import('./app-store.js').ClipPayload} ClipPayload
 */

/**
 * Cross-feature editor payload (editor -> export)
 * @typedef {import('./app-store.js').EditorPayload} EditorPayload
 */

// Export empty object for module resolution
export {};
