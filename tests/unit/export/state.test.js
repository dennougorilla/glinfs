import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelEncodingState,
  closeDialog,
  completeEncoding,
  createEncodingJob,
  createExportStore,
  failEncoding,
  initExportState,
  openDialog,
  resetExport,
  setEncoderStatus,
  setPreviewPlaying,
  startEncoding,
  togglePreviewPlaying,
  updateProgress,
  updateSettings,
} from '../../../src/features/export/state.js';

/**
 * Minimal clip fixture matching the shape openDialog() expects:
 * a frame with width/height and a selectedRange.
 */
function makeClip(overrides = {}) {
  return {
    frames: [{ width: 100, height: 50, data: new Uint8ClampedArray(4) }],
    selectedRange: { start: 0, end: 9 },
    ...overrides,
  };
}

describe('initExportState', () => {
  it('creates the default export state shape', () => {
    const state = initExportState();

    expect(state.isDialogOpen).toBe(false);
    expect(state.job).toBeNull();
    expect(state.estimatedSizeMB).toBe(0);
    expect(state.encoderStatus).toBe('gifenc-js');
    expect(state.preview).toEqual({ isPlaying: true });
    expect(state.settings).toBeTypeOf('object');
  });
});

describe('openDialog', () => {
  it('opens the dialog and computes an estimated size from the clip', () => {
    const state = initExportState();
    const clip = makeClip();

    const next = openDialog(state, clip, null);

    expect(next.isDialogOpen).toBe(true);
    expect(next.estimatedSizeMB).toBeGreaterThan(0);
    // Original state is untouched (immutability)
    expect(state.isDialogOpen).toBe(false);
  });

  it('accounts for a crop area when computing dimensions', () => {
    const state = initExportState();
    const clip = makeClip();
    const crop = { x: 0, y: 0, width: 10, height: 10 };

    const cropped = openDialog(state, clip, crop);
    const uncropped = openDialog(state, clip, null);

    expect(cropped.estimatedSizeMB).toBeLessThan(uncropped.estimatedSizeMB);
  });
});

describe('closeDialog', () => {
  it('closes the dialog and clears any in-progress job', () => {
    const state = {
      ...initExportState(),
      isDialogOpen: true,
      job: createEncodingJob(10, 'gifenc-js'),
    };

    const next = closeDialog(state);

    expect(next.isDialogOpen).toBe(false);
    expect(next.job).toBeNull();
  });
});

describe('updateSettings', () => {
  it('merges partial settings and recomputes estimated size', () => {
    const state = initExportState();
    const dims = { frameCount: 20, width: 200, height: 100 };

    const next = updateSettings(state, { quality: 1.0 }, dims);

    expect(next.settings.quality).toBe(1.0);
    // Unrelated settings survive the merge
    expect(next.settings.dithering).toBe(state.settings.dithering);
    expect(next.estimatedSizeMB).toBeGreaterThan(0);
  });

  it('produces a larger estimate for higher quality settings', () => {
    const state = initExportState();
    const dims = { frameCount: 20, width: 200, height: 100 };

    const low = updateSettings(state, { quality: 0.1 }, dims);
    const high = updateSettings(state, { quality: 1.0 }, dims);

    expect(high.estimatedSizeMB).toBeGreaterThan(low.estimatedSizeMB);
  });
});

describe('createEncodingJob', () => {
  it('creates a job in the preparing state with a fresh id', () => {
    const job = createEncodingJob(42, 'gifenc-js');

    expect(job.status).toBe('preparing');
    expect(job.progress).toBe(0);
    expect(job.currentFrame).toBe(0);
    expect(job.totalFrames).toBe(42);
    expect(job.encoder).toBe('gifenc-js');
    expect(job.result).toBeNull();
    expect(job.error).toBeNull();
    expect(job.id).toBeTruthy();

    const job2 = createEncodingJob(42, 'gifenc-js');
    expect(job2.id).not.toBe(job.id);
  });
});

describe('startEncoding', () => {
  it('attaches the job to state and marks it encoding', () => {
    const state = initExportState();
    const job = createEncodingJob(10, 'gifenc-js');

    const next = startEncoding(state, job);

    expect(next.job.status).toBe('encoding');
    expect(next.job.id).toBe(job.id);
  });
});

describe('updateProgress', () => {
  it('is a no-op when there is no active job', () => {
    const state = initExportState();

    const next = updateProgress(state, { percent: 50, current: 5 });

    expect(next).toBe(state);
  });

  it('updates progress and current frame on the active job', () => {
    const state = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));

    const next = updateProgress(state, { percent: 50, current: 5, estimatedRemaining: 1200 });

    expect(next.job.progress).toBe(50);
    expect(next.job.currentFrame).toBe(5);
    expect(next.job.estimatedRemaining).toBe(1200);
  });

  it('preserves the prior estimatedRemaining when omitted', () => {
    let state = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));
    state = updateProgress(state, { percent: 20, current: 2, estimatedRemaining: 900 });

    const next = updateProgress(state, { percent: 30, current: 3 });

    expect(next.job.estimatedRemaining).toBe(900);
  });
});

describe('completeEncoding', () => {
  it('is a no-op when there is no active job', () => {
    const state = initExportState();

    const next = completeEncoding(state, new Blob());

    expect(next).toBe(state);
  });

  it('marks the job complete with the result attached', () => {
    const state = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));
    const blob = new Blob(['gif-bytes']);

    const next = completeEncoding(state, blob);

    expect(next.job.status).toBe('complete');
    expect(next.job.progress).toBe(100);
    expect(next.job.result).toBe(blob);
  });
});

describe('failEncoding', () => {
  it('is a no-op when there is no active job', () => {
    const state = initExportState();

    const next = failEncoding(state, 'boom');

    expect(next).toBe(state);
  });

  it('marks the job errored with the message attached', () => {
    const state = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));

    const next = failEncoding(state, 'encoder crashed');

    expect(next.job.status).toBe('error');
    expect(next.job.error).toBe('encoder crashed');
  });
});

describe('cancelEncodingState', () => {
  it('is a no-op when there is no active job', () => {
    const state = initExportState();

    const next = cancelEncodingState(state);

    expect(next).toBe(state);
  });

  it('marks the job errored with a cancellation message', () => {
    const state = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));

    const next = cancelEncodingState(state);

    expect(next.job.status).toBe('error');
    expect(next.job.error).toBe('Encoding cancelled by user');
  });
});

describe('resetExport', () => {
  it('clears the job regardless of prior state', () => {
    const withJob = startEncoding(initExportState(), createEncodingJob(10, 'gifenc-js'));

    expect(resetExport(withJob).job).toBeNull();
    expect(resetExport(initExportState()).job).toBeNull();
  });
});

describe('setEncoderStatus', () => {
  it('updates the encoder status field', () => {
    const state = initExportState();

    const next = setEncoderStatus(state, 'unavailable');

    expect(next.encoderStatus).toBe('unavailable');
  });
});

describe('togglePreviewPlaying', () => {
  it('flips isPlaying from true to false and back', () => {
    const state = initExportState();
    expect(state.preview.isPlaying).toBe(true);

    const paused = togglePreviewPlaying(state);
    expect(paused.preview.isPlaying).toBe(false);

    const resumed = togglePreviewPlaying(paused);
    expect(resumed.preview.isPlaying).toBe(true);
  });
});

describe('setPreviewPlaying', () => {
  it('sets isPlaying explicitly', () => {
    const state = initExportState();

    expect(setPreviewPlaying(state, false).preview.isPlaying).toBe(false);
    expect(setPreviewPlaying(state, true).preview.isPlaying).toBe(true);
  });
});

describe('createExportStore', () => {
  it('creates a store seeded with the default export state and reacts to updates', () => {
    const store = createExportStore();

    expect(store.getState()).toEqual(initExportState());

    const listener = vi.fn();
    store.subscribe(listener);

    store.setState((state) => setEncoderStatus(state, 'unavailable'));

    expect(store.getState().encoderStatus).toBe('unavailable');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
