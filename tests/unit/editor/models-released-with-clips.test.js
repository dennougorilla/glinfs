/**
 * The model worker holds the loaded models on the GPU and ONNX Runtime's
 * WASM heap (which never shrinks). A full reset stopped it, but deleting
 * clips one by one never did, so after the last clip was gone the models
 * and the heap stayed for the rest of the session (task 13: 4.3 GB of GPU
 * memory and 1.6 GB of renderer memory after every clip was deleted). The
 * worker now stops when the last clip is released for good, and only then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  const fake = { dispose: vi.fn(), forgetClip: vi.fn() };
  return { ...actual, getSegmentationManager: () => fake, __fake: fake };
});

import * as segmentation from '../../../src/features/ai-cutout/segmentation-manager.js';
import '../../../src/features/editor/index.js';
import {
  deleteActiveClip,
  getClipPayload,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { emit } from '../../../src/shared/bus.js';

const fake = /** @type {any} */ (segmentation).__fake;

/** A clip payload with frames that only need to be closable */
function clip(id) {
  const frames = Array.from({ length: 3 }, () => ({
    frame: { close: vi.fn(), closed: false, displayWidth: 4, displayHeight: 4 },
    width: 4,
    height: 4,
    timestamp: 0,
  }));
  return { id, frames, fps: 30, width: 4, height: 4, capturedAt: Date.now() };
}

/** Let queued microtasks run */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('the model worker goes with the last clip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    fake.dispose.mockClear();
    fake.forgetClip.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the worker when the only clip is deleted and its Undo window ends', async () => {
    setClipPayload(clip('a'));
    deleteActiveClip();
    await flush();
    expect(fake.dispose).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await flush();

    expect(getClipPayload()).toBeNull();
    expect(fake.forgetClip).toHaveBeenCalledWith('a');
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the worker while another clip is open', async () => {
    setClipPayload(clip('b'));
    emit('clips:released', { ids: ['a'], reset: false });
    await flush();

    expect(fake.forgetClip).toHaveBeenCalledWith('a');
    expect(fake.dispose).not.toHaveBeenCalled();
  });
});
