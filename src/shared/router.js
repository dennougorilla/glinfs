/**
 * Simple Hash-based Router
 * @module shared/router
 */

/**
 * @typedef {'/capture' | '/editor' | '/export'} Route
 */

/** @type {Map<string, () => void>} */
let routes = new Map();

/** @type {Set<(route: Route) => void>} */
const listeners = new Set();

/** @type {Route} */
let currentRoute = '/capture';

/**
 * Initialize router with route handlers
 * @param {Record<Route, () => void>} routeHandlers - Route handler map
 */
export function initRouter(routeHandlers) {
  routes = new Map(Object.entries(routeHandlers));

  // Listen for hash changes
  window.addEventListener('hashchange', handleHashChange);

  // Handle initial route
  handleHashChange();
}

/**
 * Handle hash change event
 */
function handleHashChange() {
  const hash = window.location.hash.slice(1) || '/capture';
  const route = /** @type {Route} */ (hash);

  if (routes.has(route)) {
    currentRoute = route;

    // Clear main content
    const main = document.getElementById('main-content');
    if (main) {
      main.innerHTML = '';
    }

    // Call route handler
    const handler = routes.get(route);
    if (handler) {
      handler();
    }

    // Notify listeners
    listeners.forEach((fn) => fn(route));
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
 * Subscribe to route changes
 * @param {(route: Route) => void} callback - Callback function
 * @returns {() => void} Unsubscribe function
 */
export function onRouteChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
