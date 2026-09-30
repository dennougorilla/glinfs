/**
 * Model downloads started from Settings (main thread)
 * @module features/ai-cutout/model-downloads
 *
 * Settings → "AI models" downloads a model ahead of use through the same
 * code the segmentation worker loads it with (downloadModelToCache: fetch,
 * size and SHA-256 check, then Cache Storage; nothing unverified is
 * stored). Downloads live here, not in the Settings screen, so one keeps
 * going (and shows its progress again) when the user leaves Settings and
 * comes back. After a download the app asks for persistent storage.
 *
 * Every dependency is injectable for unit tests.
 */

import { downloadModelToCache } from './model-loader.js';
import { requestPersistentStorage } from './model-storage.js';
import { isAbortError } from './protocol.js';
import { resolveModelSpec } from './segmentation-manager.js';

/** Minimum interval between progress notifications */
export const DOWNLOAD_NOTIFY_INTERVAL_MS = 100;

/**
 * @typedef {Object} ModelDownloadState
 * @property {'downloading' | 'verifying'} phase
 * @property {number} loadedBytes
 * @property {number} totalBytes
 */

/**
 * @typedef {Object} ModelDownloadResult
 * @property {'done' | 'cancelled' | 'failed'} outcome
 * @property {unknown} [error] - Why it failed
 * @property {boolean} [cached] - done: the verified copy is in Cache Storage
 */

/**
 * @typedef {Object} ModelDownloadsDeps
 * @property {typeof downloadModelToCache} [download]
 * @property {(modelId: string) => import('./model-config.js').ModelSpec} [resolveSpec]
 * @property {() => Promise<unknown>} [persist]
 * @property {() => number} [now]
 */

/**
 * @param {ModelDownloadsDeps} [deps]
 */
export function createModelDownloads(deps = {}) {
  const {
    download = downloadModelToCache,
    resolveSpec = resolveModelSpec,
    persist = requestPersistentStorage,
    now = () => performance.now(),
  } = deps;

  /** @type {Map<string, { state: ModelDownloadState, controller: AbortController, promise: Promise<ModelDownloadResult> }>} */
  const running = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let lastNotifyAt = Number.NEGATIVE_INFINITY;

  /** @param {boolean} [force] - Not a progress step (start, phase change, end) */
  const notify = (force = false) => {
    const time = now();
    if (!force && time - lastNotifyAt < DOWNLOAD_NOTIFY_INTERVAL_MS) return;
    lastNotifyAt = time;
    for (const listener of [...listeners]) listener();
  };

  return {
    /**
     * Download a model into Cache Storage (joins a download already running).
     * @param {string} modelId
     * @returns {Promise<ModelDownloadResult>}
     */
    start(modelId) {
      const existing = running.get(modelId);
      if (existing) return existing.promise;
      const spec = resolveSpec(modelId);
      const controller = new AbortController();
      /** @type {ModelDownloadState} */
      const state = { phase: 'downloading', loadedBytes: 0, totalBytes: spec.bytes };
      const promise = (async () => {
        try {
          const { cached } = await download(spec, {
            signal: controller.signal,
            onProgress(progress) {
              const phaseChanged = progress.phase !== state.phase;
              state.phase = progress.phase;
              state.loadedBytes = progress.loadedBytes;
              state.totalBytes = progress.totalBytes;
              notify(phaseChanged);
            },
          });
          // Keep what the user chose to download when space runs low
          if (cached) await persist();
          return /** @type {ModelDownloadResult} */ ({ outcome: 'done', cached });
        } catch (error) {
          return /** @type {ModelDownloadResult} */ (
            isAbortError(error) ? { outcome: 'cancelled' } : { outcome: 'failed', error }
          );
        } finally {
          running.delete(modelId);
          notify(true);
        }
      })();
      running.set(modelId, { state, controller, promise });
      notify(true);
      return promise;
    },

    /**
     * Stop a model's download (nothing is stored).
     * @param {string} modelId
     */
    cancel(modelId) {
      running.get(modelId)?.controller.abort();
    },

    /**
     * Progress of a model's download, or null when none runs.
     * @param {string} modelId
     * @returns {ModelDownloadState | null}
     */
    get(modelId) {
      const entry = running.get(modelId);
      return entry ? { ...entry.state } : null;
    },

    /** @returns {boolean} Any download runs */
    get active() {
      return running.size > 0;
    },

    /**
     * Call `listener` when a download starts, progresses or ends.
     * @param {() => void} listener
     * @returns {() => void} Unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** @typedef {ReturnType<typeof createModelDownloads>} ModelDownloads */

/** @type {ModelDownloads | null} */
let shared = null;

/**
 * The app-wide downloads (they outlive the Settings screen).
 * @returns {ModelDownloads}
 */
export function getModelDownloads() {
  shared ??= createModelDownloads();
  return shared;
}
