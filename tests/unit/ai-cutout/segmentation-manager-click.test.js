import { describe, expect, it, vi } from 'vitest';
import { createMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import { getModelSpec } from '../../../src/features/ai-cutout/model-config.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import { createSegmentationManager } from '../../../src/features/ai-cutout/segmentation-manager.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A worker that loads any model and answers each 'prompt' with four masks:
 * a small square around the first point (or the box centre), a bigger one,
 * the object (a 40% box around the point), and the whole frame.
 */
class FakeSamWorker {
  constructor({ fail = false } = {}) {
    /** @type {Function[]} */
    this.handlers = [];
    /** @type {any[]} */
    this.posted = [];
    this.fail = fail;
    this.terminated = false;
  }

  addEventListener(type, handler) {
    if (type === 'message') this.handlers.push(handler);
  }

  emit(data) {
    for (const handler of this.handlers) handler({ data });
  }

  postMessage(msg) {
    this.posted.push(msg);
    if (msg.type === 'init') {
      queueMicrotask(() =>
        this.emit({
          type: 'ready',
          modelId: msg.model.id,
          backend: 'webgpu',
          adapter: null,
          fromCache: true,
          cached: true,
          timings: { loadMs: 1, createMs: 1 },
        }),
      );
    }
    if (msg.type === 'prompt') queueMicrotask(() => this.answer(msg));
  }

  answer(msg) {
    if (this.fail) {
      this.emit({
        type: 'segment-error',
        requestId: msg.requestId,
        error: { code: 'inference-failed', message: 'lost device' },
      });
      return;
    }
    const w = msg.maskWidth;
    const h = msg.maskHeight;
    // Centre of the prompt in mask pixels (coords are encoder pixels)
    const cx = (msg.coords[0] / msg.encoderWidth) * w;
    const cy = (msg.coords[1] / msg.encoderHeight) * h;
    const square = (/** @type {number} */ r) => {
      const data = new Uint8Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (Math.abs(x - cx) < r && Math.abs(y - cy) < r) data[y * w + x] = 255;
      return data.buffer;
    };
    this.emit({
      type: 'prompt-result',
      requestId: msg.requestId,
      width: w,
      height: h,
      masks: [square(2), square(4), square(8), new Uint8Array(w * h).fill(255).buffer],
      scores: [0.9, 0.8, 0.95, 0.2],
      // Low-res logits of answer i all equal i + 1
      lowRes: msg.wantLowRes
        ? Float32Array.from({ length: 4 * 256 * 256 }, (_, i) => Math.floor(i / 65536) + 1).buffer
        : null,
      cached: false,
      encodeMs: 200,
      decodeMs: 30,
      totalMs: 230,
    });
  }

  terminate() {
    this.terminated = true;
  }

  get prompts() {
    return this.posted.filter((m) => m.type === 'prompt');
  }
}

/** @param {string} id */
const frame = (id) => ({ id, frame: { closed: false }, timestamp: 0, width: 64, height: 32 });

function harness(workerOptions = {}) {
  const maskStore = createMaskStore();
  /** @type {FakeSamWorker[]} */
  const workers = [];
  const bitmaps = [];
  const manager = createSegmentationManager({
    maskStore,
    createWorker: () => {
      const w = new FakeSamWorker(workerOptions);
      workers.push(w);
      return /** @type {any} */ (w);
    },
    createBitmap: async (_s, width, height) => {
      const b = { width, height, close: vi.fn() };
      bitmaps.push(b);
      return /** @type {any} */ (b);
    },
    getModelSpec: (id) => getModelSpec(id),
  });
  const frames = Array.from({ length: 6 }, (_, i) => frame(`f${i}`));
  return { manager, maskStore, workers, bitmaps, frames };
}

describe('SegmentationManager.analyzeClick', () => {
  it('loads the two-file model, tracks from the click and stores masks under (click, frame)', async () => {
    const { manager, maskStore, workers, bitmaps, frames } = harness();
    const progress = vi.fn();
    const result = await manager.analyzeClick(frames, {
      range: { start: 0, end: 5 },
      currentFrame: 2,
      picks: [{ frame: 2, x: 0.5, y: 0.5, mode: 'keep' }],
      clipId: 'clip',
      onProgress: progress,
    });
    expect(result).toEqual({ tracked: 6, lost: [], anchors: 1, backend: 'webgpu' });
    const [worker] = workers;
    expect(worker.posted[0]).toMatchObject({ type: 'init', model: { id: 'click', kind: 'sam' } });
    expect(worker.posted[0].model.files).toHaveLength(2);
    // One prompt per frame, the clicked one first, with the encoder-sized frame
    expect(worker.prompts.map((m) => m.frameKey)).toEqual(['f2', 'f3', 'f4', 'f5', 'f1', 'f0']);
    const [first] = worker.prompts;
    expect(first).toMatchObject({
      modelId: 'click',
      encoderWidth: 1024,
      encoderHeight: 512,
      maskWidth: 64,
      maskHeight: 32,
    });
    // The click at the centre in encoder pixels, then SAM's padding point
    expect([...first.coords]).toEqual([512, 256, 0, 0]);
    expect([...first.labels]).toEqual([1, -1]);
    // Tracked frames carry a box (labels 2 and 3)
    expect([...worker.prompts[1].labels]).toContain(2);
    // Every prompt asks for the low-res logits; a tracked frame sends those
    // of the answer the previous frame kept (the object, answer 2) as its
    // mask_input, the clicked frame none
    expect(worker.prompts.every((m) => m.wantLowRes === true)).toBe(true);
    expect(first.maskInput).toBeNull();
    const { maskInput } = worker.prompts[1];
    expect(maskInput).toBeInstanceOf(Float32Array);
    expect(maskInput).toHaveLength(256 * 256);
    expect(new Set(maskInput)).toEqual(new Set([3]));
    expect(bitmaps.every((b) => b.width === 1024 && b.height === 512)).toBe(true);
    for (const f of frames) expect(maskStore.has(`click:${f.id}`)).toBe(true);
    // Whole: the object (a 15×15 square), not the whole frame
    const mask = /** @type {any} */ (maskStore.get('click:f2'));
    expect(
      mask.data.reduce((/** @type {number} */ n, /** @type {number} */ v) => n + (v ? 1 : 0), 0),
    ).toBe(225);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'analyzing', framesDone: 6, framesTotal: 6, frameMs: 230 }),
    );
    expect(manager.isModelBusy('click')).toBe(false);
  });

  it('only loads the model when there is no click yet', async () => {
    const { manager, workers, frames } = harness();
    const result = await manager.analyzeClick(frames, {
      range: { start: 0, end: 5 },
      currentFrame: 0,
      picks: [],
    });
    expect(result).toMatchObject({ tracked: 0, anchors: 0 });
    expect(workers[0].posted.map((m) => m.type)).toEqual(['init']);
    expect(manager.getReadyInfo('click')).toMatchObject({ resize: 'sam', modelBytes: 44_653_652 });
  });

  it('keeps the masks stored before a cancel, and stops sending prompts', async () => {
    const { manager, maskStore, workers, frames } = harness();
    const controller = new AbortController();
    const run = manager.analyzeClick(frames, {
      range: { start: 0, end: 5 },
      currentFrame: 0,
      picks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
      signal: controller.signal,
      onProgress: (p) => {
        if (p.framesDone === 2) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(maskStore.has('click:f0')).toBe(true);
    expect(maskStore.has('click:f1')).toBe(true);
    expect(workers[0].prompts.length).toBeLessThanOrEqual(3);
  });

  it('rejects with INFERENCE_FAILED and starts a fresh worker next time', async () => {
    const { manager, workers, frames } = harness({ fail: true });
    await expect(
      manager.analyzeClick(frames, {
        range: { start: 0, end: 1 },
        currentFrame: 0,
        picks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
      }),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.INFERENCE_FAILED });
    expect(workers[0].terminated).toBe(true);
  });
});
