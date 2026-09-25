#!/usr/bin/env node
/**
 * Generate tests/fixtures/models/stub-seg.onnx — a tiny stand-in for the
 * anime-segmentation model used by unit and E2E tests.
 *
 *   node scripts/generate-stub-seg-model.mjs
 *
 * Same interface as isnetis.onnx (opset 11): input `img` float32
 * [1, 3, 1024, 1024], output `mask` float32 [1, 1, 1024, 1024]. The graph
 * is a single node, `mask = ReduceMean(img, axes=[1], keepdims=1)`: the mean
 * of R, G and B in [0, 1], so bright pixels read as foreground. It has no
 * weights, so the file is under 200 bytes.
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

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

/** onnx.TensorProto.DataType.FLOAT */
const ELEM_FLOAT = 1;
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
  const bytes = buildStubModel();
  writeFileSync(STUB_MODEL_PATH, bytes);
  console.log(`Wrote ${STUB_MODEL_PATH} (${bytes.length} bytes)`);
}
