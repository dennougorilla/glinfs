/**
 * GIF trial worker: encodes one frame both ways (whole and differenced) and
 * returns the smaller, for the GIF encoder worker. Two frames' trials then
 * run at once, one here and one in the encoder worker, with the same bytes
 * as when the encoder worker runs both (see gif-frame.js encodeSmaller).
 * @module workers/gif-trial-worker
 */

import { createFrameEncoding, encodeSmaller } from '../features/export/encoders/gif-frame.js';

const whole = createFrameEncoding();
const differenced = createFrameEncoding();

/**
 * @param {MessageEvent<import('./gif-trial-runner.js').TrialJob>} event
 */
self.onmessage = (event) => {
  const job = event.data;
  try {
    whole.start(new Uint8Array(job.index), job.width, job.height, job.wholeOptions);
    differenced.start(new Uint8Array(job.differenced), job.width, job.height, job.keptOptions);
    const bytes = encodeSmaller(whole, differenced).bytes.slice();
    // The index buffers go back for the next job
    self.postMessage(
      { id: job.id, bytes: bytes.buffer, index: job.index, differenced: job.differenced },
      [bytes.buffer, job.index, job.differenced],
    );
  } catch (error) {
    self.postMessage({
      id: job.id,
      error: error instanceof Error ? error.message : 'Trial encoding failed',
    });
  }
};
