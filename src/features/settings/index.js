/**
 * Settings Feature
 * User settings management and editing interface
 */

import { renderSettings } from './ui.js';
import { navigate } from '../../shared/router.js';

/**
 * Initialize settings screen
 * @param {HTMLElement} container
 * @returns {Function} Cleanup function
 */
export function initSettings(container) {
  const handlers = {
    onBack: () => {
      navigate('/capture');
    },
  };

  // Store handler for re-rendering
  container._onBack = handlers.onBack;

  return renderSettings(container, handlers);
}
