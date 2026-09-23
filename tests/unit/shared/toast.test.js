import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideToast, showToast } from '../../../src/shared/toast.js';

/**
 * Toast slots (#100 r5, #92 review): an action (Undo) toast and a passive
 * notice live side by side — a notice must never evict a pending Undo.
 */

const undoButton = () => document.querySelector('#toast-root .app-toast-action');
const toastTexts = () =>
  [...document.querySelectorAll('#toast-root .app-toast')].map((el) => el.textContent);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  hideToast();
  vi.useRealTimers();
});

describe('showToast', () => {
  it('a passive notice keeps a live Undo toast, its action and its deadline', () => {
    const onAction = vi.fn();
    showToast('Clip deleted', { actionLabel: 'Undo', onAction });
    vi.advanceTimersByTime(2000);
    showToast('A queued clip was lost');

    expect(toastTexts()).toEqual(['Clip deletedUndo', 'A queued clip was lost']);
    expect(undoButton()).not.toBeNull();

    // The Undo toast expires on its ORIGINAL 5s deadline, not reset by the notice
    vi.advanceTimersByTime(2999);
    expect(undoButton()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(undoButton()).toBeNull();
    expect(toastTexts()).toEqual(['A queued clip was lost']);

    // ...and the notice runs its own 5s
    vi.advanceTimersByTime(2000);
    expect(toastTexts()).toEqual([]);
    expect(document.getElementById('toast-root')?.hidden).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('Undo still fires after a notice arrived, and removes only the Undo toast', () => {
    const onAction = vi.fn();
    showToast('Clip deleted', { actionLabel: 'Undo', onAction });
    showToast('A queued clip was lost');

    undoButton()?.click();

    expect(onAction).toHaveBeenCalledOnce();
    expect(toastTexts()).toEqual(['A queued clip was lost']);
  });

  it('a notice shown first is not evicted by a later Undo toast', () => {
    showToast('A queued clip was lost');
    showToast('Clip deleted', { actionLabel: 'Undo', onAction: vi.fn() });
    expect(toastTexts()).toEqual(['A queued clip was lost', 'Clip deletedUndo']);
  });

  it('a new Undo toast replaces the previous one (single-undo model)', () => {
    const first = vi.fn();
    showToast('Clip deleted', { actionLabel: 'Undo', onAction: first });
    showToast('Clip deleted', { actionLabel: 'Undo', onAction: vi.fn() });

    expect(document.querySelectorAll('#toast-root .app-toast-action')).toHaveLength(1);
    undoButton()?.click();
    expect(first).not.toHaveBeenCalled();
  });

  it('a new notice replaces the previous notice', () => {
    showToast('first');
    showToast('second');
    expect(toastTexts()).toEqual(['second']);
    expect(document.querySelector('#toast-root .app-toast')?.classList).toContain(
      'app-toast--notice',
    );
  });
});
