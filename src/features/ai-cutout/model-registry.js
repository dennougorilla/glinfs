/**
 * AI cutout model registry
 * @module features/ai-cutout/model-registry
 *
 * Every segmentation model the app can run, with everything the worker,
 * the manager, Settings ("AI models"), scripts/fetch-models.mjs and
 * the Pages deploy workflow need to know about it. Plain data with no
 * browser or Vite imports, so the Node fetch script imports it directly
 * (the pins exist once; tests/unit/ai-cutout/model-config.test.js checks
 * that deploy.yml uses the same hashes and file names).
 *
 * The `id` is what edits store (`edits.background.ai.model`) and what masks
 * are keyed by; it never changes. The file behind an id can: replacing an
 * entry's file name, bytes and SHA-256 needs no code change elsewhere — the
 * Cache Storage key includes the SHA-256, so browsers download the new file
 * on next use.
 *
 * The app ships fp16 conversions of the upstream fp32 weights, half their
 * size (scripts/convert-models-fp16.py; the input and the output stay
 * float32, so the worker feeds and reads the same tensors). Each entry pins
 * the converted file (`fileName`, `bytes`, `sha256`) and the upstream file
 * it was converted from (`convertedFrom`: a Hugging Face commit, size and
 * SHA-256). The conversion is reproducible byte for byte.
 *
 * None of the models is committed: `npm run models:fetch` downloads each
 * converted file from the `models-v1` GitHub Release of this repository
 * (asset name = `fileName`) into public/models/<fileName>, and the browser
 * fetches it same-origin only when the user analyzes with that model.
 */

/**
 * How a frame becomes the model's input and how its output reads.
 * @typedef {Object} ModelPreprocess
 * @property {'letterbox' | 'stretch'} resize - letterbox: fit s×s keeping the
 *   aspect ratio, zero padding centred; stretch: resize to s×s ignoring it
 * @property {number} scale - Multiplier applied to 0..255 channel values
 * @property {readonly [number, number, number]} mean - Subtracted per channel (R, G, B) after scaling
 * @property {readonly [number, number, number]} std - Divides per channel after the mean
 * @property {'probability'} output - The graph's output is already in [0, 1]
 */

/**
 * The upstream fp32 file a shipped model was converted from.
 * @typedef {Object} ModelUpstreamFile
 * @property {string} repo - Hugging Face repository
 * @property {string} revision - Pinned commit (never a branch)
 * @property {string} path - File path inside the repository
 * @property {number} bytes - Exact byte size
 * @property {string} sha256 - Lowercase hex SHA-256
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} id - Stable id (edits, mask keys, messages)
 * @property {string} label - What it is for, the name the UI leads with
 *   ("General", "Anime"; also in messages: "The Anime model was deleted")
 * @property {string} modelName - The network behind it, shown small next to
 *   the label where models are listed in full (Settings)
 * @property {string} shortModelName - `modelName` short enough for the
 *   editor's model switch
 * @property {string} description - What it is good at (UI copy)
 * @property {string} finds - What it cuts out, as the object of "Finds …
 *   in every frame" (UI copy)
 * @property {string} fileName - File name under public/models/, in the served
 *   URL and of the `models-v1` release asset
 * @property {number} bytes - Exact byte size of the shipped file
 * @property {string} sha256 - Lowercase hex SHA-256 of the shipped file
 * @property {ModelUpstreamFile} convertedFrom
 * @property {{ name: string, url: string }} license
 * @property {string} upstream - Project page of the network
 * @property {string} inputName - Image input: float32 [1, 3, inputSize, inputSize]
 * @property {string} outputName - Mask output: float32 [1, 1, inputSize, inputSize]
 * @property {number} inputSize
 * @property {ModelPreprocess} preprocess
 */

/**
 * GitHub Release that hosts the converted models; `npm run models:fetch`
 * downloads `<this>/<fileName>` (the browser never contacts GitHub).
 */
export const MODEL_RELEASE_URL =
  'https://github.com/dennougorilla/glinfs/releases/download/models-v1';

const APACHE_2 = Object.freeze({
  name: 'Apache-2.0',
  url: 'https://www.apache.org/licenses/LICENSE-2.0',
});

/**
 * skytnt's anime-segmentation IS-Net, converted to fp16 from `isnetis.onnx`
 * (byte-identical to rembg's `isnet-anime.onnx`). isnetis.onnx was last
 * changed in a0a563c4 (2022-09-14); the pinned 493cb608 (2026-08-17) only
 * adds the Apache-2.0 license metadata to the model card, so the bytes are
 * the same. fp16 vs fp32 through the app's worker on WebGPU: masks agree on
 * more than 99.99% of pixels after thresholding at 0.5.
 *
 * Preprocessing, verified against skytnt's own inference code:
 * - https://github.com/SkyTNT/anime-segmentation/blob/55d874013a2811cdf59c365059174c7823acf5b4/inference.py
 *   (`get_mask`, lines 14-35)
 * - https://huggingface.co/spaces/skytnt/anime-remove-background/blob/0ee865394df7f9e5500a67974839f213669fc206/app.py
 *   (`get_mask`, lines 8-21 — the Space that runs this exact isnetis.onnx)
 * Both do: RGB, `img / 255` (no mean/std), resize to fit s×s keeping the
 * aspect ratio with the short side truncated (`int(s * w / h)`), zero-pad
 * centred, HWC → CHW. The graph ends in a sigmoid (train.py `forward`
 * returns `.sigmoid()`), so the output is a [0, 1] probability.
 * @type {ModelEntry}
 */
const ANIME = {
  id: 'anime',
  label: 'Anime',
  modelName: 'ISNet (isnet-anime)',
  shortModelName: 'ISNet anime',
  description: 'Anime and illustrated characters',
  finds: 'the characters',
  fileName: 'isnetis-fp16.onnx',
  bytes: 88_070_957,
  sha256: 'f1aa383a62119572263a36ac9ebbd99bd14bc4052d0948662dc76b4b8c8d0bb0',
  convertedFrom: {
    repo: 'skytnt/anime-seg',
    revision: '493cb60893f47441b26ec4fb9a306bce9e342982',
    path: 'isnetis.onnx',
    bytes: 176_069_933,
    sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
  },
  license: APACHE_2,
  upstream: 'https://github.com/SkyTNT/anime-segmentation',
  inputName: 'img',
  outputName: 'mask',
  inputSize: 1024,
  preprocess: {
    resize: 'letterbox',
    scale: 1 / 255,
    mean: [0, 0, 0],
    std: [1, 1, 1],
    output: 'probability',
  },
};

/**
 * DIS IS-Net general-use (`isnet-general-use`, Apache-2.0: upstream
 * github.com/xuebinqin/DIS LICENSE.md; the Hugging Face card says
 * apache-2.0), converted to fp16 from the published ONNX export on Hugging
 * Face (byte-identical to rembg's isnet-general-use.onnx release asset).
 * That fp32 file has the network's 12 outputs (main + side outputs); the
 * conversion keeps only `output_image`, the one the worker reads. fp16 vs
 * fp32 through the app's worker on WebGPU: masks agree on more than 99.5%
 * of pixels after thresholding at 0.5 (the rest are soft edge pixels).
 *
 * Preprocessing, verified against the upstream inference script
 * https://github.com/xuebinqin/DIS/blob/b6764e20381f6f42a70f83fa3324181529ed1403/IS-Net/Inference.py
 * (line 23 `input_size=[1024,1024]`, lines 40-51): `F.upsample(...,
 * input_size, mode="bilinear")` — a plain stretch to 1024×1024, no
 * letterbox —, back to uint8, `/ 255`, `normalize(mean=[0.5]*3,
 * std=[1.0]*3)`, NCHW. `output_image` is the sigmoid of the main side
 * output, already in [0, 1]. Upstream then min-max normalizes each image;
 * that is deliberately NOT done here: per-frame normalization would make
 * the same pixel's value jump between frames (flicker) and would turn an
 * empty frame's noise into foreground.
 * @type {ModelEntry}
 */
const GENERAL = {
  id: 'general',
  label: 'General',
  modelName: 'ISNet (general-use)',
  shortModelName: 'ISNet',
  description: 'People, pets and objects in live-action video',
  finds: 'the people, pets and objects',
  fileName: 'isnet-general-fp16.onnx',
  bytes: 90_448_072,
  sha256: '437b3207d043c5206b11c9f1681a0b1d647aeb560174f07420ed651989f3b38b',
  convertedFrom: {
    repo: 'BritishWerewolf/IS-Net',
    revision: '9783722d9f964c0286a411e7e8e6fede947d5a53',
    path: 'onnx/model.onnx',
    bytes: 178_648_008,
    sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
  },
  license: APACHE_2,
  upstream: 'https://github.com/xuebinqin/DIS',
  inputName: 'input_image',
  outputName: 'output_image',
  inputSize: 1024,
  preprocess: {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    output: 'probability',
  },
};

/**
 * Deep-freeze a registry entry (it is shared by every module).
 * @param {ModelEntry} entry
 * @returns {Readonly<ModelEntry>}
 */
function freezeEntry(entry) {
  Object.freeze(entry.convertedFrom);
  Object.freeze(entry.preprocess.mean);
  Object.freeze(entry.preprocess.std);
  Object.freeze(entry.preprocess);
  return Object.freeze(entry);
}

/**
 * Every model, in the order the UI lists them (the editor's switch left to
 * right, Settings top to bottom). A new model needs only an entry here (and
 * its file in the `models-v1` release).
 */
export const MODEL_REGISTRY = Object.freeze([freezeEntry(GENERAL), freezeEntry(ANIME)]);

/** Model of edits that do not name one (everything saved before the general model) */
export const DEFAULT_MODEL_ID = ANIME.id;

/** Cache Storage bucket that keeps verified models between visits */
export const MODEL_CACHE_NAME = 'glinfs-models-v1';

/** @returns {string[]} Every model id */
export function getModelIds() {
  return MODEL_REGISTRY.map((entry) => entry.id);
}

/**
 * @param {unknown} id
 * @returns {boolean} `id` names a registered model
 */
export function isModelId(id) {
  return MODEL_REGISTRY.some((entry) => entry.id === id);
}

/**
 * The registry entry of a model.
 * @param {string} id
 * @returns {Readonly<ModelEntry>}
 * @throws {RangeError} for an unknown id
 */
export function getModelEntry(id) {
  const entry = MODEL_REGISTRY.find((e) => e.id === id);
  if (!entry) throw new RangeError(`Unknown AI cutout model "${id}"`);
  return entry;
}

/**
 * Download URL of a shipped model: its asset in the `models-v1` GitHub
 * Release (used by the fetch script; the browser loads it same-origin).
 * @param {{ fileName: string }} entry
 * @returns {string}
 */
export function getModelDownloadUrl(entry) {
  return `${MODEL_RELEASE_URL}/${entry.fileName}`;
}

/**
 * Pinned Hugging Face URL of the upstream fp32 file a model was converted
 * from (scripts/convert-models-fp16.py downloads it).
 * @param {{ convertedFrom: ModelUpstreamFile }} entry
 * @returns {string}
 */
export function getUpstreamModelUrl(entry) {
  const { repo, revision, path } = entry.convertedFrom;
  return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

/**
 * Decimal megabytes (10^6 bytes), the unit of "88 MB" in the README, the
 * credits, the editor and Settings: whole megabytes, or `decimals` places
 * where an amount must visibly move (download progress: "12.3 MB of 88.1 MB")
 * @param {number} bytes
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatModelSize(bytes, decimals = 0) {
  return `${(bytes / 1_000_000).toFixed(decimals)} MB`;
}
