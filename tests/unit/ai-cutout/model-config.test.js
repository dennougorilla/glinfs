import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  removeUnlistedFiles,
} from '../../../scripts/fetch-models.mjs';
import {
  buildGeneralStubModel,
  buildPortraitStubModel,
  buildSamDecoderStubModel,
  buildSamEncoderStubModel,
  buildStubModel,
  encodeVarint,
  STUB_GENERAL_MODEL_PATH,
  STUB_MODEL_PATH,
  STUB_PORTRAIT_MODEL_PATH,
  STUB_SAM_DECODER_PATH,
  STUB_SAM_ENCODER_PATH,
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
import {
  formatModelSize,
  getModelFiles,
  isSamEntry,
  isSamModelId,
} from '../../../src/features/ai-cutout/model-registry.js';
import {
  createAbortError,
  fromErrorPayload,
  SegmentationError,
  SegmentationErrorCode,
  toErrorPayload,
} from '../../../src/features/ai-cutout/protocol.js';
import { AI_MODELS, getAiModel } from '../../../src/shared/edits/model.js';

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

  it('pins the fp16 MODNet portrait model (Conv channels padded) and its upstream file', () => {
    expect(getModelEntry('portrait')).toMatchObject({
      label: 'Portrait',
      modelName: 'MODNet',
      shortModelName: 'MODNet',
      fileName: 'modnet-portrait-fp16.onnx',
      bytes: 12_987_022,
      sha256: 'e59298740c266e5a095b5b7f7c7d69c824e231799dd475e6c6d1e8fc83560f1c',
      convertedFrom: {
        repo: 'Xenova/modnet',
        revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
        path: 'onnx/model.onnx',
        bytes: 25_888_640,
        sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
      },
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
      upstream: 'https://github.com/ZHKKKe/MODNet',
      inputName: 'input',
      outputName: 'output',
      inputSize: 512,
    });
    expect(getModelEntry('portrait').licenseNote).toBeUndefined();
    // The spec the worker gets carries the 512 input side
    expect(getModelSpec('portrait')).toMatchObject({
      id: 'portrait',
      url: '/models/modnet-portrait-fp16.onnx',
      inputSize: 512,
      inputName: 'input',
      outputName: 'output',
    });
    // Only MODNet needs the WebGPU Conv workaround in the conversion script
    const script = repoFile('scripts/convert-models-fp16.py');
    expect(script.match(/"pad_conv_channels": True/g)).toHaveLength(1);
  });

  it('notes the general model’s training-data terms (DIS5K) for Settings', () => {
    const note = getModelEntry('general').licenseNote;
    expect(note).toMatchObject({ url: 'https://github.com/xuebinqin/DIS' });
    expect(note?.text).toMatch(/DIS5K/);
    expect(note?.text).toMatch(/non-commercial/);
    expect(Object.isFrozen(note)).toBe(true);
    expect(getModelEntry('anime').licenseNote).toBeUndefined();
  });

  it('pins MobileSAM (Click to select) as one model of two files shipped unchanged', () => {
    const entry = getModelEntry('click');
    expect(entry).toMatchObject({
      kind: 'sam',
      label: 'Click to select',
      modelName: 'MobileSAM',
      bytes: 28_157_093 + 16_496_559,
      license: { name: 'Apache-2.0' },
      upstream: 'https://github.com/ChaoningZhang/MobileSAM',
      inputSize: 1024,
    });
    expect(isSamEntry(entry)).toBe(true);
    expect(isSamModelId('click')).toBe(true);
    expect(isSamModelId('anime')).toBe(false);
    expect(formatModelSize(entry.bytes)).toBe('45 MB');
    const files = getModelFiles(entry);
    expect(files.map((f) => [f.role, f.fileName, f.bytes, f.sha256])).toEqual([
      [
        'encoder',
        'mobilesam-image-encoder.onnx',
        28_157_093,
        '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
      ],
      [
        'decoder',
        'mobilesam-mask-decoder.onnx',
        16_496_559,
        '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
      ],
    ]);
    for (const file of files) {
      // Shipped unchanged: the upstream pin is the shipped file
      expect(file.convertedFrom).toMatchObject({
        repo: 'Acly/MobileSAM',
        revision: '0d3b403339b4674a82493d5e97964dd78089ddc8',
        bytes: file.bytes,
        sha256: file.sha256,
      });
      expect(Object.isFrozen(file)).toBe(true);
    }
    expect(getUpstreamModelUrl(files[1])).toBe(
      'https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/sam_mask_decoder_multi.onnx',
    );
    expect(getModelSpec('click', '/glinfs/')).toEqual({
      id: 'click',
      kind: 'sam',
      bytes: 44_653_652,
      files: [
        {
          role: 'encoder',
          url: '/glinfs/models/mobilesam-image-encoder.onnx',
          bytes: 28_157_093,
          sha256: files[0].sha256,
        },
        {
          role: 'decoder',
          url: '/glinfs/models/mobilesam-mask-decoder.onnx',
          bytes: 16_496_559,
          sha256: files[1].sha256,
        },
      ],
      inputSize: 1024,
      maxPoints: 32,
    });
    expect(getModelUrl('click', '/')).toBe('/models/mobilesam-image-encoder.onnx');
  });

  it('has well-formed, unique entries and a frozen shape', () => {
    const ids = getModelIds();
    // UI order: General left/top, Portrait, Anime, then Click to select
    expect(ids).toEqual(['general', 'portrait', 'anime', 'click']);
    const fileNames = MODEL_REGISTRY.flatMap((e) => getModelFiles(e).map((f) => f.fileName));
    expect(new Set(fileNames).size).toBe(fileNames.length);
    for (const entry of MODEL_REGISTRY.filter((e) => !isSamEntry(e))) {
      expect(entry.convertedFrom.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.convertedFrom.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(entry.bytes)).toBe(true);
      // fp16 halves the upstream fp32 file
      expect(entry.bytes).toBeLessThan(entry.convertedFrom.bytes * 0.55);
      expect(Object.isFrozen(entry.convertedFrom)).toBe(true);
      expect(entry.license.url).toMatch(/^https:\/\//);
      for (const field of ['label', 'modelName', 'shortModelName', 'description']) {
        expect(typeof entry[field] === 'string' && entry[field].length > 0).toBe(true);
      }
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
    expect(formatModelSize(getModelEntry('portrait').bytes)).toBe('13 MB');
    // One helper for every size: download progress asks for a decimal
    expect(formatModelSize(getModelEntry('anime').bytes, 1)).toBe('88.1 MB');
    expect(formatModelSize(0, 1)).toBe('0.0 MB');
  });

  it('matches the model ids and the default model the edits accept', () => {
    expect([...AI_MODELS].sort()).toEqual(getModelIds().sort());
    expect(getAiModel(undefined)).toBe(DEFAULT_MODEL_ID);
    expect(getAiModel({ model: 'bogus' })).toBe(DEFAULT_MODEL_ID);
    expect(getAiModel({ model: 'general' })).toBe('general');
    expect(getAiModel({ model: 'portrait' })).toBe('portrait');
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
    // MODNet (Xenova/modnet preprocessor_config.json, upstream
    // inference_onnx.py `(im - 127.5) / 127.5`): stretch to 512², / 255,
    // mean 0.5, std 0.5 — values in [-1, 1]
    expect(getModelEntry('portrait').preprocess).toEqual({
      resize: 'stretch',
      scale: 1 / 255,
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
      output: 'probability',
    });
  });
});

describe('model-config', () => {
  it('feeds scripts/fetch-models.mjs from the registry (one release asset per model file)', () => {
    const files = MODEL_REGISTRY.flatMap((entry) => getModelFiles(entry));
    expect(MODELS).toHaveLength(files.length);
    expect(MODELS).toHaveLength(MODEL_REGISTRY.length + 1); // MobileSAM has two files
    for (const file of files) {
      const pin = MODELS.find((m) => m.fileName === file.fileName);
      expect(pin).toEqual({
        fileName: file.fileName,
        url: getModelDownloadUrl(file),
        bytes: file.bytes,
        sha256: file.sha256,
      });
      // The asset name is the local file name
      expect(getModelDownloadUrl(file)).toBe(`${MODEL_RELEASE_URL}/${file.fileName}`);
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
    // MobileSAM ships unchanged: not in the conversion script
    expect(flat).not.toContain('"id": "click"');
    for (const entry of MODEL_REGISTRY.filter((e) => !isSamEntry(e))) {
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
    const files = MODEL_REGISTRY.flatMap((entry) => getModelFiles(entry));
    expect(hashes.length).toBeGreaterThanOrEqual(2 * files.length);
    expect(new Set(hashes)).toEqual(new Set(files.map((f) => f.sha256)));
    for (const file of files) {
      expect(workflow).toContain(`public/models/${file.fileName}`);
      expect(workflow).toContain(`check ${file.fileName} ${file.sha256}`);
    }
    expect(workflow.indexOf('npm run models:fetch')).toBeLessThan(
      workflow.indexOf('npm run build'),
    );
    // The Pages artifact must stay under 1 GB
    expect(workflow).toContain('-ge 1000000000');
    const total = MODEL_REGISTRY.reduce((sum, e) => sum + e.bytes, 0);
    expect(total).toBeLessThan(250_000_000);
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
      files: [
        {
          role: 'model',
          url: '/glinfs/models/isnetis-fp16.onnx',
          bytes: 88_070_957,
          sha256: ANIME_SHA256,
        },
      ],
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
    expect(
      Buffer.from(buildPortraitStubModel()).equals(readFileSync(STUB_PORTRAIT_MODEL_PATH)),
    ).toBe(true);
  });

  it('reproduces the click-to-select stubs and gives them MobileSAM’s names', () => {
    const encoder = Buffer.from(buildSamEncoderStubModel());
    const decoder = Buffer.from(buildSamDecoderStubModel());
    expect(encoder.equals(readFileSync(STUB_SAM_ENCODER_PATH))).toBe(true);
    expect(decoder.equals(readFileSync(STUB_SAM_DECODER_PATH))).toBe(true);
    for (const token of ['input_image', 'image_embeddings', 'Resize', 'Expand']) {
      expect(encoder.toString('latin1')).toContain(token);
    }
    for (const token of [
      'image_embeddings',
      'point_coords',
      'point_labels',
      'mask_input',
      'has_mask_input',
      'orig_im_size',
      'masks',
      'iou_predictions',
      'low_res_masks',
    ]) {
      expect(decoder.toString('latin1')).toContain(token);
    }
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

  it('gives the portrait stub the portrait model’s names and its 512 input side', () => {
    const portrait = getModelEntry('portrait');
    const bytes = Buffer.from(buildPortraitStubModel());
    const text = bytes.toString('latin1');
    for (const token of [portrait.inputName, portrait.outputName, 'ReduceMean', 'Mul', 'Add']) {
      expect(text).toContain(token);
    }
    // dim_value 512 as a varint (0x80 0x04), not the 1024 of the other stubs
    expect(bytes.includes(Buffer.from([0x08, 0x80, 0x04]))).toBe(true);
    expect(bytes.includes(Buffer.from([0x08, 0x80, 0x08]))).toBe(false);
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

  it('removes files that are not in the registry (the old fp32 models) and says so', async () => {
    const out = tempDir();
    writeFileSync(join(out, pin.fileName), content);
    writeFileSync(join(out, 'isnetis.onnx'), 'fp32 model of the first release');
    writeFileSync(join(out, 'isnet-general-use.onnx'), 'upstream fp32 general model');
    writeFileSync(join(out, `${pin.fileName}.download`), 'an interrupted download');
    mkdirSync(join(out, 'keep-me'));
    const log = vi.fn();
    await expect(removeUnlistedFiles([pin], { outDir: out, log })).resolves.toEqual([
      'isnet-general-use.onnx',
      'isnetis.onnx',
      `${pin.fileName}.download`,
    ]);
    expect(readdirSync(out).sort()).toEqual(['keep-me', pin.fileName]);
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toContain('isnetis.onnx: not a model of this version, removed (31 bytes)');
    expect(lines).toHaveLength(3);
    // Nothing to do in a missing directory
    await expect(
      removeUnlistedFiles([pin], { outDir: join(out, 'missing'), log }),
    ).resolves.toEqual([]);
  });

  it('main() removes unlisted files before checking the models', async () => {
    const out = tempDir();
    writeFileSync(join(out, 'isnetis.onnx'), 'old');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(main(['--check'], { outDir: out })).resolves.toBe(1);
    expect(readdirSync(out)).toEqual([]);
    expect(logSpy.mock.calls.map(([line]) => line)).toContain(
      'isnetis.onnx: not a model of this version, removed (3 bytes)',
    );
    logSpy.mockRestore();
    error.mockRestore();
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
