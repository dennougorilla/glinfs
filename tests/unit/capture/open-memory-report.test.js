import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/toast.js', () => ({ showToast: vi.fn(), hideToast: vi.fn() }));

import { reportOpenMemory } from '../../../src/features/capture/clip-service.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { showToast } from '../../../src/shared/toast.js';

/**
 * Opening a queued clip is checked against the memory budget (memory
 * accounting PR A); the user is told on the surfaces a new clip uses.
 */

const projection = { over: true, projectedMB: 4300, budgetMB: 4000, heldMB: 3400, incomingMB: 900 };

afterEach(() => {
  vi.clearAllMocks();
});

describe('reportOpenMemory', () => {
  it('names the numbers of a refused open, as a toast when no banner shows it', () => {
    const events = [];
    const off = onBus('clip:memory-budget', (payload) => events.push(payload));

    reportOpenMemory({ ok: false, reason: 'memory-budget', projection });

    expect(events).toHaveLength(1);
    expect(events[0].message).toMatch(
      /^In memory ~3\.4 GB \+ opened clip ~900 MB exceeds the 4\.0 GB budget/,
    );
    expect(showToast).toHaveBeenCalledWith(events[0].message);
    off();
  });

  it('shows no toast when the editor Clips banner claims the notice', () => {
    const off = onBus('clip:memory-budget', (payload) => payload.markShown());
    reportOpenMemory({ ok: false, reason: 'memory-budget', projection });
    expect(showToast).not.toHaveBeenCalled();
    off();
  });

  it('names the clips removed to make room', () => {
    const events = [];
    const off = onBus('clip:auto-removed', (payload) => events.push(payload));
    reportOpenMemory({
      ok: true,
      removed: [{ id: 'q1', capturedAt: 0, sourceName: 'wave.gif' }],
    });
    expect(events[0].message).toBe(
      'Memory budget reached — removed the oldest clip (wave.gif) to make room',
    );
    off();
  });

  it('says nothing for an open that needed no room, or failed for another reason', () => {
    const events = [];
    const offA = onBus('clip:memory-budget', (payload) => events.push(payload));
    const offB = onBus('clip:auto-removed', (payload) => events.push(payload));
    reportOpenMemory({ ok: true, removed: [] });
    reportOpenMemory({ ok: false, reason: 'decode-failed' });
    expect(events).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
    offA();
    offB();
  });
});
