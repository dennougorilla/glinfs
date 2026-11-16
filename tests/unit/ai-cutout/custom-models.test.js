import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessTestOutput,
  CUSTOM_MODEL_FORMAT,
  createTestFrame,
  customModelId,
  exportDefinition,
  formatShape,
  isCustomModelId,
  labelFromFileName,
  normalizeCustomModelDefinition,
  parseDefinitionJson,
  proposeSettings,
  renameDefinition,
  toModelEntry,
} from '../../../src/features/ai-cutout/custom-models.js';
import { getModelSpec } from '../../../src/features/ai-cutout/model-config.js';
import {
  checkModelUrl,
  isModelHost,
  MODEL_HOST_SOURCES,
  urlFileName,
} from '../../../src/features/ai-cutout/model-hosts.js';
import {
  getModelEntry,
  getModelIds,
  isModelId,
  MODEL_REGISTRY,
  onCustomModelsChange,
  setCustomModelEntries,
} from '../../../src/features/ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import {
  CUSTOM_MODEL_ID_PATTERN,
  getAiModel,
  normalizeEdits,
} from '../../../src/shared/edits/model.js';

const SHA = 'dd67588b7b3fe3d4b311a5f30d4298f3a3b5e2bd513c0c72c0e41c29fcb8e05e';

/** A definition as the dialog builds it */
function rawDefinition(overrides = {}) {
  return {
    format: CUSTOM_MODEL_FORMAT,
    version: 1,
    label: 'BiRefNet lite (mine)',
    source: 'file',
    fileName: 'birefnet-lite-fp16.onnx',
    bytes: 122_466_609,
    sha256: SHA,
    inputName: 'input_image',
    outputName: 'output_image',
    inputSize: 1024,
    resize: 'stretch',
    normalization: 'imagenet',
    output: 'logits',
    subjects: ['anime', 'general'],
    ...overrides,
  };
}

/** @param {object} [overrides] */
function definition(overrides) {
  const result = normalizeCustomModelDefinition(rawDefinition(overrides));
  if (!result.ok) throw new Error(result.error);
  return result.definition;
}

afterEach(() => setCustomModelEntries([]));

describe('custom model definitions', () => {
  it('normalizes a definition and gives it a stable id from its file and settings', () => {
    const d = definition();
    expect(d.id).toMatch(/^custom-dd67588b7b3fe3d4-[0-9a-f]{8}$/);
    expect(isCustomModelId(d.id)).toBe(true);
    // Same file and settings: same id, whatever the label, cards or source
    expect(definition({ label: 'Other', subjects: ['portrait'] }).id).toBe(d.id);
    expect(
      definition({ source: 'url', url: 'https://huggingface.co/a/b/resolve/c/m.onnx' }).id,
    ).toBe(d.id);
    expect(renameDefinition(d, '  Renamed  ')).toMatchObject({ id: d.id, label: 'Renamed' });
    // Settings that change the masks: another model
    for (const change of [
      { normalization: 'unit' },
      { output: 'probability' },
      { inputSize: 512 },
      { resize: 'letterbox' },
      { outputName: 'other' },
      { sha256: 'a'.repeat(64) },
    ]) {
      expect(definition(change).id).not.toBe(d.id);
    }
    // The id is recomputed: a definition cannot claim another model's id
    expect(definition({ id: 'custom-0000000000000000-00000000' }).id).toBe(d.id);
    expect(customModelId(d)).toBe(d.id);
  });

  it('rejects what it cannot run or trust', () => {
    const bad = [
      [null, 'not a model definition'],
      [{ ...rawDefinition(), format: 'x' }, 'not a Glinfs model definition'],
      [{ ...rawDefinition(), version: 2 }, 'newer version'],
      [{ ...rawDefinition(), sha256: 'xyz' }, 'SHA-256'],
      [{ ...rawDefinition(), bytes: 0 }, 'size'],
      [{ ...rawDefinition(), bytes: 3_000_000_000 }, 'over 2 GB'],
      [{ ...rawDefinition(), inputSize: 16 }, 'input size'],
      [{ ...rawDefinition(), resize: 'crop' }, 'resize'],
      [{ ...rawDefinition(), normalization: 'weird' }, 'normalization'],
      [{ ...rawDefinition(), normalization: 'toString' }, 'normalization'],
      [{ ...rawDefinition(), output: 'softmax' }, 'output kind'],
      [{ ...rawDefinition(), subjects: ['click'] }, 'subject card'],
      [{ ...rawDefinition(), source: 'url', url: 'http://huggingface.co/x.onnx' }, 'https'],
      [{ ...rawDefinition(), source: 'cloud' }, 'source'],
    ];
    for (const [raw, message] of bad) {
      const result = normalizeCustomModelDefinition(raw);
      expect(result.ok).toBe(false);
      expect(/** @type {any} */ (result).error).toContain(message);
    }
  });

  it('exports a definition as JSON and reads it back unchanged', () => {
    const d = definition({ source: 'url', url: 'https://huggingface.co/a/b/resolve/c/m.onnx' });
    const json = exportDefinition(d);
    expect(JSON.parse(json)).toEqual(d);
    expect(parseDefinitionJson(json)).toEqual({ ok: true, definition: d });
    expect(parseDefinitionJson('{oops')).toEqual({ ok: false, error: 'The file is not JSON.' });
  });

  it('makes a registry entry the worker and the editor can use', () => {
    const local = toModelEntry(definition());
    expect(local).toMatchObject({
      custom: true,
      localOnly: true,
      label: 'BiRefNet lite (mine)',
      fileName: `custom/${SHA}.onnx`,
      inputName: 'input_image',
      outputName: 'output_image',
      preprocess: {
        resize: 'stretch',
        scale: 1 / 255,
        mean: [0.485, 0.456, 0.406],
        std: [0.229, 0.224, 0.225],
        output: 'logits',
      },
      subjects: ['anime', 'general'],
    });
    expect('url' in local).toBe(false);
    const remote = toModelEntry(
      definition({ source: 'url', url: 'https://huggingface.co/a/b/resolve/c/m.onnx' }),
    );
    expect(remote).toMatchObject({
      localOnly: false,
      url: 'https://huggingface.co/a/b/resolve/c/m.onnx',
    });
    expect(labelFromFileName('model_fp16.onnx')).toBe('model_fp16');
    expect(labelFromFileName('.onnx')).toBe('Custom model');
  });
});

describe('custom models in the registry', () => {
  it('lists, looks up and specs a custom model like a registry one', () => {
    const d = definition();
    const seen = [];
    const off = onCustomModelsChange(() => seen.push(getModelIds().length));
    setCustomModelEntries([toModelEntry(d)]);
    off();
    expect(seen).toEqual([MODEL_REGISTRY.length + 1]);
    expect(getModelIds().at(-1)).toBe(d.id);
    expect(isModelId(d.id)).toBe(true);
    expect(getModelEntry(d.id).label).toBe(d.label);
    const spec = getModelSpec(d.id, '/glinfs/');
    expect(spec).toMatchObject({
      id: d.id,
      url: `/glinfs/models/custom/${SHA}.onnx`,
      localOnly: true,
      bytes: d.bytes,
      sha256: SHA,
      inputName: 'input_image',
    });
    expect(spec.files[0]).toMatchObject({ localOnly: true, sha256: SHA });
    // A URL model is fetched from its URL
    const url = 'https://huggingface.co/a/b/resolve/c/m.onnx';
    const byUrl = definition({ source: 'url', url, normalization: 'unit' });
    setCustomModelEntries([toModelEntry(byUrl)]);
    expect(getModelSpec(byUrl.id).url).toBe(url);
    // A custom entry cannot shadow a built-in model
    setCustomModelEntries([{ ...toModelEntry(d), id: 'anime' }]);
    expect(getModelEntry('anime').custom).toBeUndefined();
  });

  it('fails clearly for a custom model that is gone, instead of using another model', () => {
    const d = definition();
    expect(isModelId(d.id)).toBe(false);
    const entry = getModelEntry(d.id);
    expect(entry).toMatchObject({ missing: true, label: 'Missing custom model' });
    expect(() => getModelSpec(d.id)).toThrow(
      expect.objectContaining({ code: SegmentationErrorCode.MODEL_UNAVAILABLE }),
    );
    expect(() => getModelEntry('nope')).toThrow(RangeError);
    // The edits keep the id
    expect(getAiModel({ model: d.id })).toBe(d.id);
    const edits = normalizeEdits(
      { background: { enabled: true, method: 'ai', ai: { model: d.id } } },
      10,
    );
    expect(edits.background.ai.model).toBe(d.id);
    expect(getAiModel({ model: 'custom-nope' })).toBe('anime');
  });

  it('uses one id pattern in the edits and in the custom models', () => {
    const d = definition();
    expect(CUSTOM_MODEL_ID_PATTERN.test(d.id)).toBe(true);
    for (const id of ['custom-x', 'custom-dd67588b7b3fe3d4-1234567', `${d.id}0`, 'anime']) {
      expect(CUSTOM_MODEL_ID_PATTERN.test(id)).toBe(isCustomModelId(id));
    }
  });
});

describe('proposeSettings', () => {
  const image = (/** @type {any[]} */ shape, type = 'float32', name = 'input') => ({
    name,
    isTensor: true,
    type,
    shape,
  });

  it('proposes settings for a fixed [1, 3, S, S] → [1, 1, S, S] graph', () => {
    const proposal = proposeSettings({
      inputs: [image([1, 3, 1024, 1024], 'float32', 'input_image')],
      outputs: [image([1, 1, 1024, 1024], 'float32', 'output_image')],
    });
    expect(proposal).toEqual({
      problems: [],
      maskOutputs: ['output_image'],
      fixedInputSize: 1024,
      settings: {
        inputName: 'input_image',
        outputName: 'output_image',
        inputSize: 1024,
        resize: 'stretch',
        normalization: 'imagenet',
        output: 'probability',
      },
    });
  });

  it('lets the user choose the side of a symbolic graph and picks the main mask output', () => {
    const proposal = proposeSettings({
      inputs: [image(['batch', 3, 'height', 'width'])],
      outputs: [
        image(['batch', 1, 'height', 'width'], 'float32', 'side_1'),
        image(['batch', 1, 'height', 'width'], 'float32', 'mask'),
        image(['batch', 4, 'height', 'width'], 'float32', 'features'),
      ],
    });
    expect(proposal.problems).toEqual([]);
    expect(proposal.fixedInputSize).toBeNull();
    expect(proposal.settings.inputSize).toBe(1024);
    expect(proposal.maskOutputs).toEqual(['mask', 'side_1']);
    expect(proposal.settings.outputName).toBe('mask');
    expect(
      proposeSettings({
        inputs: [image([1, 3, 512, 512])],
        outputs: [image([1, 1, 512, 512], 'float32', 'logits')],
      }).settings.output,
    ).toBe('logits');
  });

  it('says why a graph is out of scope', () => {
    const problems = (/** @type {any} */ graph) => proposeSettings(graph).problems.join(' ');
    expect(
      problems({
        inputs: [image([1, 3, 1024, 1024]), image([1, 1])],
        outputs: [image([1, 1, 1024, 1024])],
      }),
    ).toMatch(/2 inputs/);
    expect(
      problems({
        inputs: [image([1, 3, 1024, 1024], 'float16')],
        outputs: [image([1, 1, 1024, 1024])],
      }),
    ).toMatch(/float16.*keep_io_types/);
    expect(
      problems({ inputs: [image([1, 3, 768, 1024])], outputs: [image([1, 1, 768, 1024])] }),
    ).toMatch(/square/);
    expect(
      problems({ inputs: [image([1, 1024, 1024, 3])], outputs: [image([1, 1, 1024, 1024])] }),
    ).toMatch(/1024 channels/);
    expect(
      problems({ inputs: [image([4, 3, 320, 320])], outputs: [image([4, 1, 320, 320])] }),
    ).toMatch(/batch of 4/);
    expect(
      problems({
        inputs: [image([1, 3, 1024, 1024])],
        outputs: [image([1, 21, 1024, 1024], 'float32', 'seg')],
      }),
    ).toMatch(/No output is a float32 mask.*"seg" float32 1 × 21 × 1024 × 1024/);
    expect(
      problems({ inputs: [image([1, 3, 1024, 1024])], outputs: [image([1, 1, 512, 512])] }),
    ).toMatch(/No output is a float32 mask/);
    expect(problems({ inputs: [image([1, 3, 4096, 4096])], outputs: [] })).toMatch(
      /outside 32–2048.*no outputs/,
    );
    expect(formatShape(['batch', 3, null, -1])).toBe('batch × 3 × ? × ?');
  });
});

describe('assessTestOutput', () => {
  const half = (/** @type {number} */ a, /** @type {number} */ b) =>
    Float32Array.from({ length: 100 }, (_, i) => (i < 50 ? a : b));

  it('passes a mask that covers part of the test image', () => {
    expect(assessTestOutput(half(0, 1), 'probability')).toMatchObject({
      ok: true,
      problem: null,
      coverage: 0.5,
    });
    expect(assessTestOutput(half(-8, 6), 'logits')).toMatchObject({ ok: true, coverage: 0.5 });
  });

  it('fails NaN, logits read as probabilities, and an empty or full mask', () => {
    const nan = half(0, 1);
    nan[3] = Number.NaN;
    expect(assessTestOutput(nan, 'probability')).toMatchObject({
      ok: false,
      problem: 'nan',
      message: expect.stringMatching(/NaN for 1 of 100.*float16/),
    });
    expect(assessTestOutput(half(-8, 6), 'probability')).toMatchObject({
      ok: false,
      problem: 'range',
      message: expect.stringMatching(/-8 to 6.*Logits/),
    });
    expect(assessTestOutput(new Float32Array(100), 'probability')).toMatchObject({
      ok: false,
      problem: 'all-zero',
      canSaveAnyway: true,
    });
    expect(assessTestOutput(new Float32Array(100).fill(9), 'logits')).toMatchObject({
      ok: false,
      problem: 'all-one',
      canSaveAnyway: true,
    });
  });

  it('draws a test frame with a subject in front of a backdrop', () => {
    const size = 64;
    const frame = createTestFrame(size);
    expect(frame).toHaveLength(size * size * 4);
    const at = (/** @type {number} */ x, /** @type {number} */ y) =>
      [...frame.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)].join(',');
    // Body (red) in the lower middle, backdrop in the corners
    expect(at(32, 48)).toBe('200,40,60');
    expect(at(1, 1)).not.toBe(at(32, 48));
    expect(frame[3]).toBe(255);
  });
});

describe('model hosts', () => {
  const base = 'https://dennougorilla.github.io/glinfs/';

  it('allows this site and Hugging Face, and turns a /blob/ page into its file', () => {
    expect(checkModelUrl('models/x.onnx', base)).toEqual({
      ok: true,
      url: 'https://dennougorilla.github.io/glinfs/models/x.onnx',
    });
    expect(
      checkModelUrl(
        'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/blob/main/onnx/model.onnx',
        base,
      ),
    ).toEqual({
      ok: true,
      url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
    });
    expect(checkModelUrl('https://us.aws.cdn.hf.co/xet/abc', base).ok).toBe(true);
    expect(isModelHost('cdn-lfs.huggingface.co')).toBe(true);
    expect(isModelHost('huggingface.co.evil.com')).toBe(false);
    expect(isModelHost('nothuggingface.co')).toBe(false);
  });

  it('refuses other hosts, plain http and credentials with a reason', () => {
    for (const url of [
      'https://github.com/dennougorilla/glinfs/releases/download/models-v1/isnetis-fp16.onnx',
      'http://huggingface.co/a/b/resolve/c/m.onnx',
      'https://user:pw@huggingface.co/a/b/resolve/c/m.onnx',
      'javascript:alert(1)',
      '',
    ]) {
      const checked = checkModelUrl(url, base);
      expect(checked.ok).toBe(false);
      expect(/** @type {any} */ (checked).reason.length).toBeGreaterThan(10);
    }
    expect(urlFileName('https://huggingface.co/a/b/resolve/c/onnx/model%20x.onnx')).toBe(
      'model x.onnx',
    );
  });

  it('matches the connect-src of the page CSP', () => {
    const html = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/index.html'),
      'utf8',
    );
    const connect = /connect-src ([^;]+);/.exec(html)?.[1].split(/\s+/) ?? [];
    expect(connect).toEqual(["'self'", ...MODEL_HOST_SOURCES]);
  });
});
