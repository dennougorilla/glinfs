/**
 * Clip Codec Manager - main-thread bridge to the clip codec worker (#92)
 * @module shared/clip-codec
 *
 * Two workers: one runs the encodes, one the decodes, each one job at a time
 * in order. A user is waiting on every decode (opening a queued clip), while
 * encodes are background housekeeping, so a decode never waits for an
 * encode (a 1080p compression takes seconds). Running both at once adds no
 * frame memory: the encode's frames are alive until it finishes either way.
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
 *   Only the job RUNNING on that worker is affected: pending jobs have not
 *   transferred anything yet. After a crash they dispatch to a freshly
 *   created worker (the other worker carries on); after an explicit terminate() (teardown) they are
 *   failed instead, handing their untransferred frames back (RECOVERABLE).
 * Decode never loses data: its input chunks are cloned, not transferred.
 *
 * Nothing waits forever: the worker reports progress (JOB_PROGRESS) while a
 * job runs, at least as often as the codec accepts input or emits output. A
 * running job with neither a reply nor progress for `stallMs` is STALLED
 * (a decoder that stopped handing out frames, a wedged GPU process): its
 * worker is terminated, the job fails with error 'stalled' (an encode as
 * LOST, its frames died with the worker) and the queue continues on a
 * fresh worker. The bound is on silence, not on the job's length, so long
 * clips are not cut off.
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
 * Silence that makes a running job stalled. The worker reports progress at
 * most every 250 ms while the codec moves. Measured on a Mac M3 (Chrome
 * 157, 300 x 1080p and 60 x 4K VP9, hardware and software): the first
 * report came 20-50 ms after the job started and the longest gap between
 * reports was 265 ms. 15 s is about 60 times that, a wide margin for slow
 * PCs, while a stalled open still ends in seconds instead of never.
 */
export const CODEC_STALL_MS = 15_000;

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
 * @typedef {{jobId: number, kind: 'encode'|'decode', message: Object, transfer: Transferable[]}} PendingJob
 */

/**
 * One worker and its queue
 * @typedef {Object} Lane
 * @property {'encode'|'decode'} kind
 * @property {Worker | null} worker - Created when the first job dispatches
 * @property {PendingJob[]} pending
 * @property {number | null} activeJobId - Job running in the worker
 * @property {ReturnType<typeof setTimeout> | null} watchdog
 */

/**
 * @param {'encode'|'decode'} kind
 * @returns {Lane}
 */
function createLane(kind) {
  return { kind, worker: null, pending: [], activeJobId: null, watchdog: null };
}

/** @param {Lane} lane */
function disarm(lane) {
  if (lane.watchdog !== null) clearTimeout(lane.watchdog);
  lane.watchdog = null;
}

/**
 * Manager for the clip codec workers
 */
export class ClipCodecManager {
  /** @type {() => Worker} */
  #createWorker;

  /** @type {number} Monotonic job id */
  #nextJobId = 1;

  /** @type {Map<number, {kind: 'encode'|'decode', resolve: (result: any) => void}>} */
  #jobs = new Map();

  /** @type {Record<'encode'|'decode', Lane>} One worker per kind of job */
  #lanes = { encode: createLane('encode'), decode: createLane('decode') };

  /** @type {boolean | null} null until the probe resolves */
  #available = null;

  /** @type {string | null} Codec chosen by the probe */
  #codec = null;

  /** @type {Promise<boolean> | null} */
  #probePromise = null;

  /** Silence (ms) after which the running job is stalled */
  #stallMs;

  /**
   * @param {Object} [options]
   * @param {() => Worker} [options.createWorker] - Worker factory (test seam)
   * @param {number} [options.stallMs] - Stall bound (default CODEC_STALL_MS)
   */
  constructor(options = {}) {
    this.#stallMs = options.stallMs ?? CODEC_STALL_MS;
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
      this.#lanes.encode.pending.push({
        jobId,
        kind: 'encode',
        message: { type: 'ENCODE', payload },
        transfer: frames,
      });
      this.#pump(this.#lanes.encode);
    });
  }

  /**
   * Whether the encode submitted with exactly this frames array is still
   * waiting in the queue (not dispatched to the worker yet) (#186)
   * @param {VideoFrame[]} frames - The array passed to encode()
   * @returns {boolean}
   */
  isEncodeQueued(frames) {
    return this.#lanes.encode.pending.some((p) => p.transfer === frames);
  }

  /**
   * Withdraw a queued encode before it dispatches (#186: its clip was
   * removed to make room). Nothing was transferred, so the job resolves as
   * a RECOVERABLE failure carrying the submitted frames — ownership is the
   * caller's again. A job already running in the worker cannot be withdrawn
   * (its frames are there until it settles): returns false.
   * @param {VideoFrame[]} frames - The array passed to encode()
   * @returns {boolean} true if the job was withdrawn
   */
  cancelEncode(frames) {
    const { pending } = this.#lanes.encode;
    const index = pending.findIndex((p) => p.transfer === frames);
    if (index === -1) return false;
    const [p] = pending.splice(index, 1);
    const job = this.#jobs.get(p.jobId);
    this.#jobs.delete(p.jobId);
    job?.resolve({ ok: false, error: 'cancelled', frames });
    return true;
  }

  /**
   * Decode compressed chunks back into VideoFrames (transferred to main).
   *
   * Runs on the decode worker, so it never waits for an encode. The chunk
   * buffers are structured-
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
      this.#lanes.decode.pending.push({
        jobId,
        kind: 'decode',
        message: { type: 'DECODE', payload: { jobId, chunks, config } },
        transfer: [],
      });
      this.#pump(this.#lanes.decode);
    });
  }

  /**
   * Teardown: terminate both workers and fail every job instead of requeueing
   * (unlike the crash path, which keeps pending jobs for a fresh worker).
   * - The RUNNING encode already transferred its frames into the worker:
   *   LOST per the failure contract above (resolved with frames: []).
   * - PENDING encodes never transferred theirs: resolved with the exact
   *   array that was submitted (RECOVERABLE), so ownership returns to the
   *   caller, which keeps or closes them — nothing leaks.
   * Not terminal: the next encode/decode lazily creates a fresh worker.
   */
  terminate() {
    /** @type {PendingJob[]} */
    const pending = [];
    for (const lane of Object.values(this.#lanes)) {
      lane.worker?.terminate();
      lane.worker = null;
      pending.push(...lane.pending);
      lane.pending = [];
      lane.activeJobId = null;
      disarm(lane);
    }
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

  /**
   * Dispatch the lane's next pending job if its worker is idle
   * @param {Lane} lane
   */
  #pump(lane) {
    if (lane.activeJobId !== null) return;
    const next = lane.pending.shift();
    if (!next) return;

    if (!lane.worker) {
      const worker = this.#createWorker();
      worker.onmessage = (e) => this.#handleWorkerMessage(lane, e);
      worker.onerror = (e) => {
        // A replaced worker's late error concerns nothing running now
        if (lane.worker === worker) this.#handleWorkerError(lane, e);
      };
      lane.worker = worker;
    }

    lane.activeJobId = next.jobId;
    this.#arm(lane);
    try {
      lane.worker.postMessage(next.message, next.transfer);
    } catch (err) {
      // A throwing postMessage transfers nothing: the frames are still ours
      // to hand back (RECOVERABLE), not lost
      this.#settle(lane, next.jobId, {
        ok: false,
        error: err instanceof Error ? err.message : 'postMessage failed',
        ...(next.kind === 'encode' ? { frames: next.transfer } : {}),
      });
    }
  }

  /**
   * Resolve a job and run the lane's next one
   * @param {Lane} lane
   * @param {number} jobId
   * @param {EncodeResult|DecodeResult} result
   */
  #settle(lane, jobId, result) {
    const job = this.#jobs.get(jobId);
    this.#jobs.delete(jobId);
    if (lane.activeJobId === jobId) {
      lane.activeJobId = null;
      disarm(lane);
    }
    job?.resolve(result);
    this.#pump(lane);
  }

  /**
   * (Re)start the stall bound for the lane's running job
   * @param {Lane} lane
   */
  #arm(lane) {
    disarm(lane);
    lane.watchdog = setTimeout(() => this.#handleStall(lane), this.#stallMs);
  }

  /**
   * The lane's running job went silent: end its worker and fail it, like a
   * crash (its next pending job then starts on a fresh worker; the other
   * lane is not touched)
   * @param {Lane} lane
   */
  #handleStall(lane) {
    lane.watchdog = null;
    const activeJobId = lane.activeJobId;
    if (activeJobId === null) return;
    console.error(`[ClipCodecManager] ${lane.kind} stalled: no progress for ${this.#stallMs} ms`);
    lane.worker?.terminate();
    lane.worker = null;
    this.#settle(
      lane,
      activeJobId,
      lane.kind === 'encode'
        ? { ok: false, error: 'stalled', frames: [] }
        : { ok: false, error: 'stalled' },
    );
  }

  /**
   * @param {Lane} lane
   * @param {MessageEvent} e
   */
  #handleWorkerMessage(lane, e) {
    const { type, payload } = e.data;
    if (
      (type === 'DECODE_RESULT' || type === 'JOB_ERROR') &&
      Array.isArray(payload?.frames) &&
      !this.#jobs.has(payload.jobId)
    ) {
      // A reply for a job already settled (stalled, terminated): nobody
      // will take its frames, so they end here
      for (const frame of payload.frames) {
        try {
          frame.close();
        } catch {
          // Already closed
        }
      }
      return;
    }
    switch (type) {
      case 'JOB_PROGRESS':
        if (payload?.jobId === lane.activeJobId) this.#arm(lane);
        break;
      case 'ENCODE_RESULT':
        this.#settle(lane, payload.jobId, {
          ok: true,
          chunks: payload.chunks,
          config: payload.config,
          byteLength: payload.byteLength,
        });
        break;
      case 'DECODE_RESULT':
        this.#settle(lane, payload.jobId, { ok: true, frames: payload.frames });
        break;
      case 'JOB_ERROR': {
        const job = this.#jobs.get(payload.jobId);
        this.#settle(
          lane,
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
   * A worker crashed: fail its running job (LOST for an encode — its
   * transferred frames are gone with the worker) and recycle the worker:
   * settling pumps the lane's next pending job, which lazily creates a
   * fresh worker in #pump()
   * @param {Lane} lane
   * @param {ErrorEvent} e
   */
  #handleWorkerError(lane, e) {
    console.error('[ClipCodecManager] Worker error:', e.message);
    lane.worker?.terminate();
    lane.worker = null;
    const activeJobId = lane.activeJobId;
    if (activeJobId !== null) {
      this.#settle(
        lane,
        activeJobId,
        lane.kind === 'encode'
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
