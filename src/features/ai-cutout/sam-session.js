/**
 * Click-to-select (MobileSAM) inference with ONNX Runtime (segmentation worker)
 * @module features/ai-cutout/sam-session
 *
 * The two graphs of a SAM model, as exported by Acly/MobileSAM (see the
 * CLICK entry in model-registry.js for the contract):
 * - the image encoder runs once per frame on the frame resized to a long
 *   side of 1024, as HWC float RGB 0..255 (runSamEncoder) and gives the
 *   image embedding, kept by the worker per frame;
 * - the prompt decoder runs per click or tracked frame (runSamDecoder):
 *   points (and a box as two corner points) in encoder pixels, optionally
 *   the low-resolution mask of an earlier answer, and the mask size wanted
 *   (`orig_im_size`: the decoder upsamples and crops to it itself). It
 *   answers four mask logits and their predicted IoU.
 *
 * `ort` is injected so this is unit-tested without ONNX Runtime.
 */

import { logitsToProbability, SAM_LOW_RES_SIZE } from './sam-prompts.js';

/** @typedef {import('./session-init.js').OrtLike} OrtLike */
/** @typedef {import('./session-init.js').SessionLike} SessionLike */

/** Graph names of the Acly/MobileSAM export */
export const SAM_NAMES = Object.freeze({
  encoderInput: 'input_image',
  embeddings: 'image_embeddings',
  pointCoords: 'point_coords',
  pointLabels: 'point_labels',
  maskInput: 'mask_input',
  hasMaskInput: 'has_mask_input',
  origImSize: 'orig_im_size',
  masks: 'masks',
  scores: 'iou_predictions',
  lowRes: 'low_res_masks',
});

/** Shape of the image embedding */
export const SAM_EMBEDDING_DIMS = /** @type {const} */ ([1, 256, 64, 64]);

/** Values in one embedding (4 MB as float32) */
export const SAM_EMBEDDING_LENGTH = 256 * 64 * 64;

/**
 * RGBA pixels as the encoder's HWC float RGB (0..255)
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function rgbaToHwc(rgba, width, height, out = new Float32Array(width * height * 3)) {
  const n = width * height;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    out[k] = rgba[j];
    out[k + 1] = rgba[j + 1];
    out[k + 2] = rgba[j + 2];
  }
  return out;
}

/**
 * Dispose every output tensor
 * @param {Record<string, { dispose?: () => void }>} outputs
 */
function disposeAll(outputs) {
  for (const tensor of Object.values(outputs)) tensor?.dispose?.();
}

/**
 * Run the encoder on one frame
 * @param {OrtLike} ort
 * @param {SessionLike} session
 * @param {Float32Array} hwc - width × height × 3
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Float32Array>} The embedding (its own copy)
 */
export async function runSamEncoder(ort, session, hwc, width, height) {
  const input = new ort.Tensor('float32', hwc.subarray(0, width * height * 3), [height, width, 3]);
  const outputs = await session.run({ [SAM_NAMES.encoderInput]: input });
  try {
    const out = outputs[SAM_NAMES.embeddings];
    if (!out?.getData) throw new Error(`The encoder has no output named "${SAM_NAMES.embeddings}"`);
    const data = /** @type {Float32Array} */ (await out.getData());
    if (data.length !== SAM_EMBEDDING_LENGTH) {
      throw new Error(
        `The encoder returned ${data.length} values, expected ${SAM_EMBEDDING_LENGTH}`,
      );
    }
    // getData may hand out the tensor's own buffer: keep a copy that outlives it
    return Float32Array.from(data);
  } finally {
    disposeAll(outputs);
  }
}

/**
 * @typedef {Object} SamDecodeRequest
 * @property {Float32Array} embedding
 * @property {Float32Array} coords - [x, y] per point, encoder pixels
 * @property {Float32Array} labels - One per point
 * @property {number} maskWidth
 * @property {number} maskHeight
 * @property {Float32Array | null} [maskInput] - 256 × 256 low-res logits of an earlier answer
 * @property {boolean} [wantLowRes] - Also return the four low-res logits
 */

/**
 * @typedef {Object} SamDecodeResult
 * @property {Float32Array} logits - 4 masks × maskHeight × maskWidth
 * @property {Float32Array} scores - 4 predicted IoUs
 * @property {number} count - Masks returned (4)
 * @property {Float32Array | null} lowRes - 4 × 256 × 256 (when asked for)
 */

/**
 * Run the prompt decoder
 * @param {OrtLike} ort
 * @param {SessionLike} session
 * @param {SamDecodeRequest} request
 * @returns {Promise<SamDecodeResult>}
 */
export async function runSamDecoder(ort, session, request) {
  const points = request.labels.length;
  const lowResLength = SAM_LOW_RES_SIZE * SAM_LOW_RES_SIZE;
  const maskInput =
    request.maskInput?.length === lowResLength ? request.maskInput : new Float32Array(lowResLength);
  const feeds = {
    [SAM_NAMES.embeddings]: new ort.Tensor('float32', request.embedding, [...SAM_EMBEDDING_DIMS]),
    [SAM_NAMES.pointCoords]: new ort.Tensor('float32', request.coords, [1, points, 2]),
    [SAM_NAMES.pointLabels]: new ort.Tensor('float32', request.labels, [1, points]),
    [SAM_NAMES.maskInput]: new ort.Tensor('float32', maskInput, [
      1,
      1,
      SAM_LOW_RES_SIZE,
      SAM_LOW_RES_SIZE,
    ]),
    [SAM_NAMES.hasMaskInput]: new ort.Tensor(
      'float32',
      Float32Array.of(request.maskInput?.length === lowResLength ? 1 : 0),
      [1],
    ),
    [SAM_NAMES.origImSize]: new ort.Tensor(
      'float32',
      Float32Array.of(request.maskHeight, request.maskWidth),
      [2],
    ),
  };
  const fetches = [SAM_NAMES.masks, SAM_NAMES.scores];
  if (request.wantLowRes) fetches.push(SAM_NAMES.lowRes);
  const outputs = await session.run(feeds, fetches);
  try {
    const masks = outputs[SAM_NAMES.masks];
    const scores = outputs[SAM_NAMES.scores];
    if (!masks?.getData || !scores?.getData) throw new Error('The decoder returned no masks');
    const logits = Float32Array.from(/** @type {Float32Array} */ (await masks.getData()));
    const iou = Float32Array.from(/** @type {Float32Array} */ (await scores.getData()));
    const count = iou.length;
    if (logits.length !== count * request.maskWidth * request.maskHeight) {
      throw new Error(
        `The decoder returned ${logits.length} mask values, expected ${count} × ${request.maskWidth} × ${request.maskHeight}`,
      );
    }
    const low = outputs[SAM_NAMES.lowRes];
    const lowRes =
      request.wantLowRes && low?.getData
        ? Float32Array.from(/** @type {Float32Array} */ (await low.getData()))
        : null;
    return { logits, scores: iou, count, lowRes };
  } finally {
    disposeAll(outputs);
  }
}

/**
 * The decoder's answers as candidate masks (0..255 probabilities)
 * @param {SamDecodeResult} result
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8Array, score: number, index: number }[]}
 */
export function toCandidates(result, width, height) {
  const size = width * height;
  return Array.from({ length: result.count }, (_, index) => ({
    data: logitsToProbability(result.logits, index * size, size),
    score: result.scores[index],
    index,
  }));
}

/**
 * Warm-up run of the encoder (a small blank frame: the graph pads every
 * input to 1024 × 1024, so this runs the whole network)
 * @param {OrtLike} ort
 * @returns {(session: SessionLike) => Promise<void>}
 */
export function samEncoderWarmup(ort) {
  return async (session) => {
    const side = 64;
    await runSamEncoder(ort, session, new Float32Array(side * side * 3), side, side);
  };
}

/**
 * Warm-up run of the decoder (a blank embedding, one point)
 * @param {OrtLike} ort
 * @returns {(session: SessionLike) => Promise<void>}
 */
export function samDecoderWarmup(ort) {
  return async (session) => {
    await runSamDecoder(ort, session, {
      embedding: new Float32Array(SAM_EMBEDDING_LENGTH),
      coords: Float32Array.of(32, 32, 0, 0),
      labels: Float32Array.of(1, -1),
      maskWidth: 64,
      maskHeight: 64,
    });
  };
}
