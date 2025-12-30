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
 * @param {string} tag - HTML tag name
 * @param {Record<string, string>} [attrs={}] - Attributes
 * @param {(string|Element)[]} [children=[]] - Child elements or text
 * @returns {HTMLElement} Created element
 */
export function createElement(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      element.className = value;
    } else if (key.startsWith('data-')) {
      element.setAttribute(key, value);
    } else {
      element.setAttribute(key, value);
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

/**
 * @typedef {Object} CustomSelectOption
 * @property {string} value - Option value
 * @property {string} label - Display label
 */

/**
 * @typedef {Object} CustomSelectOptions
 * @property {CustomSelectOption[]} options - Available options
 * @property {string} value - Currently selected value
 * @property {(value: string) => void} onChange - Change handler
 * @property {boolean} [disabled] - Disabled state
 * @property {string} [ariaLabel] - Accessibility label
 */

/**
 * Create custom styled select dropdown with keyboard navigation
 * @param {CustomSelectOptions} config - Select configuration
 * @returns {HTMLElement} Custom select element
 */
export function createCustomSelect(config) {
  const { options, value, onChange, disabled = false, ariaLabel } = config;

  const container = createElement('div', { className: 'custom-select' });
  if (disabled) container.classList.add('custom-select--disabled');

  const button = createElement('button', {
    type: 'button',
    className: 'custom-select__trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  });
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (disabled) button.setAttribute('disabled', 'true');

  const selectedOption = options.find((o) => o.value === value);
  const valueDisplay = createElement(
    'span',
    { className: 'custom-select__value' },
    [selectedOption?.label || '']
  );
  const arrow = createElement('span', { className: 'custom-select__arrow' }, [
    '\u25BC',
  ]);

  button.appendChild(valueDisplay);
  button.appendChild(arrow);

  const dropdown = createElement('ul', {
    className: 'custom-select__dropdown',
    role: 'listbox',
    tabindex: '-1',
  });

  let isOpen = false;
  let focusedIndex = options.findIndex((o) => o.value === value);
  if (focusedIndex < 0) focusedIndex = 0;

  function renderOptions() {
    dropdown.innerHTML = '';
    options.forEach((option, index) => {
      const li = createElement(
        'li',
        {
          className: `custom-select__option${option.value === value ? ' custom-select__option--selected' : ''}`,
          role: 'option',
          'aria-selected': option.value === value ? 'true' : 'false',
          'data-value': option.value,
        },
        [option.label]
      );
      if (index === focusedIndex) li.classList.add('custom-select__option--focused');
      dropdown.appendChild(li);
    });
  }

  function openDropdown() {
    if (disabled) return;
    isOpen = true;
    button.setAttribute('aria-expanded', 'true');
    dropdown.classList.add('custom-select__dropdown--open');
    focusedIndex = options.findIndex((o) => o.value === value);
    if (focusedIndex < 0) focusedIndex = 0;
    renderOptions();
    dropdown.focus();
  }

  function closeDropdown() {
    isOpen = false;
    button.setAttribute('aria-expanded', 'false');
    dropdown.classList.remove('custom-select__dropdown--open');
    button.focus();
  }

  function selectOption(optionValue) {
    const opt = options.find((o) => o.value === optionValue);
    if (opt) {
      valueDisplay.textContent = opt.label;
      onChange(optionValue);
    }
    closeDropdown();
  }

  button.addEventListener('click', () => {
    if (isOpen) closeDropdown();
    else openDropdown();
  });

  button.addEventListener('keydown', (e) => {
    if (disabled) return;
    switch (e.key) {
      case 'Enter':
      case ' ':
      case 'ArrowDown':
        e.preventDefault();
        openDropdown();
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          closeDropdown();
        }
        break;
    }
  });

  dropdown.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusedIndex = Math.min(focusedIndex + 1, options.length - 1);
        renderOptions();
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusedIndex = Math.max(focusedIndex - 1, 0);
        renderOptions();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        selectOption(options[focusedIndex].value);
        break;
      case 'Escape':
        e.preventDefault();
        closeDropdown();
        break;
      case 'Tab':
        closeDropdown();
        break;
    }
  });

  dropdown.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const option = target.closest('[data-value]');
    if (option) {
      selectOption(/** @type {HTMLElement} */ (option).dataset.value || '');
    }
  });

  document.addEventListener('click', (e) => {
    if (isOpen && !container.contains(/** @type {Node} */ (e.target))) {
      closeDropdown();
    }
  });

  renderOptions();
  container.appendChild(button);
  container.appendChild(dropdown);

  return container;
}

/**
 * @typedef {Object} CustomSliderOptions
 * @property {number} min - Minimum value
 * @property {number} max - Maximum value
 * @property {number} step - Step increment
 * @property {number} value - Current value
 * @property {(value: number) => void} onChange - Change handler (fires on release)
 * @property {(value: number) => void} [onInput] - Real-time input handler
 * @property {boolean} [disabled] - Disabled state
 * @property {string} [ariaLabel] - Accessibility label
 * @property {boolean} [showValue] - Show value display
 * @property {(value: number) => string} [valueFormat] - Value formatter
 */

/**
 * Create custom styled slider with keyboard navigation
 * @param {CustomSliderOptions} config - Slider configuration
 * @returns {HTMLElement} Custom slider element
 */
export function createCustomSlider(config) {
  const {
    min,
    max,
    step,
    value,
    onChange,
    onInput,
    disabled = false,
    ariaLabel,
    showValue = true,
    valueFormat = (v) => String(v),
  } = config;

  const container = createElement('div', { className: 'custom-slider' });
  if (disabled) container.classList.add('custom-slider--disabled');

  const track = createElement('div', { className: 'custom-slider__track' });
  const fill = createElement('div', { className: 'custom-slider__fill' });
  const thumb = createElement('div', {
    className: 'custom-slider__thumb',
    role: 'slider',
    tabindex: disabled ? '-1' : '0',
    'aria-valuemin': String(min),
    'aria-valuemax': String(max),
    'aria-valuenow': String(value),
  });
  if (ariaLabel) thumb.setAttribute('aria-label', ariaLabel);

  let valueDisplay = null;
  if (showValue) {
    valueDisplay = createElement(
      'span',
      { className: 'custom-slider__value' },
      [valueFormat(value)]
    );
  }

  let currentValue = value;
  let isDragging = false;

  function updateVisuals(val) {
    const percent = ((val - min) / (max - min)) * 100;
    fill.style.width = `${percent}%`;
    thumb.style.left = `${percent}%`;
    thumb.setAttribute('aria-valuenow', String(val));
    if (valueDisplay) {
      valueDisplay.textContent = valueFormat(val);
    }
  }

  function clampValue(val) {
    const clamped = Math.min(max, Math.max(min, val));
    const stepped = Math.round(clamped / step) * step;
    return Math.min(max, Math.max(min, stepped));
  }

  function setValue(newValue, isFinal = false) {
    const clamped = clampValue(newValue);
    if (clamped !== currentValue) {
      currentValue = clamped;
      updateVisuals(currentValue);
      if (onInput) onInput(currentValue);
    }
    if (isFinal) {
      onChange(currentValue);
    }
  }

  function getValueFromEvent(e) {
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    return min + percent * (max - min);
  }

  track.addEventListener('mousedown', (e) => {
    if (disabled) return;
    e.preventDefault();
    isDragging = true;
    thumb.focus();
    setValue(getValueFromEvent(e));
  });

  thumb.addEventListener('mousedown', (e) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    thumb.focus();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    setValue(getValueFromEvent(e));
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      onChange(currentValue);
    }
  });

  thumb.addEventListener('keydown', (e) => {
    if (disabled) return;
    let newValue = currentValue;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        newValue = currentValue + step;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        newValue = currentValue - step;
        break;
      case 'Home':
        e.preventDefault();
        newValue = min;
        break;
      case 'End':
        e.preventDefault();
        newValue = max;
        break;
      case 'PageUp':
        e.preventDefault();
        newValue = currentValue + step * 10;
        break;
      case 'PageDown':
        e.preventDefault();
        newValue = currentValue - step * 10;
        break;
      default:
        return;
    }
    setValue(newValue, true);
  });

  updateVisuals(value);
  track.appendChild(fill);
  track.appendChild(thumb);
  container.appendChild(track);
  if (valueDisplay) {
    container.appendChild(valueDisplay);
  }

  // Expose method to update value programmatically
  /** @type {HTMLElement & { setValue: (v: number) => void }} */
  const element = /** @type {any} */ (container);
  element.setValue = (v) => {
    currentValue = clampValue(v);
    updateVisuals(currentValue);
  };

  return element;
}
