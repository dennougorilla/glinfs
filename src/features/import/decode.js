/**
 * Import Decode - turn an image file into clip frames via WebCodecs
 * @module features/import/decode
 *
 * FRAME OWNERSHIP: every VideoFrame created here (decoded source frames and
 * the restamped clones that fill repeated slots) is owned by decodeImageFile until it returns. On ANY
 * error, refusal or abort it closes all of them, and the ImageDecoder, before
 * rethrowing. On success ownership passes to the caller, which must either
 * hand the frames to setClipPayload or close them.
 */

import {
  checkSourceFrameCount,
  checkTotalSlots,
  chooseImportFps,
  computeFrameSlots,
  formatAlphaSupport,
  hasTransparentPixel,
  ImportError,
  resolveImportMimeType,
} from './core.js';

/**
 * @typedef {Object} DecodedImport
 * @property {import('../capture/types.js').Frame[]} frames - One wrapper per
 *   constant-fps slot; repeated slots hold restamped clones of their source
 *   frame (same pixels, own timestamp) and share its sharedKey
 * @property {number} fps - Chosen clip fps
 * @property {number} width
 * @property {number} height
 * @property {boolean} hasAlpha - Any source pixel is not fully opaque
 * @property {number} sourceFrameCount - Frames in the file
 */

/**
 * @typedef {Object} ImportMetadata
 * @property {number} sourceFrameCount
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} DecodeOptions
 * @property {(decoded: number, total: number) => void} [onProgress] - After each source frame
 * @property {(metadata: ImportMetadata) => void} [onMetadata] - Called once the
 *   first frame is decoded (size known) and before the rest are; throw an
 *   ImportError to refuse the import early (e.g. memory budget)
 * @property {AbortSignal} [signal] - Abort decoding (throws ImportError 'aborted')
 */

/** Monotonic suffix so frame ids stay unique across imports */
let importCounter = 0;

/**
 * Throw the import's abort error when the signal fired
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ImportError('aborted', 'Opening the file was cancelled');
  }
}

/**
 * Close VideoFrames, ignoring ones that are already closed
 * @param {Iterable<VideoFrame>} videoFrames
 */
function closeAll(videoFrames) {
  for (const vf of videoFrames) {
    try {
      if (!vf.closed) vf.close();
    } catch {
      // Already closed
    }
  }
}

/**
 * Reusable pixel buffer for alpha scans (grown on demand)
 */
class ScratchBuffer {
  constructor() {
    /** @type {Uint8Array} */
    this.bytes = new Uint8Array(0);
  }

  /**
   * @param {number} size
   * @returns {Uint8Array} A view of exactly `size` bytes
   */
  get(size) {
    if (this.bytes.byteLength < size) {
      this.bytes = new Uint8Array(size);
    }
    return this.bytes.subarray(0, size);
  }
}

/**
 * Read a frame's pixels as RGBA through a 2D canvas (fallback when copyTo
 * cannot convert the frame's native format).
 * @param {VideoFrame} image
 * @returns {Uint8ClampedArray}
 */
function readPixelsViaCanvas(image) {
  const width = image.displayWidth;
  const height = image.displayHeight;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D context');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Whether a decoded frame has any pixel that is not fully opaque.
 * Formats without an alpha channel answer without reading pixels.
 * @param {VideoFrame} image
 * @param {ScratchBuffer} scratch
 * @returns {Promise<boolean>}
 */
export async function frameHasAlpha(image, scratch) {
  const support = formatAlphaSupport(image.format);
  if (support === false) return false;

  if (support === true) {
    // Native RGBA/BGRA: alpha is byte 3 of every pixel either way. The
    // default rect is the visible rect, tightly packed, so no padding bytes
    // can masquerade as transparent pixels.
    const buffer = scratch.get(image.allocationSize());
    await image.copyTo(buffer);
    return hasTransparentPixel(buffer);
  }

  // Unknown / planar-with-alpha formats: ask for an RGBA conversion, and
  // fall back to a canvas readback where copyTo cannot convert
  try {
    const options = /** @type {VideoFrameCopyToOptions} */ ({ format: 'RGBA' });
    const buffer = scratch.get(image.allocationSize(options));
    await image.copyTo(buffer, options);
    return hasTransparentPixel(buffer);
  } catch {
    return hasTransparentPixel(readPixelsViaCanvas(image));
  }
}

/**
 * Decode an image file (GIF, APNG, animated WebP, PNG, JPEG, WebP) into
 * constant-fps clip frames.
 *
 * @param {File|Blob & { name?: string }} file
 * @param {DecodeOptions} [options]
 * @returns {Promise<DecodedImport>}
 * @throws {ImportError} unsupported-type | too-many-frames | decode-failed |
 *   aborted, or whatever onMetadata throws
 */
export async function decodeImageFile(file, options = {}) {
  const { onProgress, onMetadata, signal } = options;
  const name = /** @type {{ name?: string }} */ (file).name ?? 'file';

  const resolvedType = resolveImportMimeType(file);
  if (!resolvedType) {
    throw new ImportError('unsupported-type', `Can't open "${name}" — unsupported file type`);
  }
  // APNG is PNG on the wire: browsers' PNG decoder plays its animation, and
  // not every ImageDecoder recognizes the separate 'image/apng' name
  const type = resolvedType === 'image/apng' ? 'image/png' : resolvedType;
  if (typeof ImageDecoder === 'undefined') {
    throw new ImportError(
      'decode-failed',
      'This browser cannot decode images for editing — use a recent Chrome or Edge',
    );
  }
  if (!(await ImageDecoder.isTypeSupported(type))) {
    throw new ImportError(
      'unsupported-type',
      `Can't open "${name}" — this browser cannot decode ${type} files`,
    );
  }
  throwIfAborted(signal);

  const data = await file.arrayBuffer();
  throwIfAborted(signal);

  /** Every VideoFrame this call created, closed on any failure */
  /** @type {VideoFrame[]} */
  const created = [];
  /** @type {ImageDecoder|null} */
  let decoder = null;

  try {
    try {
      // Unpremultiplied pixels: the export fast path reads frames with
      // VideoFrame.copyTo, and premultiplied RGB would darken the soft
      // edges of PNG/WebP alpha that canvas paths draw correctly
      decoder = new ImageDecoder({ data, type, premultiplyAlpha: 'none' });
      await decoder.tracks.ready;
      // The whole file is in memory, so this resolves as soon as parsing is
      // done and frameCount is final (it can grow while data streams in)
      await decoder.completed;
    } catch (err) {
      throw toDecodeError(name, err);
    }
    throwIfAborted(signal);

    const sourceFrameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
    const countError = checkSourceFrameCount(sourceFrameCount);
    if (countError) throw countError;

    /** @type {VideoFrame[]} */
    const sources = [];
    /** @type {Array<number|null>} */
    const durationsMs = [];
    const scratch = new ScratchBuffer();
    let width = 0;
    let height = 0;
    let hasAlpha = false;

    for (let i = 0; i < sourceFrameCount; i++) {
      throwIfAborted(signal);
      /** @type {VideoFrame} */
      let image;
      try {
        ({ image } = await decoder.decode({ frameIndex: i }));
      } catch (err) {
        throw toDecodeError(name, err);
      }
      created.push(image);
      sources.push(image);
      throwIfAborted(signal);

      if (i === 0) {
        width = image.displayWidth || image.codedWidth;
        height = image.displayHeight || image.codedHeight;
        if (!width || !height) {
          throw new ImportError('decode-failed', `"${name}" has no image data`);
        }
        onMetadata?.({ sourceFrameCount, width, height });
      }

      // image.duration is in microseconds (null for stills)
      durationsMs.push(typeof image.duration === 'number' ? image.duration / 1000 : null);

      // Scan SOURCE frames only (clones share their pixels), and only until
      // the first transparent pixel anywhere in the file
      if (!hasAlpha) {
        hasAlpha = await frameHasAlpha(image, scratch);
      }

      onProgress?.(i + 1, sourceFrameCount);
    }
    throwIfAborted(signal);

    const fps = chooseImportFps(durationsMs);
    // A still image has no timing to preserve: one frame, not a 100 ms run
    const slots = sources.length === 1 ? [1] : computeFrameSlots(durationsMs, fps);
    const totalSlots = slots.reduce((sum, n) => sum + n, 0);
    const slotError = checkTotalSlots(totalSlots, fps);
    if (slotError) throw slotError;

    importCounter += 1;
    const prefix = `import-${Date.now()}-${importCounter}`;
    /** @type {import('../capture/types.js').Frame[]} */
    const frames = [];
    const slotDurationUs = Math.round(1e6 / fps);
    let slotIndex = 0;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const sourceId = `${prefix}-${i}`;
      let sourceUsed = false;
      for (let k = 0; k < slots[i]; k++) {
        const timestamp = Math.round((slotIndex * 1e6) / fps);
        /** @type {VideoFrame} */
        let videoFrame;
        if (k === 0 && source.timestamp === timestamp) {
          // First slot holds the decoded frame itself
          videoFrame = source;
          sourceUsed = true;
        } else {
          // Holds repeat the source as new handles over the SAME pixels (a
          // clone, restamped): every slot needs its own timestamp, or the
          // queue codec would see a run of identical presentation times
          videoFrame = new VideoFrame(source, { timestamp, duration: slotDurationUs });
          created.push(videoFrame);
        }
        frames.push({
          id: k === 0 ? sourceId : `${sourceId}-${k}`,
          frame: videoFrame,
          timestamp,
          width,
          height,
          sharedKey: sourceId,
        });
        slotIndex += 1;
      }
      // Every slot re-wrapped the source: the decoded handle itself is spare
      if (!sourceUsed) source.close();
    }

    return { frames, fps, width, height, hasAlpha, sourceFrameCount };
  } catch (err) {
    closeAll(created);
    throw err;
  } finally {
    try {
      decoder?.close();
    } catch {
      // Already closed
    }
  }
}

/**
 * Wrap a decoder failure as a user-facing ImportError
 * @param {string} name
 * @param {unknown} err
 * @returns {ImportError}
 */
function toDecodeError(name, err) {
  if (err instanceof ImportError) return err;
  console.warn('[Import] Decode failed:', err);
  return new ImportError(
    'decode-failed',
    `Couldn't read "${name}" — the file may be damaged or not a supported image`,
  );
}
