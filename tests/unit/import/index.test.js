import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/import/decode.js', () => ({
  decodeImageFile: vi.fn(),
}));
vi.mock('../../../src/shared/router.js', () => ({
  navigate: vi.fn(),
}));
vi.mock('../../../src/shared/toast.js', () => ({
  showToast: vi.fn(),
}));

import { ImportError } from '../../../src/features/import/core.js';
import { decodeImageFile } from '../../../src/features/import/decode.js';
import {
  IMPORT_BUSY_MESSAGE,
  importFile,
  isImporting,
  projectImportBudget,
  reportImportBusy,
} from '../../../src/features/import/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { navigate } from '../../../src/shared/router.js';
import { showToast } from '../../../src/shared/toast.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

/**
 * importFile: the refusal paths and frame ownership. The decoder is mocked
 * (its own ownership is pinned in decode.test.js); the app-store is real so
 * demote/queue-full behave exactly as in the app.
 */

function mockVideoFrame() {
  const vf = { closed: false };
  vf.close = vi.fn(() => {
    vf.closed = true;
  });
  return vf;
}

/**
 * A decoded import like decodeImageFile returns
 * @param {{ slots?: number, sources?: number, width?: number, height?: number, hasAlpha?: boolean, fps?: number }} [options]
 */
function decodedImport({
  slots = 7,
  sources = 3,
  width = 64,
  height = 48,
  hasAlpha = true,
  fps = 10,
} = {}) {
  const frames = Array.from({ length: slots }, (_, i) => ({
    id: `import-${i}`,
    frame: mockVideoFrame(),
    timestamp: (i * 1e6) / fps,
    width,
    height,
    sharedKey: `src-${Math.min(i, sources - 1)}`,
  }));
  return { frames, fps, width, height, hasAlpha, sourceFrameCount: sources };
}

/**
 * Make the mocked decoder call onMetadata (like the real one) and resolve
 * @param {ReturnType<typeof decodedImport>} result
 */
function decodeResolves(result) {
  vi.mocked(decodeImageFile).mockImplementation(async (_file, options) => {
    options?.onMetadata?.({
      sourceFrameCount: result.sourceFrameCount,
      width: result.width,
      height: result.height,
    });
    options?.onProgress?.(result.sourceFrameCount, result.sourceFrameCount);
    return result;
  });
}

/** @param {string} [name] @param {string} [type] */
function gifFile(name = 'cat.gif', type = 'image/gif') {
  return /** @type {File} */ (/** @type {unknown} */ ({ name, type, size: 1024 }));
}

function captureClip(count = 2) {
  return {
    frames: Array.from({ length: count }, (_, i) => ({
      id: `cap-${i}`,
      frame: mockVideoFrame(),
      timestamp: i,
      width: 10,
      height: 10,
    })),
    fps: 30,
    capturedAt: 1,
  };
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  document.body.innerHTML = '<div id="live-region"></div>';
  vi.clearAllMocks();
});

afterEach(() => {
  resetAppStore();
});

describe('importFile success', () => {
  it('stores the decoded clip as the active payload and opens the editor', async () => {
    const decoded = decodedImport();
    decodeResolves(decoded);

    const result = await importFile(gifFile());

    expect(result).toEqual({ ok: true, frameCount: 7, fps: 10, hasAlpha: true });
    const payload = getClipPayload();
    expect(payload?.frames).toBe(decoded.frames);
    expect(payload).toMatchObject({
      fps: 10,
      hasAlpha: true,
      sourceName: 'cat.gif',
      sceneDetectionEnabled: false,
    });
    expect(navigate).toHaveBeenCalledWith('/editor');
    expect(decoded.frames.every((f) => !f.frame.closed)).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toContain('Opened cat.gif');
    expect(isImporting()).toBe(false);
  });

  it('demotes the previous active clip into the queue', async () => {
    const previous = captureClip();
    setClipPayload(previous);
    decodeResolves(decodedImport());

    const result = await importFile(gifFile());

    expect(result.ok).toBe(true);
    expect(getClipQueue()).toHaveLength(1);
    expect(getClipQueue()[0].frames).toBe(previous.frames);
    expect(previous.frames.every((f) => !f.frame.closed)).toBe(true);
  });

  it('forwards progress and the abort signal to the decoder', async () => {
    decodeResolves(decodedImport());
    const onProgress = vi.fn();
    const controller = new AbortController();

    await importFile(gifFile(), { onProgress, signal: controller.signal });

    const options = vi.mocked(decodeImageFile).mock.calls[0][1];
    expect(options?.signal).toBe(controller.signal);
    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });
});

describe('importFile refusals', () => {
  it('refuses an unsupported file before decoding, with toast + live region', async () => {
    const result = await importFile(gifFile('notes.txt', 'text/plain'));

    expect(result).toMatchObject({ ok: false, reason: 'unsupported-type' });
    expect(decodeImageFile).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('notes.txt'));
    expect(document.getElementById('live-region')?.textContent).toContain('notes.txt');
    expect(navigate).not.toHaveBeenCalled();
    expect(getClipPayload()).toBeNull();
  });

  it('refuses early when a clip is active and the queue is full', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    setClipPayload(captureClip());
    enqueueClip(captureClip());
    const queueFull = vi.fn();
    const off = onBus('clip:queue-full', queueFull);

    const result = await importFile(gifFile());
    off();

    expect(result).toMatchObject({ ok: false, reason: 'queue-full' });
    expect(decodeImageFile).not.toHaveBeenCalled();
    expect(queueFull).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Clip queue full'));
  });

  it('closes every frame when the queue fills while decoding', async () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    setClipPayload(captureClip());
    const decoded = decodedImport();
    vi.mocked(decodeImageFile).mockImplementation(async () => {
      // Clip Now lands while the file decodes
      enqueueClip(captureClip());
      return decoded;
    });

    const result = await importFile(gifFile());

    expect(result).toMatchObject({ ok: false, reason: 'queue-full' });
    expect(decoded.frames.every((f) => f.frame.close.mock.calls.length === 1)).toBe(true);
    expect(getClipPayload()?.sourceName).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refuses by memory budget at metadata time (before decoding everything)', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    // 200 x 1000x1000 RGBA ~ 763 MB of unique frames
    const decoded = decodedImport({ sources: 200, slots: 200, width: 1000, height: 1000 });
    let decodedAll = false;
    vi.mocked(decodeImageFile).mockImplementation(async (_file, options) => {
      options?.onMetadata?.({ sourceFrameCount: 200, width: 1000, height: 1000 });
      decodedAll = true;
      return decoded;
    });
    const budgetEvent = vi.fn();
    const off = onBus('clip:memory-budget', budgetEvent);

    const result = await importFile(gifFile());
    off();

    expect(result).toMatchObject({ ok: false, reason: 'memory-budget' });
    expect(decodedAll).toBe(false);
    expect(budgetEvent).toHaveBeenCalledWith(expect.objectContaining({ budgetMB: 500 }));
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  it('re-checks the budget after decoding and closes the frames when over', async () => {
    updateSetting('capture', 'memoryBudgetMB', 500);
    const decoded = decodedImport({ sources: 200, slots: 200, width: 1000, height: 1000 });
    // No onMetadata call: only the post-decode check can catch it
    vi.mocked(decodeImageFile).mockResolvedValue(decoded);

    const result = await importFile(gifFile());

    expect(result).toMatchObject({ ok: false, reason: 'memory-budget' });
    expect(decoded.frames.every((f) => f.frame.closed)).toBe(true);
    expect(getClipPayload()).toBeNull();
  });

  it('reports decoder errors to the user', async () => {
    vi.mocked(decodeImageFile).mockRejectedValue(
      new ImportError('decode-failed', `Couldn't read "cat.gif"`),
    );

    const result = await importFile(gifFile());

    expect(result).toEqual({
      ok: false,
      reason: 'decode-failed',
      message: `Couldn't read "cat.gif"`,
    });
    expect(showToast).toHaveBeenCalledWith(`Couldn't read "cat.gif"`);
  });

  it('turns unexpected errors into a decode failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(decodeImageFile).mockRejectedValue(new TypeError('boom'));

    const result = await importFile(gifFile());

    expect(result).toMatchObject({ ok: false, reason: 'decode-failed' });
    expect(result.message).toContain('cat.gif');
    consoleError.mockRestore();
  });

  it('an abort after decoding closes the frames silently', async () => {
    const controller = new AbortController();
    const decoded = decodedImport();
    vi.mocked(decodeImageFile).mockImplementation(async () => {
      controller.abort();
      return decoded;
    });

    const result = await importFile(gifFile(), { signal: controller.signal });

    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(decoded.frames.every((f) => f.frame.closed)).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
    expect(getClipPayload()).toBeNull();
  });

  it('refuses a second import while one is decoding', async () => {
    /** @type {(value: any) => void} */
    let finish = () => {};
    vi.mocked(decodeImageFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const first = importFile(gifFile());
    expect(isImporting()).toBe(true);
    const second = await importFile(gifFile('dog.gif'));
    expect(second).toMatchObject({ ok: false, reason: 'busy', message: IMPORT_BUSY_MESSAGE });
    // The refusal is never silent
    expect(showToast).toHaveBeenCalledWith(IMPORT_BUSY_MESSAGE);

    finish(decodedImport());
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(isImporting()).toBe(false);
  });
});

describe('reportImportBusy', () => {
  it('tells the user another file is still opening (toast + bus event)', () => {
    /** @type {any[]} */
    const events = [];
    const off = onBus('import:error', (detail) => events.push(detail));
    reportImportBusy();
    off();

    expect(showToast).toHaveBeenCalledWith(IMPORT_BUSY_MESSAGE);
    expect(events).toEqual([{ code: 'busy', message: IMPORT_BUSY_MESSAGE }]);
  });
});

describe('projectImportBudget', () => {
  it('adds unique source frames to the memory already held', () => {
    updateSetting('capture', 'memoryBudgetMB', 1000);
    const projection = projectImportBudget(4, 1024, 256);
    expect(projection).toMatchObject({ incomingMB: 4, heldMB: 0, budgetMB: 1000, over: false });
  });
});
