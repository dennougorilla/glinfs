import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderClipEntries } from '../../../src/shared/clip-entries.js';

/** A queued clip that failed to open says so on its own row */
describe('clip entry after a failed open', () => {
  /** @type {HTMLElement} */
  let container;
  /** @type {(() => void)[]} */
  let cleanups = [];

  /** @param {Partial<import('../../../src/shared/app-store.js').ClipQueueEntry>} entry */
  function render(entry, onPromote = vi.fn()) {
    cleanups = renderClipEntries(container, {
      activeClip: null,
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
          ...entry,
        },
      ],
      onPromote,
      onDelete: vi.fn(),
    });
    return /** @type {HTMLElement} */ (container.querySelector('[data-testid="clip-entry"]'));
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="c"></div>';
    container = /** @type {HTMLElement} */ (document.getElementById('c'));
  });

  afterEach(() => {
    for (const fn of cleanups) fn();
    document.body.innerHTML = '';
  });

  it('shows "Couldn\'t open" on the row, without a spinner', () => {
    const row = render({ openFailed: true });
    expect(row.getAttribute('data-clip-open-failed')).toBe('true');
    const status = row.querySelector('.clip-entry-status');
    expect(status?.textContent).toBe("Couldn't open");
    expect(status?.querySelector('.clip-entry-status-spinner')).toBeNull();
    expect(status?.querySelector('.clip-entry-status-alert')).not.toBeNull();
  });

  it('opens again when clicked', () => {
    const onPromote = vi.fn();
    const row = render({ openFailed: true }, onPromote);
    /** @type {HTMLButtonElement} */ (row.querySelector('button.clip-entry-main')).click();
    expect(onPromote).toHaveBeenCalledWith('clip-1');
  });

  it('shows nothing extra for a clip that opened or was never opened', () => {
    const row = render({ openFailed: false });
    expect(row.hasAttribute('data-clip-open-failed')).toBe(false);
    expect(row.querySelector('.clip-entry-status')).toBeNull();
  });

  it('shows "Opening…" again while a retry runs', () => {
    const row = render({ openFailed: false, status: 'decoding' });
    expect(row.querySelector('.clip-entry-status')?.textContent).toBe('Opening…');
  });
});
