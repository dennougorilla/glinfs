/**
 * AI cutout model configuration (browser side)
 * @module features/ai-cutout/model-config
 *
 * The models themselves are listed in model-registry.js (plain data shared
 * with scripts/fetch-models.mjs). This module adds what depends on the
 * running app: the same-origin URL under Vite's base path, and the spec the
 * segmentation worker receives.
 */

import { getModelEntry } from './model-registry.js';

export {
  DEFAULT_MODEL_ID,
  getModelDownloadUrl,
  getModelEntry,
  getModelIds,
  getUpstreamModelUrl,
  isModelId,
  MODEL_CACHE_NAME,
  MODEL_REGISTRY,
  MODEL_RELEASE_URL,
} from './model-registry.js';

/** Default model input side (both models take 1024×1024) */
export const MODEL_INPUT_SIZE = 1024;

/** Probability masks are stored at the source size scaled to at most this long side */
export const MASK_MAX_SIDE = 1024;

/** @typedef {import('./model-registry.js').ModelPreprocess} ModelPreprocess */

/**
 * Same-origin URL of a model, under the app's base path
 * (`/glinfs/models/isnetis-fp16.onnx` on GitHub Pages).
 * @param {string} modelId
 * @param {string} [baseUrl] - Defaults to Vite's BASE_URL
 * @returns {string}
 */
export function getModelUrl(modelId, baseUrl = import.meta.env?.BASE_URL ?? '/') {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}models/${getModelEntry(modelId).fileName}`;
}

/**
 * What the worker needs to fetch, verify and run one model.
 * @typedef {Object} ModelSpec
 * @property {string} id - Registry id
 * @property {string} url - Same-origin URL to fetch
 * @property {number} bytes - Expected byte size
 * @property {string} sha256 - Expected lowercase hex SHA-256
 * @property {string} inputName
 * @property {string} outputName
 * @property {number} inputSize
 * @property {ModelPreprocess} preprocess
 * @property {boolean} [fetchAllOutputs] - DEV/E2E only: fetch every graph
 *   output instead of the mask alone (measures what the side outputs cost)
 */

/**
 * The spec of a registered model.
 * @param {string} modelId
 * @param {string} [baseUrl]
 * @returns {ModelSpec}
 */
export function getModelSpec(modelId, baseUrl) {
  const entry = getModelEntry(modelId);
  return {
    id: entry.id,
    url: getModelUrl(modelId, baseUrl),
    bytes: entry.bytes,
    sha256: entry.sha256,
    inputName: entry.inputName,
    outputName: entry.outputName,
    inputSize: entry.inputSize,
    preprocess: entry.preprocess,
  };
}
