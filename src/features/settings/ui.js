/**
 * Settings UI
 * Provides inline editing interface for all user settings
 */

import { createElement } from '../../shared/utils/dom.js';
import {
  loadSettings,
  updateSetting,
  resetSettings,
  resetCategory,
  SETTINGS_METADATA,
  getDefaultSettings,
} from '../../shared/user-settings.js';

/**
 * Render settings screen
 * @param {HTMLElement} container
 * @param {Object} handlers
 * @returns {Function} Cleanup function
 */
export function renderSettings(container, handlers = {}) {
  const { onBack = () => {} } = handlers;

  const settings = loadSettings();
  const cleanups = [];

  container.className = 'settings-container';
  container.innerHTML = '';

  // Header
  const header = createElement('div', { className: 'settings-header' });

  const backBtn = createElement('button', {
    className: 'btn btn-ghost',
    textContent: '← 戻る',
  });
  cleanups.push(() => backBtn.removeEventListener('click', onBack));
  backBtn.addEventListener('click', onBack);

  const title = createElement('h1', {
    className: 'settings-title',
    textContent: '設定',
  });

  const resetAllBtn = createElement('button', {
    className: 'btn btn-ghost',
    textContent: 'すべてリセット',
  });
  const handleResetAll = () => {
    if (confirm('すべての設定をデフォルト値にリセットしますか?')) {
      resetSettings();
      renderSettings(container, handlers);
    }
  };
  cleanups.push(() => resetAllBtn.removeEventListener('click', handleResetAll));
  resetAllBtn.addEventListener('click', handleResetAll);

  header.append(backBtn, title, resetAllBtn);

  // Settings content
  const content = createElement('div', { className: 'settings-content' });

  // Render capture settings
  const captureSection = renderSettingsCategory(
    'capture',
    SETTINGS_METADATA.capture.label,
    settings.capture,
    SETTINGS_METADATA.capture.settings,
    cleanups
  );
  content.appendChild(captureSection);

  // Render export settings
  const exportSection = renderSettingsCategory(
    'export',
    SETTINGS_METADATA.export.label,
    settings.export,
    SETTINGS_METADATA.export.settings,
    cleanups
  );
  content.appendChild(exportSection);

  // Render thumbnail quality setting
  const thumbnailSection = renderThumbnailQualitySetting(
    settings.thumbnailQuality,
    cleanups
  );
  content.appendChild(thumbnailSection);

  container.append(header, content);

  return () => {
    cleanups.forEach(cleanup => cleanup());
  };
}

/**
 * Render a settings category section
 * @param {string} category
 * @param {string} label
 * @param {Object} values
 * @param {Object} metadata
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderSettingsCategory(category, label, values, metadata, cleanups) {
  const section = createElement('div', { className: 'settings-section' });

  const header = createElement('div', { className: 'settings-section-header' });
  const titleEl = createElement('h2', {
    className: 'settings-section-title',
    textContent: label,
  });

  const resetBtn = createElement('button', {
    className: 'btn btn-ghost btn-sm',
    textContent: 'リセット',
  });
  const handleReset = () => {
    if (confirm(`${label}をデフォルト値にリセットしますか?`)) {
      resetCategory(category);
      const container = section.closest('.settings-container');
      const handlers = { onBack: container._onBack };
      renderSettings(container, handlers);
    }
  };
  cleanups.push(() => resetBtn.removeEventListener('click', handleReset));
  resetBtn.addEventListener('click', handleReset);

  header.append(titleEl, resetBtn);

  const list = createElement('div', { className: 'settings-list' });

  Object.entries(metadata).forEach(([key, meta]) => {
    const value = values[key];
    const item = renderSettingItem(category, key, value, meta, cleanups);
    list.appendChild(item);
  });

  section.append(header, list);
  return section;
}

/**
 * Render thumbnail quality setting
 * @param {string} value
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderThumbnailQualitySetting(value, cleanups) {
  const section = createElement('div', { className: 'settings-section' });

  const header = createElement('div', { className: 'settings-section-header' });
  const titleEl = createElement('h2', {
    className: 'settings-section-title',
    textContent: 'その他',
  });
  header.appendChild(titleEl);

  const list = createElement('div', { className: 'settings-list' });

  const item = renderSettingItem(
    'thumbnailQuality',
    null,
    value,
    SETTINGS_METADATA.thumbnailQuality,
    cleanups
  );
  list.appendChild(item);

  section.append(header, list);
  return section;
}

/**
 * Render a single setting item
 * @param {string} category
 * @param {string|null} key
 * @param {any} value
 * @param {Object} metadata
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderSettingItem(category, key, value, metadata, cleanups) {
  const item = createElement('div', { className: 'settings-item' });

  const labelEl = createElement('label', {
    className: 'settings-item-label',
    textContent: metadata.label,
  });

  const control = renderSettingControl(
    category,
    key,
    value,
    metadata,
    cleanups
  );

  item.append(labelEl, control);
  return item;
}

/**
 * Render setting control based on type
 * @param {string} category
 * @param {string|null} key
 * @param {any} value
 * @param {Object} metadata
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderSettingControl(category, key, value, metadata, cleanups) {
  const { type } = metadata;

  const handleChange = (newValue) => {
    if (key === null) {
      updateSetting(category, null, newValue);
    } else {
      updateSetting(category, key, newValue);
    }
  };

  switch (type) {
    case 'boolean':
      return renderBooleanControl(value, handleChange, cleanups);

    case 'select':
      return renderSelectControl(
        value,
        metadata.options,
        handleChange,
        cleanups
      );

    case 'range':
      return renderRangeControl(value, metadata, handleChange, cleanups);

    case 'number':
      return renderNumberControl(value, metadata, handleChange, cleanups);

    default:
      return createElement('span', { textContent: String(value) });
  }
}

/**
 * Render boolean toggle control
 * @param {boolean} value
 * @param {Function} onChange
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderBooleanControl(value, onChange, cleanups) {
  const control = createElement('div', { className: 'settings-control' });

  const toggle = createElement('button', {
    className: `btn-toggle ${value ? 'active' : ''}`,
    textContent: value ? 'ON' : 'OFF',
  });

  const handleClick = () => {
    const newValue = !value;
    toggle.className = `btn-toggle ${newValue ? 'active' : ''}`;
    toggle.textContent = newValue ? 'ON' : 'OFF';
    onChange(newValue);
  };

  cleanups.push(() => toggle.removeEventListener('click', handleClick));
  toggle.addEventListener('click', handleClick);

  control.appendChild(toggle);
  return control;
}

/**
 * Render select control
 * @param {any} value
 * @param {Array} options
 * @param {Function} onChange
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderSelectControl(value, options, onChange, cleanups) {
  const control = createElement('div', { className: 'settings-control' });

  const select = createElement('select', { className: 'settings-select' });

  options.forEach(option => {
    const optionEl = createElement('option', {
      value: option.value,
      textContent: option.label,
      selected: option.value === value,
    });
    select.appendChild(optionEl);
  });

  const handleChange = (e) => {
    const option = options.find(o => String(o.value) === e.target.value);
    if (option) {
      onChange(option.value);
    }
  };

  cleanups.push(() => select.removeEventListener('change', handleChange));
  select.addEventListener('change', handleChange);

  control.appendChild(select);
  return control;
}

/**
 * Render range slider control
 * @param {number} value
 * @param {Object} metadata
 * @param {Function} onChange
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderRangeControl(value, metadata, onChange, cleanups) {
  const { min, max, step, format } = metadata;
  const control = createElement('div', { className: 'settings-control' });

  const wrapper = createElement('div', { className: 'settings-range-wrapper' });

  const input = createElement('input', {
    type: 'range',
    className: 'settings-range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });

  const valueDisplay = createElement('span', {
    className: 'settings-range-value',
    textContent: format ? format(value) : String(value),
  });

  const handleInput = (e) => {
    const newValue = parseFloat(e.target.value);
    valueDisplay.textContent = format ? format(newValue) : String(newValue);
    onChange(newValue);
  };

  cleanups.push(() => input.removeEventListener('input', handleInput));
  input.addEventListener('input', handleInput);

  wrapper.append(input, valueDisplay);
  control.appendChild(wrapper);
  return control;
}

/**
 * Render number input control
 * @param {number} value
 * @param {Object} metadata
 * @param {Function} onChange
 * @param {Array} cleanups
 * @returns {HTMLElement}
 */
function renderNumberControl(value, metadata, onChange, cleanups) {
  const { min, max, step, format } = metadata;
  const control = createElement('div', { className: 'settings-control' });

  const wrapper = createElement('div', { className: 'settings-number-wrapper' });

  const input = createElement('input', {
    type: 'number',
    className: 'settings-number',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });

  const display = createElement('span', {
    className: 'settings-number-display',
    textContent: format ? format(value) : String(value),
  });

  const handleChange = (e) => {
    const newValue = parseInt(e.target.value, 10);
    if (!isNaN(newValue) && newValue >= min && newValue <= max) {
      display.textContent = format ? format(newValue) : String(newValue);
      onChange(newValue);
    }
  };

  cleanups.push(() => input.removeEventListener('change', handleChange));
  input.addEventListener('change', handleChange);

  wrapper.append(input, display);
  control.appendChild(wrapper);
  return control;
}
