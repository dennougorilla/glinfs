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
  sourceUrl,
} from '../../../scripts/fetch-models.mjs';
import {
  buildStubModel,
  encodeVarint,
  STUB_MODEL_PATH,
} from '../../../scripts/generate-stub-seg-model.mjs';
import {
  getModelSourceUrl,
  getModelSpec,
  getModelUrl,
  MASK_MAX_SIDE,
  MODEL_BYTES,
  MODEL_CACHE_NAME,
  MODEL_FILE_NAME,
  MODEL_HF_REPO,
  MODEL_HF_REVISION,
  MODEL_INPUT_NAME,
  MODEL_INPUT_SIZE,
  MODEL_OUTPUT_NAME,
  MODEL_SHA256,
  PREPROCESS,
} from '../../../src/features/ai-cutout/model-config.js';
import {
  createAbortError,
  fromErrorPayload,
  SegmentationError,
  SegmentationErrorCode,
  toErrorPayload,
} from '../../../src/features/ai-cutout/protocol.js';

describe('model-config', () => {
  it('pins the anime-segmentation model by commit, size and SHA-256', () => {
    expect(MODEL_HF_REPO).toBe('skytnt/anime-seg');
    expect(MODEL_HF_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL_BYTES).toBe(176_069_933);
    expect(MODEL_FILE_NAME).toBe('isnetis.onnx');
    expect(MODEL_INPUT_SIZE).toBe(1024);
    expect(MASK_MAX_SIDE).toBe(1024);
    expect([MODEL_INPUT_NAME, MODEL_OUTPUT_NAME]).toEqual(['img', 'mask']);
    expect(MODEL_CACHE_NAME).toBe('glinfs-models-v1');
  });

  it('keeps the pins identical to scripts/fetch-models.mjs', () => {
    const pin = MODELS.find((m) => m.fileName === MODEL_FILE_NAME);
    expect(pin).toEqual({
      fileName: MODEL_FILE_NAME,
      repo: MODEL_HF_REPO,
      revision: MODEL_HF_REVISION,
      bytes: MODEL_BYTES,
      sha256: MODEL_SHA256,
    });
    expect(sourceUrl(/** @type {any} */ (pin))).toBe(getModelSourceUrl());
    expect(getModelSourceUrl()).toContain(`/resolve/${MODEL_HF_REVISION}/`);
  });

  it('uses the same SHA-256 as the Pages deploy workflow (cache key and final check)', () => {
    const workflow = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/deploy.yml'),
      'utf-8',
    );
    const hashes = workflow.match(/[0-9a-f]{64}/g) ?? [];
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashes)).toEqual(new Set([MODEL_SHA256]));
    expect(workflow.indexOf('npm run models:fetch')).toBeLessThan(
      workflow.indexOf('npm run build'),
    );
  });

  it('serves the model same-origin under the base path', () => {
    expect(getModelUrl('/glinfs/')).toBe('/glinfs/models/isnetis.onnx');
    expect(getModelUrl('/glinfs')).toBe('/glinfs/models/isnetis.onnx');
    expect(getModelUrl()).toBe('/models/isnetis.onnx'); // vitest BASE_URL is '/'
  });

  it('describes the model for the worker', () => {
    expect(getModelSpec('/glinfs/')).toEqual({
      url: '/glinfs/models/isnetis.onnx',
      bytes: MODEL_BYTES,
      sha256: MODEL_SHA256,
      inputName: 'img',
      outputName: 'mask',
      inputSize: 1024,
    });
  });

  it('documents the upstream preprocessing contract', () => {
    expect(PREPROCESS).toMatchObject({
      colorOrder: 'rgb',
      mean: null,
      std: null,
      layout: 'nchw',
      pad: 'center-zero',
      output: 'probability',
    });
    expect(PREPROCESS.scale).toBeCloseTo(1 / 255);
    expect(Object.isFrozen(PREPROCESS)).toBe(true);
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

  it('reproduces the committed stub model byte for byte', () => {
    const committed = readFileSync(STUB_MODEL_PATH);
    expect(Buffer.from(buildStubModel()).equals(committed)).toBe(true);
  });

  it('names the same input/output and op as documented', () => {
    const text = Buffer.from(buildStubModel()).toString('latin1');
    for (const token of ['img', 'mask', 'ReduceMean', 'axes', 'keepdims']) {
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
    repo: 'someone/tiny',
    revision: 'a'.repeat(40),
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

  it('builds pinned Hugging Face URLs', () => {
    expect(sourceUrl(pin)).toBe(
      `https://huggingface.co/someone/tiny/resolve/${'a'.repeat(40)}/tiny.onnx`,
    );
  });

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
    expect(fetchSpy).toHaveBeenCalledWith(sourceUrl(pin), { redirect: 'follow' });
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
