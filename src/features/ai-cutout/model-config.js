/**
 * AI cutout model configuration
 * @module features/ai-cutout/model-config
 *
 * The segmentation model is skytnt's anime-segmentation IS-Net
 * (`isnetis.onnx`, Apache-2.0 — byte-identical to rembg's
 * `isnet-anime.onnx`). It is NOT committed: `npm run models:fetch`
 * (scripts/fetch-models.mjs) downloads it from the pinned Hugging Face
 * revision below into public/models/, and the Pages deploy workflow does the
 * same before `vite build`, so the browser fetches it same-origin.
 *
 * The revision and SHA-256 are pinned here AND in scripts/fetch-models.mjs;
 * tests/unit/ai-cutout/model-config.test.js keeps the two in sync.
 */

/** Hugging Face repository that hosts the model */
export const MODEL_HF_REPO = 'skytnt/anime-seg';

/**
 * Pinned Hugging Face commit (never `main`). isnetis.onnx was last changed
 * in a0a563c4 (2022-09-14); 493cb608 (2026-08-17) only adds the Apache-2.0
 * license metadata to the model card, so the file bytes are the same.
 */
export const MODEL_HF_REVISION = '493cb60893f47441b26ec4fb9a306bce9e342982';

/** File name, both on Hugging Face and under public/models/ */
export const MODEL_FILE_NAME = 'isnetis.onnx';

/** Stable id for the model (cache keys, messages) */
export const MODEL_ID = 'isnetis';

/** Exact byte size of the fp32 model */
export const MODEL_BYTES = 176_069_933;

/** Lowercase hex SHA-256 of the model (the Hugging Face LFS object id) */
export const MODEL_SHA256 = 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99';

/** Model input: float32 [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE] */
export const MODEL_INPUT_SIZE = 1024;

/** Name of the model's image input */
export const MODEL_INPUT_NAME = 'img';

/** Name of the model's mask output: float32 [1, 1, 1024, 1024] in [0, 1] */
export const MODEL_OUTPUT_NAME = 'mask';

/** Probability masks are stored at the source size scaled to at most this long side */
export const MASK_MAX_SIDE = 1024;

/** Cache Storage bucket that keeps the verified model between visits */
export const MODEL_CACHE_NAME = 'glinfs-models-v1';

/**
 * Preprocessing contract, verified against skytnt's own inference code:
 * - https://github.com/SkyTNT/anime-segmentation/blob/55d874013a2811cdf59c365059174c7823acf5b4/inference.py
 *   (`get_mask`, lines 14-35)
 * - https://huggingface.co/spaces/skytnt/anime-remove-background/blob/0ee865394df7f9e5500a67974839f213669fc206/app.py
 *   (`get_mask`, lines 8-22 — the Space that runs this exact isnetis.onnx)
 *
 * Both do: RGB, `img / 255` (no mean/std), resize to fit s×s keeping the
 * aspect ratio with the short side truncated (`int(s * w / h)`), zero-pad
 * centred (`ph // 2`, `pw // 2`), HWC → CHW, add a batch axis. The ONNX
 * graph ends in a sigmoid (train.py `forward` returns `.sigmoid()`, and
 * export.py exports that module), so the output is already a [0, 1]
 * probability. The padding is cropped back out and the rest resized to the
 * output size (cv2.resize, bilinear).
 * @type {Readonly<{
 *   colorOrder: 'rgb',
 *   scale: number,
 *   mean: null,
 *   std: null,
 *   layout: 'nchw',
 *   resize: 'fit-keep-aspect',
 *   pad: 'center-zero',
 *   output: 'probability',
 * }>}
 */
export const PREPROCESS = Object.freeze({
  colorOrder: 'rgb',
  scale: 1 / 255,
  mean: null,
  std: null,
  layout: 'nchw',
  resize: 'fit-keep-aspect',
  pad: 'center-zero',
  output: 'probability',
});

/**
 * Same-origin URL of the model, under the app's base path
 * (`/glinfs/models/isnetis.onnx` on GitHub Pages).
 * @param {string} [baseUrl] - Defaults to Vite's BASE_URL
 * @returns {string}
 */
export function getModelUrl(baseUrl = import.meta.env?.BASE_URL ?? '/') {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}models/${MODEL_FILE_NAME}`;
}

/**
 * Pinned download URL of the model on Hugging Face (used by the fetch
 * script; the browser never contacts Hugging Face).
 * @returns {string}
 */
export function getModelSourceUrl() {
  return `https://huggingface.co/${MODEL_HF_REPO}/resolve/${MODEL_HF_REVISION}/${MODEL_FILE_NAME}`;
}

/**
 * What the worker needs to fetch and verify one model.
 * @typedef {Object} ModelSpec
 * @property {string} url - Same-origin URL to fetch
 * @property {number} bytes - Expected byte size
 * @property {string} sha256 - Expected lowercase hex SHA-256
 * @property {string} inputName
 * @property {string} outputName
 * @property {number} inputSize
 */

/**
 * The production model spec.
 * @param {string} [baseUrl]
 * @returns {ModelSpec}
 */
export function getModelSpec(baseUrl) {
  return {
    url: getModelUrl(baseUrl),
    bytes: MODEL_BYTES,
    sha256: MODEL_SHA256,
    inputName: MODEL_INPUT_NAME,
    outputName: MODEL_OUTPUT_NAME,
    inputSize: MODEL_INPUT_SIZE,
  };
}
