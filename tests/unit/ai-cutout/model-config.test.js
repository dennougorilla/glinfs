import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeMismatch,
  ensureModel,
  hashFile,
  MODELS,
  main,
} from '../../../scripts/fetch-models.mjs';
import {
  buildGeneralStubModel,
  buildStubModel,
  encodeVarint,
  STUB_GENERAL_MODEL_PATH,
  STUB_MODEL_PATH,
} from '../../../scripts/generate-stub-seg-model.mjs';
import {
  DEFAULT_MODEL_ID,
  getModelDownloadUrl,
  getModelEntry,
  getModelIds,
  getModelSpec,
  getModelUrl,
  getUpstreamModelUrl,
  isModelId,
  MASK_MAX_SIDE,
  MODEL_CACHE_NAME,
  MODEL_INPUT_SIZE,
  MODEL_REGISTRY,
  MODEL_RELEASE_URL,
} from '../../../src/features/ai-cutout/model-config.js';
import { formatModelSize } from '../../../src/features/ai-cutout/model-registry.js';
import {
  createAbortError,
  fromErrorPayload,
  SegmentationError,
  SegmentationErrorCode,
  toErrorPayload,
} from '../../../src/features/ai-cutout/protocol.js';
import { AI_MODELS } from '../../../src/shared/edits/model.js';

const ANIME_SHA256 = 'f1aa383a62119572263a36ac9ebbd99bd14bc4052d0948662dc76b4b8c8d0bb0';
const GENERAL_SHA256 = '437b3207d043c5206b11c9f1681a0b1d647aeb560174f07420ed651989f3b38b';

const repoFile = (/** @type {string} */ path) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..', path), 'utf-8');

describe('model registry', () => {
  it('pins the fp16 anime-segmentation model and the upstream file it comes from', () => {
    expect(getModelEntry('anime')).toMatchObject({
      label: 'Anime',
      fileName: 'isnetis-fp16.onnx',
      bytes: 88_070_957,
      sha256: ANIME_SHA256,
      convertedFrom: {
        repo: 'skytnt/anime-seg',
        revision: '493cb60893f47441b26ec4fb9a306bce9e342982',
        path: 'isnetis.onnx',
        bytes: 176_069_933,
        sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
      },
      license: { name: 'Apache-2.0' },
      inputName: 'img',
      outputName: 'mask',
      inputSize: 1024,
    });
  });

  it('pins the fp16 general IS-Net (DIS) model and the upstream file it comes from', () => {
    expect(getModelEntry('general')).toMatchObject({
      label: 'General',
      fileName: 'isnet-general-fp16.onnx',
      bytes: 90_448_072,
      sha256: GENERAL_SHA256,
      convertedFrom: {
        repo: 'BritishWerewolf/IS-Net',
        revision: '9783722d9f964c0286a411e7e8e6fede947d5a53',
        path: 'onnx/model.onnx',
        bytes: 178_648_008,
        sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
      },
      license: { name: 'Apache-2.0' },
      inputName: 'input_image',
      outputName: 'output_image',
      inputSize: 1024,
    });
  });

  it('has well-formed, unique entries and a frozen shape', () => {
    const ids = getModelIds();
    expect(ids).toEqual(['anime', 'general']);
    expect(new Set(MODEL_REGISTRY.map((e) => e.fileName)).size).toBe(ids.length);
    for (const entry of MODEL_REGISTRY) {
      expect(entry.convertedFrom.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.convertedFrom.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(entry.bytes)).toBe(true);
      // fp16 halves the upstream fp32 file
      expect(entry.bytes).toBeLessThan(entry.convertedFrom.bytes * 0.55);
      expect(Object.isFrozen(entry.convertedFrom)).toBe(true);
      expect(entry.license.url).toMatch(/^https:\/\//);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.preprocess)).toBe(true);
    }
    expect(DEFAULT_MODEL_ID).toBe('anime');
    expect(MODEL_INPUT_SIZE).toBe(1024);
    expect(MASK_MAX_SIDE).toBe(1024);
    expect(MODEL_CACHE_NAME).toBe('glinfs-models-v1');
    expect(isModelId('general')).toBe(true);
    expect(isModelId('isnetis')).toBe(false);
    expect(() => getModelEntry('nope')).toThrow(RangeError);
    expect(formatModelSize(178_648_008)).toBe('179 MB');
    expect(formatModelSize(getModelEntry('anime').bytes)).toBe('88 MB');
    expect(formatModelSize(getModelEntry('general').bytes)).toBe('90 MB');
  });

  it('matches the model ids the edits accept', () => {
    expect([...AI_MODELS]).toEqual(getModelIds());
  });

  it('documents each upstream preprocessing contract', () => {
    // skytnt get_mask: letterbox, / 255, no mean/std
    expect(getModelEntry('anime').preprocess).toEqual({
      resize: 'letterbox',
      scale: 1 / 255,
      mean: [0, 0, 0],
      std: [1, 1, 1],
      output: 'probability',
    });
    // DIS Inference.py: stretch to 1024², / 255, mean 0.5, std 1
    expect(getModelEntry('general').preprocess).toEqual({
      resize: 'stretch',
      scale: 1 / 255,
      mean: [0.5, 0.5, 0.5],
      std: [1, 1, 1],
      output: 'probability',
    });
  });
});

describe('model-config', () => {
  it('feeds scripts/fetch-models.mjs from the registry (one release asset per model)', () => {
    expect(MODELS).toHaveLength(MODEL_REGISTRY.length);
    for (const entry of MODEL_REGISTRY) {
      const pin = MODELS.find((m) => m.fileName === entry.fileName);
      expect(pin).toEqual({
        fileName: entry.fileName,
        url: getModelDownloadUrl(entry),
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
      // The asset name is the local file name
      expect(getModelDownloadUrl(entry)).toBe(`${MODEL_RELEASE_URL}/${entry.fileName}`);
    }
    expect(MODEL_RELEASE_URL).toBe(
      'https://github.com/dennougorilla/glinfs/releases/download/models-v1',
    );
    expect(getModelDownloadUrl(getModelEntry('anime'))).toBe(
      'https://github.com/dennougorilla/glinfs/releases/download/models-v1/isnetis-fp16.onnx',
    );
    expect(getUpstreamModelUrl(getModelEntry('general'))).toBe(
      'https://huggingface.co/BritishWerewolf/IS-Net/resolve/9783722d9f964c0286a411e7e8e6fede947d5a53/onnx/model.onnx',
    );
  });

  it('converts from the same upstream files to the same asset names as scripts/convert-models-fp16.py', () => {
    const script = repoFile('scripts/convert-models-fp16.py');
    const flat = script.replace(/"\s*\n\s*"/g, ''); // join Python's implicit string concatenation
    for (const entry of MODEL_REGISTRY) {
      const { bytes, sha256 } = entry.convertedFrom;
      expect(flat).toContain(`"id": "${entry.id}"`);
      expect(flat).toContain(`"asset": "${entry.fileName}"`);
      expect(flat).toContain(`"upstream_url": "${getUpstreamModelUrl(entry)}"`);
      expect(flat).toContain(
        `"upstream_bytes": ${bytes.toLocaleString('en-US').replaceAll(',', '_')}`,
      );
      expect(flat).toContain(`"upstream_sha256": "${sha256}"`);
      expect(flat).toContain(`"keep_outputs": ["${entry.outputName}"]`);
    }
    expect(repoFile('scripts/requirements-models.txt')).toMatch(/^onnxconverter-common==\d/m);
  });

  it('uses the same SHA-256s and files as the Pages deploy workflow (cache key and final check)', () => {
    const workflow = repoFile('.github/workflows/deploy.yml');
    const hashes = workflow.match(/[0-9a-f]{64}/g) ?? [];
    // Each hash appears in the cache key and in the final check
    expect(hashes.length).toBeGreaterThanOrEqual(2 * MODEL_REGISTRY.length);
    expect(new Set(hashes)).toEqual(new Set(MODEL_REGISTRY.map((e) => e.sha256)));
    for (const entry of MODEL_REGISTRY) {
      expect(workflow).toContain(`public/models/${entry.fileName}`);
      expect(workflow).toContain(`check ${entry.fileName} ${entry.sha256}`);
    }
    expect(workflow.indexOf('npm run models:fetch')).toBeLessThan(
      workflow.indexOf('npm run build'),
    );
    // The Pages artifact must stay under 1 GB
    expect(workflow).toContain('-ge 1000000000');
    const total = MODEL_REGISTRY.reduce((sum, e) => sum + e.bytes, 0);
    expect(total).toBeLessThan(200_000_000);
  });

  it('serves each model same-origin under the base path', () => {
    expect(getModelUrl('anime', '/glinfs/')).toBe('/glinfs/models/isnetis-fp16.onnx');
    expect(getModelUrl('anime', '/glinfs')).toBe('/glinfs/models/isnetis-fp16.onnx');
    expect(getModelUrl('anime')).toBe('/models/isnetis-fp16.onnx'); // vitest BASE_URL is '/'
    expect(getModelUrl('general', '/glinfs/')).toBe('/glinfs/models/isnet-general-fp16.onnx');
  });

  it('describes each model for the worker', () => {
    expect(getModelSpec('anime', '/glinfs/')).toEqual({
      id: 'anime',
      url: '/glinfs/models/isnetis-fp16.onnx',
      bytes: 88_070_957,
      sha256: ANIME_SHA256,
      inputName: 'img',
      outputName: 'mask',
      inputSize: 1024,
      preprocess: getModelEntry('anime').preprocess,
    });
    expect(getModelSpec('general')).toMatchObject({
      id: 'general',
      url: '/models/isnet-general-fp16.onnx',
      sha256: GENERAL_SHA256,
      inputName: 'input_image',
      outputName: 'output_image',
      preprocess: { resize: 'stretch', mean: [0.5, 0.5, 0.5] },
    });
  });
});

describe('protocol', () => {
  it('round-trips SegmentationErrors through message payloads', () => {
    const error = new SegmentationError(SegmentationErrorCode.HASH_MISMATCH, 'bad hash');
    const payload = toErrorPayload(error, SegmentationErrorCode.INFERENCE_FAILED);
    expect(payload).toEqual({ code: 'hash-mismatch', message: 'bad hash' });
    const back = fromErrorPayload(payload, SegmentationErrorCode.INFERENCE_FAILED);
    expect(back).toBeInstanceOf(SegmentationError);
    expect(back.code).toBe('hash-mismatch');
  });

  it('uses the fallback code for other errors', () => {
    expect(toErrorPayload(new Error('x'), 'inference-failed')).toEqual({
      code: 'inference-failed',
      message: 'x',
    });
    expect(toErrorPayload('plain', 'inference-failed').message).toBe('plain');
    expect(fromErrorPayload(undefined, 'worker-crashed')).toMatchObject({
      code: 'worker-crashed',
      message: 'Segmentation failed',
    });
  });

  it('creates AbortErrors', () => {
    expect(createAbortError().name).toBe('AbortError');
  });
});

describe('scripts/generate-stub-seg-model.mjs', () => {
  it('encodes varints', () => {
    expect(encodeVarint(0)).toEqual([0]);
    expect(encodeVarint(127)).toEqual([127]);
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
    expect(() => encodeVarint(-1)).toThrow(RangeError);
  });

  it('reproduces the committed stub models byte for byte', () => {
    expect(Buffer.from(buildStubModel()).equals(readFileSync(STUB_MODEL_PATH))).toBe(true);
    expect(Buffer.from(buildGeneralStubModel()).equals(readFileSync(STUB_GENERAL_MODEL_PATH))).toBe(
      true,
    );
  });

  it('names the same input/output and op as documented', () => {
    const text = Buffer.from(buildStubModel()).toString('latin1');
    for (const token of ['img', 'mask', 'ReduceMean', 'axes', 'keepdims']) {
      expect(text).toContain(token);
    }
  });

  it('gives the general stub the general model’s names and a side output', () => {
    const general = getModelEntry('general');
    const text = Buffer.from(buildGeneralStubModel()).toString('latin1');
    for (const token of [general.inputName, general.outputName, 'side_1', 'ReduceMean', 'Add']) {
      expect(text).toContain(token);
    }
  });
});

describe('scripts/fetch-models.mjs', () => {
  /** @type {string} */
  let dir;
  const content = Buffer.from('not really a model');
  const pin = {
    fileName: 'tiny.onnx',
    url: 'https://example.test/releases/download/v1/tiny.onnx',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  const quiet = () => {};

  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir() {
    dir = mkdtempSync(join(tmpdir(), 'glinfs-models-'));
    return dir;
  }

  it('describes size and hash mismatches', () => {
    expect(describeMismatch(pin, { bytes: pin.bytes, sha256: pin.sha256 })).toBeNull();
    expect(describeMismatch(pin, { bytes: 1, sha256: pin.sha256 })).toContain('size 1 bytes');
    expect(describeMismatch(pin, { bytes: pin.bytes, sha256: 'x' })).toContain('SHA-256 x');
  });

  it('hashes files and returns null for missing ones', async () => {
    const out = tempDir();
    writeFileSync(join(out, 'f'), content);
    await expect(hashFile(join(out, 'f'))).resolves.toEqual({
      bytes: pin.bytes,
      sha256: pin.sha256,
    });
    await expect(hashFile(join(out, 'missing'))).resolves.toBeNull();
  });

  it('keeps a verified file without downloading', async () => {
    const out = tempDir();
    writeFileSync(join(out, pin.fileName), content);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ensureModel(pin, { outDir: out, log: quiet })).resolves.toBe('present');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downloads, verifies and renames into place', async () => {
    const out = tempDir();
    const fetchSpy = vi.fn(async () => new Response(content));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ensureModel(pin, { outDir: out, log: quiet })).resolves.toBe('downloaded');
    expect(fetchSpy).toHaveBeenCalledWith(pin.url, { redirect: 'follow' });
    expect(readFileSync(join(out, pin.fileName)).equals(content)).toBe(true);
  });

  it('replaces a corrupt file and deletes a download that does not match', async () => {
    const out = tempDir();
    writeFileSync(join(out, pin.fileName), 'corrupt');
    vi.stubGlobal('fetch', async () => new Response('something else entirely'));
    await expect(ensureModel(pin, { outDir: out, log: quiet })).rejects.toThrow(
      /downloaded file rejected/,
    );
    await expect(hashFile(join(out, pin.fileName))).resolves.toBeNull();
    await expect(hashFile(join(out, `${pin.fileName}.download`))).resolves.toBeNull();
  });

  it('fails on HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(ensureModel(pin, { outDir: tempDir(), log: quiet })).rejects.toThrow(/HTTP 503/);
  });

  it('--check verifies without downloading and fails loudly', async () => {
    const out = tempDir();
    await expect(ensureModel(pin, { outDir: out, checkOnly: true, log: quiet })).rejects.toThrow(
      /missing/,
    );
    writeFileSync(join(out, pin.fileName), 'corrupt');
    await expect(ensureModel(pin, { outDir: out, checkOnly: true, log: quiet })).rejects.toThrow(
      /deleted/,
    );
    await expect(hashFile(join(out, pin.fileName))).resolves.toBeNull();
  });

  it('main() returns a non-zero exit code and says why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // --check never downloads: an empty directory must fail
    await expect(main(['--check'], { outDir: tempDir() })).resolves.toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain('models:fetch FAILED');
    error.mockRestore();
  });
});
