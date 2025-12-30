/**
 * Event Bus for Cross-Feature Communication
 * @module shared/bus
 */

/**
 * @typedef {Object} EventBus
 * @property {(event: string, payload?: any) => void} emit - Emit event
 * @property {(event: string, handler: (payload: any) => void) => () => void} on - Subscribe to event
 * @property {(event: string, handler: (payload: any) => void) => void} once - Subscribe once
 * @property {(event: string) => void} off - Remove all listeners for event
 */

/** @type {Map<string, Set<(payload: any) => void>>} */
const listeners = new Map();

/**
 * Emit event to all listeners
 * @param {string} event - Event name
 * @param {any} [payload] - Event payload
 */
export function emit(event, payload) {
  const handlers = listeners.get(event);
  if (handlers) {
    handlers.forEach((fn) => {
      try {
        fn(payload);
      } catch (error) {
        console.error(`Error in event handler for "${event}":`, error);
      }
    });
  }
}

/**
 * Subscribe to event
 * @param {string} event - Event name
 * @param {(payload: any) => void} handler - Event handler
 * @returns {() => void} Unsubscribe function
 */
export function on(event, handler) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event).add(handler);

  return () => {
    const handlers = listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  };
}

/**
 * Subscribe to event once
 * @param {string} event - Event name
 * @param {(payload: any) => void} handler - Event handler
 */
export function once(event, handler) {
  const wrapper = (payload) => {
    off(event, wrapper);
    handler(payload);
  };
  on(event, wrapper);
}

/**
 * Remove specific handler from event
 * @param {string} event - Event name
 * @param {(payload: any) => void} handler - Handler to remove
 */
function off(event, handler) {
  const handlers = listeners.get(event);
  if (handlers) {
    handlers.delete(handler);
  }
}

/**
 * Remove all listeners for event
 * @param {string} event - Event name
 */
export function offAll(event) {
  listeners.delete(event);
}

/** @type {EventBus} */
export const bus = {
  emit,
  on,
  once,
  off: offAll,
};
