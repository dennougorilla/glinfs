/**
 * AI cutout model configuration (browser side)
 * @module features/ai-cutout/model-config
 *
 * The models themselves are listed in model-registry.js (plain data shared
 * with scripts/fetch-models.mjs). This module adds what depends on the
 * running app: the same-origin URL under Vite's base path, and the spec the
 * segmentation worker receives.
 */

import {
  getModelEntry,
  getModelFiles,
  isEntryOffered,
  isModelId,
  isSamEntry,
  MODEL_REGISTRY,
} from './model-registry.js';
import { SegmentationError, SegmentationErrorCode } from './protocol.js';

export {
  DEFAULT_MODEL_ID,
  getCustomModelEntries,
  getModelDownloadUrl,
  getModelEntry,
  getModelFiles,
  getModelIds,
  getReleaseModels,
  getUpstreamModelUrl,
  isCustomEntryId,
  isModelId,
  isSamModelId,
  MODEL_CACHE_NAME,
  MODEL_REGISTRY,
  MODEL_RELEASE_URL,
} from './model-registry.js';

/**
 * Whether this build offers the development-only models: a development
 * build does, unless VITE_HIDE_DEV_MODELS=1 (the E2E suite's dev server
 * sets it, see playwright.config.js: the suite checks the release's model
 * lists)
 * @param {Record<string, unknown> | undefined} [env] - Defaults to import.meta.env
 * @returns {boolean}
 */
export function devModelsEnabled(env = import.meta.env) {
  return Boolean(env?.DEV) && env?.VITE_HIDE_DEV_MODELS !== '1';
}

/**
 * Whether this build offers a model: a development build offers every
 * model (see devModelsEnabled), a production build every model that is
 * not `devOnly` (the release ones and the ones hosted at their own `url`),
 * and every model the user added
 * @param {string} modelId
 * @param {boolean} [dev] - Defaults to devModelsEnabled()
 * @returns {boolean}
 */
export function isModelOffered(modelId, dev = devModelsEnabled()) {
  const entry = MODEL_REGISTRY.find((e) => e.id === modelId);
  if (entry) return isEntryOffered(entry, dev);
  // A model the user added is offered wherever it was added
  return isModelId(modelId);
}

/** Default model input side (the IS-Net models; each model has its own `inputSize`) */
export const MODEL_INPUT_SIZE = 1024;

/** Probability masks are stored at the source size scaled to at most this long side */
export const MASK_MAX_SIDE = 1024;

/** @typedef {import('./model-registry.js').ModelPreprocess} ModelPreprocess */
/** @typedef {import('./model-registry.js').ModelRecurrentPair} ModelRecurrentPair */

/**
 * Same-origin URL of a model file, under the app's base path
 * (`/glinfs/models/isnetis-fp16.onnx` on GitHub Pages).
 * @param {string} fileName
 * @param {string} [baseUrl] - Defaults to Vite's BASE_URL
 * @returns {string}
 */
export function getModelFileUrl(fileName, baseUrl = import.meta.env?.BASE_URL ?? '/') {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}models/${fileName}`;
}

/**
 * Same-origin URL of a model's (first) file, under the app's base path.
 * @param {string} modelId
 * @param {string} [baseUrl] - Defaults to Vite's BASE_URL
 * @returns {string}
 */
export function getModelUrl(modelId, baseUrl) {
  const entry = getModelEntry(modelId);
  if ('url' in entry && entry.url) return entry.url;
  return getModelFileUrl(getModelFiles(entry)[0].fileName, baseUrl);
}

/**
 * One file the worker fetches and verifies.
 * @typedef {Object} ModelFileSpec
 * @property {string} role - 'model', or 'encoder' / 'decoder' of a SAM model
 * @property {string} url - URL to fetch: same-origin, or a hosted model's
 *   URL on another origin (fetched with CORS)
 * @property {number} bytes - Expected byte size
 * @property {string} sha256 - Expected lowercase hex SHA-256
 * @property {boolean} [localOnly] - Never downloaded: the file exists only
 *   in Cache Storage (a custom model added from a local file)
 * @property {boolean} [keepOtherPins] - A custom model: storing a download
 *   keeps the URL's copies under other pins (they may be other models')
 */

/**
 * What the worker needs to fetch, verify and run one model. A single-file
 * model also carries its file's url/bytes/sha256 at the top level (`bytes`
 * is always the total of `files`).
 * @typedef {Object} ModelSpec
 * @property {string} id - Registry id
 * @property {string} [label] - What the UI calls it (messages)
 * @property {'sam'} [kind] - A click-to-select model (encoder + decoder)
 * @property {string} [url] - URL to fetch (single-file models; see ModelFileSpec)
 * @property {number} bytes - Expected byte size (all files)
 * @property {string} [sha256] - Expected lowercase hex SHA-256 (single-file models)
 * @property {boolean} [localOnly] - Never downloaded (see ModelFileSpec)
 * @property {boolean} [keepOtherPins] - A custom model (see ModelFileSpec)
 * @property {boolean} [webgpuOnly] - Never on the CPU fallback (model-registry.js)
 * @property {ModelFileSpec[]} files - Every file, in load order
 * @property {string} [inputName]
 * @property {string} [outputName]
 * @property {number} inputSize - Square input side, or the encoder's long side (SAM)
 * @property {ModelPreprocess} [preprocess]
 * @property {number} [maxPoints] - SAM: prompt points per decode
 * @property {readonly ModelRecurrentPair[]} [recurrent] - A video model's
 *   state: each output is fed back as its input on the next frame
 * @property {boolean} [fetchAllOutputs] - DEV/E2E only: fetch every graph
 *   output instead of the mask alone (measures what the side outputs cost)
 */

/**
 * The files of a spec (a spec built by hand, e.g. in a test, may only carry
 * the single file's url/bytes/sha256)
 * @param {Pick<ModelSpec, 'url' | 'bytes' | 'sha256'> & { files?: ModelFileSpec[] }} spec
 * @returns {ModelFileSpec[]}
 */
export function getSpecFiles(spec) {
  if (spec.files?.length) return spec.files;
  return [
    {
      role: 'model',
      url: /** @type {string} */ (spec.url),
      bytes: spec.bytes,
      sha256: /** @type {string} */ (spec.sha256),
    },
  ];
}

/**
 * The spec of a registered model.
 * @param {string} modelId
 * @param {string} [baseUrl]
 * @returns {ModelSpec}
 */
export function getModelSpec(modelId, baseUrl) {
  const entry = getModelEntry(modelId);
  if (entry.missing) {
    throw new SegmentationError(
      SegmentationErrorCode.MODEL_UNAVAILABLE,
      'This clip uses a custom model that is not in this browser (it was deleted, or added on another device). Add it again in Settings → AI models, or choose another model.',
    );
  }
  // A model hosted elsewhere is fetched from its own URL (with CORS)
  const remoteUrl = 'url' in entry && entry.url ? entry.url : null;
  const localOnly = Boolean(entry.localOnly);
  const custom = Boolean(entry.custom);
  const files = getModelFiles(entry).map((file) => ({
    role: file.role,
    url: remoteUrl ?? getModelFileUrl(file.fileName, baseUrl),
    bytes: file.bytes,
    sha256: file.sha256,
    ...(localOnly ? { localOnly } : {}),
    ...(custom ? { keepOtherPins: true } : {}),
  }));
  if (isSamEntry(entry)) {
    return {
      id: entry.id,
      kind: 'sam',
      bytes: entry.bytes,
      files,
      inputSize: entry.inputSize,
      maxPoints: entry.maxPoints,
    };
  }
  return {
    id: entry.id,
    label: entry.label,
    url: files[0].url,
    bytes: entry.bytes,
    sha256: entry.sha256,
    ...(localOnly ? { localOnly } : {}),
    ...(entry.webgpuOnly ? { webgpuOnly: true } : {}),
    files,
    inputName: entry.inputName,
    outputName: entry.outputName,
    inputSize: entry.inputSize,
    preprocess: entry.preprocess,
    ...(entry.recurrent ? { recurrent: entry.recurrent } : {}),
  };
}
