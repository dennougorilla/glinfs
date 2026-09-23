/**
 * Clip Codec Manager - main-thread bridge to the clip codec worker (#92)
 * @module shared/clip-codec
 *
 * One worker, one job at a time. Jobs are FIFO except that DECODE jobs jump
 * ahead of pending encodes — a user is actively waiting on every decode
 * (promote), while encodes are background housekeeping.
 *
 * Results are result-objects, never rejections, so the app-store's entry
 * state machine can branch without try/catch:
 * - encode -> { ok:true, chunks, config, byteLength }
 *           | { ok:false, error, frames }
 * - decode -> { ok:true, frames } | { ok:false, error }
 *
 * Encode failure contract — the caller tells the two cases apart by
 * comparing frames.length with what it submitted:
 * - RECOVERABLE (encoder/config error in a healthy worker): every input
 *   VideoFrame is transferred back in `frames`; the caller owns them again
 *   and the clip survives.
 * - LOST (worker crash via onerror, terminate(), or a failure after which
 *   the worker could not transfer every frame back): `frames` is [] (or
 *   short). Frames transferred into a dead worker cannot be recovered — the
 *   caller must drop the clip and tell the user (app-store: 'compress-lost').
 *   Only the job RUNNING at that moment is affected: pending jobs have not
 *   transferred anything yet. After a crash they dispatch to a freshly
 *   created worker; after an explicit terminate() (teardown) they are
 *   failed instead, handing their untransferred frames back (RECOVERABLE).
 * Decode never loses data: its input chunks are cloned, not transferred.
 *
 * Feature detection runs ONCE via VideoEncoder.isConfigSupported (vp09
 * preferred, vp8 fallback). isCompressionAvailable() is synchronous and
 * reports false until the probe resolves; entries enqueued in that window
 * simply stay raw, which is the graceful-fallback path anyway.
 *
 * The worker factory is injectable (like CaptureWorkerManager's video seam)
 * so unit tests can drive the protocol without real Workers or WebCodecs.
 */

/** Probed in preference order; 1080p is a representative config, support is
 * not resolution-dependent for these software-decodable codecs */
const CODEC_CANDIDATES = ['vp09.00.10.08', 'vp8'];

/**
 * @typedef {import('../workers/clip-codec-worker.js').SerializedChunk} SerializedChunk
 */

/**
 * @typedef {Object} EncodedClipConfig
 * @property {string} codec
 * @property {number} codedWidth
 * @property {number} codedHeight
 * @property {ArrayBuffer} [description] - Codec-specific decoder extradata
 */

/**
 * @typedef {{ ok: true, chunks: SerializedChunk[], config: EncodedClipConfig, byteLength: number }
 *         | { ok: false, error: string, frames: VideoFrame[] }} EncodeResult
 */

/**
 * @typedef {{ ok: true, frames: VideoFrame[] } | { ok: false, error: string }} DecodeResult
 */

/** Managers whose NEXT encode job is armed to crash the worker (E2E only) */
const crashArmedForTest = new WeakSet();

/**
 * E2E test hook (exposed via __TEST_HOOKS__ only): the worker throws an
 * uncaught error as soon as it receives the manager's NEXT encode job —
 * after its frames were transferred — driving the real onerror crash path.
 *
 * Dev/test builds only: every use is behind import.meta.env.DEV (true under
 * `vite` dev — which Playwright runs — and vitest; false in `vite build`), so
 * production bundles contain neither this hook nor the worker's crash
 * branch. A module function rather than a method, so it tree-shakes away.
 *
 * @param {ClipCodecManager} manager
 */
export function crashNextEncodeForTest(manager) {
  if (import.meta.env.DEV) crashArmedForTest.add(manager);
}

/**
 * Manager for the clip codec worker
 */
export class ClipCodecManager {
  /** @type {Worker | null} */
  #worker = null;

  /** @type {() => Worker} */
  #createWorker;

  /** @type {number} Monotonic job id */
  #nextJobId = 1;

  /** @type {Map<number, {kind: 'encode'|'decode', resolve: (result: any) => void}>} */
  #jobs = new Map();

  /** @type {{jobId: number, kind: 'encode'|'decode', message: Object, transfer: Transferable[]}[]} */
  #pending = [];

  /** @type {number | null} jobId currently running in the worker */
  #activeJobId = null;

  /** @type {boolean | null} null until the probe resolves */
  #available = null;

  /** @type {string | null} Codec chosen by the probe */
  #codec = null;

  /** @type {Promise<boolean> | null} */
  #probePromise = null;

  /**
   * @param {Object} [options]
   * @param {() => Worker} [options.createWorker] - Worker factory (test seam)
   */
  constructor(options = {}) {
    this.#createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL('../workers/clip-codec-worker.js', import.meta.url), {
          type: 'module',
        }));
  }

  /**
   * Probe VideoEncoder support once (cached). Safe to call repeatedly.
   * @returns {Promise<boolean>} true when clip compression is usable
   */
  probeSupport() {
    if (!this.#probePromise) {
      this.#probePromise = this.#runProbe();
    }
    return this.#probePromise;
  }

  /** @returns {Promise<boolean>} */
  async #runProbe() {
    try {
      const VideoEncoderCtor = globalThis.VideoEncoder;
      if (typeof VideoEncoderCtor?.isConfigSupported !== 'function') {
        this.#available = false;
        return false;
      }
      for (const codec of CODEC_CANDIDATES) {
        const support = await VideoEncoderCtor.isConfigSupported({
          codec,
          width: 1920,
          height: 1080,
          bitrate: 8_000_000,
          framerate: 30,
        });
        if (support?.supported) {
          this.#codec = codec;
          this.#available = true;
          return true;
        }
      }
    } catch {
      // Fall through to unavailable
    }
    this.#available = false;
    return false;
  }

  /**
   * Whether compression can be used RIGHT NOW (probe resolved supported).
   * Synchronous by design: callers in the enqueue hot path must not await.
   * @returns {boolean}
   */
  isCompressionAvailable() {
    return this.#available === true;
  }

  /**
   * Encode VideoFrames into compressed chunks.
   * The frames are TRANSFERRED into the worker when the job dispatches —
   * after calling this, the caller's VideoFrame objects must be treated as
   * moved (they stay valid only until dispatch, which may be immediate).
   *
   * @param {VideoFrame[]} frames - Ownership moves to the codec
   * @param {{fps: number, width: number, height: number}} options
   * @returns {Promise<EncodeResult>}
   */
  encode(frames, { fps, width, height }) {
    if (!this.isCompressionAvailable() || !this.#codec) {
      return Promise.resolve({ ok: false, error: 'compression-unavailable', frames });
    }
    const jobId = this.#nextJobId++;
    /** @type {Record<string, unknown>} */
    const payload = { jobId, frames, codec: this.#codec, fps, width, height };
    // Test hook, compiled out of production builds (see crashNextEncodeForTest)
    if (import.meta.env.DEV && crashArmedForTest.delete(this)) {
      payload.crashForTest = true;
    }
    return new Promise((resolve) => {
      this.#jobs.set(jobId, { kind: 'encode', resolve });
      this.#pending.push({
        jobId,
        kind: 'encode',
        message: { type: 'ENCODE', payload },
        transfer: frames,
      });
      this.#pump();
    });
  }

  /**
   * Decode compressed chunks back into VideoFrames (transferred to main).
   *
   * Jumps ahead of pending ENCODE jobs. The chunk buffers are structured-
   * CLONED into the worker (not transferred) on purpose: a decode failure
   * must leave the entry's compressed bytes intact, and compressed clips are
   * small enough (tens of MB) that the copy is cheap next to raw frames.
   *
   * @param {{chunks: SerializedChunk[], config: EncodedClipConfig}} compressed
   * @returns {Promise<DecodeResult>}
   */
  decode({ chunks, config }) {
    const jobId = this.#nextJobId++;
    return new Promise((resolve) => {
      this.#jobs.set(jobId, { kind: 'decode', resolve });
      const job = {
        jobId,
        kind: /** @type {'decode'} */ ('decode'),
        message: { type: 'DECODE', payload: { jobId, chunks, config } },
        transfer: [],
      };
      // Priority: after already-pending decodes, before any pending encode
      const firstEncode = this.#pending.findIndex((p) => p.kind === 'encode');
      if (firstEncode === -1) {
        this.#pending.push(job);
      } else {
        this.#pending.splice(firstEncode, 0, job);
      }
      this.#pump();
    });
  }

  /**
   * Teardown: terminate the worker and fail every job instead of requeueing
   * (unlike the crash path, which keeps pending jobs for a fresh worker).
   * - The RUNNING encode already transferred its frames into the worker:
   *   LOST per the failure contract above (resolved with frames: []).
   * - PENDING encodes never transferred theirs: resolved with the exact
   *   array that was submitted (RECOVERABLE), so ownership returns to the
   *   caller, which keeps or closes them — nothing leaks.
   * Not terminal: the next encode/decode lazily creates a fresh worker.
   */
  terminate() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    const pending = this.#pending;
    this.#pending = [];
    this.#activeJobId = null;
    /** @type {[(result: any) => void, EncodeResult|DecodeResult][]} */
    const settled = [];
    for (const p of pending) {
      const job = this.#jobs.get(p.jobId);
      this.#jobs.delete(p.jobId);
      if (!job) continue;
      settled.push([
        job.resolve,
        p.kind === 'encode'
          ? { ok: false, error: 'terminated', frames: /** @type {VideoFrame[]} */ (p.transfer) }
          : { ok: false, error: 'terminated' },
      ]);
    }
    // Whatever is left was dispatched (the running job)
    for (const job of this.#jobs.values()) {
      settled.push([
        job.resolve,
        job.kind === 'encode'
          ? { ok: false, error: 'terminated', frames: [] }
          : { ok: false, error: 'terminated' },
      ]);
    }
    this.#jobs.clear();
    for (const [resolve, result] of settled) resolve(result);
  }

  /** Dispatch the next pending job if the worker is idle */
  #pump() {
    if (this.#activeJobId !== null) return;
    const next = this.#pending.shift();
    if (!next) return;

    if (!this.#worker) {
      this.#worker = this.#createWorker();
      this.#worker.onmessage = (e) => this.#handleWorkerMessage(e);
      this.#worker.onerror = (e) => this.#handleWorkerError(e);
    }

    this.#activeJobId = next.jobId;
    try {
      this.#worker.postMessage(next.message, next.transfer);
    } catch (err) {
      // A throwing postMessage transfers nothing: the frames are still ours
      // to hand back (RECOVERABLE), not lost
      this.#settle(next.jobId, {
        ok: false,
        error: err instanceof Error ? err.message : 'postMessage failed',
        ...(next.kind === 'encode' ? { frames: next.transfer } : {}),
      });
    }
  }

  /**
   * Resolve a job and run the next one
   * @param {number} jobId
   * @param {EncodeResult|DecodeResult} result
   */
  #settle(jobId, result) {
    const job = this.#jobs.get(jobId);
    this.#jobs.delete(jobId);
    if (this.#activeJobId === jobId) {
      this.#activeJobId = null;
    }
    job?.resolve(result);
    this.#pump();
  }

  /**
   * @param {MessageEvent} e
   */
  #handleWorkerMessage(e) {
    const { type, payload } = e.data;
    switch (type) {
      case 'ENCODE_RESULT':
        this.#settle(payload.jobId, {
          ok: true,
          chunks: payload.chunks,
          config: payload.config,
          byteLength: payload.byteLength,
        });
        break;
      case 'DECODE_RESULT':
        this.#settle(payload.jobId, { ok: true, frames: payload.frames });
        break;
      case 'JOB_ERROR': {
        const job = this.#jobs.get(payload.jobId);
        this.#settle(
          payload.jobId,
          job?.kind === 'encode'
            ? { ok: false, error: payload.message, frames: payload.frames ?? [] }
            : { ok: false, error: payload.message },
        );
        break;
      }
    }
  }

  /**
   * Worker crashed: fail the active job (LOST — its transferred frames are
   * gone with the worker) and recycle the worker: settling pumps the next
   * pending job, which lazily creates a fresh worker in #pump().
   * @param {ErrorEvent} e
   */
  #handleWorkerError(e) {
    console.error('[ClipCodecManager] Worker error:', e.message);
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    const activeJobId = this.#activeJobId;
    if (activeJobId !== null) {
      const job = this.#jobs.get(activeJobId);
      this.#settle(
        activeJobId,
        job?.kind === 'encode'
          ? { ok: false, error: e.message || 'worker crashed', frames: [] }
          : { ok: false, error: e.message || 'worker crashed' },
      );
    }
  }
}

/**
 * Create a ClipCodecManager instance
 * @param {ConstructorParameters<typeof ClipCodecManager>[0]} [options]
 * @returns {ClipCodecManager}
 */
export function createClipCodecManager(options) {
  return new ClipCodecManager(options);
}
