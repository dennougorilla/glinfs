import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for #95: the Clip Now service and its global Shift+C hotkey.
 *
 * - clipNow() takes a non-stopping snapshot and enqueues it; the active
 *   clip and the mounted screen are never touched
 * - a full queue refuses BEFORE draining the worker's ring buffer
 * - a refusal after conversion closes the orphaned frames (they never
 *   entered the store, so the service still owns them)
 * - the hotkey is exactly Shift+C, inert in form fields and without a
 *   live capture session
 */

const captureContext = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));

vi.mock('../../../src/features/capture/index.js', () => ({
  getLiveCaptureContext: vi.fn(() => captureContext.current),
  // Pass-through conversion: each "bitmap" item becomes a mock Frame
  convertBitmapFramesToVideoFrames: vi.fn((items) =>
    items.map((_item, i) => ({
      id: String(i),
      frame: { close: vi.fn(), closed: false },
      timestamp: i,
      width: 100,
      height: 100,
    })),
  ),
}));

import {
  clipNow,
  handleClipNowHotkey,
  isCaptureLive,
} from '../../../src/features/capture/clip-service.js';
import { convertBitmapFramesToVideoFrames } from '../../../src/features/capture/index.js';
import { enqueueClip, getClipQueue, resetAppStore } from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

function createMockFrames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    frame: { close: vi.fn(), closed: false },
    timestamp: i,
    width: 100,
    height: 100,
  }));
}

/** Install a fake live capture session with `count` buffered bitmaps */
function installLiveCapture(count = 3) {
  const workerManager = {
    requestFrames: vi.fn().mockResolvedValue(Array.from({ length: count }, (_, i) => ({ i }))),
  };
  captureContext.current = { workerManager, fps: 30, sceneDetection: false };
  return workerManager;
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  captureContext.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('isCaptureLive', () => {
  it('reflects whether a live capture context exists', () => {
    expect(isCaptureLive()).toBe(false);
    installLiveCapture();
    expect(isCaptureLive()).toBe(true);
  });
});

describe('clipNow', () => {
  it('refuses without a live capture session', async () => {
    const result = await clipNow();
    expect(result).toEqual({ ok: false, reason: 'no-capture' });
    expect(getClipQueue()).toHaveLength(0);
  });

  it('snapshots the buffer and enqueues a clip, announcing on the bus', async () => {
    const workerManager = installLiveCapture(4);
    const queued = [];
    const unsubscribe = onBus('clip:queued', (payload) => queued.push(payload));

    const result = await clipNow();

    expect(result.ok).toBe(true);
    expect(workerManager.requestFrames).toHaveBeenCalledTimes(1);
    const queue = getClipQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].frames).toHaveLength(4);
    expect(queue[0].fps).toBe(30);
    expect(queued).toEqual([expect.objectContaining({ queueLength: 1, limit: 3 })]);

    unsubscribe();
  });

  it('refuses at the queue limit BEFORE draining the ring buffer', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueClip({ frames: createMockFrames(1), fps: 30, capturedAt: Date.now() });
    const workerManager = installLiveCapture();

    const fullEvents = [];
    const unsubscribe = onBus('clip:queue-full', (payload) => fullEvents.push(payload));

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'queue-full' });
    // The buffered frames were never pulled — the snapshot is not wasted
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
    expect(fullEvents).toEqual([{ limit: 1 }]);
    expect(getClipQueue()).toHaveLength(1);

    unsubscribe();
  });

  it('closes converted frames when the enqueue itself is refused (race to full)', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    installLiveCapture(2);

    // Fill the queue AFTER the early check runs: intercept requestFrames
    const workerManager = captureContext.current.workerManager;
    workerManager.requestFrames.mockImplementation(async () => {
      enqueueClip({ frames: createMockFrames(1), fps: 30, capturedAt: Date.now() });
      return [{ i: 0 }, { i: 1 }];
    });

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'queue-full' });
    // The refused frames (returned by the conversion mock) were closed
    const converted = vi.mocked(convertBitmapFramesToVideoFrames).mock.results[0].value;
    for (const frame of converted) {
      expect(frame.frame.close).toHaveBeenCalledOnce();
    }
    expect(getClipQueue()).toHaveLength(1);
  });

  it('returns no-frames when the buffer is empty, without enqueuing', async () => {
    installLiveCapture(0);

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'no-frames' });
    expect(getClipQueue()).toHaveLength(0);
  });
});

describe('memory budget refusal (#96)', () => {
  /** Live capture whose buffer projects to frameCount x 100x100 RGBA */
  function installLiveCaptureWithStats(frameCount, dims = { width: 100, height: 100 }) {
    const workerManager = {
      requestFrames: vi.fn().mockResolvedValue([{ i: 0 }]),
      getEffectiveFrameDimensions: vi.fn(() => ({ ...dims, scaled: false })),
    };
    captureContext.current = {
      workerManager,
      fps: 30,
      sceneDetection: false,
      stats: { frameCount, fps: 30 },
    };
    return workerManager;
  }

  it('refuses BEFORE draining the buffer when the projection exceeds the budget', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    // 20000 frames x 100*100*4 bytes = ~763 MB projected > 500 MB budget
    const workerManager = installLiveCaptureWithStats(20000);

    const events = [];
    const unsubscribe = onBus('clip:memory-budget', (payload) => events.push(payload));

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'memory-budget' });
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
    expect(getClipQueue()).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].projectedMB).toBeGreaterThan(events[0].budgetMB);

    unsubscribe();
  });

  it('counts frames already held (active + queue) against the budget', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    // Held: 3000 frames x 200x200 RGBA = ~457 MB; incoming: 2000 x 100x100 = ~76 MB
    enqueueClip({
      frames: Array.from({ length: 3000 }, (_, i) => ({
        id: String(i),
        frame: { close: vi.fn(), closed: false },
        timestamp: i,
        width: 200,
        height: 200,
      })),
      fps: 30,
      capturedAt: Date.now(),
    });
    const workerManager = installLiveCaptureWithStats(2000);

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'memory-budget' });
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });

  it('allows the clip when the projection fits the budget', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    // 100 frames x 100x100 RGBA = ~3.8 MB, well under budget
    installLiveCaptureWithStats(100);

    const result = await clipNow();

    expect(result.ok).toBe(true);
    expect(getClipQueue()).toHaveLength(1);
  });
});

describe('handleClipNowHotkey (Shift+C guard)', () => {
  function keyEvent(overrides = {}) {
    return {
      key: 'C',
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
  }

  it('fires clipNow on a bare Shift+C with a live capture', () => {
    const workerManager = installLiveCapture();
    const e = keyEvent();

    handleClipNowHotkey(/** @type {any} */ (e));

    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(workerManager.requestFrames).toHaveBeenCalledTimes(1);
  });

  it('is inert without a live capture session', () => {
    const e = keyEvent();

    handleClipNowHotkey(/** @type {any} */ (e));

    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores modified combos (Ctrl/Cmd/Alt) and other keys', () => {
    const workerManager = installLiveCapture();

    for (const overrides of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: false, key: 'c' },
      { key: 'G' },
    ]) {
      const e = keyEvent(overrides);
      handleClipNowHotkey(/** @type {any} */ (e));
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });

  it('is inert while focus is in a form control', () => {
    const workerManager = installLiveCapture();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const e = keyEvent();
    handleClipNowHotkey(/** @type {any} */ (e));

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });
});
