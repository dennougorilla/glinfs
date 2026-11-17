/**
 * Clip Codec Worker - WebCodecs encode/decode off the main thread (#92)
 *
 * Runs one job at a time (the ClipCodecManager serializes jobs and gives
 * decode priority). Encode turns transferred VideoFrames into
 * EncodedVideoChunk bytes; decode turns those bytes back into VideoFrames
 * transferred to the main thread.
 *
 * Frame-ownership contract (mirrors the app-store rules):
 * - ENCODE receives its VideoFrames by TRANSFER — this worker owns them.
 *   They are closed here ONLY after the encoder flush succeeds. On a caught
 *   failure every input frame is transferred BACK in the JOB_ERROR message,
 *   so a recoverable encode error never destroys a clip. If they cannot all
 *   be transferred back — or this worker crashes outright — the frames are
 *   lost; the main thread detects the short/empty `frames` and drops the
 *   clip with a user-visible notice (see clip-codec.js failure contract).
 * - DECODE never holds the decoder's own output frames: each one is copied
 *   into a frame this worker owns and closed at once. A decoder may draw
 *   its output from a small fixed pool (hardware decoders do) and stops
 *   until a picture comes back, so holding them until flush() would hang
 *   every clip longer than the pool. The copies are transferred to the
 *   main thread, which owns them from then on. On failure, the copies made
 *   so far are closed here (the main thread never saw them).
 *
 * @module workers/clip-codec-worker
 */

/** Emit a keyframe every N frames so decode never depends on one fragile key */
const KEYFRAME_INTERVAL = 150;

/** Bitrate cap in bits/s (quality-biased: min(20Mbps, w*h*fps*0.15)) */
const MAX_BITRATE = 20_000_000;

/**
 * @typedef {Object} SerializedChunk
 * @property {'key'|'delta'} type
 * @property {number} timestamp
 * @property {number|null} duration
 * @property {ArrayBuffer} data
 */

self.onmessage = (e) => {
  const { type, payload } = e.data;
  switch (type) {
    case 'ENCODE':
      if (import.meta.env.DEV && payload.crashForTest) {
        // Test hook (clip-codec.js crashNextEncodeForTest; compiled out of
        // production builds): an uncaught error in a timer escapes to the
        // Worker's onerror on the main thread, exactly like a real crash —
        // the frames just transferred in are lost with this worker.
        setTimeout(() => {
          throw new Error('clip-codec-worker: forced crash (test hook)');
        }, 0);
        break;
      }
      void handleEncode(payload);
      break;
    case 'DECODE':
      void handleDecode(payload);
      break;
  }
};

/** Progress reports per job: at most one per this many ms */
const PROGRESS_EVERY_MS = 250;

/**
 * A function that tells the manager the job is moving (its stall watchdog,
 * clip-codec.js): called whenever the codec accepts input or emits output,
 * posting at most every PROGRESS_EVERY_MS
 * @param {number} jobId
 * @returns {() => void}
 */
function progressReporter(jobId) {
  let last = -Infinity;
  return () => {
    const now = performance.now();
    if (now - last < PROGRESS_EVERY_MS) return;
    last = now;
    self.postMessage({ type: 'JOB_PROGRESS', payload: { jobId } });
  };
}

/**
 * Close a VideoFrame, tolerating already-closed frames
 * @param {VideoFrame} frame
 */
function closeSafe(frame) {
  try {
    frame.close();
  } catch {
    // Already closed
  }
}

/**
 * Copy a BufferSource (e.g. decoderConfig.description) into a standalone
 * ArrayBuffer that can be transferred.
 * @param {AllowSharedBufferSource|undefined} source
 * @returns {ArrayBuffer|undefined}
 */
function copyToArrayBuffer(source) {
  if (!source) return undefined;
  if (source instanceof ArrayBuffer) return source.slice(0);
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  }
  return undefined;
}

/**
 * Encode transferred VideoFrames into chunks + decoder config.
 *
 * @param {Object} payload
 * @param {number} payload.jobId
 * @param {VideoFrame[]} payload.frames - Transferred in; owned here
 * @param {string} payload.codec - Probed codec string (vp09.* or vp8)
 * @param {number} payload.fps
 * @param {number} payload.width
 * @param {number} payload.height
 */
async function handleEncode({ jobId, frames, codec, fps, width, height }) {
  /** @type {SerializedChunk[]} */
  const chunks = [];
  let byteLength = 0;
  /** @type {VideoDecoderConfig|null} */
  let decoderConfig = null;
  const progress = progressReporter(jobId);

  try {
    /** @type {(reason: Error) => void} */
    let failEncode = () => {};
    const encoderFailed = new Promise((_resolve, reject) => {
      failEncode = reject;
    });
    // Swallow the rejection when flush() settles first — without a handler
    // an unconsumed encoderFailed would surface as an unhandled rejection.
    encoderFailed.catch(() => {});

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        progress();
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({
          type: chunk.type === 'key' ? 'key' : 'delta',
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? null,
          data,
        });
        byteLength += chunk.byteLength;
        if (metadata?.decoderConfig && !decoderConfig) {
          decoderConfig = metadata.decoderConfig;
        }
      },
      error: (err) => failEncode(err instanceof Error ? err : new Error(String(err))),
    });
    encoder.addEventListener('dequeue', progress);

    encoder.configure({
      codec,
      width,
      height,
      bitrate: Math.min(MAX_BITRATE, Math.round(width * height * fps * 0.15)),
      framerate: fps,
      latencyMode: 'quality',
    });

    frames.forEach((frame, index) => {
      // Frames stay OPEN until flush succeeds: closing as we go would make a
      // mid-encode failure unrecoverable (the never-lost guarantee).
      encoder.encode(frame, { keyFrame: index % KEYFRAME_INTERVAL === 0 });
    });

    await Promise.race([encoder.flush(), encoderFailed]);
    encoder.close();

    // Success: the raw frames end here
    for (const frame of frames) closeSafe(frame);

    const description = copyToArrayBuffer(decoderConfig?.description);
    /** @type {ArrayBuffer[]} */
    const transfer = chunks.map((c) => c.data);
    if (description) transfer.push(description);

    self.postMessage(
      {
        type: 'ENCODE_RESULT',
        payload: {
          jobId,
          chunks,
          config: {
            codec: decoderConfig?.codec ?? codec,
            codedWidth: decoderConfig?.codedWidth ?? width,
            codedHeight: decoderConfig?.codedHeight ?? height,
            description,
          },
          byteLength,
        },
      },
      transfer,
    );
  } catch (err) {
    // Failure: hand every surviving frame BACK to the main thread so the
    // queue entry can stay raw instead of losing the clip.
    const message = err instanceof Error ? err.message : 'Encode failed';
    try {
      self.postMessage({ type: 'JOB_ERROR', payload: { jobId, message, frames } }, frames);
    } catch {
      // Frames could not be transferred back (e.g. some already closed by a
      // dying encoder) — close the rest and report the plain error.
      for (const frame of frames) closeSafe(frame);
      self.postMessage({ type: 'JOB_ERROR', payload: { jobId, message, frames: [] } });
    }
  }
}

/**
 * Decode chunks back into VideoFrames and transfer them to the main thread.
 *
 * @param {Object} payload
 * @param {number} payload.jobId
 * @param {SerializedChunk[]} payload.chunks
 * @param {{codec: string, codedWidth: number, codedHeight: number, description?: ArrayBuffer}} payload.config
 */
async function handleDecode({ jobId, chunks, config }) {
  /** @type {VideoFrame[]} */
  const frames = [];
  /** @type {Promise<void>[]} */
  const copies = [];
  const progress = progressReporter(jobId);

  try {
    /** @type {(reason: Error) => void} */
    let failDecode = () => {};
    const decoderFailed = new Promise((_resolve, reject) => {
      failDecode = reject;
    });
    decoderFailed.catch(() => {});

    const decoder = new VideoDecoder({
      output: (frame) => {
        const copy = ownedCopy(frame).then(
          (owned) => {
            frames.push(owned);
            progress();
          },
          (err) => failDecode(err instanceof Error ? err : new Error(String(err))),
        );
        copies.push(copy);
      },
      error: (err) => failDecode(err instanceof Error ? err : new Error(String(err))),
    });
    decoder.addEventListener('dequeue', progress);

    decoder.configure({
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      ...(config.description ? { description: config.description } : {}),
    });

    for (const chunk of chunks) {
      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.type,
          timestamp: chunk.timestamp,
          ...(chunk.duration != null ? { duration: chunk.duration } : {}),
          data: chunk.data,
        }),
      );
    }

    await Promise.race([decoder.flush(), decoderFailed]);
    await Promise.race([Promise.all(copies), decoderFailed]);
    decoder.close();

    // Presentation order (all-progressive input should already be ordered,
    // but the decoder makes no such promise)
    frames.sort((a, b) => a.timestamp - b.timestamp);

    self.postMessage({ type: 'DECODE_RESULT', payload: { jobId, frames } }, frames);
  } catch (err) {
    // The main thread never owned these frames — close them here, also
    // the copies still in flight when the decode failed
    for (const frame of frames) closeSafe(frame);
    void Promise.allSettled(copies).then(() => {
      for (const frame of frames) closeSafe(frame);
    });
    const message = err instanceof Error ? err.message : 'Decode failed';
    self.postMessage({ type: 'JOB_ERROR', payload: { jobId, message } });
  }
}

/**
 * Copy a decoder output frame into a frame backed by memory this worker
 * owns, and close the decoder's frame right away (returning its picture
 * buffer to the decoder). The copy keeps the format, the visible size,
 * the timing and the colour space.
 * @param {VideoFrame} frame - Closed by this function
 * @returns {Promise<VideoFrame>}
 */
async function ownedCopy(frame) {
  try {
    const format = frame.format;
    if (format === null) {
      // Opaque frame (no CPU-readable layout): draw it instead
      const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
      /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(
        frame,
        0,
        0,
      );
      return new VideoFrame(canvas, {
        timestamp: frame.timestamp,
        ...(frame.duration != null ? { duration: frame.duration } : {}),
      });
    }
    const rect = frame.visibleRect;
    const data = new ArrayBuffer(frame.allocationSize());
    const layout = await frame.copyTo(data);
    return new VideoFrame(data, {
      format,
      codedWidth: rect?.width ?? frame.codedWidth,
      codedHeight: rect?.height ?? frame.codedHeight,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      timestamp: frame.timestamp,
      ...(frame.duration != null ? { duration: frame.duration } : {}),
      layout,
      colorSpace: frame.colorSpace?.toJSON?.() ?? undefined,
    });
  } finally {
    closeSafe(frame);
  }
}
