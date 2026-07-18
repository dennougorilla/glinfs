/**
 * Simple Hash-based Router
 * @module shared/router
 */

/**
 * @typedef {'/capture' | '/editor' | '/export' | '/loading' | '/settings'} Route
 */

/** @type {Map<string, () => (() => void) | void>} */
let routes = new Map();

/** @type {Set<(route: Route) => void>} */
const listeners = new Set();

/** @type {Route} */
let currentRoute = '/capture';

/** @type {(() => void) | null} */
let currentCleanup = null;

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
  // Route matching is based on the path only. `navigate()` may append query
  // parameters, which must not turn an otherwise valid route into a 404.
  const [path] = hash.split('?');
  const route = /** @type {Route} */ (path);

  if (routes.has(route)) {
    // Call cleanup from previous route before switching
    // Pass target route so cleanup can decide whether to pause or fully cleanup
    if (currentCleanup) {
      try {
        currentCleanup(route);
      } catch (error) {
        // Cleanup failures must not block navigation, but hiding them entirely
        // makes lifecycle/resource leaks almost impossible to diagnose.
        console.error(`[Router] Failed to clean up route "${currentRoute}":`, error);
      }
      currentCleanup = null;
    }

    currentRoute = route;

    // Clear main content
    const main = document.getElementById('main-content');
    if (main) {
      // Feature screens may apply route-specific classes (for example the
      // Settings screen). Reset them before mounting the next route.
      main.className = '';
      main.innerHTML = '';
    }

    // Call route handler and store cleanup function
    const handler = routes.get(route);
    if (handler) {
      try {
        const cleanup = handler();
        if (typeof cleanup === 'function') {
          currentCleanup = cleanup;
        }
      } catch (error) {
        console.error(`[Router] Failed to initialize route "${route}":`, error);

        // Recover to the known entry screen. If that screen itself fails,
        // render a stable error instead of creating a redirect loop.
        if (route !== '/capture') {
          navigate('/capture');
          return;
        }

        if (main) {
          main.textContent = 'Unable to load the application. Please reload the page.';
        }
        return;
      }
    }

    // Notify listeners
    listeners.forEach((fn) => {
      try {
        fn(route);
      } catch (error) {
        console.error(`[Router] Route listener failed for "${route}":`, error);
      }
    });
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
