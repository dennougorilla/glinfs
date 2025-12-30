/**
 * Observable State Store
 * @module shared/store
 */

/**
 * @template T
 * @typedef {Object} Store
 * @property {() => T} getState - Get current state
 * @property {(updater: Partial<T> | ((state: T) => T)) => void} setState - Update state
 * @property {(listener: (state: T, prevState: T) => void) => () => void} subscribe - Subscribe to changes with previous state
 */

/**
 * Create a reactive store with immutable state updates
 * @template T
 * @param {T} initialState - Initial state
 * @returns {Store<T>} Store instance
 */
export function createStore(initialState) {
  /** @type {T} */
  let state = initialState;

  /** @type {Set<(state: T, prevState: T) => void>} */
  const listeners = new Set();

  /**
   * Get current state
   * @returns {T}
   */
  function getState() {
    return state;
  }

  /**
   * Update state (immutably)
   * @param {Partial<T> | ((state: T) => T)} updater
   */
  function setState(updater) {
    const prevState = state;
    const newState =
      typeof updater === 'function'
        ? /** @type {(state: T) => T} */ (updater)(state)
        : { ...state, ...updater };

    // Skip if no change (shallow comparison)
    if (newState === state) return;

    state = newState;

    // Notify listeners with current and previous state
    listeners.forEach((fn) => fn(state, prevState));
  }

  /**
   * Subscribe to state changes
   * @param {(state: T, prevState: T) => void} listener
   * @returns {() => void} Unsubscribe function
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}
