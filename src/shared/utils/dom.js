/**
 * DOM Utilities
 * @module shared/utils/dom
 */

/**
 * Query selector with type assertion
 * @template {Element} T
 * @param {string} selector - CSS selector
 * @param {Element|Document} [parent=document] - Parent element
 * @returns {T|null} Found element or null
 */
export function qs(selector, parent = document) {
  return /** @type {T|null} */ (parent.querySelector(selector));
}

/**
 * Query selector (throws if not found)
 * @template {Element} T
 * @param {string} selector - CSS selector
 * @param {Element|Document} [parent=document] - Parent element
 * @returns {T} Found element
 * @throws {Error} If element not found
 */
export function qsRequired(selector, parent = document) {
  const element = /** @type {T|null} */ (parent.querySelector(selector));
  if (!element) {
    throw new Error(`Required element not found: ${selector}`);
  }
  return element;
}

/**
 * Query selector all
 * @template {Element} T
 * @param {string} selector - CSS selector
 * @param {Element|Document} [parent=document] - Parent element
 * @returns {T[]} Array of found elements
 */
export function qsa(selector, parent = document) {
  return /** @type {T[]} */ ([...parent.querySelectorAll(selector)]);
}

/**
 * Create element with attributes and children
 *
 * Attributes whose value is `null`, `undefined`, or boolean `false` are
 * skipped entirely. This allows conditional attribute patterns like
 * `{ disabled: isDisabled ? 'true' : undefined }` — without the skip,
 * `setAttribute` would stringify `undefined` and boolean attributes such
 * as `disabled` would become enabled by mere presence.
 *
 * @param {string} tag - HTML tag name
 * @param {Record<string, string|boolean|null|undefined>} [attrs={}] - Attributes
 * @param {(string|Element)[]} [children=[]] - Child elements or text
 * @returns {HTMLElement} Created element
 */
export function createElement(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'className') {
      element.className = String(value);
    } else {
      element.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(child);
    }
  }

  return element;
}

/**
 * @typedef {Object} ErrorScreenAction
 * @property {string} label - Button label
 * @property {() => void} onClick - Click handler
 * @property {boolean} [primary] - Primary button style
 */

/**
 * @typedef {Object} ErrorScreenOptions
 * @property {string} title - Error title
 * @property {string} message - Error message
 * @property {ErrorScreenAction[]} [actions] - Action buttons
 * @property {string} [icon] - Error icon (default: ⚠️)
 */

/**
 * Create a standardized error screen component
 * @param {ErrorScreenOptions} options - Error screen configuration
 * @param {(() => void)[]} [cleanups] - Array to collect cleanup functions
 * @returns {HTMLElement} Error screen element
 */
export function createErrorScreen(options, cleanups = []) {
  const { title, message, actions = [], icon = '\u26A0\uFE0F' } = options;

  const container = createElement(
    'div',
    {
      className: 'error-screen',
      role: 'alert',
      'aria-live': 'assertive',
    },
    [
      createElement('div', { className: 'error-screen__icon' }, [icon]),
      createElement('h2', { className: 'error-screen__title' }, [title]),
      createElement('p', { className: 'error-screen__message' }, [message]),
    ],
  );

  if (actions.length > 0) {
    const actionsContainer = createElement('div', { className: 'error-screen__actions' });

    for (const action of actions) {
      const btn = createElement(
        'button',
        {
          type: 'button',
          className: action.primary ? 'btn btn-error' : 'btn btn-secondary',
        },
        [action.label],
      );

      cleanups.push(on(btn, 'click', action.onClick));
      actionsContainer.appendChild(btn);
    }

    container.appendChild(actionsContainer);
  }

  return container;
}

/**
 * Add event listener with cleanup
 * @param {Element|Document|Window} element - Target element
 * @param {string} event - Event name
 * @param {EventListener} handler - Event handler
 * @param {AddEventListenerOptions} [options] - Event options
 * @returns {() => void} Function to remove listener
 */
export function on(element, event, handler, options) {
  element.addEventListener(event, handler, options);
  return () => element.removeEventListener(event, handler, options);
}

/**
 * Set CSS custom property
 * @param {string} name - Property name (e.g., '--primary-color')
 * @param {string} value - Property value
 * @param {HTMLElement} [element=document.documentElement] - Target element
 */
export function setCssVar(name, value, element = document.documentElement) {
  element.style.setProperty(name, value);
}
