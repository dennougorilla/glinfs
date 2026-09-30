#!/usr/bin/env node
/**
 * Generate the tiny stand-ins for the AI cutout models used by unit and E2E
 * tests:
 *
 *   node scripts/generate-stub-seg-model.mjs
 *
 * tests/fixtures/models/stub-seg.onnx — same interface as the anime model
 * isnetis-fp16.onnx (opset 11): input `img` float32 [1, 3, 1024, 1024], output
 * `mask` float32 [1, 1, 1024, 1024]. The graph is a single node,
 * `mask = ReduceMean(img, axes=[1], keepdims=1)`: the mean of R, G and B in
 * [0, 1], so bright pixels read as foreground. It has no weights, so the
 * file is under 200 bytes.
 *
 * tests/fixtures/models/stub-seg-general.onnx — same interface as the
 * general model (isnet-general-fp16.onnx): input `input_image`, outputs
 * `output_image` and one side output `side_1` (the upstream fp32 graph has
 * 11; the shipped fp16 conversion keeps only `output_image`). Its
 * input is normalized with mean 0.5, so the graph adds the 0.5 back:
 * `side_1 = ReduceMean(input_image)`, `output_image = side_1 + 0.5` — the
 * same [0, 1] mean brightness as the anime stub gives.
 *
 * tests/fixtures/models/stub-seg-portrait.onnx — same interface as the
 * portrait model (modnet-portrait-fp16.onnx): input `input` float32
 * [1, 3, 512, 512] (a 1024 feed is rejected, so it checks that the worker
 * uses the model's own input side), output `output` [1, 1, 512, 512]. Its
 * input is normalized to [-1, 1] (mean 0.5, std 0.5), so the graph maps it
 * back: `output = ReduceMean(input) * 0.5 + 0.5`.
 *
 * tests/fixtures/models/stub-sam-encoder.onnx and stub-sam-decoder.onnx —
 * the two files of the click-to-select model (MobileSAM), same names and
 * shapes (opset 13). The encoder takes `input_image` [h, w, 3] (0..255),
 * averages the channels, resizes that grey image to 64 × 64 and repeats it
 * over 256 channels: `image_embeddings` [1, 256, 64, 64]. The decoder
 * ignores the prompt: from channel 0 of the embedding it makes four mask
 * logits `(grey - t) / 8` with t = 128, 200, 128, 60 (so the answers differ
 * in size: a bright part, the bright things, all but the darkest), resizes
 * them to `orig_im_size` (`masks` [1, 4, h, w]) and to 256 × 256
 * (`low_res_masks`), and answers fixed `iou_predictions` 0.9, 0.95, 0.85,
 * 0.3 — so Whole is threshold 128 and Part threshold 200. Its prompt inputs
 * are declared but unused.
 *
 * The ONNX protobuf is written by hand (proto2 wire format, see
 * https://github.com/onnx/onnx/blob/main/onnx/onnx.proto) so the script needs
 * no dependency; the output is deterministic, which keeps the committed file
 * reproducible.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default output path of the committed stub model */
export const STUB_MODEL_PATH = resolve(__dirname, '../tests/fixtures/models/stub-seg.onnx');

/** Output path of the committed stub of the general model */
export const STUB_GENERAL_MODEL_PATH = resolve(
  __dirname,
  '../tests/fixtures/models/stub-seg-general.onnx',
);

/** Output path of the committed stub of the portrait model */
export const STUB_PORTRAIT_MODEL_PATH = resolve(
  __dirname,
  '../tests/fixtures/models/stub-seg-portrait.onnx',
);

/** Output paths of the committed click-to-select stubs */
export const STUB_SAM_ENCODER_PATH = resolve(
  __dirname,
  '../tests/fixtures/models/stub-sam-encoder.onnx',
);
export const STUB_SAM_DECODER_PATH = resolve(
  __dirname,
  '../tests/fixtures/models/stub-sam-decoder.onnx',
);

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

/** onnx.TensorProto.DataType.FLOAT */
const ELEM_FLOAT = 1;
/** onnx.TensorProto.DataType.INT64 */
const ELEM_INT64 = 7;
/** onnx.AttributeProto.AttributeType.STRING */
const ATTR_STRING = 3;
/** onnx.AttributeProto.AttributeType */
const ATTR_INT = 2;
const ATTR_INTS = 7;

/**
 * Encode a non-negative integer as a protobuf varint.
 * @param {number} value
 * @returns {number[]}
 */
export function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varint must be a non-negative safe integer, got ${value}`);
  }
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
function varintField(field, value) {
  return [...encodeVarint((field << 3) | WIRE_VARINT), ...encodeVarint(value)];
}

/**
 * @param {number} field
 * @param {number[] | string} payload - Raw bytes, or a string written as UTF-8
 * @returns {number[]}
 */
function bytesField(field, payload) {
  const bytes = typeof payload === 'string' ? [...new TextEncoder().encode(payload)] : payload;
  return [
    ...encodeVarint((field << 3) | WIRE_LENGTH_DELIMITED),
    ...encodeVarint(bytes.length),
    ...bytes,
  ];
}

/**
 * ValueInfoProto for a float tensor.
 * @param {string} name
 * @param {(number | string)[]} dims - number = dim_value, string = dim_param (symbolic)
 * @returns {number[]}
 */
function floatTensorInfo(name, dims) {
  const shape = dims.flatMap((dim) =>
    bytesField(1, typeof dim === 'number' ? varintField(1, dim) : bytesField(2, dim)),
  );
  const tensorType = [...varintField(1, ELEM_FLOAT), ...bytesField(2, shape)];
  const typeProto = bytesField(1, tensorType);
  return [...bytesField(1, name), ...bytesField(2, typeProto)];
}

/**
 * NodeProto
 * @param {string} op
 * @param {string[]} inputs - '' for an omitted optional input
 * @param {string[]} outputs
 * @param {number[][]} [attributes]
 * @returns {number[]}
 */
function node(op, inputs, outputs, attributes = []) {
  return [
    ...inputs.flatMap((name) => bytesField(1, name)),
    ...outputs.flatMap((name) => bytesField(2, name)),
    ...bytesField(3, `${op}_${outputs[0]}`),
    ...bytesField(4, op),
    ...attributes.flatMap((attr) => bytesField(5, attr)),
  ];
}

/** @param {string} name @param {number[]} values */
const intsAttr = (name, values) => [
  ...bytesField(1, name),
  ...values.flatMap((v) => varintField(8, v)),
  ...varintField(20, ATTR_INTS),
];
/** @param {string} name @param {number} value */
const intAttr = (name, value) => [
  ...bytesField(1, name),
  ...varintField(3, value),
  ...varintField(20, ATTR_INT),
];
/** @param {string} name @param {string} value */
const stringAttr = (name, value) => [
  ...bytesField(1, name),
  ...bytesField(4, value),
  ...varintField(20, ATTR_STRING),
];

/**
 * TensorProto initializer with raw little-endian data
 * @param {string} name
 * @param {number[]} dims
 * @param {'float' | 'int64'} type
 * @param {number[]} values
 * @returns {number[]}
 */
function initializer(name, dims, type, values) {
  const raw = [];
  for (const v of values) {
    if (type === 'float') {
      raw.push(...new Uint8Array(Float32Array.of(v).buffer));
    } else {
      raw.push(...new Uint8Array(BigInt64Array.of(BigInt(v)).buffer));
    }
  }
  return [
    ...dims.flatMap((d) => varintField(1, d)),
    ...varintField(2, type === 'float' ? ELEM_FLOAT : ELEM_INT64),
    ...bytesField(8, name),
    ...bytesField(9, raw),
  ];
}

/**
 * ModelProto around a graph (opset 13)
 * @param {number[]} graph
 * @returns {Uint8Array}
 */
function model13(graph) {
  const opset = [...bytesField(1, ''), ...varintField(2, 13)];
  return Uint8Array.from([
    ...varintField(1, 7),
    ...bytesField(2, 'glinfs-stub-seg'),
    ...bytesField(7, graph),
    ...bytesField(8, opset),
  ]);
}

/**
 * Build the click-to-select encoder stub (see the file comment).
 * @returns {Uint8Array}
 */
export function buildSamEncoderStubModel() {
  const graph = [
    ...bytesField(
      1,
      node(
        'ReduceMean',
        ['input_image'],
        ['grey'],
        [intsAttr('axes', [2]), intAttr('keepdims', 1)],
      ),
    ),
    ...bytesField(1, node('Transpose', ['grey'], ['grey_chw'], [intsAttr('perm', [2, 0, 1])])),
    ...bytesField(1, node('Unsqueeze', ['grey_chw', 'axis0'], ['grey_nchw'])),
    ...bytesField(
      1,
      node('Resize', ['grey_nchw', '', '', 'grid_size'], ['grid'], [stringAttr('mode', 'linear')]),
    ),
    ...bytesField(1, node('Expand', ['grid', 'embedding_shape'], ['image_embeddings'])),
    ...bytesField(2, 'stub-sam-encoder'),
    ...bytesField(5, initializer('axis0', [1], 'int64', [0])),
    ...bytesField(5, initializer('grid_size', [4], 'int64', [1, 1, 64, 64])),
    ...bytesField(5, initializer('embedding_shape', [4], 'int64', [1, 256, 64, 64])),
    ...bytesField(11, floatTensorInfo('input_image', ['image_height', 'image_width', 3])),
    ...bytesField(12, floatTensorInfo('image_embeddings', [1, 256, 64, 64])),
  ];
  return model13(graph);
}

/**
 * Build the click-to-select decoder stub (see the file comment).
 * @returns {Uint8Array}
 */
export function buildSamDecoderStubModel() {
  const graph = [
    ...bytesField(1, node('Slice', ['image_embeddings', 'zero', 'one', 'one'], ['grey'])),
    ...bytesField(1, node('Sub', ['grey', 'thresholds'], ['shifted'])),
    ...bytesField(1, node('Div', ['shifted', 'eight'], ['logits'])),
    ...bytesField(1, node('Cast', ['orig_im_size'], ['hw'], [intAttr('to', ELEM_INT64)])),
    ...bytesField(1, node('Concat', ['one_four', 'hw'], ['mask_size'], [intAttr('axis', 0)])),
    ...bytesField(
      1,
      node('Resize', ['logits', '', '', 'mask_size'], ['masks'], [stringAttr('mode', 'linear')]),
    ),
    ...bytesField(
      1,
      node(
        'Resize',
        ['logits', '', '', 'low_size'],
        ['low_res_masks'],
        [stringAttr('mode', 'linear')],
      ),
    ),
    ...bytesField(1, node('Identity', ['scores'], ['iou_predictions'])),
    ...bytesField(2, 'stub-sam-decoder'),
    ...bytesField(5, initializer('zero', [1], 'int64', [0])),
    ...bytesField(5, initializer('one', [1], 'int64', [1])),
    ...bytesField(5, initializer('thresholds', [1, 4, 1, 1], 'float', [128, 200, 128, 60])),
    ...bytesField(5, initializer('eight', [], 'float', [8])),
    ...bytesField(5, initializer('one_four', [2], 'int64', [1, 4])),
    ...bytesField(5, initializer('low_size', [4], 'int64', [1, 4, 256, 256])),
    ...bytesField(5, initializer('scores', [1, 4], 'float', [0.9, 0.95, 0.85, 0.3])),
    ...bytesField(11, floatTensorInfo('image_embeddings', [1, 256, 64, 64])),
    ...bytesField(11, floatTensorInfo('point_coords', [1, 'num_points', 2])),
    ...bytesField(11, floatTensorInfo('point_labels', [1, 'num_points'])),
    ...bytesField(11, floatTensorInfo('mask_input', [1, 1, 256, 256])),
    ...bytesField(11, floatTensorInfo('has_mask_input', [1])),
    ...bytesField(11, floatTensorInfo('orig_im_size', [2])),
    ...bytesField(12, floatTensorInfo('masks', [1, 4, 'h', 'w'])),
    ...bytesField(12, floatTensorInfo('iou_predictions', [1, 4])),
    ...bytesField(12, floatTensorInfo('low_res_masks', [1, 4, 256, 256])),
  ];
  return model13(graph);
}

/**
 * Build the general stub's bytes (see the file comment).
 * @param {{ size?: number }} [options] - Spatial size (default 1024)
 * @returns {Uint8Array}
 */
export function buildGeneralStubModel({ size = 1024 } = {}) {
  const axesAttr = [...bytesField(1, 'axes'), ...varintField(8, 1), ...varintField(20, ATTR_INTS)];
  const keepdimsAttr = [
    ...bytesField(1, 'keepdims'),
    ...varintField(3, 1),
    ...varintField(20, ATTR_INT),
  ];
  const meanNode = [
    ...bytesField(1, 'input_image'),
    ...bytesField(2, 'side_1'),
    ...bytesField(3, 'mean_rgb'),
    ...bytesField(4, 'ReduceMean'),
    ...bytesField(5, axesAttr),
    ...bytesField(5, keepdimsAttr),
  ];
  const addNode = [
    ...bytesField(1, 'side_1'),
    ...bytesField(1, 'half'),
    ...bytesField(2, 'output_image'),
    ...bytesField(3, 'undo_mean'),
    ...bytesField(4, 'Add'),
  ];
  // TensorProto: scalar float 0.5 (data_type 1, name, raw_data little-endian)
  const half = [
    ...varintField(2, ELEM_FLOAT),
    ...bytesField(8, 'half'),
    ...bytesField(9, [0x00, 0x00, 0x00, 0x3f]),
  ];
  const graph = [
    ...bytesField(1, meanNode),
    ...bytesField(1, addNode),
    ...bytesField(2, 'stub-seg-general'),
    ...bytesField(5, half),
    ...bytesField(11, floatTensorInfo('input_image', [1, 3, size, size])),
    ...bytesField(12, floatTensorInfo('output_image', [1, 1, size, size])),
    ...bytesField(12, floatTensorInfo('side_1', [1, 1, size, size])),
  ];
  const opset = [...bytesField(1, ''), ...varintField(2, 11)];
  const model = [
    ...varintField(1, 6),
    ...bytesField(2, 'glinfs-stub-seg'),
    ...bytesField(7, graph),
    ...bytesField(8, opset),
  ];
  return Uint8Array.from(model);
}

/**
 * Build the portrait stub's bytes (see the file comment).
 * @param {{ size?: number }} [options] - Spatial size (default 512, like MODNet)
 * @returns {Uint8Array}
 */
export function buildPortraitStubModel({ size = 512 } = {}) {
  const axesAttr = [...bytesField(1, 'axes'), ...varintField(8, 1), ...varintField(20, ATTR_INTS)];
  const keepdimsAttr = [
    ...bytesField(1, 'keepdims'),
    ...varintField(3, 1),
    ...varintField(20, ATTR_INT),
  ];
  const meanNode = [
    ...bytesField(1, 'input'),
    ...bytesField(2, 'mean_pm1'),
    ...bytesField(3, 'mean_rgb'),
    ...bytesField(4, 'ReduceMean'),
    ...bytesField(5, axesAttr),
    ...bytesField(5, keepdimsAttr),
  ];
  const mulNode = [
    ...bytesField(1, 'mean_pm1'),
    ...bytesField(1, 'half'),
    ...bytesField(2, 'mean_half'),
    ...bytesField(3, 'undo_std'),
    ...bytesField(4, 'Mul'),
  ];
  const addNode = [
    ...bytesField(1, 'mean_half'),
    ...bytesField(1, 'half'),
    ...bytesField(2, 'output'),
    ...bytesField(3, 'undo_mean'),
    ...bytesField(4, 'Add'),
  ];
  const half = [
    ...varintField(2, ELEM_FLOAT),
    ...bytesField(8, 'half'),
    ...bytesField(9, [0x00, 0x00, 0x00, 0x3f]),
  ];
  const graph = [
    ...bytesField(1, meanNode),
    ...bytesField(1, mulNode),
    ...bytesField(1, addNode),
    ...bytesField(2, 'stub-seg-portrait'),
    ...bytesField(5, half),
    ...bytesField(11, floatTensorInfo('input', [1, 3, size, size])),
    ...bytesField(12, floatTensorInfo('output', [1, 1, size, size])),
  ];
  const opset = [...bytesField(1, ''), ...varintField(2, 11)];
  const model = [
    ...varintField(1, 6),
    ...bytesField(2, 'glinfs-stub-seg'),
    ...bytesField(7, graph),
    ...bytesField(8, opset),
  ];
  return Uint8Array.from(model);
}

/**
 * Build the stub model's bytes.
 * @param {{ size?: number }} [options] - Spatial size (default 1024, like isnetis)
 * @returns {Uint8Array}
 */
export function buildStubModel({ size = 1024 } = {}) {
  const axesAttr = [...bytesField(1, 'axes'), ...varintField(8, 1), ...varintField(20, ATTR_INTS)];
  const keepdimsAttr = [
    ...bytesField(1, 'keepdims'),
    ...varintField(3, 1),
    ...varintField(20, ATTR_INT),
  ];
  const node = [
    ...bytesField(1, 'img'),
    ...bytesField(2, 'mask'),
    ...bytesField(3, 'mean_rgb'),
    ...bytesField(4, 'ReduceMean'),
    ...bytesField(5, axesAttr),
    ...bytesField(5, keepdimsAttr),
  ];
  const graph = [
    ...bytesField(1, node),
    ...bytesField(2, 'stub-seg'),
    ...bytesField(11, floatTensorInfo('img', [1, 3, size, size])),
    ...bytesField(12, floatTensorInfo('mask', [1, 1, size, size])),
  ];
  const opset = [...bytesField(1, ''), ...varintField(2, 11)];
  const model = [
    ...varintField(1, 6), // ir_version 6 (opset 11 era)
    ...bytesField(2, 'glinfs-stub-seg'),
    ...bytesField(7, graph),
    ...bytesField(8, opset),
  ];
  return Uint8Array.from(model);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [path, bytes] of [
    [STUB_MODEL_PATH, buildStubModel()],
    [STUB_GENERAL_MODEL_PATH, buildGeneralStubModel()],
    [STUB_PORTRAIT_MODEL_PATH, buildPortraitStubModel()],
    [STUB_SAM_ENCODER_PATH, buildSamEncoderStubModel()],
    [STUB_SAM_DECODER_PATH, buildSamDecoderStubModel()],
  ]) {
    writeFileSync(path, bytes);
    console.log(`Wrote ${path} (${bytes.length} bytes)`);
  }
}
