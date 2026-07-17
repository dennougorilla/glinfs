/**
 * Settings Feature
 * User settings management and editing interface
 */

import { navigate } from '../../shared/router.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { renderSettings } from './ui.js';

/**
 * Initialize settings screen
 * Called by the router with no arguments; fetches its own container
 * like the other features.
 * @returns {Function} Cleanup function
 */
export function initSettings() {
  const container = qsRequired('#main-content');

  const handlers = {
    onBack: () => {
      navigate('/capture');
    },
  };

  return renderSettings(container, handlers);
}
