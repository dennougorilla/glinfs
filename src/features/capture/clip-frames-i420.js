/**
 * The open clip's frames move off the GPU in the background (D3's cheap
 * half, #233).
 *
 * A clip from the capture buffer opens at once on its GPU RGBA VideoFrames,
 * as before #233. Then clones of them go to the converter worker, and each
 * frame is swapped for its CPU I420 copy (1.5 B/px instead of 4) as the copy
 * lands; the GPU frame is closed right away. Waiting for every copy before
 * the editor showed cost 1.2 s at 1080p on win-r9.
 *
 * The swap is in place (the Frame wrapper's `frame` and `byteLength`), so
 * everything holding the clip sees the copy from then on. Readers take
 * `frame.frame` right before they use it, so none holds a GPU frame across
 * the swap. A swap applies only while the clip is still the open one: a
 * clip that left was queued (and is being encoded from the frames it had)
 * or deleted (held for Undo), so its frames stay as they are.
 *
 * Memory: the clip is counted at its I420 size from the start
 * (countAsCpuCopies), as the budget check before it opened assumed; for the
 * second or so the copies take, it holds the RGBA frames the capture buffer
 * held a moment before. Frames no copy reached are counted as RGBA again.
 *
 * @module features/capture/clip-frames-i420
 */

import { getClipPayload } from '../../shared/app-store.js';
import { I420_COLOR_SPACE, i420Layout } from '../../shared/i420.js';
import { convertToI420, isCpuFrameConversionAvailable } from '../../workers/i420-converter.js';

/** Formats of a VideoFrame whose pixels are already in CPU memory */
const CPU_FORMATS = new Set(['I420', 'I420A', 'NV12']);

/**
 * Frame lists being converted now (one job per clip)
 * @type {WeakSet<import('./types.js').Frame[]>}
 */
const converting = new WeakSet();

/**
 * @param {import('./types.js').Frame} frame
 * @returns {boolean}
 */
function isGpuFrame(frame) {
  const vf = frame.frame;
  return (
    vf != null &&
    typeof vf.clone === 'function' &&
    vf.codedWidth > 0 &&
    !CPU_FORMATS.has(vf.format ?? '')
  );
}

/**
 * Count a new clip's GPU frames at the size of their CPU I420 copies, which
 * convertOpenClipFrames makes once the clip is open. Nothing changes where
 * no converter runs.
 * @param {import('./types.js').Frame[]} frames
 */
export function countAsCpuCopies(frames) {
  if (!isCpuFrameConversionAvailable()) return;
  for (const frame of frames) {
    if (isGpuFrame(frame)) frame.byteLength = i420Layout(frame.width, frame.height).size;
  }
}

/**
 * Start moving the open clip's GPU frames to CPU I420 copies, if any are
 * left and no job runs for them yet. Cheap to call on every change of the
 * open clip.
 * @returns {Promise<void> | null} The job, or null when there is nothing to do
 */
export function convertOpenClipFrames() {
  const frames = getClipPayload()?.frames;
  if (!frames || converting.has(frames) || !isCpuFrameConversionAvailable()) return null;
  const targets = frames.filter(isGpuFrame);
  if (targets.length === 0) return null;
  // One size per job: a clip has one (the newest source's frames)
  const { codedWidth, codedHeight } = targets[0].frame;
  const sized = targets.filter(
    (f) => f.frame.codedWidth === codedWidth && f.frame.codedHeight === codedHeight,
  );

  /** @type {Array<{ id: string, timestamp: number, source: VideoFrame }>} */
  const items = [];
  /** @type {import('./types.js').Frame[]} */
  const wrappers = [];
  /** @type {import('./types.js').Frame['frame'][]} */
  const originals = [];
  for (const wrapper of sized) {
    try {
      items.push({ id: wrapper.id, timestamp: wrapper.timestamp, source: wrapper.frame.clone() });
      wrappers.push(wrapper);
      originals.push(wrapper.frame);
    } catch {
      // Closed meanwhile: nothing to copy
    }
  }
  if (items.length === 0) return null;

  converting.add(frames);
  const isOpen = () => getClipPayload()?.frames === frames;
  // The frames still on the GPU when the job ends count as RGBA again
  const settle = () => {
    wrappers.forEach((wrapper, i) => {
      if (wrapper.frame === originals[i]) delete wrapper.byteLength;
    });
    converting.delete(frames);
  };
  return convertToI420(items, {
    onFrame: ({ index, width, height, data }) => {
      const wrapper = wrappers[index];
      const old = wrapper?.frame;
      if (!wrapper || !isOpen() || !old || old.codedWidth === 0) return;
      let copy;
      try {
        copy = new VideoFrame(data, {
          format: 'I420',
          codedWidth: width,
          codedHeight: height,
          timestamp: old.timestamp,
          colorSpace: I420_COLOR_SPACE,
          transfer: [data],
        });
      } catch (err) {
        console.warn('[Capture] Could not make a frame from the converted bytes:', err);
        return;
      }
      wrapper.frame = copy;
      wrapper.byteLength = i420Layout(width, height).size;
      old.close();
    },
  }).then(
    ({ rest, lost }) => {
      // Given back unconverted: the clones are ours to close; the clip keeps
      // those frames on the GPU
      for (const { item } of rest) item.source?.close();
      if (lost > 0)
        console.warn(`[Capture] ${lost} frames stayed on the GPU (converter lost them)`);
      settle();
    },
    (err) => {
      console.warn('[Capture] Moving the clip off the GPU failed:', err);
      settle();
    },
  );
}
