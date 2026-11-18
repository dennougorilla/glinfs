import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initEditor } from '../../../src/features/editor/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  RING_BUFFER_HOLDER,
  registerClipCodec,
  registerMemoryHolder,
  resetAppStore,
  setClipPayload,
  undoDelete,
} from '../../../src/shared/app-store.js';
import { BYTES_PER_MB } from '../../../src/shared/utils/memory-monitor.js';

/**
 * Review of #230, P1: deleting the open clip keeps the editor on screen
 * while the compressed successor opens. At the default 4 GB budget a full
 * capture buffer plus the deleted clip's Undo hold leave no room for the
 * successor, so its open is refused. The editor must not stay on the
 * deleted clip (its frames close when the hold ends): it shows the opening
 * state and opens the successor once the hold ends.
 */

const W = 1920;
const H = 1080;

/** @param {number} count @param {string} tag */
function rgbaFrames(count, tag) {
  return Array.from({ length: count }, (_, i) => {
    const vf = { closed: false, timestamp: i, codedWidth: W, codedHeight: H };
    vf.close = vi.fn(() => {
      vf.closed = true;
    });
    return { id: `${tag}${i}`, frame: vf, timestamp: i * 33, width: W, height: H };
  });
}

/** @param {number} count */
function decodedFrames(count) {
  return Array.from({ length: count }, (_, i) => {
    const vf = {
      closed: false,
      timestamp: i * 33_000,
      codedWidth: W,
      codedHeight: H,
      format: 'I420',
      allocationSize: () => W * H * 1.5,
    };
    vf.close = vi.fn(() => {
      vf.closed = true;
    });
    return vf;
  });
}

function createMockCodec() {
  /** @type {{ resolve: (r: any) => void }[]} */
  const encodeCalls = [];
  /** @type {{ resolve: (r: any) => void }[]} */
  const decodeCalls = [];
  return {
    isCompressionAvailable: () => true,
    encode: vi.fn(() => new Promise((resolve) => encodeCalls.push({ resolve }))),
    decode: vi.fn(() => new Promise((resolve) => decodeCalls.push({ resolve }))),
    isEncodeQueued: () => false,
    cancelEncode: () => false,
    encodeCalls,
    decodeCalls,
  };
}

function pressDelete() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Delete',
      code: 'Delete',
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('deleting the open clip when the successor does not fit yet (#230 review P1)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;
  let offBuffer = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    // A full 1080p capture buffer at the defaults: 60 % of 4000 MB
    offBuffer = registerMemoryHolder(RING_BUFFER_HOLDER, () => 2400);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    offBuffer();
    registerClipCodec(null);
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('leaves the deleted clip, then opens the successor when the Undo hold ends', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    enqueueClip({ frames: rgbaFrames(150, 'b'), fps: 30, capturedAt: 1000 });
    codec.encodeCalls[0].resolve({
      ok: true,
      chunks: [],
      config: { codec: 'vp8', codedWidth: W, codedHeight: H },
      byteLength: 10 * BYTES_PER_MB,
    });
    await vi.advanceTimersByTimeAsync(0);
    const [successor] = getClipQueue();
    expect(successor.status).toBe('compressed');

    const deletedFrames = rgbaFrames(150, 'a');
    setClipPayload({ frames: deletedFrames, fps: 30, capturedAt: 2000 });
    cleanup = initEditor();
    const deletedId = getClipPayload()?.id;

    // Held then: buffer 2400 + the deleted clip in its Undo hold (~1244)
    // + the successor decoded (~467) > 4000: the open is refused
    pressDelete();
    await vi.advanceTimersByTimeAsync(0);
    expect(codec.decode).not.toHaveBeenCalled();

    // The editor does not stay on the deleted clip
    expect(document.querySelector('.editor-clip-opening')).not.toBeNull();
    expect(document.querySelector('.editor-canvas')).toBeNull();
    expect(getClipPayload()?.id).not.toBe(deletedId);

    // The hold ends: its memory is free and the successor opens
    await vi.advanceTimersByTimeAsync(5000);
    expect(deletedFrames[0].frame.closed).toBe(true);
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(150) });
    await vi.advanceTimersByTimeAsync(0);

    expect(getClipPayload()?.id).toBe(successor.id);
    expect(document.querySelector('.editor-clip-opening')).toBeNull();
  });

  it('gives the deleted clip back on Undo while the successor waits', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    enqueueClip({ frames: rgbaFrames(150, 'b'), fps: 30, capturedAt: 1000 });
    codec.encodeCalls[0].resolve({
      ok: true,
      chunks: [],
      config: { codec: 'vp8', codedWidth: W, codedHeight: H },
      byteLength: 10 * BYTES_PER_MB,
    });
    await vi.advanceTimersByTimeAsync(0);

    setClipPayload({ frames: rgbaFrames(150, 'a'), fps: 30, capturedAt: 2000 });
    cleanup = initEditor();
    const deletedId = getClipPayload()?.id;
    pressDelete();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.editor-clip-opening')).not.toBeNull();

    // The toast's Undo (its root does not survive the DOM reset between tests)
    expect(undoDelete()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    // Undo puts the clip back at the queue front, where it compresses like
    // any demoted clip; the editor opens it, not the successor
    expect(getClipQueue()[0].id).toBe(deletedId);
    codec.encodeCalls[1].resolve({
      ok: true,
      chunks: [],
      config: { codec: 'vp8', codedWidth: W, codedHeight: H },
      byteLength: 10 * BYTES_PER_MB,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(150) });
    await vi.advanceTimersByTimeAsync(0);
    expect(getClipPayload()?.id).toBe(deletedId);
    expect(document.querySelector('.editor-clip-opening')).toBeNull();
  });
});
