/**
 * Performance Utilities
 * @module shared/utils/performance
 */

/**
 * Get memory usage estimate (if available)
 * @returns {number|null} Bytes or null if not supported
 */
export function getMemoryUsage() {
  // @ts-ignore - performance.memory is non-standard Chrome API
  if (performance.memory) {
    // @ts-ignore
    return performance.memory.usedJSHeapSize;
  }
  return null;
}

/**
 * Request idle callback with fallback
 * @param {() => void} callback - Callback function
 * @param {{ timeout?: number }} [options] - Options
 * @returns {number} Handle for cancellation
 */
export function requestIdleCallback(callback, options) {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, options);
  }
  // Fallback to setTimeout
  return window.setTimeout(callback, options?.timeout ?? 1);
}

/**
 * Cancel idle callback
 * @param {number} handle - Handle from requestIdleCallback
 */
export function cancelIdleCallback(handle) {
  if ('cancelIdleCallback' in window) {
    window.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

/**
 * @typedef {Function & { cancel: () => void }} ThrottledFunction
 */

/**
 * Throttle function calls
 * @template {(...args: any[]) => any} T
 * @param {T} fn - Function to throttle
 * @param {number} ms - Minimum interval in milliseconds
 * @returns {T & { cancel: () => void }} Throttled function with cancel method
 */
export function throttle(fn, ms) {
  let lastCall = 0;
  let timeoutId = null;

  const throttled = function (...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= ms) {
      lastCall = now;
      fn.apply(this, args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn.apply(this, args);
      }, ms - timeSinceLastCall);
    }
  };

  // Cancel any pending throttled call
  throttled.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return /** @type {T & { cancel: () => void }} */ (throttled);
}

/**
 * Debounce function calls
 * @template {(...args: any[]) => any} T
 * @param {T} fn - Function to debounce
 * @param {number} ms - Delay in milliseconds
 * @returns {T} Debounced function
 */
export function debounce(fn, ms) {
  let timeoutId = null;

  return /** @type {T} */ (
    function (...args) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        timeoutId = null;
        fn.apply(this, args);
      }, ms);
    }
  );
}
