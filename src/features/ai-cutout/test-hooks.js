/**
 * AI cutout E2E test hooks (development builds only)
 * @module features/ai-cutout/test-hooks
 *
 * main.js imports this module dynamically behind `import.meta.env.DEV`, so
 * production bundles contain neither the hooks nor the model override they
 * set. They let Playwright run the app's real segmentation worker end to
 * end: with the stub model (served by `page.route`) its size/hash are
 * accepted and the WASM fallback runs without the confirmation step.
 */

import { getClipPayload } from '../../shared/app-store.js';
import { getSharedMaskStore } from './mask-store.js';
import { frameKey, getSegmentationManager, setDevModelOverride } from './segmentation-manager.js';

/**
 * @typedef {import('./segmentation-manager.js').AnalysisProgress} AnalysisProgress
 */

/**
 * Mask of the active clip's frame `index`, or null.
 * @param {number} index
 * @returns {import('./preprocess.js').ProbabilityMask | null}
 */
function maskForFrame(index) {
  const frame = getClipPayload()?.frames[index];
  return frame ? getSharedMaskStore().get(frameKey(frame)) : null;
}

/**
 * Install `hooks.aiCutout`.
 * @param {Record<string, unknown>} hooks - window.__TEST_HOOKS__
 */
export function installAiCutoutTestHooks(hooks) {
  hooks.aiCutout = {
    /**
     * Accept a different model (the stub): expected size/hash, and whether
     * WASM runs without asking. Resets the manager so the next analysis
     * starts a fresh worker with these values; null restores the real model.
     * @param {{ sha256?: string, bytes?: number, allowWasm?: boolean } | null} override
     */
    setModelOverride(override) {
      setDevModelOverride(override);
      getSegmentationManager().dispose();
    },

    /** @returns {Promise<{ webgpu: boolean }>} */
    getCapabilities: () => getSegmentationManager().getCapabilities(),

    /**
     * Analyze the active clip's frames through the app's manager and worker.
     * @param {{ allowWasm?: boolean, abortAfterFrames?: number, frameIndices?: number[] }} [options]
     * @returns {Promise<Object>} Result, timings and the progress phases seen,
     *   or `{ error: { name, code, message } }`
     */
    async analyzeClip({ allowWasm = false, abortAfterFrames, frameIndices } = {}) {
      const clip = getClipPayload();
      if (!clip) throw new Error('No active clip');
      const frames = frameIndices ? frameIndices.map((i) => clip.frames[i]) : clip.frames;
      const controller = new AbortController();
      /** @type {number[]} */
      const frameMs = [];
      /** @type {string[]} */
      const phases = [];
      let maxLoadedBytes = 0;
      const startedAt = performance.now();
      /** @type {number | null} */
      let firstFrameAt = null;
      const manager = getSegmentationManager();
      try {
        const result = await manager.analyzeFrames(frames, {
          allowWasm,
          clipId: clip.id,
          signal: controller.signal,
          onProgress(/** @type {AnalysisProgress} */ progress) {
            if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
            maxLoadedBytes = Math.max(maxLoadedBytes, progress.loadedBytes);
            if (progress.frameMs !== null) {
              frameMs.push(progress.frameMs);
              firstFrameAt ??= performance.now();
            }
            if (abortAfterFrames !== undefined && progress.framesDone >= abortAfterFrames) {
              controller.abort();
            }
          },
        });
        return {
          ...result,
          readyInfo: manager.readyInfo,
          frameMs,
          phases,
          maxLoadedBytes,
          totalMs: performance.now() - startedAt,
          firstFrameAtMs: firstFrameAt === null ? null : firstFrameAt - startedAt,
        };
      } catch (error) {
        const e = /** @type {any} */ (error);
        return {
          error: {
            name: e?.name,
            code: typeof e?.code === 'string' ? e.code : null,
            message: String(e?.message ?? e),
          },
          frameMs,
          phases,
        };
      }
    },

    /**
     * Mask values of frame `index` at pixel positions given in SOURCE
     * coordinates normalized to 0..1.
     * @param {number} index
     * @param {{ x: number, y: number }[]} points
     * @returns {{ width: number, height: number, values: number[] } | null}
     */
    sampleMask(index, points) {
      const mask = maskForFrame(index);
      if (!mask) return null;
      const values = points.map(({ x, y }) => {
        const px = Math.min(mask.width - 1, Math.floor(x * mask.width));
        const py = Math.min(mask.height - 1, Math.floor(y * mask.height));
        return mask.data[py * mask.width + px];
      });
      return { width: mask.width, height: mask.height, values };
    },

    /**
     * Frame `index`'s mask as a grayscale PNG data URL (for inspection).
     * @param {number} index
     * @returns {Promise<string | null>}
     */
    async maskToPngDataUrl(index) {
      const mask = maskForFrame(index);
      if (!mask) return null;
      const canvas = document.createElement('canvas');
      canvas.width = mask.width;
      canvas.height = mask.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const image = ctx.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.data.length; i++) {
        const v = mask.data[i];
        image.data[i * 4] = v;
        image.data[i * 4 + 1] = v;
        image.data[i * 4 + 2] = v;
        image.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    },

    /** @returns {{ size: number, byteLength: number, version: number }} */
    getMaskStoreStats() {
      const store = getSharedMaskStore();
      return { size: store.size, byteLength: store.byteLength, version: store.version };
    },

    /** Drop every stored mask. */
    clearMasks() {
      getSharedMaskStore().clear();
    },
  };
}
