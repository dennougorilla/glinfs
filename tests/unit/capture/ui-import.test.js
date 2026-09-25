import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initCaptureState } from '../../../src/features/capture/state.js';
import { renderCaptureScreen, updateImportStatus } from '../../../src/features/capture/ui.js';
import { IMPORT_ACCEPT_ATTRIBUTE } from '../../../src/features/import/core.js';

/**
 * Capture screen entry points for opening a GIF / image file: the button,
 * the hidden file input, drag-and-drop on the preview and the busy state.
 */

/**
 * @param {Partial<import('../../../src/features/capture/ui.js').CaptureUIHandlers>} [overrides]
 * @returns {import('../../../src/features/capture/ui.js').CaptureUIHandlers}
 */
function createHandlers(overrides = {}) {
  return {
    onStart: vi.fn(async () => {}),
    onStop: vi.fn(),
    onCreateClip: vi.fn(async () => false),
    onSettingsChange: vi.fn(),
    getSettings: vi.fn(() => null),
    onImportFile: vi.fn(),
    getImportStatus: vi.fn(() => null),
    ...overrides,
  };
}

/**
 * A drag event carrying files (jsdom has no DragEvent/DataTransfer)
 * @param {string} type
 * @param {File[]} files
 * @param {string[]} [types]
 */
function dragEvent(type, files = [], types = ['Files']) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' },
  });
  return event;
}

/** @type {HTMLElement} */
let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
});

describe('import controls', () => {
  it('renders the button and a hidden file input accepting the supported types', () => {
    renderCaptureScreen(container, initCaptureState(), createHandlers());

    const button = container.querySelector('.capture-import-btn');
    const input = /** @type {HTMLInputElement} */ (
      container.querySelector('[data-testid="import-file-input"]')
    );
    expect(button?.textContent).toBe('Open GIF or image');
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(input.type).toBe('file');
    expect(input.accept).toBe(IMPORT_ACCEPT_ATTRIBUTE);
    expect(container.querySelector('.capture-import-status')?.hasAttribute('hidden')).toBe(true);
  });

  it('is available while a screen is being shared too', () => {
    const state = { ...initCaptureState(), isSharing: true, stream: /** @type {any} */ ({}) };
    renderCaptureScreen(container, state, createHandlers());

    expect(container.querySelector('.btn-create-clip')).not.toBeNull();
    expect(container.querySelector('.capture-import-btn')).not.toBeNull();
  });

  it('mentions opening/dropping a GIF in the empty state', () => {
    renderCaptureScreen(container, initCaptureState(), createHandlers());
    expect(container.querySelector('.capture-import-hint')?.textContent).toContain(
      'drop a GIF here',
    );
  });

  it('renders no import controls without an import handler', () => {
    const handlers = createHandlers();
    delete handlers.onImportFile;
    renderCaptureScreen(container, initCaptureState(), handlers);

    expect(container.querySelector('.capture-import-btn')).toBeNull();
    expect(container.querySelector('.capture-import-hint')).toBeNull();
  });

  it('the button opens the file picker', () => {
    renderCaptureScreen(container, initCaptureState(), createHandlers());
    const input = /** @type {HTMLInputElement} */ (
      container.querySelector('[data-testid="import-file-input"]')
    );
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});

    /** @type {HTMLButtonElement} */ (container.querySelector('.capture-import-btn')).click();

    expect(click).toHaveBeenCalled();
  });

  it('choosing a file hands it to onImportFile', () => {
    const handlers = createHandlers();
    renderCaptureScreen(container, initCaptureState(), handlers);
    const input = /** @type {HTMLInputElement} */ (
      container.querySelector('[data-testid="import-file-input"]')
    );
    const file = new File(['x'], 'cat.gif', { type: 'image/gif' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    input.dispatchEvent(new Event('change'));

    expect(handlers.onImportFile).toHaveBeenCalledWith(file);
  });

  it('shows the busy label and disables the button while opening', () => {
    renderCaptureScreen(
      container,
      initCaptureState(),
      createHandlers({ getImportStatus: () => 'Opening cat.gif…' }),
    );

    const button = container.querySelector('.capture-import-btn');
    const status = container.querySelector('.capture-import-status');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(status?.hasAttribute('hidden')).toBe(false);
    expect(status?.textContent).toBe('Opening cat.gif…');
  });

  it('updateImportStatus toggles the busy state in place', () => {
    renderCaptureScreen(container, initCaptureState(), createHandlers());
    const button = container.querySelector('.capture-import-btn');
    const status = container.querySelector('.capture-import-status');

    updateImportStatus(container, 'Opening cat.gif… 50%');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(status?.textContent).toBe('Opening cat.gif… 50%');
    expect(status?.hasAttribute('hidden')).toBe(false);

    updateImportStatus(container, null);
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.hasAttribute('aria-busy')).toBe(false);
    expect(status?.hasAttribute('hidden')).toBe(true);
  });
});

describe('drag-and-drop onto the preview', () => {
  it('highlights while a file drag is over the panel and opens the dropped file', () => {
    const handlers = createHandlers();
    renderCaptureScreen(container, initCaptureState(), handlers);
    const panel = /** @type {HTMLElement} */ (container.querySelector('.capture-preview-panel'));
    const child = /** @type {HTMLElement} */ (panel.querySelector('.empty-state'));
    const file = new File(['x'], 'cat.gif', { type: 'image/gif' });

    const enter = dragEvent('dragenter');
    panel.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(panel.classList.contains('capture-import-dropzone--active')).toBe(true);

    // Crossing into a child: enter child, then leave the panel itself
    child.dispatchEvent(dragEvent('dragenter'));
    panel.dispatchEvent(dragEvent('dragleave'));
    expect(panel.classList.contains('capture-import-dropzone--active')).toBe(true);

    const over = dragEvent('dragover');
    panel.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = dragEvent('drop', [file]);
    child.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(panel.classList.contains('capture-import-dropzone--active')).toBe(false);
    expect(handlers.onImportFile).toHaveBeenCalledWith(file);
  });

  it('clears the highlight when the drag leaves', () => {
    renderCaptureScreen(container, initCaptureState(), createHandlers());
    const panel = /** @type {HTMLElement} */ (container.querySelector('.capture-preview-panel'));

    panel.dispatchEvent(dragEvent('dragenter'));
    panel.dispatchEvent(dragEvent('dragleave'));

    expect(panel.classList.contains('capture-import-dropzone--active')).toBe(false);
  });

  it('ignores drags that carry no files (text, links)', () => {
    const handlers = createHandlers();
    renderCaptureScreen(container, initCaptureState(), handlers);
    const panel = /** @type {HTMLElement} */ (container.querySelector('.capture-preview-panel'));

    const enter = dragEvent('dragenter', [], ['text/plain']);
    panel.dispatchEvent(enter);
    const drop = dragEvent('drop', [], ['text/plain']);
    panel.dispatchEvent(drop);

    expect(enter.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(panel.classList.contains('capture-import-dropzone--active')).toBe(false);
    expect(handlers.onImportFile).not.toHaveBeenCalled();
  });
});
