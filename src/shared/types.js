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

/**
 * Application version string injected at build time by Vite.
 * Defined in vite.config.js via `define: { __APP_VERSION__: ... }`
 * Usage: Use `/* global __APP_VERSION__ *\/` in files that reference it.
 * @global __APP_VERSION__
 */

// Export empty object for module resolution
export {};
