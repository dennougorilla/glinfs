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
    // scripts/generate-conv-rule-fixture.py: one graph, six Convs
    const convs = listConvs(readOnnxGraph(fixture('webgpu-conv-rule.onnx')));
    expect(convs).toEqual([
      { name: 'conv_hazard_6', inputChannels: 6, kernel: [3, 3], group: 1 },
      { name: 'conv_ok_8', inputChannels: 8, kernel: [3, 3], group: 1 },
      { name: 'conv_ok_1x1', inputChannels: 6, kernel: [1, 1], group: 1 },
      // an fp16 initializer through a Cast
      { name: 'conv_cast_33', inputChannels: 33, kernel: [3, 3], group: 1 },
      // a Constant node
      { name: 'conv_const_99', inputChannels: 99, kernel: [3, 3], group: 1 },
      { name: 'conv_group_2x3', inputChannels: 3, kernel: [3, 3], group: 2 },
    ]);
  });

  it('rejects bytes that are not a model', () => {
    expect(() => readOnnxGraph(new TextEncoder().encode('not an onnx file'))).toThrow(RangeError);
  });
});

describe('isWebgpuConvHazard', () => {
  it('is the measured rule: kernel > 1, input channels divisible by 3, not by 4, more than 3', () => {
    const flagged = [];
    for (let c = 1; c <= 130; c++) {
      if (isWebgpuConvHazard({ inputChannels: c, kernel: [3, 3], group: 1 })) flagged.push(c);
    }
    // The 3 × 3 channel counts that came out wrong in the sweep (bakeoff3, 1..130)
    expect(flagged).toEqual([
      6, 9, 15, 18, 21, 27, 30, 33, 39, 42, 45, 51, 54, 57, 63, 66, 69, 75, 78, 81, 87, 90, 93, 99,
      102, 105, 111, 114, 117, 123, 126, 129,
    ]);
    expect(isWebgpuConvHazard({ inputChannels: 99, kernel: [1, 1], group: 1 })).toBe(false);
    expect(isWebgpuConvHazard({ inputChannels: 6, kernel: [7, 7], group: 1 })).toBe(true);
    // Grouped Convs were not measured: not flagged
    expect(isWebgpuConvHazard({ inputChannels: 6, kernel: [3, 3], group: 2 })).toBe(false);
  });
});

describe('findWebgpuConvHazards', () => {
  it('flags the Convs WebGPU computes wrong, and describes them for the Add model dialog', () => {
    const hazards = findWebgpuConvHazards(fixture('webgpu-conv-rule.onnx'));
    expect(hazards.map((h) => h.name)).toEqual(['conv_hazard_6', 'conv_cast_33', 'conv_const_99']);
    const message = describeWebgpuConvHazards(hazards);
    expect(message).toContain('onnxruntime-web WebGPU computes this convolution wrongly');
    expect(message).toContain('conv_hazard_6, 6 input channels, kernel 3 × 3 (and 2 more)');
    expect(message).toContain('Pad its input channels to a multiple of 4');
  });

  it('fails the model test on WebGPU only (WASM computes these Convs right)', () => {
    const hazards = findWebgpuConvHazards(fixture('stub-seg-conv6.onnx'));
    expect(hazards).toEqual([{ name: 'conv6_3x3', inputChannels: 6, kernel: [3, 3], group: 1 }]);
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
