import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteActiveClipFromAnywhere,
  initEditor,
  promoteClipFromQueue,
} from '../../../src/features/editor/index.js';
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
import { BYTES_PER_MB } from '../../../src/shared/utils/memory-monitor.js';

/**
 * Deleting the open clip hands the editor to the newest queued clip.
 *
 * Review of #230, round 2, item 2: at the defaults (30 fps, 15 s, 4000 MB)
 * a full 1080p buffer (~2397 MB) plus the deleted clip in its Undo hold
 * (~2397 MB) left no room for any decoded successor, so every delete waited
 * 5 s on "Opening clip...". The hold goes when its 5 s end (or the next
 * deletion replaces it), so the successor's check leaves it out.
 *
 * Item 1: an opening screen mounted by the editor itself (after a failed
 * succession) must not outlive the route: leaving to Capture and then the
 * clip arriving must not mount the editor over Capture.
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

describe('deleting the open clip opens the next one (#230 review)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;
  let offBuffer = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    window.location.hash = '#/editor';
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

  /** A compressed queued clip of `count` 1080p frames */
  async function compressedSuccessor(codec, count) {
    enqueueClip({ frames: rgbaFrames(count, 'b'), fps: 30, capturedAt: 1000 });
    codec.encodeCalls.at(-1).resolve({
      ok: true,
      chunks: [],
      config: { codec: 'vp8', codedWidth: W, codedHeight: H },
      byteLength: 10 * BYTES_PER_MB,
    });
    await vi.advanceTimersByTimeAsync(0);
    const [successor] = getClipQueue();
    expect(successor.status).toBe('compressed');
    return successor;
  }

  it('opens the successor at once, the Undo hold left out of the check (round 2, item 2)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const successor = await compressedSuccessor(codec, 300);
    // The default 15 s clip: 289 frames of 1080p RGBA, ~2397 MB
    setClipPayload({ frames: rgbaFrames(289, 'a'), fps: 30, capturedAt: 2000 });
    cleanup = initEditor();

    // Buffer 2400 + successor decoded ~933 fits 4000; with the hold
    // (~2397) it would not
    pressDelete();
    await vi.advanceTimersByTimeAsync(0);
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(300) });
    await vi.advanceTimersByTimeAsync(0);

    expect(getClipPayload()?.id).toBe(successor.id);
    expect(document.querySelector('.editor-clip-opening')).toBeNull();
  });

  it('opens any queued clip outside the editor within 5 s of a delete (round 3, item 1)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const queued = await compressedSuccessor(codec, 289);
    setClipPayload({ frames: rgbaFrames(289, 'a'), fps: 30, capturedAt: 2000 });

    // From the header popover, no editor mounted: delete, then open
    expect(deleteActiveClipFromAnywhere()).toBe(true);
    const opened = promoteClipFromQueue(queued.id);
    await vi.advanceTimersByTimeAsync(0);
    // Buffer 2400 + decoded ~899 fits; with the hold (~2397) it would not
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(289) });
    expect(await opened).toBe(true);
    expect(getClipPayload()?.id).toBe(queued.id);
  });

  it('still refuses a successor that does not fit without the hold, and leaves the deleted clip', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    await compressedSuccessor(codec, 300);
    offBuffer();
    offBuffer = registerMemoryHolder(RING_BUFFER_HOLDER, () => 3500);
    setClipPayload({ frames: rgbaFrames(150, 'a'), fps: 30, capturedAt: 2000 });
    cleanup = initEditor();
    const deletedId = getClipPayload()?.id;

    // Buffer 3500 + successor ~933 > 4000 whatever the hold
    pressDelete();
    await vi.advanceTimersByTimeAsync(0);

    // The deleted clip is not kept as the open clip; Capture is next
    expect(codec.decode).not.toHaveBeenCalled();
    expect(getClipPayload()?.id).not.toBe(deletedId);
    expect(window.location.hash).toBe('#/capture');
  });

  it('an opening screen the editor mounted itself goes with the route (round 2, item 1)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const successor = await compressedSuccessor(codec, 150);
    // Room for everything, the hold included: only the cleanup is tested
    offBuffer();
    offBuffer = registerMemoryHolder(RING_BUFFER_HOLDER, () => 1000);
    setClipPayload({ frames: rgbaFrames(150, 'a'), fps: 30, capturedAt: 2000 });
    cleanup = initEditor();

    // The successor's decode fails: the editor mounts again on the queue,
    // which shows the opening screen and tries the successor again
    pressDelete();
    await vi.advanceTimersByTimeAsync(0);
    codec.decodeCalls[0].resolve({ ok: false, error: 'boom' });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.editor-clip-opening')).not.toBeNull();
    expect(codec.decode).toHaveBeenCalledTimes(2);

    // The user goes to Capture: the router runs the first mount's cleanup
    cleanup?.();
    cleanup = null;
    const main = /** @type {HTMLElement} */ (document.querySelector('#main-content'));
    main.innerHTML = '<p id="capture-screen">capture</p>';

    // The retried decode lands later: nothing mounts over Capture
    codec.decodeCalls[1].resolve({ ok: true, frames: decodedFrames(150) });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('#capture-screen')).not.toBeNull();
    expect(document.querySelector('.editor-screen')).toBeNull();
    // The clip still opens (the next editor mount shows it)
    expect(getClipPayload()?.id).toBe(successor.id);
  });
});
