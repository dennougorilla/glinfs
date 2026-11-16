/**
 * Reading an ONNX graph's Conv nodes from the file bytes, and the WebGPU Conv check
 * @module features/ai-cutout/onnx-graph
 *
 * onnxruntime-web's WebGPU backend (1.30 and 1.31.1) computes a Conv wrong
 * when its kernel is larger than 1 × 1 and its input has a number of
 * channels that is divisible by 3, not by 4, and more than 3 (6, 9, 15, 18,
 * 21, 27, 30, 33 ... 99 ...): the output is off by about its own magnitude,
 * while the WASM and CPU backends are right. Measured on 190 one-Conv graphs
 * (1 to 130 input channels, 1 × 1, 3 × 3 and 7 × 7 kernels, strides 1 and
 * 2) on an NVIDIA RTX 3080 Ti and on Chrome's SwiftShader adapter (a CPU
 * implementation of WebGPU), with the same wrong values on both: the error
 * is in the WebGPU kernel, not in a GPU or driver. Zero-padding the input
 * channels to a multiple of 4 (zero channels in the input and the weight)
 * gives exactly the same result and avoids it; scripts/convert-models-fp16.py
 * does that for the shipped models. Grouped Convs were not measured and are
 * not flagged.
 *
 * The reader is a minimal protobuf walk over the ModelProto: the graph's
 * nodes (name, op_type, inputs, outputs, attributes) and the shapes of its
 * initializers. Tensor data is skipped, never decoded, so a large file reads
 * fast. Weights in external data files are not supported (neither does the
 * app load such files).
 *
 * No ORT, no DOM: unit-tested.
 */

/**
 * @typedef {Object} OnnxAttribute
 * @property {number} [i]
 * @property {number[]} [ints]
 * @property {number[]} [dims] - Of a tensor attribute (a Constant's value)
 */

/**
 * @typedef {Object} OnnxNode
 * @property {string} name
 * @property {string} opType
 * @property {string[]} inputs
 * @property {string[]} outputs
 * @property {Record<string, OnnxAttribute>} attributes
 */

/**
 * @typedef {Object} OnnxGraph
 * @property {OnnxNode[]} nodes
 * @property {Map<string, number[]>} initializerDims - Initializer name → shape
 */

/**
 * @typedef {Object} ConvInfo
 * @property {string} name - The node's name (or its output when unnamed)
 * @property {number} inputChannels - Per group (the weight's axis 1)
 * @property {number[]} kernel
 * @property {number} group
 */

const decoder = new TextDecoder();

/**
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {[number, number]} value, next position
 */
function varint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('Truncated ONNX file');
    const b = buf[pos++];
    value += (b & 0x7f) * scale;
    if (b < 0x80) return [value, pos];
    scale *= 128;
  }
}

/**
 * The fields of a message between `start` and `end`
 * @param {Uint8Array} buf
 * @param {number} start
 * @param {number} end
 * @param {(field: number, wire: number, value: number, from: number, to: number) => void} visit -
 *   value: a varint's value; from / to: a length-delimited field's bytes
 */
function eachField(buf, start, end, visit) {
  let pos = start;
  while (pos < end) {
    const [key, afterKey] = varint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    pos = afterKey;
    if (wire === 0) {
      const [value, next] = varint(buf, pos);
      visit(field, wire, value, pos, next);
      pos = next;
    } else if (wire === 2) {
      const [length, next] = varint(buf, pos);
      if (next + length > end) throw new RangeError('Truncated ONNX file');
      visit(field, wire, 0, next, next + length);
      pos = next + length;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new RangeError(`Unsupported protobuf wire type ${wire}`);
    }
  }
  if (pos !== end) throw new RangeError('Truncated ONNX file');
}

/**
 * Repeated int64 field: packed (wire 2) or one varint per entry (wire 0)
 * @param {Uint8Array} buf
 * @param {number} wire
 * @param {number} value
 * @param {number} from
 * @param {number} to
 * @param {number[]} out
 */
function pushInts(buf, wire, value, from, to, out) {
  if (wire === 0) {
    out.push(value);
    return;
  }
  let pos = from;
  while (pos < to) {
    const [v, next] = varint(buf, pos);
    out.push(v);
    pos = next;
  }
}

/**
 * Shape of a TensorProto (dims = 1); its name (8)
 * @param {Uint8Array} buf
 * @param {number} from
 * @param {number} to
 * @returns {{ name: string, dims: number[] }}
 */
function readTensorHeader(buf, from, to) {
  const dims = [];
  let name = '';
  eachField(buf, from, to, (field, wire, value, a, b) => {
    if (field === 1) pushInts(buf, wire, value, a, b, dims);
    else if (field === 8 && wire === 2) name = decoder.decode(buf.subarray(a, b));
  });
  return { name, dims };
}

/**
 * @param {Uint8Array} buf
 * @param {number} from
 * @param {number} to
 * @returns {[string, OnnxAttribute]}
 */
function readAttribute(buf, from, to) {
  let name = '';
  /** @type {OnnxAttribute} */
  const attribute = {};
  eachField(buf, from, to, (field, wire, value, a, b) => {
    if (field === 1 && wire === 2) name = decoder.decode(buf.subarray(a, b));
    else if (field === 3 && wire === 0) attribute.i = value;
    else if (field === 8) pushInts(buf, wire, value, a, b, (attribute.ints ??= []));
    else if (field === 5 && wire === 2) attribute.dims = readTensorHeader(buf, a, b).dims;
  });
  return [name, attribute];
}

/**
 * @param {Uint8Array} buf
 * @param {number} from
 * @param {number} to
 * @returns {OnnxNode}
 */
function readNode(buf, from, to) {
  /** @type {OnnxNode} */
  const node = { name: '', opType: '', inputs: [], outputs: [], attributes: {} };
  eachField(buf, from, to, (field, wire, _value, a, b) => {
    if (wire !== 2) return;
    const text = () => decoder.decode(buf.subarray(a, b));
    if (field === 1) node.inputs.push(text());
    else if (field === 2) node.outputs.push(text());
    else if (field === 3) node.name = text();
    else if (field === 4) node.opType = text();
    else if (field === 5) {
      const [name, attribute] = readAttribute(buf, a, b);
      node.attributes[name] = attribute;
    }
  });
  return node;
}

/**
 * The main graph of an ONNX file: nodes and initializer shapes
 * @param {Uint8Array} bytes - A ModelProto
 * @returns {OnnxGraph}
 * @throws {RangeError} on a file that is not a readable ModelProto
 */
export function readOnnxGraph(bytes) {
  /** @type {OnnxGraph} */
  const graph = { nodes: [], initializerDims: new Map() };
  let found = false;
  eachField(bytes, 0, bytes.length, (field, wire, _value, from, to) => {
    if (field !== 7 || wire !== 2) return; // ModelProto.graph
    found = true;
    eachField(bytes, from, to, (gField, gWire, _v, a, b) => {
      if (gWire !== 2) return;
      if (gField === 1) graph.nodes.push(readNode(bytes, a, b));
      else if (gField === 5) {
        const { name, dims } = readTensorHeader(bytes, a, b);
        graph.initializerDims.set(name, dims);
      }
    });
  });
  if (!found) throw new RangeError('No graph in this ONNX file');
  return graph;
}

/** Ops a weight may pass through on its way from an initializer to a Conv */
const PASS_THROUGH = new Set(['Cast', 'Identity', 'DequantizeLinear']);

/**
 * Every Conv of a graph whose weight shape is known (an initializer, a
 * Constant, or either through Cast / Identity / DequantizeLinear)
 * @param {OnnxGraph} graph
 * @returns {ConvInfo[]}
 */
export function listConvs(graph) {
  /** @type {Map<string, OnnxNode>} */
  const producer = new Map();
  for (const node of graph.nodes) for (const out of node.outputs) producer.set(out, node);
  /** @param {string} name @returns {number[] | null} */
  const dimsOf = (name) => {
    let current = name;
    for (let hops = 0; hops < 8; hops++) {
      const dims = graph.initializerDims.get(current);
      if (dims) return dims;
      const node = producer.get(current);
      if (!node) return null;
      if (node.opType === 'Constant') return node.attributes.value?.dims ?? null;
      if (!PASS_THROUGH.has(node.opType)) return null;
      current = node.inputs[0];
    }
    return null;
  };
  /** @type {ConvInfo[]} */
  const convs = [];
  for (const node of graph.nodes) {
    if (node.opType !== 'Conv') continue;
    const dims = dimsOf(node.inputs[1] ?? '');
    if (!dims || dims.length < 3) continue;
    convs.push({
      name: node.name || node.outputs[0] || '(unnamed Conv)',
      inputChannels: dims[1],
      kernel: node.attributes.kernel_shape?.ints ?? dims.slice(2),
      group: node.attributes.group?.i ?? 1,
    });
  }
  return convs;
}

/**
 * Whether onnxruntime-web's WebGPU backend computes this Conv wrong (see the
 * module header): kernel above 1 × 1, input channels divisible by 3, not by
 * 4, more than 3; plain Convs (group 1) only
 * @param {ConvInfo} conv
 * @returns {boolean}
 */
export function isWebgpuConvHazard({ inputChannels, kernel, group }) {
  return (
    group === 1 &&
    kernel.some((k) => k > 1) &&
    inputChannels > 3 &&
    inputChannels % 3 === 0 &&
    inputChannels % 4 !== 0
  );
}

/**
 * The Convs of an ONNX file that WebGPU computes wrong
 * @param {Uint8Array} bytes
 * @returns {ConvInfo[]}
 */
export function findWebgpuConvHazards(bytes) {
  return listConvs(readOnnxGraph(bytes)).filter(isWebgpuConvHazard);
}

/**
 * The model test's verdict on such Convs: a failure on WebGPU (the backend
 * computes them wrong), nothing to say on WASM (it computes them right)
 * @param {ConvInfo[]} hazards
 * @param {'webgpu' | 'wasm' | null} backend - Where the test runs
 * @returns {{ ok: false, problem: 'webgpu-conv', message: string } | null}
 */
export function assessWebgpuConvs(hazards, backend) {
  if (backend !== 'webgpu' || hazards.length === 0) return null;
  return { ok: false, problem: 'webgpu-conv', message: describeWebgpuConvHazards(hazards) };
}

/**
 * The failure the model test reports for such Convs
 * @param {ConvInfo[]} hazards - At least one
 * @returns {string}
 */
export function describeWebgpuConvHazards(hazards) {
  const [first] = hazards;
  const more = hazards.length > 1 ? ` (and ${hazards.length - 1} more)` : '';
  return `onnxruntime-web WebGPU computes this convolution wrongly: ${first.name}, ${first.inputChannels} input channels, kernel ${first.kernel.join(' × ')}${more}. Pad its input channels to a multiple of 4 (zero channels in the input and in the weight give the same result).`;
}
