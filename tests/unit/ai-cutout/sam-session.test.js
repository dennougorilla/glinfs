import { describe, expect, it, vi } from 'vitest';
import {
  rgbaToHwc,
  runSamDecoder,
  runSamEncoder,
  SAM_EMBEDDING_LENGTH,
  samDecoderWarmup,
  samEncoderWarmup,
  toCandidates,
} from '../../../src/features/ai-cutout/sam-session.js';

class Tensor {
  /** @param {string} type @param {any} data @param {number[]} dims */
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

/** @param {Record<string, any>} outputs */
function fakeSession(outputs) {
  const disposed = [];
  const run = vi.fn(async () =>
    Object.fromEntries(
      Object.entries(outputs).map(([name, data]) => [
        name,
        { getData: async () => data, dispose: () => disposed.push(name) },
      ]),
    ),
  );
  return { session: { run }, run, disposed };
}

const ort = /** @type {any} */ ({ Tensor });

describe('sam-session', () => {
  it('turns RGBA into HWC float RGB 0..255', () => {
    const rgba = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 0]);
    expect([...rgbaToHwc(rgba, 2, 1)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('runs the encoder on an [H, W, 3] tensor and copies the embedding', async () => {
    const embedding = new Float32Array(SAM_EMBEDDING_LENGTH).fill(0.5);
    const { session, run, disposed } = fakeSession({ image_embeddings: embedding });
    const hwc = new Float32Array(4 * 2 * 3 + 30); // longer reused buffer
    const out = await runSamEncoder(ort, /** @type {any} */ (session), hwc, 4, 2);
    const feeds = /** @type {any} */ (run.mock.calls[0])[0];
    expect(feeds.input_image.dims).toEqual([2, 4, 3]);
    expect(feeds.input_image.data.length).toBe(24);
    expect(out).not.toBe(embedding);
    expect(out[0]).toBe(0.5);
    expect(disposed).toEqual(['image_embeddings']);
  });

  it('rejects an encoder output of the wrong size', async () => {
    const { session } = fakeSession({ image_embeddings: new Float32Array(3) });
    await expect(
      runSamEncoder(ort, /** @type {any} */ (session), new Float32Array(3), 1, 1),
    ).rejects.toThrow(/expected 1048576/);
  });

  it('feeds the decoder the points, the mask size, and a mask input only when given', async () => {
    const w = 3;
    const h = 2;
    const logits = new Float32Array(4 * w * h).map((_, i) => (i < w * h ? 5 : -5));
    const { session, run } = fakeSession({
      masks: logits,
      iou_predictions: Float32Array.of(0.9, 0.1, 0.2, 0.3),
    });
    const result = await runSamDecoder(ort, /** @type {any} */ (session), {
      embedding: new Float32Array(SAM_EMBEDDING_LENGTH),
      coords: Float32Array.of(10, 20, 0, 0),
      labels: Float32Array.of(1, -1),
      maskWidth: w,
      maskHeight: h,
    });
    const [feeds, fetches] = /** @type {any} */ (run.mock.calls[0]);
    expect(feeds.point_coords.dims).toEqual([1, 2, 2]);
    expect(feeds.point_labels.dims).toEqual([1, 2]);
    expect([...feeds.orig_im_size.data]).toEqual([2, 3]);
    expect([...feeds.has_mask_input.data]).toEqual([0]);
    expect(feeds.mask_input.dims).toEqual([1, 1, 256, 256]);
    expect(fetches).toEqual(['masks', 'iou_predictions']);
    expect(result.count).toBe(4);
    const candidates = toCandidates(result, w, h);
    expect(candidates.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect([...candidates[0].data]).toEqual([253, 253, 253, 253, 253, 253]);
    expect([...candidates[1].data]).toEqual([2, 2, 2, 2, 2, 2]);
    expect(candidates[0].score).toBeCloseTo(0.9);

    // With an earlier low-res answer
    const low = new Float32Array(256 * 256).fill(1);
    const again = fakeSession({
      masks: logits,
      iou_predictions: new Float32Array(4),
      low_res_masks: new Float32Array(4 * 256 * 256),
    });
    const withLow = await runSamDecoder(ort, /** @type {any} */ (again.session), {
      embedding: new Float32Array(SAM_EMBEDDING_LENGTH),
      coords: Float32Array.of(1, 1, 0, 0),
      labels: Float32Array.of(1, -1),
      maskWidth: w,
      maskHeight: h,
      maskInput: low,
      wantLowRes: true,
    });
    const [feeds2, fetches2] = /** @type {any} */ (again.run.mock.calls[0]);
    expect([...feeds2.has_mask_input.data]).toEqual([1]);
    expect(feeds2.mask_input.data).toBe(low);
    expect(fetches2).toContain('low_res_masks');
    expect(withLow.lowRes?.length).toBe(4 * 256 * 256);
  });

  it('rejects decoder masks of the wrong size', async () => {
    const { session } = fakeSession({
      masks: new Float32Array(5),
      iou_predictions: new Float32Array(4),
    });
    await expect(
      runSamDecoder(ort, /** @type {any} */ (session), {
        embedding: new Float32Array(SAM_EMBEDDING_LENGTH),
        coords: Float32Array.of(1, 1),
        labels: Float32Array.of(1),
        maskWidth: 2,
        maskHeight: 2,
      }),
    ).rejects.toThrow(/expected 4 × 2 × 2/);
  });

  it('warms both graphs up with blank inputs', async () => {
    const enc = fakeSession({ image_embeddings: new Float32Array(SAM_EMBEDDING_LENGTH) });
    await samEncoderWarmup(ort)(/** @type {any} */ (enc.session));
    expect(/** @type {any} */ (enc.run.mock.calls[0])[0].input_image.dims).toEqual([64, 64, 3]);
    const dec = fakeSession({
      masks: new Float32Array(4 * 64 * 64),
      iou_predictions: new Float32Array(4),
    });
    await samDecoderWarmup(ort)(/** @type {any} */ (dec.session));
    expect(dec.run).toHaveBeenCalledTimes(1);
  });
});
