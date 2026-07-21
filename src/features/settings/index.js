/**
 * Settings Feature
 * User settings management and editing interface
 */

import { getPreviousRoute, navigate } from '../../shared/router.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { renderSettings } from './ui.js';

/**
 * Route to return to when the previous route can't be used as a back
 * target (unknown, or Settings itself via a stale/duplicate entry).
 * @type {import('../../shared/router.js').Route}
 */
const FALLBACK_BACK_ROUTE = '/capture';

/**
 * Initialize settings screen
 * Called by the router with no arguments; fetches its own container
 * like the other features.
 * @returns {Function} Cleanup function
 */
export function initSettings() {
  const container = qsRequired('#main-content');

  // Settings is reachable from any screen via the header gear, so "back"
  // should return to wherever the user actually came from rather than a
  // hardcoded destination. Captured once at mount time since navigating
  // away from settings would otherwise change what getPreviousRoute()
  // reports before onBack runs.
  const previousRoute = getPreviousRoute();
  const backRoute =
    previousRoute && previousRoute !== '/settings' ? previousRoute : FALLBACK_BACK_ROUTE;

  const handlers = {
    onBack: () => {
      navigate(backRoute);
    },
  };

  return renderSettings(container, handlers);
}
