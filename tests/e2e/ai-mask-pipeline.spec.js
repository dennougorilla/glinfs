/**
 * E2E: the AI cutout mask pipeline in a real browser, below the UI.
 *
 * Builds a synthetic clip (two discs over a dark background) as real
 * VideoFrames, feeds hand-made probability masks (1 inside the discs) to
 * the final-mask builder with a Keep pick on one disc, then renders it with
 * the editor's cached renderer and exports it through the real encoder
 * worker. The exported GIF is decoded with ImageDecoder. This checks the
 * canvas/worker plumbing the unit tests fake; the segmentation model and
 * the UI are covered by their own specs.
 *
 * @module tests/e2e/ai-mask-pipeline.spec
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

test('a Keep pick is followed through the clip and exported as transparency', async ({ page }) => {
  await gotoCapture(page);

  const result = await page.evaluate(async () => {
    const { createFinalMaskCache } = await import('/glinfs/shared/masks/final-masks.js');
    const { encodeGif, MissingCutoutMasksError } = await import('/glinfs/features/export/api.js');
    const { createDefaultSettings } = await import('/glinfs/features/export/core.js');
    const { normalizeEdits } = await import('/glinfs/shared/edits/model.js');
    const { createEditorFrameRenderer } = await import('/glinfs/features/editor/edits-preview.js');

    const W = 96;
    const H = 64;
    const N = 6;
    const R = 10;
    /** Disc A moves right; disc B stays put */
    const discA = (/** @type {number} */ f) => ({ x: 20 + 4 * f, y: 22 });
    const discB = { x: 72, y: 44 };

    /** @type {any[]} */
    const frames = [];
    /** @type {Uint8Array[]} */
    const probs = [];
    for (let f = 0; f < N; f++) {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
      ctx.fillStyle = '#202020';
      ctx.fillRect(0, 0, W, H);
      const prob = new Uint8Array(W * H);
      for (const [disc, color] of [
        [discA(f), '#ff4040'],
        [discB, '#40a0ff'],
      ]) {
        const { x, y } = /** @type {{ x: number, y: number }} */ (disc);
        ctx.fillStyle = /** @type {string} */ (color);
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fill();
        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            if ((px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2 <= (R - 1) ** 2) prob[py * W + px] = 255;
          }
        }
      }
      const timestamp = f * 100_000;
      frames.push({
        id: `ai-${f}`,
        frame: new VideoFrame(canvas, { timestamp }),
        timestamp,
        width: W,
        height: H,
      });
      probs.push(prob);
    }

    try {
      const pick = { frame: 3, x: discA(3).x / W, y: discA(3).y / H, mode: 'keep' };
      const edits = normalizeEdits(
        { background: { enabled: true, method: 'ai', ai: { picks: [pick] } } },
        N,
      );
      const cache = createFinalMaskCache();
      const maskSource = await cache.build({
        storeVersion: 1,
        frameCount: N,
        getProb: (f) => ({ data: probs[f], width: W, height: H }),
        ai: edits.background.ai,
        sourceWidth: W,
      });

      /** @param {Uint8ClampedArray | number[]} rgba @param {number} x @param {number} y */
      const alphaAt = (rgba, x, y) => rgba[(y * W + x) * 4 + 3];

      // Editor preview (real canvas readback + mask)
      const preview = new OffscreenCanvas(W, H);
      const previewCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (
        preview.getContext('2d', { willReadFrequently: true })
      );
      const renderer = createEditorFrameRenderer();
      const previewAlpha = frames.map((frame, f) => {
        renderer.render(previewCtx, frame, null, edits, f, { transparent: true, maskSource });
        const { data } = previewCtx.getImageData(0, 0, W, H);
        return {
          a: alphaAt(data, discA(f).x, discA(f).y),
          b: alphaAt(data, discB.x, discB.y),
          bg: alphaAt(data, 2, 2),
        };
      });

      // Export through the real encoder worker
      const settings = { ...createDefaultSettings(), frameSkip: 1, playbackSpeed: 1 };
      const blob = await encodeGif({
        frames,
        crop: null,
        settings,
        fps: 10,
        onProgress: () => {},
        edits,
        transparent: true,
        maskSource,
      });
      const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' });
      await decoder.tracks.ready;
      await decoder.completed;
      const exported = [];
      for (let f = 0; f < decoder.tracks.selectedTrack.frameCount; f++) {
        const { image } = await decoder.decode({ frameIndex: f });
        const out = new OffscreenCanvas(W, H);
        const outCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (out.getContext('2d'));
        outCtx.drawImage(image, 0, 0);
        image.close();
        const { data } = outCtx.getImageData(0, 0, W, H);
        exported.push({
          a: alphaAt(data, discA(f).x, discA(f).y),
          b: alphaAt(data, discB.x, discB.y),
          bg: alphaAt(data, 2, 2),
        });
      }
      decoder.close();

      // Refusal: one exported frame without a mask
      let refusal = '';
      try {
        await encodeGif({
          frames,
          crop: null,
          settings,
          fps: 10,
          onProgress: () => {},
          edits,
          transparent: true,
          maskSource: {
            version: -1,
            getFinalMask: (i) => (i === 4 ? null : maskSource.getFinalMask(i)),
          },
        });
      } catch (error) {
        refusal = error instanceof MissingCutoutMasksError ? error.message : `other: ${error}`;
      }

      return { previewAlpha, exported, refusal };
    } finally {
      for (const frame of frames) frame.frame.close();
    }
  });

  const kept = { a: 255, b: 0, bg: 0 };
  expect(result.previewAlpha).toEqual(new Array(6).fill(kept));
  expect(result.exported).toEqual(new Array(6).fill(kept));
  expect(result.refusal).toMatch(/missing for 1 of 6 frames \(first: frame 4\)/);
});
