import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getModelFiles, MODEL_REGISTRY } from '../../../src/features/ai-cutout/model-registry.js';
import {
  assessWebgpuConvs,
  describeWebgpuConvHazards,
  findWebgpuConvHazards,
  isWebgpuConvHazard,
  listConvs,
  readOnnxGraph,
} from '../../../src/features/ai-cutout/onnx-graph.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name) => new Uint8Array(readFileSync(join(root, 'tests/fixtures/models', name)));

describe('readOnnxGraph / listConvs', () => {
  it('reads every Conv with its input channels, kernel and group, whatever holds the weight', () => {
    // scripts/generate-conv-rule-fixture.py: one graph, eight Convs
    const convs = listConvs(readOnnxGraph(fixture('webgpu-conv-rule.onnx')));
    const conv = (name, inputChannels, outputChannels, k, group = 1) => ({
      name,
      inputChannels,
      outputChannels,
      kernel: [k, k],
      group,
    });
    expect(convs).toEqual([
      conv('conv_hazard_6', 6, 4, 3),
      conv('conv_ok_8', 8, 4, 3),
      conv('conv_ok_1x1', 6, 4, 1),
      // an fp16 initializer through a Cast
      conv('conv_cast_33', 33, 4, 3),
      // a Constant node
      conv('conv_const_99', 99, 4, 3),
      conv('conv_group_2x3', 3, 4, 3, 2),
      conv('conv_ok_out3', 6, 3, 3),
      conv('conv_dilated_6', 6, 4, 3),
    ]);
  });

  it('rejects bytes that are not a model', () => {
    expect(() => readOnnxGraph(new TextEncoder().encode('not an onnx file'))).toThrow(RangeError);
  });
});

describe('isWebgpuConvHazard', () => {
  it('is the measured rule: kernel > 1, input channels divisible by 3, not by 4, more than 3, output channels a multiple of 4', () => {
    const hazard = (inputChannels, outputChannels, k = 3, group = 1) =>
      isWebgpuConvHazard({ inputChannels, outputChannels, kernel: [k, k], group });
    const flagged = [];
    for (let c = 1; c <= 130; c++) if (hazard(c, 64)) flagged.push(c);
    // The 3 × 3 input channel counts that came out wrong in the sweep (64 outputs, 1..130)
    expect(flagged).toEqual([
      6, 9, 15, 18, 21, 27, 30, 33, 39, 42, 45, 51, 54, 57, 63, 66, 69, 75, 78, 81, 87, 90, 93, 99,
      102, 105, 111, 114, 117, 123, 126, 129,
    ]);
    expect(hazard(99, 64, 1)).toBe(false);
    expect(hazard(6, 64, 7)).toBe(true);
    // Output channels (sweep of #198's review: 1, 2, 3, 4, 5, 6, 8, 12, 16 with 6, 9, 15, 99 inputs)
    const outputs = [1, 2, 3, 4, 5, 6, 8, 12, 16].filter((o) => hazard(9, o));
    expect(outputs).toEqual([4, 8, 12, 16]);
    // No grouped Conv measured was wrong: not flagged
    expect(hazard(6, 4, 3, 2)).toBe(false);
  });
});

describe('findWebgpuConvHazards', () => {
  it('flags the Convs WebGPU computes wrong, and describes them for the Add model dialog', () => {
    const hazards = findWebgpuConvHazards(fixture('webgpu-conv-rule.onnx'));
    expect(hazards.map((h) => h.name)).toEqual([
      'conv_hazard_6',
      'conv_cast_33',
      'conv_const_99',
      'conv_dilated_6',
    ]);
    const message = describeWebgpuConvHazards(hazards);
    expect(message).toContain('onnxruntime-web WebGPU computes this convolution wrongly');
    expect(message).toContain(
      'conv_hazard_6, 6 input and 4 output channels, kernel 3 × 3 (and 3 more)',
    );
    expect(message).toContain('Pad its input channels to a multiple of 4');
  });

  it('fails the model test on WebGPU only (WASM computes these Convs right)', () => {
    const hazards = findWebgpuConvHazards(fixture('stub-seg-conv6.onnx'));
    expect(hazards).toEqual([
      { name: 'conv6_3x3', inputChannels: 6, outputChannels: 4, kernel: [3, 3], group: 1 },
    ]);
    expect(assessWebgpuConvs(hazards, 'webgpu')).toEqual({
      ok: false,
      problem: 'webgpu-conv',
      message: describeWebgpuConvHazards(hazards),
    });
    expect(assessWebgpuConvs(hazards, 'wasm')).toBeNull();
    expect(assessWebgpuConvs([], 'webgpu')).toBeNull();
  });

  it('finds nothing in the test stand-ins of the app models', () => {
    for (const name of ['stub-seg.onnx', 'stub-sam-encoder.onnx', 'stub-sam-decoder.onnx']) {
      expect(findWebgpuConvHazards(fixture(name))).toEqual([]);
    }
  });

  // The shipped files are not in the repository (npm run models:fetch puts the
  // release ones in public/models); scanned when present, else
  // `npm run models:check-convs` (its output is in the PR that added it)
  const shipped = MODEL_REGISTRY.flatMap((entry) => getModelFiles(entry)).map((f) => f.fileName);
  const present = shipped.filter((name) => existsSync(join(root, 'public/models', name)));
  it.skipIf(present.length === 0)('no shipped model file in public/models has such a Conv', () => {
    for (const name of present) {
      const bytes = new Uint8Array(readFileSync(join(root, 'public/models', name)));
      expect({ name, hazards: findWebgpuConvHazards(bytes) }).toEqual({ name, hazards: [] });
    }
  });
});
