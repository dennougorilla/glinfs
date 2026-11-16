/**
 * Models the user adds (pure, no DOM)
 * @module features/ai-cutout/custom-models
 *
 * Settings → AI models → "Add model" turns an ONNX file (picked, dropped or
 * downloaded from a URL) into a model the app runs like a registry one.
 * This module holds what that needs without a browser:
 *
 * - the definition: what the user confirmed (label, input size, resize,
 *   normalization, output kind, the subject cards that list it) plus the
 *   file's size and SHA-256, its source (a local file or a URL) and the
 *   graph's input and output names. It is stored in IndexedDB
 *   (custom-model-store.js) and exported / imported as JSON, so a set-up
 *   can be shared;
 * - its stable id: `custom-<first 16 hex of the file's SHA-256>-<hash of the
 *   settings that change the masks>`. The same file with the same settings
 *   gets the same id on every device (a shared definition finds its masks
 *   under the same key), a rename keeps it, other settings make another
 *   model (their masks differ);
 * - the registry entry the rest of the app reads (toModelEntry);
 * - the proposal made from the graph's inputs and outputs (proposeSettings)
 *   and what a test run's output says (assessTestOutput).
 *
 * Scope: one float32 image input [1, 3, S, S] and one float32 mask output
 * [1, 1, S, S] (one chosen among several outputs). Anything else is
 * described as out of scope instead of guessed at.
 */

/** Format tag of a definition (stored and exported) */
export const CUSTOM_MODEL_FORMAT = 'glinfs-custom-model';

/** Version of the definition format */
export const CUSTOM_MODEL_VERSION = 1;

/** Ids of user-added models */
const CUSTOM_ID_PATTERN = /^custom-[0-9a-f]{16}-[0-9a-f]{8}$/;

/** The subject cards a custom model can be listed on (not Click to select) */
export const CUSTOM_MODEL_SUBJECTS = /** @type {const} */ (['anime', 'general', 'portrait']);

/** Card names of CUSTOM_MODEL_SUBJECTS (as the Background tab shows them) */
export const CUSTOM_SUBJECT_LABELS = Object.freeze({
  anime: 'Anime',
  general: 'Anything',
  portrait: 'Person',
});

/**
 * Normalization presets: `(v / 255 - mean) / std` per channel
 * @type {Readonly<Record<'unit' | 'imagenet' | 'symmetric', { label: string, mean: readonly number[], std: readonly number[] }>>}
 */
export const NORMALIZATIONS = Object.freeze({
  unit: Object.freeze({
    label: '0..1',
    mean: Object.freeze([0, 0, 0]),
    std: Object.freeze([1, 1, 1]),
  }),
  imagenet: Object.freeze({
    label: 'ImageNet mean/std',
    mean: Object.freeze([0.485, 0.456, 0.406]),
    std: Object.freeze([0.229, 0.224, 0.225]),
  }),
  symmetric: Object.freeze({
    label: '-1..1',
    mean: Object.freeze([0.5, 0.5, 0.5]),
    std: Object.freeze([0.5, 0.5, 0.5]),
  }),
});

/** @type {readonly ('letterbox' | 'stretch')[]} */
export const RESIZE_MODES = Object.freeze(['stretch', 'letterbox']);

/** @type {readonly ('probability' | 'logits')[]} */
export const OUTPUT_KINDS = Object.freeze(['probability', 'logits']);

/** A file above this size is only read after an explicit confirmation */
export const LARGE_MODEL_BYTES = 1_000_000_000;

/**
 * Largest file the app reads: a single ONNX protobuf cannot exceed 2 GiB
 * (bigger models keep their weights in separate files, which the browser
 * runtime cannot load from here)
 */
export const MAX_MODEL_BYTES = 2 ** 31 - 1;

/** Input sides a model may declare or the user may enter */
export const INPUT_SIZE_LIMITS = Object.freeze({ min: 32, max: 2048 });

/** Longest label kept */
export const LABEL_MAX_LENGTH = 60;

/** Default input side for a graph whose side is symbolic */
export const DEFAULT_INPUT_SIZE = 1024;

/**
 * @typedef {'anime' | 'general' | 'portrait'} CustomModelSubject
 */

/**
 * The settings of a custom model that the user confirms.
 * @typedef {Object} CustomModelSettings
 * @property {string} label
 * @property {string} inputName
 * @property {string} outputName
 * @property {number} inputSize
 * @property {'letterbox' | 'stretch'} resize
 * @property {'unit' | 'imagenet' | 'symmetric'} normalization
 * @property {'probability' | 'logits'} output
 * @property {CustomModelSubject[]} subjects - The cards that list it (at least one)
 */

/**
 * A custom model: its settings, its file and where the file came from.
 * @typedef {CustomModelSettings & {
 *   format: typeof CUSTOM_MODEL_FORMAT,
 *   version: number,
 *   id: string,
 *   source: 'file' | 'url',
 *   url?: string,
 *   fileName: string,
 *   bytes: number,
 *   sha256: string,
 * }} CustomModelDefinition
 */

/**
 * Whether an id has the form of a user-added model's id (registered or not)
 * @param {unknown} id
 * @returns {id is string}
 */
export function isCustomModelId(id) {
  return typeof id === 'string' && CUSTOM_ID_PATTERN.test(id);
}

/**
 * 32-bit FNV-1a of a string, as 8 hex digits
 * @param {string} text
 * @returns {string}
 */
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The stable id of a custom model: its file and the settings that change
 * its masks (not the label, the cards or where the file came from)
 * @param {Pick<CustomModelDefinition, 'sha256' | 'inputName' | 'outputName' | 'inputSize' | 'resize' | 'normalization' | 'output'>} definition
 * @returns {string}
 */
export function customModelId({
  sha256,
  inputName,
  outputName,
  inputSize,
  resize,
  normalization,
  output,
}) {
  const settings = JSON.stringify([
    inputName,
    outputName,
    inputSize,
    resize,
    normalization,
    output,
  ]);
  return `custom-${sha256.slice(0, 16)}-${fnv1a32(settings)}`;
}

/**
 * The label a file name suggests ("birefnet-lite-fp16.onnx" → "birefnet-lite-fp16")
 * @param {string} fileName
 * @returns {string}
 */
export function labelFromFileName(fileName) {
  const base = String(fileName ?? '')
    .replace(/\.onnx$/i, '')
    .trim();
  return (base || 'Custom model').slice(0, LABEL_MAX_LENGTH);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanLabel(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LENGTH)
    : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTensorName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/**
 * Check and normalize a definition (stored, imported or just confirmed).
 * The id is always recomputed from the content, so an imported definition
 * cannot claim another model's masks.
 * @param {unknown} raw
 * @returns {{ ok: true, definition: CustomModelDefinition } | { ok: false, error: string }}
 */
export function normalizeCustomModelDefinition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'This is not a model definition.' };
  }
  const d = /** @type {Record<string, unknown>} */ (raw);
  if (d.format !== CUSTOM_MODEL_FORMAT) {
    return { ok: false, error: 'This is not a Glinfs model definition.' };
  }
  if (typeof d.version !== 'number' || d.version > CUSTOM_MODEL_VERSION) {
    return { ok: false, error: 'This model definition was made by a newer version of Glinfs.' };
  }
  const fail = (/** @type {string} */ what) => ({
    ok: /** @type {const} */ (false),
    error: `The model definition has no valid ${what}.`,
  });
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) return fail('SHA-256');
  if (!Number.isSafeInteger(d.bytes) || /** @type {number} */ (d.bytes) <= 0) return fail('size');
  if (/** @type {number} */ (d.bytes) > MAX_MODEL_BYTES) return fail('size (over 2 GB)');
  if (!isTensorName(d.inputName)) return fail('input name');
  if (!isTensorName(d.outputName)) return fail('output name');
  const size = d.inputSize;
  if (
    !Number.isSafeInteger(size) ||
    /** @type {number} */ (size) < INPUT_SIZE_LIMITS.min ||
    /** @type {number} */ (size) > INPUT_SIZE_LIMITS.max
  ) {
    return fail('input size');
  }
  if (!RESIZE_MODES.includes(/** @type {any} */ (d.resize))) return fail('resize mode');
  if (typeof d.normalization !== 'string' || !Object.hasOwn(NORMALIZATIONS, d.normalization)) {
    return fail('normalization');
  }
  if (!OUTPUT_KINDS.includes(/** @type {any} */ (d.output))) return fail('output kind');
  const subjects = Array.isArray(d.subjects)
    ? CUSTOM_MODEL_SUBJECTS.filter((s) => /** @type {unknown[]} */ (d.subjects).includes(s))
    : [];
  if (subjects.length === 0) return fail('subject card');
  if (d.source !== 'file' && d.source !== 'url') return fail('source');
  /** @type {string | undefined} */
  let url;
  if (d.source === 'url') {
    try {
      const parsed = new URL(/** @type {string} */ (d.url));
      if (parsed.protocol !== 'https:') return fail('download URL (https)');
      url = parsed.href;
    } catch {
      return fail('download URL');
    }
  }
  const fileName =
    typeof d.fileName === 'string' && d.fileName.trim()
      ? d.fileName.trim().slice(0, 200)
      : 'model.onnx';
  const label = cleanLabel(d.label) || labelFromFileName(fileName);
  /** @type {CustomModelDefinition} */
  const definition = {
    format: CUSTOM_MODEL_FORMAT,
    version: CUSTOM_MODEL_VERSION,
    id: '',
    label,
    source: d.source,
    ...(url ? { url } : {}),
    fileName,
    bytes: /** @type {number} */ (d.bytes),
    sha256: d.sha256,
    inputName: /** @type {string} */ (d.inputName),
    outputName: /** @type {string} */ (d.outputName),
    inputSize: /** @type {number} */ (size),
    resize: /** @type {any} */ (d.resize),
    normalization: /** @type {any} */ (d.normalization),
    output: /** @type {any} */ (d.output),
    subjects,
  };
  definition.id = customModelId(definition);
  return { ok: true, definition };
}

/**
 * The same definition under a new label (the id stays)
 * @param {CustomModelDefinition} definition
 * @param {string} label
 * @returns {CustomModelDefinition}
 */
export function renameDefinition(definition, label) {
  return { ...definition, label: cleanLabel(label) || definition.label };
}

/**
 * Synthetic same-origin path a local file's bytes are cached under (it is
 * never fetched: a custom model from a file only exists in Cache Storage)
 * @param {string} sha256
 * @returns {string}
 */
export function customModelFileName(sha256) {
  return `custom/${sha256}.onnx`;
}

/**
 * The registry entry of a custom model (what the worker, the editor and
 * Settings read; see model-registry.js ModelEntry)
 * @param {CustomModelDefinition} definition
 * @returns {import('./model-registry.js').ModelEntry & { custom: true, localOnly: boolean, subjects: readonly CustomModelSubject[], definition: CustomModelDefinition }}
 */
export function toModelEntry(definition) {
  const { mean, std } = NORMALIZATIONS[definition.normalization];
  const fromUrl = definition.source === 'url' && definition.url;
  let host = '';
  if (fromUrl) {
    try {
      host = new URL(/** @type {string} */ (definition.url)).hostname;
    } catch {
      host = '';
    }
  }
  return {
    id: definition.id,
    custom: true,
    label: definition.label,
    modelName: definition.fileName,
    shortModelName: 'Custom',
    description: fromUrl ? `Added from ${host}` : 'Added from a file',
    finds: 'the subject',
    fileName: customModelFileName(definition.sha256),
    ...(fromUrl ? { url: definition.url } : {}),
    localOnly: !fromUrl,
    bytes: definition.bytes,
    sha256: definition.sha256,
    convertedFrom: {
      repo: '',
      revision: '',
      path: definition.fileName,
      bytes: definition.bytes,
      sha256: definition.sha256,
    },
    license: { name: 'Added by you', url: fromUrl ? /** @type {string} */ (definition.url) : '' },
    upstream: fromUrl ? /** @type {string} */ (definition.url) : '',
    inputName: definition.inputName,
    outputName: definition.outputName,
    inputSize: definition.inputSize,
    preprocess: {
      resize: definition.resize,
      scale: 1 / 255,
      mean: /** @type {[number, number, number]} */ ([...mean]),
      std: /** @type {[number, number, number]} */ ([...std]),
      output: definition.output,
    },
    subjects: Object.freeze([...definition.subjects]),
    definition,
  };
}

/**
 * The JSON a definition is exported as (Settings → Export)
 * @param {CustomModelDefinition} definition
 * @returns {string}
 */
export function exportDefinition(definition) {
  const { format, version, id, label, source, url, fileName, bytes, sha256 } = definition;
  const { inputName, outputName, inputSize, resize, normalization, output, subjects } = definition;
  return `${JSON.stringify(
    {
      format,
      version,
      id,
      label,
      source,
      ...(url ? { url } : {}),
      fileName,
      bytes,
      sha256,
      inputName,
      outputName,
      inputSize,
      resize,
      normalization,
      output,
      subjects,
    },
    null,
    2,
  )}\n`;
}

/**
 * Read an exported definition (the text of a .json file)
 * @param {string} text
 * @returns {{ ok: true, definition: CustomModelDefinition } | { ok: false, error: string }}
 */
export function parseDefinitionJson(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON.' };
  }
  return normalizeCustomModelDefinition(raw);
}

// ------------------------------------------------------------------
// Graph inspection → proposal
// ------------------------------------------------------------------

/**
 * One graph input or output, as onnxruntime-web's `inputMetadata` /
 * `outputMetadata` describe it.
 * @typedef {Object} GraphValue
 * @property {string} name
 * @property {boolean} isTensor
 * @property {string} [type] - 'float32', 'float16', ...
 * @property {readonly (number | string | null)[]} [shape] - A string or
 *   null for a symbolic or unknown dimension
 */

/**
 * @typedef {Object} GraphInfo
 * @property {readonly GraphValue[]} inputs
 * @property {readonly GraphValue[]} outputs
 */

/**
 * What the app can make of a graph.
 * @typedef {Object} GraphProposal
 * @property {string[]} problems - Why the file is out of scope (empty: in scope)
 * @property {string[]} maskOutputs - Outputs that can be the mask, best first
 * @property {number | null} fixedInputSize - The side the graph fixes (null: symbolic)
 * @property {Omit<CustomModelSettings, 'label' | 'subjects'>} settings - Proposed settings
 */

/**
 * @param {number | string | null | undefined} dim
 * @returns {number | null} The size, or null when symbolic
 */
function dimValue(dim) {
  return typeof dim === 'number' && Number.isFinite(dim) && dim > 0 ? dim : null;
}

/**
 * Describe a shape as the dialog shows it ("1 × 3 × 1024 × 1024", "? × 3 × H × W")
 * @param {readonly (number | string | null)[] | undefined} shape
 * @returns {string}
 */
export function formatShape(shape) {
  if (!shape) return 'unknown shape';
  if (shape.length === 0) return 'scalar';
  return shape
    .map((dim) =>
      typeof dim === 'number' && dim > 0 ? String(dim) : typeof dim === 'string' && dim ? dim : '?',
    )
    .join(' × ');
}

/** Output names that usually are the final mask, best first */
const MASK_NAME_HINTS = [
  /^output$/i,
  /^output_image$/i,
  /^mask$/i,
  /^alphas?$/i,
  /^pha$/i,
  /^out$/i,
];

/**
 * How well a mask output's name says it is the final mask (lower is better)
 * @param {string} name
 * @returns {number}
 */
function maskNameRank(name) {
  const index = MASK_NAME_HINTS.findIndex((pattern) => pattern.test(name));
  return index === -1 ? MASK_NAME_HINTS.length : index;
}

/**
 * Propose settings for a graph, or say why it is out of scope (one float32
 * image input [1, 3, S, S] and a float32 mask output [1, 1, S, S]).
 * @param {GraphInfo} graph
 * @returns {GraphProposal}
 */
export function proposeSettings(graph) {
  /** @type {string[]} */
  const problems = [];
  const inputs = graph.inputs ?? [];
  const outputs = graph.outputs ?? [];
  const input = inputs[0];
  let fixedInputSize = null;
  if (inputs.length !== 1) {
    problems.push(`The model has ${inputs.length} inputs. This app gives a model one image input.`);
  }
  if (input) {
    const shape = input.shape ?? [];
    if (!input.isTensor) {
      problems.push(`The input "${input.name}" is not a tensor.`);
    } else if (input.type && input.type !== 'float32') {
      problems.push(
        `The input "${input.name}" is ${input.type}. This app feeds float32 images (convert with keep_io_types).`,
      );
    }
    if (shape.length !== 4) {
      problems.push(
        `The input "${input.name}" has the shape ${formatShape(shape)}. This app feeds 1 × 3 × S × S.`,
      );
    } else {
      const [batch, channels, height, width] = shape.map(dimValue);
      if (batch !== null && batch !== 1) {
        problems.push(
          `The input "${input.name}" takes a batch of ${batch}. This app feeds one frame.`,
        );
      }
      if (channels !== null && channels !== 3) {
        problems.push(
          `The input "${input.name}" has ${channels} channels. This app feeds RGB (3).`,
        );
      }
      if (height !== null && width !== null && height !== width) {
        problems.push(
          `The input "${input.name}" is ${height} × ${width}. This app feeds square images.`,
        );
      } else {
        const side = height ?? width;
        if (side !== null) {
          if (side < INPUT_SIZE_LIMITS.min || side > INPUT_SIZE_LIMITS.max) {
            problems.push(
              `The input side ${side} is outside ${INPUT_SIZE_LIMITS.min}–${INPUT_SIZE_LIMITS.max}.`,
            );
          } else {
            fixedInputSize = side;
          }
        }
      }
    }
  }

  const maskOutputs = outputs
    .filter((output) => {
      if (!output.isTensor || (output.type && output.type !== 'float32')) return false;
      const shape = output.shape ?? [];
      if (shape.length !== 4) return false;
      const [batch, channels, height, width] = shape.map(dimValue);
      if (batch !== null && batch !== 1) return false;
      if (channels !== null && channels !== 1) return false;
      if (height !== null && width !== null && height !== width) return false;
      const side = height ?? width;
      return side === null || fixedInputSize === null || side === fixedInputSize;
    })
    .map((output, index) => ({ name: output.name, index }))
    .sort((a, b) => maskNameRank(a.name) - maskNameRank(b.name) || a.index - b.index)
    .map((output) => output.name);
  if (outputs.length === 0) {
    problems.push('The model has no outputs.');
  } else if (maskOutputs.length === 0) {
    const listed = outputs
      .map((output) => `"${output.name}" ${output.type ?? ''} ${formatShape(output.shape)}`.trim())
      .join(', ');
    problems.push(`No output is a float32 mask of 1 × 1 × S × S (the outputs are ${listed}).`);
  }

  const inputName = input?.name ?? '';
  return {
    problems,
    maskOutputs,
    fixedInputSize,
    settings: {
      inputName,
      outputName: maskOutputs[0] ?? '',
      inputSize: fixedInputSize ?? DEFAULT_INPUT_SIZE,
      // Most matting and salient-object models are trained on squares
      // stretched from the photo, with ImageNet statistics; the test run
      // shows whether that holds (an all-empty or all-full mask)
      resize: 'stretch',
      normalization: 'imagenet',
      output: /logit/i.test(maskOutputs[0] ?? '') ? 'logits' : 'probability',
    },
  };
}

// ------------------------------------------------------------------
// Test run
// ------------------------------------------------------------------

/**
 * @typedef {Object} TestAssessment
 * @property {boolean} ok
 * @property {'nan' | 'range' | 'all-zero' | 'all-one' | null} problem
 * @property {string} message - What the test found (UI copy)
 * @property {number} min - Smallest raw output value (NaN ignored)
 * @property {number} max - Largest raw output value (NaN ignored)
 * @property {number} coverage - Share of values above 0.5 after the output kind is applied
 * @property {boolean} [canSaveAnyway] - The model ran: the result may be the test image's fault
 */

/** Mask share below which the test mask counts as empty (and 1 - it as full) */
const EMPTY_SHARE = 0.002;

/**
 * Judge a test run's raw mask output for the chosen output kind: NaN,
 * values outside [0, 1] for a probability output, or a mask that is
 * empty or covers everything on the test image.
 * @param {ArrayLike<number>} values
 * @param {'probability' | 'logits'} kind
 * @returns {TestAssessment}
 */
export function assessTestOutput(values, kind) {
  let nan = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let above = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isNaN(value)) {
      nan++;
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
    const probability = kind === 'logits' ? 1 / (1 + Math.exp(-value)) : value;
    if (probability > 0.5) above++;
  }
  const counted = values.length - nan;
  const coverage = counted > 0 ? above / counted : 0;
  const range = counted > 0 ? `${round(min)} to ${round(max)}` : 'none';
  if (nan > 0) {
    return {
      ok: false,
      problem: 'nan',
      message: `The model returned NaN for ${nan} of ${values.length} mask values. On WebGPU this usually means a float16 overflow inside the graph (pooling in float16); this file cannot be used as it is.`,
      min,
      max,
      coverage,
    };
  }
  if (kind === 'probability' && (min < -0.01 || max > 1.01)) {
    return {
      ok: false,
      problem: 'range',
      message: `The output ranges from ${range}, outside 0..1: it is probably logits. Choose "Logits (sigmoid)" and test again.`,
      min,
      max,
      coverage,
    };
  }
  if (coverage < EMPTY_SHARE || coverage > 1 - EMPTY_SHARE) {
    const empty = coverage < EMPTY_SHARE;
    return {
      ok: false,
      problem: empty ? 'all-zero' : 'all-one',
      message: empty
        ? `The mask is empty on the test image (output ${range}). Try another normalization or output kind.`
        : `The mask covers the whole test image (output ${range}). Try another normalization or output kind.`,
      min,
      max,
      coverage,
      canSaveAnyway: true,
    };
  }
  return {
    ok: true,
    problem: null,
    message: `The model ran: the mask covers ${Math.round(coverage * 100)}% of the test image (output ${range}).`,
    min,
    max,
    coverage,
  };
}

/**
 * @param {number} value
 * @returns {string}
 */
function round(value) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
}

/**
 * The test image: a figure (head and body, outlined) in front of a
 * two-tone backdrop, so a working model finds a subject that covers part
 * of the frame. RGBA, size × size.
 * @param {number} size
 * @returns {Uint8ClampedArray}
 */
export function createTestFrame(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cx = size / 2;
  const head = { x: cx, y: size * 0.32, r: size * 0.13 };
  const body = { x: cx, y: size * 0.72, rx: size * 0.22, ry: size * 0.3 };
  const outline = size * 0.012;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Backdrop: pale sky above, muted floor below, with a soft gradient
      const t = y / size;
      let r = y < size * 0.75 ? 170 + 50 * t : 120;
      let g = y < size * 0.75 ? 195 + 30 * t : 135;
      let b = y < size * 0.75 ? 225 : 110;
      const dHead = Math.hypot(x - head.x, y - head.y) - head.r;
      const dBody =
        (Math.hypot((x - body.x) / body.rx, (y - body.y) / body.ry) - 1) *
        Math.min(body.rx, body.ry);
      const d = Math.min(dHead, dBody);
      if (d < 0) {
        if (dHead < 0) {
          // Face with dark hair on top
          const hair = y < head.y - head.r * 0.2;
          r = hair ? 60 : 245;
          g = hair ? 40 : 205;
          b = hair ? 30 : 180;
        } else {
          r = 200;
          g = 40;
          b = 60;
        }
      } else if (d < outline) {
        r = 20;
        g = 20;
        b = 25;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}
