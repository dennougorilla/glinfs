import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for #95: the Clip Now service and its global Shift+C hotkey.
 *
 * - clipNow() takes a non-stopping snapshot and enqueues it; the active
 *   clip and the mounted screen are never touched
 * - a full queue refuses BEFORE draining the worker's ring buffer
 * - a refusal after conversion closes the orphaned frames (they never
 *   entered the store, so the service still owns them)
 * - the hotkey is exactly Shift+C, inert in form fields / contenteditable
 *   and without a live capture session, and stays live under a modal
 */

const captureContext = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));

vi.mock('../../../src/features/capture/index.js', () => ({
  getLiveCaptureContext: vi.fn(() => captureContext.current),
  // Pass-through conversion: each "bitmap" item becomes a mock Frame
  makeQueuedClipFrames: vi.fn((items) =>
    items.map((_item, i) => ({
      id: String(i),
      frame: { close: vi.fn(), closed: false },
      timestamp: i,
      width: 100,
      height: 100,
    })),
  ),
}));

// Clip frames are CPU I420 when the converter worker can run (D3); most
// tests here keep the RGBA numbers they were written with
const cpuFrames = vi.hoisted(() => ({ available: false }));
vi.mock('../../../src/workers/i420-converter.js', () => ({
  isCpuFrameConversionAvailable: vi.fn(() => cpuFrames.available),
}));

import {
  buildMemoryBudgetMessage,
  checkClipRoom,
  clipNow,
  isCaptureLive,
  projectClipMemory,
  registerClipNowHotkey,
} from '../../../src/features/capture/clip-service.js';
import {
  getLiveCaptureContext,
  makeQueuedClipFrames,
} from '../../../src/features/capture/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  RING_BUFFER_HOLDER,
  registerClipCodec,
  registerMemoryHolder,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { hideToast } from '../../../src/shared/toast.js';
import { loadSettings, updateSetting } from '../../../src/shared/user-settings.js';
import { BYTES_PER_MB } from '../../../src/shared/utils/memory-monitor.js';

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
  cpuFrames.available = false;
  // Drop one-shot implementations a refused test never consumed, so they
  // cannot leak into the next test (restores the pass-through conversion)
  vi.mocked(makeQueuedClipFrames).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  hideToast();
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
    // No codec registered => raw-fallback default limit (#92)
    expect(queued).toEqual([expect.objectContaining({ queueLength: 1, limit: 3 })]);

    unsubscribe();
  });

  it('refuses at the queue limit BEFORE draining the ring buffer (auto-remove off)', async () => {
    updateSetting('capture', 'autoRemoveOldClips', false);
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
    updateSetting('capture', 'autoRemoveOldClips', false);
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
    const converted = vi.mocked(makeQueuedClipFrames).mock.results[0].value;
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
    // Nothing is queued, so there is nothing automatic removal could free
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

  it('counts frames already held (active + queue) against the budget (auto-remove off)', async () => {
    updateSetting('capture', 'autoRemoveOldClips', false);
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

describe('automatic removal of the oldest clips (#186)', () => {
  const MB = BYTES_PER_MB;

  /** Frames of about `sizeMB` each (raw RGBA accounting) */
  function createSizedFrames(count, sizeMB) {
    const side = Math.round(Math.sqrt((sizeMB * MB) / 4));
    return Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      frame: { close: vi.fn(), closed: false },
      timestamp: i,
      width: side,
      height: side,
    }));
  }

  /** Enqueue a one-frame clip of about `sizeMB`; capturedAt orders them */
  function enqueueSized(sizeMB, capturedAt) {
    const result = enqueueClip({ frames: createSizedFrames(1, sizeMB), fps: 30, capturedAt });
    if (!result.ok) throw new Error('enqueue refused in test setup');
    return /** @type {NonNullable<typeof result.entry>} */ (result.entry);
  }

  /**
   * Live capture whose buffer projects to `frameCount` frames of 1 MB and
   * whose snapshot is `realCount` such frames (the conversion mock is
   * overridden once)
   */
  function installLiveCaptureOfMB(frameCount, realCount = frameCount) {
    const side = Math.round(Math.sqrt(MB / 4));
    const workerManager = {
      requestFrames: vi
        .fn()
        .mockResolvedValue(Array.from({ length: frameCount }, (_, i) => ({ i }))),
      getEffectiveFrameDimensions: vi.fn(() => ({ width: side, height: side, scaled: false })),
    };
    captureContext.current = {
      workerManager,
      fps: 30,
      sceneDetection: false,
      stats: { frameCount, fps: 30 },
    };
    vi.mocked(makeQueuedClipFrames).mockImplementationOnce(() => createSizedFrames(realCount, 1));
    return workerManager;
  }

  function collect(event) {
    const events = [];
    const off = onBus(event, (payload) => events.push(payload));
    return { events, off };
  }

  it('removes the oldest clip when the queue is full, then enqueues', async () => {
    updateSetting('capture', 'clipQueueLimit', 2);
    const oldest = enqueueSized(1, 1);
    const newer = enqueueSized(1, 2);
    const oldestFrame = oldest.frames?.[0].frame;
    installLiveCapture(2);
    const removedEvents = collect('clip:auto-removed');
    const fullEvents = collect('clip:queue-full');

    const result = await clipNow();

    expect(result.ok).toBe(true);
    const queue = getClipQueue();
    expect(queue).toHaveLength(2);
    expect(queue[1].id).toBe(newer.id);
    expect(queue.some((e) => e.id === oldest.id)).toBe(false);
    expect(oldestFrame?.close).toHaveBeenCalledOnce();
    expect(fullEvents.events).toEqual([]);
    expect(removedEvents.events).toEqual([
      expect.objectContaining({ ids: [oldest.id], reason: 'queue-full' }),
    ]);
    expect(removedEvents.events[0].message).toMatch(
      /^Clip queue full — removed the oldest clip \(.+\) to make room$/,
    );
    // Visible on every route (Create Clip leaves the Capture screen at once)
    expect(document.querySelector('.app-toast-message')?.textContent).toBe(
      removedEvents.events[0].message,
    );

    removedEvents.off();
    fullEvents.off();
  });

  it('removes as many of the oldest clips as the memory budget needs', async () => {
    updateSetting('capture', 'clipQueueLimit', 10);
    updateSetting('capture', 'memoryBudgetMB', 500);
    const a = enqueueSized(150, 1);
    const b = enqueueSized(150, 2);
    const c = enqueueSized(150, 3);
    // Held 450 MB + new 120 MB = 570 MB: 70 MB over -> only the oldest goes
    installLiveCaptureOfMB(120);
    const removedEvents = collect('clip:auto-removed');

    let result = await clipNow();

    expect(result.ok).toBe(true);
    expect(getClipQueue().map((e) => e.id)).toEqual([expect.any(String), c.id, b.id]);
    expect(removedEvents.events.map((e) => e.ids)).toEqual([[a.id]]);

    // Held 420 MB + new 300 MB = 720 MB: 220 MB over -> two oldest go
    installLiveCaptureOfMB(300);
    result = await clipNow();

    expect(result.ok).toBe(true);
    expect(removedEvents.events[1]).toEqual(
      expect.objectContaining({ ids: [b.id, c.id], reason: 'memory-budget' }),
    );
    expect(removedEvents.events[1].message).toMatch(
      /^Memory budget reached — removed the 2 oldest clips \(.+, .+\) to make room$/,
    );
    expect(getClipQueue()).toHaveLength(2);

    removedEvents.off();
  });

  it('shows no toast when the editor Clips banner claims the notice (one surface)', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueSized(1, 1);
    installLiveCapture(1);
    // Stand-in for the editor: its banner is on screen, so it claims it
    const off = onBus('clip:auto-removed', ({ markShown }) => markShown());
    const announced = [];
    document.body.insertAdjacentHTML('beforeend', '<div id="live-region"></div>');

    const result = await clipNow();

    expect(result.ok).toBe(true);
    expect(document.querySelector('.app-toast-message')).toBeNull();
    // Screen readers still hear it
    announced.push(document.getElementById('live-region')?.textContent);
    expect(announced[0]).toMatch(
      /removed the oldest clip .* to make room\. Clip added to queue \(1\/1\)$/,
    );
    off();
  });

  it('names an imported clip by its file name', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueClip({
      frames: createSizedFrames(1, 1),
      fps: 10,
      capturedAt: 1,
      sourceName: 'cat.gif',
    });
    installLiveCapture(1);
    const removedEvents = collect('clip:auto-removed');

    await clipNow();

    expect(removedEvents.events[0].message).toBe(
      'Clip queue full — removed the oldest clip (cat.gif) to make room',
    );
    removedEvents.off();
  });

  it('refuses as today, removing nothing, when every queued clip is not enough', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    setClipPayload({ frames: createSizedFrames(1, 400), fps: 30, capturedAt: 0 });
    const queued = enqueueSized(50, 1);
    // Held 450 MB + new 120 MB: even without the queued clip 520 > 500
    const workerManager = installLiveCaptureOfMB(120);
    const budgetEvents = collect('clip:memory-budget');
    const removedEvents = collect('clip:auto-removed');

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'memory-budget' });
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
    expect(getClipQueue().map((e) => e.id)).toEqual([queued.id]);
    expect(queued.frames?.[0].frame.close).not.toHaveBeenCalled();
    expect(removedEvents.events).toEqual([]);
    // Deleting a clip by hand cannot help either, so it is not suggested
    expect(budgetEvents.events[0].message).toMatch(/raise Memory Budget in Settings/);
    expect(budgetEvents.events[0].message).not.toMatch(/delete a queued clip/);

    budgetEvents.off();
    removedEvents.off();
  });

  it('never removes the active clip, even with nothing queued', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    const activeFrames = createSizedFrames(1, 450);
    setClipPayload({ frames: activeFrames, fps: 30, capturedAt: 0 });
    installLiveCaptureOfMB(120);

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'memory-budget' });
    expect(getClipPayload()?.frames).toBe(activeFrames);
    expect(activeFrames[0].frame.close).not.toHaveBeenCalled();
  });

  it('removes nothing and refuses when the real snapshot does not fit after all', async () => {
    // Regression (PR #191 review): the final check used to fall back to
    // making only the queue slot, closing a clip and then storing the new
    // one over the budget anyway
    updateSetting('capture', 'clipQueueLimit', 1);
    updateSetting('capture', 'memoryBudgetMB', 500);
    setClipPayload({ frames: createSizedFrames(1, 400), fps: 30, capturedAt: 0 });
    const queued = enqueueSized(50, 1);
    // Projected 96 MB: removing the queued clip leaves 496 MB, so it may
    // start. The buffer grew to 104 MB meanwhile: 504 MB even without it.
    installLiveCaptureOfMB(96, 104);
    const removedEvents = collect('clip:auto-removed');
    const budgetEvents = collect('clip:memory-budget');

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'memory-budget' });
    expect(getClipQueue().map((e) => e.id)).toEqual([queued.id]);
    expect(queued.frames?.[0].frame.close).not.toHaveBeenCalled();
    expect(removedEvents.events).toEqual([]);
    expect(budgetEvents.events).toHaveLength(1);
    expect(budgetEvents.events[0].incomingMB).toBeCloseTo(104, 0);
    // The refused snapshot never entered the store: its frames were closed
    const refused = vi.mocked(makeQueuedClipFrames).mock.results[0].value;
    expect(refused).toHaveLength(104);
    for (const frame of refused) expect(frame.frame.close).toHaveBeenCalledOnce();
    removedEvents.off();
    budgetEvents.off();
  });

  it('restores the plain refusal when the setting is off', async () => {
    updateSetting('capture', 'autoRemoveOldClips', false);
    updateSetting('capture', 'clipQueueLimit', 1);
    const queued = enqueueSized(1, 1);
    const workerManager = installLiveCapture(2);
    const removedEvents = collect('clip:auto-removed');

    const result = await clipNow();

    expect(result).toEqual({ ok: false, reason: 'queue-full' });
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
    expect(getClipQueue().map((e) => e.id)).toEqual([queued.id]);
    expect(removedEvents.events).toEqual([]);
    removedEvents.off();
  });

  it('is on by default', () => {
    expect(loadSettings().capture.autoRemoveOldClips).toBe(true);
  });
});

describe('the budget counts what is held (memory accounting PR A)', () => {
  const W = 1920;
  const H = 1080;
  /** Default settings on a 1080p screen: 4000 MB, 15 s x 30 fps clamped to 60 % */
  const BUFFER_FRAMES = Math.floor((4000 * 0.6 * BYTES_PER_MB) / (W * H * 4));

  function frames1080(count, tag = 'a') {
    return Array.from({ length: count }, (_, i) => ({
      id: `${tag}${i}`,
      frame: { close: vi.fn(), closed: false, codedWidth: W, codedHeight: H },
      timestamp: i,
      width: W,
      height: H,
    }));
  }

  /** A full 1080p buffer; the snapshot is BUFFER_FRAMES frames */
  function installFullBuffer() {
    const workerManager = {
      requestFrames: vi
        .fn()
        .mockResolvedValue(Array.from({ length: BUFFER_FRAMES }, (_, i) => ({ i }))),
      getEffectiveFrameDimensions: vi.fn(() => ({ width: W, height: H, scaled: false })),
    };
    captureContext.current = {
      workerManager,
      fps: 30,
      sceneDetection: false,
      stats: { frameCount: BUFFER_FRAMES, fps: 30 },
    };
    vi.mocked(makeQueuedClipFrames).mockImplementationOnce(() => frames1080(BUFFER_FRAMES, 'snap'));
    return workerManager;
  }

  const codec = {
    isCompressionAvailable: () => true,
    encode: vi.fn(() => new Promise(() => {})),
    decode: vi.fn(() => new Promise(() => {})),
  };

  let offBuffer = () => {};
  beforeEach(() => {
    registerClipCodec(codec);
    // The live buffer, as main.js registers it
    offBuffer = registerMemoryHolder(
      RING_BUFFER_HOLDER,
      () => (BUFFER_FRAMES * W * H * 4) / BYTES_PER_MB,
    );
  });
  afterEach(() => {
    registerClipCodec(null);
    offBuffer();
  });

  it('Create Clip with an active clip at 1080p defaults: not refused (M2)', () => {
    const context = installFullBuffer();
    setClipPayload({ frames: frames1080(BUFFER_FRAMES, 'act'), fps: 30, capturedAt: 0 });

    const projection = projectClipMemory(getLiveCaptureContext(), { asActive: true });

    // The new active clip is the snapshot; the old one is counted compressed
    expect(projection.over).toBe(false);
    expect(projection.incomingMB).toBeCloseTo((BUFFER_FRAMES * W * H * 4) / BYTES_PER_MB, 3);
    expect(projection.heldMB).toBeLessThan(20);
    expect(checkClipRoom({ needSlot: true, projection })).toEqual({ ok: true });
    expect(context.requestFrames).not.toHaveBeenCalled();
  });

  it('Clip Now with an active clip at 1080p defaults: queued, not refused', async () => {
    installFullBuffer();
    setClipPayload({ frames: frames1080(BUFFER_FRAMES, 'act'), fps: 30, capturedAt: 0 });

    const result = await clipNow();

    expect(result.ok).toBe(true);
    expect(getClipQueue()).toHaveLength(1);
  });

  it('does not count the buffer the snapshot drains', () => {
    installFullBuffer();
    const projection = projectClipMemory(getLiveCaptureContext());
    expect(projection.heldMB).toBeCloseTo(0, 6);
  });

  it('counts the snapshot raw when it will not compress', () => {
    registerClipCodec(null);
    installFullBuffer();
    const projection = projectClipMemory(getLiveCaptureContext());
    expect(projection.incomingMB).toBeCloseTo((BUFFER_FRAMES * W * H * 4) / BYTES_PER_MB, 3);
  });

  it('counts a new active clip at 1.5 B/px when its frames become CPU I420 (D3)', () => {
    cpuFrames.available = true;
    installFullBuffer();
    const projection = projectClipMemory(getLiveCaptureContext(), { asActive: true });
    expect(projection.incomingMB).toBeCloseTo((BUFFER_FRAMES * W * H * 1.5) / BYTES_PER_MB, 3);
  });

  it('counts a snapshot that will not compress at 1.5 B/px when it becomes CPU I420 (D3)', () => {
    cpuFrames.available = true;
    registerClipCodec(null);
    installFullBuffer();
    const projection = projectClipMemory(getLiveCaptureContext());
    expect(projection.incomingMB).toBeCloseTo((BUFFER_FRAMES * W * H * 1.5) / BYTES_PER_MB, 3);
  });

  it('names the numbers in the unit Settings shows', () => {
    const message = buildMemoryBudgetMessage({
      over: true,
      projectedMB: 4600,
      budgetMB: 4000,
      heldMB: 2100,
      incomingMB: 2500,
    });
    expect(message).toMatch(/~2\.1 GB \+ new clip ~2\.5 GB exceeds the 4\.0 GB budget/);
  });
});

describe('checkClipRoom', () => {
  const fits = { over: false, projectedMB: 0, budgetMB: 500, heldMB: 0, incomingMB: 0 };

  it('needs no queue slot for Create Clip without an active clip', () => {
    updateSetting('capture', 'autoRemoveOldClips', false);
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueClip({ frames: createMockFrames(1), fps: 30, capturedAt: 1 });
    expect(checkClipRoom({ needSlot: false, projection: fits })).toEqual({ ok: true });
    expect(checkClipRoom({ needSlot: true, projection: fits })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
  });

  it('allows a full queue when the oldest clip can go (setting on)', () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueClip({ frames: createMockFrames(1), fps: 30, capturedAt: 1 });
    expect(checkClipRoom({ needSlot: true, projection: fits })).toEqual({ ok: true });
    // Checking removes nothing
    expect(getClipQueue()).toHaveLength(1);
  });
});

describe('Clip Now hotkey (Shift+C via the app dispatcher)', () => {
  /** @type {(() => void) | null} */
  let unregister = null;

  beforeEach(() => {
    unregister = registerClipNowHotkey();
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    document.body.innerHTML = '';
  });

  /** Dispatch a keydown on document and return it (for defaultPrevented) */
  function press(overrides = {}) {
    const e = new KeyboardEvent('keydown', {
      key: 'C',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...overrides,
    });
    document.dispatchEvent(e);
    return e;
  }

  it('fires clipNow on a bare Shift+C with a live capture', () => {
    const workerManager = installLiveCapture();

    const e = press();

    expect(e.defaultPrevented).toBe(true);
    expect(workerManager.requestFrames).toHaveBeenCalledTimes(1);
  });

  it('is inert without a live capture session', () => {
    expect(press().defaultPrevented).toBe(false);
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
      expect(press(overrides).defaultPrevented).toBe(false);
    }
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });

  it('is inert while focus is in a form control', () => {
    const workerManager = installLiveCapture();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    expect(press().defaultPrevented).toBe(false);
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });

  it('is inert while a contenteditable element has focus', () => {
    const workerManager = installLiveCapture();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();

    expect(press().defaultPrevented).toBe(false);
    expect(workerManager.requestFrames).not.toHaveBeenCalled();
  });

  it('stays live while a modal (frame grid) is open', () => {
    const workerManager = installLiveCapture();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    expect(press().defaultPrevented).toBe(true);
    expect(workerManager.requestFrames).toHaveBeenCalledTimes(1);
  });
});
