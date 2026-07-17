/**
 * Simple Hash-based Router
 * @module shared/router
 */

/**
 * @typedef {'/capture' | '/editor' | '/export' | '/loading' | '/settings'} Route
 */

/**
 * Cleanup returned by a route handler. Receives the route being navigated to
 * so features can decide between pausing and full teardown.
 * @typedef {(nextRoute: Route) => void} RouteCleanup
 */

/** @type {Map<string, () => RouteCleanup | void>} */
let routes = new Map();

/** @type {Set<(route: Route) => void>} */
const listeners = new Set();

/** @type {Route} */
let currentRoute = '/capture';

/** @type {RouteCleanup | null} */
let currentCleanup = null;

/** @type {Record<string, string>} */
let currentParams = {};

/**
 * Last hash that was fully processed. Duplicate hashchange deliveries for
 * the same hash (the browser queues one event per mutation but the handler
 * reads the live hash) must not re-run the route handler — re-initializing
 * a feature twice tears down live UI mid-flight.
 * @type {string | null}
 */
let lastProcessedHash = null;

/** @type {boolean} */
let isListening = false;

/**
 * Initialize router with route handlers
 *
 * Safe to call again (e.g. in tests): the hashchange listener is only
 * registered once, and any previous route's cleanup is run first.
 * @param {Record<Route, () => RouteCleanup | void>} routeHandlers - Route handler map
 */
export function initRouter(routeHandlers) {
  routes = new Map(Object.entries(routeHandlers));

  // Re-initialization replaces the handler map; drop stale cleanup from
  // the previous handler set so it can't touch the new routes' DOM, and
  // force the current hash to be processed against the new handlers.
  currentCleanup = null;
  lastProcessedHash = null;

  // Listen for hash changes (once — repeated init must not stack listeners)
  if (!isListening) {
    window.addEventListener('hashchange', handleHashChange);
    isListening = true;
  }

  // Handle initial route
  handleHashChange();
}

/**
 * Handle hash change event
 */
function handleHashChange() {
  const hash = window.location.hash.slice(1) || '/capture';

  // Skip duplicate deliveries for a hash that was already processed
  if (hash === lastProcessedHash) return;

  // Separate the route path from optional query params so that
  // navigate('/editor', {x: '1'}) ('#/editor?x=1') still matches '/editor'.
  const queryIndex = hash.indexOf('?');
  const path = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const route = /** @type {Route} */ (path);

  if (routes.has(route)) {
    lastProcessedHash = hash;
    currentParams =
      queryIndex === -1 ? {} : Object.fromEntries(new URLSearchParams(hash.slice(queryIndex + 1)));

    // Call cleanup from previous route before switching
    // Pass target route so cleanup can decide whether to pause or fully cleanup
    if (currentCleanup) {
      try {
        currentCleanup(route);
      } catch (error) {
        console.error(`[router] Cleanup error while leaving ${currentRoute}:`, error);
      }
      currentCleanup = null;
    }

    currentRoute = route;

    // Clear main content
    const main = document.getElementById('main-content');
    if (main) {
      main.innerHTML = '';
    }

    // Call route handler and store cleanup function
    const handler = routes.get(route);
    if (handler) {
      const cleanup = handler();
      if (typeof cleanup === 'function') {
        currentCleanup = cleanup;
      }
    }

    // Notify listeners, isolating exceptions so one failing listener
    // cannot block the rest or break the navigation itself.
    for (const fn of listeners) {
      try {
        fn(route);
      } catch (error) {
        console.error('[router] Route listener error:', error);
      }
    }
  } else {
    // Fallback to capture
    navigate('/capture');
  }
}

/**
 * Navigate to route
 * @param {Route} route - Target route
 * @param {Record<string, string>} [params] - Optional query params
 */
export function navigate(route, params) {
  let hash = route;
  if (params) {
    const query = new URLSearchParams(params).toString();
    hash = `${route}?${query}`;
  }
  window.location.hash = hash;
}

/**
 * Get current route
 * @returns {Route} Current route
 */
export function getCurrentRoute() {
  return currentRoute;
}

/**
 * Get query params of the current route (e.g. from '#/editor?frame=5')
 * @returns {Record<string, string>}
 */
export function getRouteParams() {
  return { ...currentParams };
}

/**
 * Subscribe to route changes
 * @param {(route: Route) => void} callback - Callback function
 * @returns {() => void} Unsubscribe function
 */
export function onRouteChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
