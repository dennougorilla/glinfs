import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderClipEntries } from '../../../src/shared/clip-entries.js';

/**
 * #98: queue-entry deletion uses an inline two-step control instead of
 * window.confirm — first click arms ("Delete?"), a second click within 3s
 * deletes, timeout or blur reverts. These tests pin that contract.
 */
describe('clip-entries inline two-step delete (#98)', () => {
  /** @type {HTMLElement} */
  let container;
  /** @type {(() => void)[]} */
  let cleanups = [];
  /** @type {ReturnType<typeof vi.fn>} */
  let onDelete;

  function renderOneEntry() {
    onDelete = vi.fn();
    cleanups = renderClipEntries(container, {
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
    });
    return /** @type {HTMLButtonElement} */ (container.querySelector('.clip-entry-delete'));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="c"></div>';
    container = /** @type {HTMLElement} */ (document.getElementById('c'));
  });

  afterEach(() => {
    cleanups.forEach((fn) => {
      fn();
    });
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first click arms instead of deleting', () => {
    const btn = renderOneEntry();

    btn.click();

    expect(onDelete).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('Delete?');
    expect(btn.classList.contains('clip-entry-delete--armed')).toBe(true);
    expect(btn.getAttribute('aria-label')).toMatch(/^Confirm delete/);
  });

  it('second click within the window deletes', () => {
    const btn = renderOneEntry();

    btn.click();
    vi.advanceTimersByTime(1000);
    btn.click();

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('clip-1');
  });

  it('reverts to idle after the 3s window with no delete', () => {
    const btn = renderOneEntry();

    btn.click();
    vi.advanceTimersByTime(3100);

    expect(onDelete).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('×');
    expect(btn.classList.contains('clip-entry-delete--armed')).toBe(false);

    // A click after the revert arms again rather than deleting
    btn.click();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('losing focus disarms', () => {
    const btn = renderOneEntry();

    btn.click();
    btn.dispatchEvent(new FocusEvent('blur'));

    expect(btn.textContent).toBe('×');
    btn.click();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('renders the compact single-line meta with the full detail as tooltip', () => {
    renderOneEntry();
    const meta = container.querySelector('.clip-entry-meta');
    const info = container.querySelector('.clip-entry-info');

    // "1.0s · 30f · HH:MM" — one line, frame count abbreviated
    expect(meta?.textContent).toMatch(/^1\.0s · 30f · \d{2}:\d{2}/);
    expect(info?.getAttribute('title')).toContain('30 frames');
  });
});
