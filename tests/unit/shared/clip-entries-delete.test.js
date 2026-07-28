import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderClipEntries } from '../../../src/shared/clip-entries.js';

/**
 * #100 round 5: deletion is a SINGLE click on the trailing trash button —
 * safety comes from the app-store's deferred deletion + undo toast, not
 * from a confirm step. These tests pin the one-click contract and the
 * compact entry meta.
 */
describe('clip-entries single-click delete (#100 r5)', () => {
  /** @type {HTMLElement} */
  let container;
  /** @type {(() => void)[]} */
  let cleanups = [];
  /** @type {ReturnType<typeof vi.fn>} */
  let onDelete;
  /** @type {ReturnType<typeof vi.fn>} */
  let onDeleteActive;

  function renderEntries({ withActive = false } = {}) {
    onDelete = vi.fn();
    onDeleteActive = vi.fn();
    cleanups = renderClipEntries(container, {
      activeClip: withActive
        ? {
            id: 'active-1',
            frames: [],
            fps: 30,
            capturedAt: Date.now() + 1000,
            thumbnailDataUrl: null,
          }
        : null,
      queue: [
        {
          id: 'clip-1',
          frames: null,
          status: 'compressed',
          frameCount: 30,
          compressed: null,
          fps: 30,
          capturedAt: Date.now(),
          thumbnailDataUrl: null,
        },
      ],
      onDelete,
      onDeleteActive,
    });
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="c"></div>';
    container = /** @type {HTMLElement} */ (document.getElementById('c'));
  });

  afterEach(() => {
    cleanups.forEach((fn) => {
      fn();
    });
    document.body.innerHTML = '';
  });

  it('a single click deletes a queued entry immediately (undo covers safety)', () => {
    renderEntries();
    const btn = /** @type {HTMLButtonElement} */ (container.querySelector('.clip-entry-delete'));

    btn.click();

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('clip-1');
  });

  it('the delete button is a trash icon, not text', () => {
    renderEntries();
    const btn = container.querySelector('.clip-entry-delete');
    expect(btn?.querySelector('svg')).not.toBeNull();
    expect(btn?.textContent).toBe('');
  });

  it('the active entry deletes with a single click through onDeleteActive', () => {
    renderEntries({ withActive: true });
    const btn = /** @type {HTMLButtonElement} */ (
      container.querySelector('[data-testid="delete-active-clip"]')
    );

    btn.click();

    expect(onDeleteActive).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('renders the compact single-line meta with the full detail as tooltip', () => {
    renderEntries();
    const meta = container.querySelector('.clip-entry-meta');
    const info = container.querySelector('.clip-entry-info');

    expect(meta?.textContent).toMatch(/^1\.0s · 30f · \d{2}:\d{2}/);
    expect(info?.getAttribute('title')).toContain('30 frames');
  });
});
