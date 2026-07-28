import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteQueuedClip,
  enqueueClip,
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  getClipQueueLimit,
  getEditorPayload,
  isClipQueueFull,
  promoteQueuedClip,
  releaseAllFramesAndReset,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  undoDelete,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

/**
 * Tests for #95: the bounded clip queue and its frame-ownership rules.
 *
 * The invariants under test (see the ownership comment atop app-store.js):
 * - frames are closed ONLY on explicit queue-entry delete and on
 *   releaseAllFramesAndReset (which drains the queue)
 * - promote/demote/setClipPayload NEVER close frames — they move ownership
 * - a full queue REFUSES enqueue (and the demote inside setClipPayload)
 *   without destroying anything
 * - the active clip is structurally not in the queue and cannot be evicted
 * - every queue mutation emits 'queue:changed'
 * - editor state saved at demote survives the promote round-trip
 */

// Mock VideoFrame-wrapping Frame object, matching the shape app-store expects
function createMockFrame(id = '1', closed = false) {
  return {
    id,
    frame: { close: vi.fn(), closed },
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

function createMockFrames(count = 3) {
  return Array.from({ length: count }, (_, i) => createMockFrame(String(i)));
}

/** @param {import('../../../src/shared/app-store.js').ClipPayload['frames']} frames */
function clipPayloadOf(frames, fps = 30) {
  return { frames, fps, capturedAt: Date.now() };
}

function expectNoClose(frames) {
  for (const f of frames) {
    expect(f.frame.close).not.toHaveBeenCalled();
  }
}

function expectAllClosedOnce(frames) {
  for (const f of frames) {
    expect(f.frame.close).toHaveBeenCalledOnce();
  }
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
});

describe('queue limit configuration', () => {
  it('defaults to 10 (#92 compressed queue) and clamps corrupted values into 1-30', () => {
    expect(getClipQueueLimit()).toBe(10);

    updateSetting('capture', 'clipQueueLimit', 7);
    expect(getClipQueueLimit()).toBe(7);

    updateSetting('capture', 'clipQueueLimit', 0);
    expect(getClipQueueLimit()).toBe(1);

    updateSetting('capture', 'clipQueueLimit', 999);
    expect(getClipQueueLimit()).toBe(30);

    updateSetting('capture', 'clipQueueLimit', 'garbage');
    expect(getClipQueueLimit()).toBe(10);
  });
});

describe('enqueueClip', () => {
  it('adds entries newest-first and emits queue:changed', () => {
    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));

    const first = enqueueClip(clipPayloadOf(createMockFrames(2)));
    const second = enqueueClip(clipPayloadOf(createMockFrames(2)));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const queue = getClipQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].id).toBe(second.entry.id);
    expect(queue[1].id).toBe(first.entry.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'enqueue', queueLength: 2, limit: 10 });

    unsubscribe();
  });

  it('REFUSES at the limit: nothing destroyed, queue unchanged, refusal returned', () => {
    updateSetting('capture', 'clipQueueLimit', 2);
    enqueueClip(clipPayloadOf(createMockFrames(1)));
    enqueueClip(clipPayloadOf(createMockFrames(1)));
    const before = getClipQueue();

    const refusedFrames = createMockFrames(2);
    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));

    const result = enqueueClip(clipPayloadOf(refusedFrames));

    expect(result).toEqual({ ok: false, reason: 'queue-full', limit: 2 });
    expect(getClipQueue().map((e) => e.id)).toEqual(before.map((e) => e.id));
    // Refusal destroys nothing — neither the refused frames nor queued ones
    expectNoClose(refusedFrames);
    for (const entry of getClipQueue()) {
      expectNoClose(entry.frames);
    }
    // A refusal is not a mutation: no queue:changed
    expect(events).toHaveLength(0);
    expect(isClipQueueFull()).toBe(true);

    unsubscribe();
  });

  it('never counts the active clip against the queue limit', () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    setClipPayload(clipPayloadOf(createMockFrames(1)));

    // Active clip exists but queue is empty — enqueue must succeed
    expect(enqueueClip(clipPayloadOf(createMockFrames(1))).ok).toBe(true);
    expect(getClipQueue()).toHaveLength(1);
    expect(getClipPayload()).not.toBeNull();
  });
});

describe('promoteQueuedClip ownership', () => {
  it('closes NO frames on promote/demote and swaps active with the queued entry', () => {
    const framesA = createMockFrames(3);
    const framesB = createMockFrames(3);
    setClipPayload(clipPayloadOf(framesA));
    const { entry } = enqueueClip(clipPayloadOf(framesB));

    const result = promoteQueuedClip(entry.id, {
      selectedRange: { start: 0, end: 2 },
      cropArea: null,
      playbackSpeed: 1,
      currentFrame: 0,
    });

    expect(result).not.toBeNull();
    expect(getClipPayload()?.frames).toBe(framesB);
    // Demoted active clip sits at the queue FRONT, frames intact
    const queue = getClipQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].frames).toBe(framesA);
    expectNoClose(framesA);
    expectNoClose(framesB);
  });

  it('emits queue:changed and clears editorPayload (without closing frames)', () => {
    const framesA = createMockFrames(2);
    setClipPayload(clipPayloadOf(framesA));
    setEditorPayload({
      selectedRange: { start: 0, end: 1 },
      cropArea: null,
      clip: { frames: framesA },
      fps: 30,
    });
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(2)));

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));

    promoteQueuedClip(entry.id, null);

    expect(events).toEqual([expect.objectContaining({ type: 'promote' })]);
    expect(getEditorPayload()).toBeNull();
    expectNoClose(framesA);

    unsubscribe();
  });

  it('promotes with no active clip (empty-editor adoption) without growing the queue', () => {
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(2)));

    const result = promoteQueuedClip(entry.id, null);

    expect(result?.payload.frames).toBe(entry.frames);
    expect(getClipQueue()).toHaveLength(0);
  });

  it('returns null for an unknown id and mutates nothing', () => {
    setClipPayload(clipPayloadOf(createMockFrames(1)));
    enqueueClip(clipPayloadOf(createMockFrames(1)));

    expect(promoteQueuedClip('nope', null)).toBeNull();
    expect(getClipQueue()).toHaveLength(1);
    expect(getClipPayload()).not.toBeNull();
  });

  it('cannot exceed the limit even at a full queue (swap is remove-one add-one)', () => {
    updateSetting('capture', 'clipQueueLimit', 2);
    setClipPayload(clipPayloadOf(createMockFrames(1)));
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(1)));
    enqueueClip(clipPayloadOf(createMockFrames(1)));
    expect(isClipQueueFull()).toBe(true);

    const result = promoteQueuedClip(entry.id, null);

    expect(result).not.toBeNull();
    expect(getClipQueue()).toHaveLength(2);
  });
});

describe('editor-state round-trip (A -> B -> A)', () => {
  it('preserves selection, crop, speed and current frame across demote/promote', () => {
    const framesA = createMockFrames(5);
    const framesB = createMockFrames(5);
    setClipPayload(clipPayloadOf(framesA));
    const { entry: entryB } = enqueueClip(clipPayloadOf(framesB));

    const stateA = {
      selectedRange: { start: 1, end: 3 },
      cropArea: { x: 10, y: 10, width: 50, height: 50, aspectRatio: 'free' },
      playbackSpeed: 2,
      currentFrame: 2,
    };

    // A -> B: A demotes carrying stateA
    promoteQueuedClip(entryB.id, stateA);
    const demotedA = getClipQueue()[0];
    expect(demotedA.frames).toBe(framesA);
    expect(demotedA.savedEditorState).toEqual(stateA);

    // B -> A: promoted A exposes stateA for the editor to restore
    const result = promoteQueuedClip(demotedA.id, {
      selectedRange: { start: 0, end: 4 },
      cropArea: null,
      playbackSpeed: 1,
      currentFrame: 0,
    });

    expect(result?.payload.frames).toBe(framesA);
    expect(result?.savedEditorState).toEqual(stateA);
    expect(result?.payload.savedEditorState).toEqual(stateA);
    // Full round-trip closed nothing
    expectNoClose(framesA);
    expectNoClose(framesB);
  });

  it('carries scenes detected while editing through the demote', () => {
    setClipPayload({ ...clipPayloadOf(createMockFrames(2)), sceneDetectionEnabled: true });
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(2)));
    const scenes = [{ id: 's1', startFrame: 0, endFrame: 1 }];

    promoteQueuedClip(entry.id, {
      selectedRange: { start: 0, end: 1 },
      cropArea: null,
      playbackSpeed: 1,
      currentFrame: 0,
      scenes,
    });

    expect(getClipQueue()[0].scenes).toEqual(scenes);
  });
});

describe('setClipPayload demote path', () => {
  it('REFUSES a new clip when the queue is full: active and queue stay untouched', () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    const activeFrames = createMockFrames(2);
    setClipPayload(clipPayloadOf(activeFrames));
    enqueueClip(clipPayloadOf(createMockFrames(2)));

    const newFrames = createMockFrames(2);
    const result = setClipPayload(clipPayloadOf(newFrames));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('queue-full');
    // Nothing changed, nothing closed
    expect(getClipPayload()?.frames).toBe(activeFrames);
    expect(getClipQueue()).toHaveLength(1);
    expectNoClose(activeFrames);
    expectNoClose(newFrames);
  });

  it('metadata-only update (same frames reference) skips the queue entirely', () => {
    const frames = createMockFrames(2);
    setClipPayload(clipPayloadOf(frames));

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));
    const result = setClipPayload({ ...clipPayloadOf(frames), scenes: [] });

    expect(result.ok).toBe(true);
    expect(getClipQueue()).toHaveLength(0);
    expect(events).toHaveLength(0);

    unsubscribe();
  });

  it('keeps the clip id stable so a demoted clip is the same clip', () => {
    const frames = createMockFrames(1);
    setClipPayload(clipPayloadOf(frames));
    const id = getClipPayload()?.id;
    expect(id).toBeTruthy();

    setClipPayload(clipPayloadOf(createMockFrames(1)));

    expect(getClipQueue()[0].id).toBe(id);
  });
});

describe('deleteQueuedClip', () => {
  it('holds the deleted entry for undo, closing frames only after the grace window (#100 r5)', () => {
    vi.useFakeTimers();
    const frames = createMockFrames(3);
    const { entry } = enqueueClip(clipPayloadOf(frames));
    const kept = enqueueClip(clipPayloadOf(createMockFrames(1)));

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));

    expect(deleteQueuedClip(entry.id)).toBe(true);

    // Deletion is deferred: nothing is closed while undo is possible
    for (const frame of frames) {
      expect(frame.frame.close).not.toHaveBeenCalled();
    }
    expect(getClipQueue().map((e) => e.id)).toEqual([kept.entry.id]);
    expect(events).toEqual([expect.objectContaining({ type: 'delete', queueLength: 1 })]);

    vi.advanceTimersByTime(5100);
    expectAllClosedOnce(frames);

    unsubscribe();
    vi.useRealTimers();
  });

  it('undoDelete restores the entry to its original position with frames intact', () => {
    vi.useFakeTimers();
    const framesA = createMockFrames(2);
    const a = enqueueClip(clipPayloadOf(framesA));
    const b = enqueueClip(clipPayloadOf(createMockFrames(2)));
    // Queue (newest first): [b, a] — delete a (index 1), undo restores there
    expect(deleteQueuedClip(a.entry.id)).toBe(true);

    expect(undoDelete()).toBe(true);

    expect(getClipQueue().map((e) => e.id)).toEqual([b.entry.id, a.entry.id]);
    for (const frame of framesA) {
      expect(frame.frame.close).not.toHaveBeenCalled();
    }
    // Grace timer was cancelled — nothing closes later either
    vi.advanceTimersByTime(10000);
    for (const frame of framesA) {
      expect(frame.frame.close).not.toHaveBeenCalled();
    }
    vi.useRealTimers();
  });

  it('a second delete finalizes the previous hold (single-undo model)', () => {
    vi.useFakeTimers();
    const framesA = createMockFrames(2);
    const a = enqueueClip(clipPayloadOf(framesA));
    const b = enqueueClip(clipPayloadOf(createMockFrames(2)));

    deleteQueuedClip(a.entry.id);
    deleteQueuedClip(b.entry.id);

    // a's hold was superseded and released; only b remains undoable
    expectAllClosedOnce(framesA);
    expect(undoDelete()).toBe(true);
    expect(getClipQueue().map((e) => e.id)).toEqual([b.entry.id]);
    vi.useRealTimers();
  });

  it('returns false for an unknown id without closing anything', () => {
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(1)));

    expect(deleteQueuedClip('nope')).toBe(false);
    expectNoClose(entry.frames);
  });
});

describe('releaseAllFramesAndReset drains the queue', () => {
  it('closes active, editor and every queued clip frames, and empties the queue', () => {
    const activeFrames = createMockFrames(2);
    setClipPayload(clipPayloadOf(activeFrames));
    const queued1 = createMockFrames(2);
    const queued2 = createMockFrames(2);
    enqueueClip(clipPayloadOf(queued1));
    enqueueClip(clipPayloadOf(queued2));

    releaseAllFramesAndReset();

    expectAllClosedOnce(activeFrames);
    expectAllClosedOnce(queued1);
    expectAllClosedOnce(queued2);
    expect(getClipQueue()).toHaveLength(0);
    expect(getClipPayload()).toBeNull();
  });
});

describe('memory estimate', () => {
  it('uses conservative raw RGBA w*h*4 across active and queued frames', () => {
    // 100x100 RGBA = 40,000 bytes per frame
    setClipPayload(clipPayloadOf(createMockFrames(2)));
    enqueueClip(clipPayloadOf(createMockFrames(3)));

    const expectedMB = (5 * 100 * 100 * 4) / (1024 * 1024);
    expect(getClipMemoryEstimateMB()).toBeCloseTo(expectedMB, 6);
  });
});
