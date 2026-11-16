/**
 * Model files from another origin (a registry entry's `url`, a model added
 * by URL), custom models that only exist in Cache Storage, and the
 * download of a file nothing pins yet.
 */
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadModelToCache,
  downloadUnpinnedModel,
  loadModelBytes,
} from '../../../src/features/ai-cutout/model-loader.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';

const subtle = /** @type {SubtleCrypto} */ (webcrypto.subtle);
const BASE = 'https://dennougorilla.github.io/glinfs/';
const HF =
  'https://huggingface.co/dennougorilla/glinfs-models/resolve/d4b06cb3e2d551d954cd9fd748abc14a79f1618c/birefnet-lite-fp16.onnx';
const MODEL = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 13) % 256));
const SHA = createHash('sha256').update(MODEL).digest('hex');

/** @param {Uint8Array} bytes @param {Record<string, string>} [headers] */
function response(bytes, headers = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.byteLength; i += 1000)
          controller.enqueue(bytes.slice(i, i + 1000));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/octet-stream', ...headers } },
  );
}

describe('remote model files', () => {
  it('fetches another origin with CORS, no credentials and no referrer, and verifies it', async () => {
    const fetchImpl = vi.fn(async () => response(MODEL));
    const { bytes } = await downloadModelToCache(
      { url: HF, bytes: MODEL.byteLength, sha256: SHA },
      { fetchImpl, subtle, baseHref: BASE, cacheStorage: undefined },
    );
    expect(bytes).toEqual(MODEL);
    expect(fetchImpl).toHaveBeenCalledWith(HF, {
      cache: 'no-store',
      signal: undefined,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('rejects a remote file whose SHA-256 is not the pinned one', async () => {
    const fetchImpl = vi.fn(async () => response(MODEL));
    await expect(
      downloadModelToCache(
        { url: HF, bytes: MODEL.byteLength, sha256: '0'.repeat(64) },
        { fetchImpl, subtle, baseHref: BASE, cacheStorage: undefined },
      ),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.HASH_MISMATCH });
  });

  it('refuses a host the page may not talk to before fetching anything', async () => {
    const fetchImpl = vi.fn();
    await expect(
      downloadModelToCache(
        { url: 'https://example.com/model.onnx', bytes: 1, sha256: SHA },
        { fetchImpl, subtle, baseHref: BASE, cacheStorage: undefined },
      ),
    ).rejects.toMatchObject({
      code: SegmentationErrorCode.DOWNLOAD_FAILED,
      message: expect.stringMatching(/Hugging Face only/),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says that CORS may be why a cross-origin fetch failed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      downloadModelToCache(
        { url: HF, bytes: 1, sha256: SHA },
        { fetchImpl, subtle, baseHref: BASE, cacheStorage: undefined },
      ),
    ).rejects.toMatchObject({
      code: SegmentationErrorCode.DOWNLOAD_FAILED,
      message: expect.stringMatching(/huggingface\.co failed: Failed to fetch .*CORS/),
    });
  });

  it('never downloads a custom model that only exists in Cache Storage', async () => {
    const fetchImpl = vi.fn();
    await expect(
      loadModelBytes(
        {
          url: '/glinfs/models/custom/x.onnx',
          bytes: 10,
          sha256: SHA,
          localOnly: true,
          label: 'Mine',
        },
        { fetchImpl, subtle, baseHref: BASE, cacheStorage: undefined },
      ),
    ).rejects.toMatchObject({
      code: SegmentationErrorCode.MODEL_UNAVAILABLE,
      message: expect.stringMatching(/"Mine" is no longer in this browser/),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('downloadUnpinnedModel', () => {
  const options = (/** @type {any} */ extra = {}) => ({
    maxBytes: 1_000_000,
    subtle,
    baseHref: BASE,
    ...extra,
  });

  it('downloads with progress and returns the bytes and their SHA-256', async () => {
    const onProgress = vi.fn();
    const result = await downloadUnpinnedModel(HF, {
      ...options({ onProgress }),
      fetchImpl: vi.fn(async () => response(MODEL, { 'content-length': String(MODEL.byteLength) })),
    });
    expect(result).toEqual({ bytes: MODEL, sha256: SHA });
    expect(onProgress).toHaveBeenLastCalledWith({ loadedBytes: 4096, totalBytes: 4096 });
  });

  it('reads a body of unknown size', async () => {
    const result = await downloadUnpinnedModel(HF, {
      ...options(),
      fetchImpl: vi.fn(async () => response(MODEL)),
    });
    expect(result?.sha256).toBe(SHA);
  });

  it('asks before reading an announced size and stops when refused', async () => {
    const confirmSize = vi.fn(() => false);
    const result = await downloadUnpinnedModel(HF, {
      ...options({ confirmSize }),
      fetchImpl: vi.fn(async () => response(MODEL, { 'content-length': '4096' })),
    });
    expect(result).toBeNull();
    expect(confirmSize).toHaveBeenCalledWith(4096);
  });

  it('refuses a file above the cap, announced or not', async () => {
    await expect(
      downloadUnpinnedModel(HF, {
        ...options({ maxBytes: 100 }),
        fetchImpl: vi.fn(async () => response(MODEL, { 'content-length': '4096' })),
      }),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.DOWNLOAD_FAILED });
    await expect(
      downloadUnpinnedModel(HF, {
        ...options({ maxBytes: 100 }),
        fetchImpl: vi.fn(async () => response(MODEL)),
      }),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.DOWNLOAD_FAILED });
  });

  it('reads a web page or a 404 as not found', async () => {
    const page = new TextEncoder().encode('<!doctype html><html></html>');
    await expect(
      downloadUnpinnedModel(HF, {
        ...options(),
        fetchImpl: vi.fn(async () => new Response(page, { status: 200 })),
      }),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.MODEL_NOT_FOUND });
    await expect(
      downloadUnpinnedModel(HF, {
        ...options(),
        fetchImpl: vi.fn(async () => new Response('', { status: 404 })),
      }),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.MODEL_NOT_FOUND });
  });

  it('refuses a GitHub release URL (no CORS) before fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(
      downloadUnpinnedModel(
        'https://github.com/dennougorilla/glinfs/releases/download/models-v1/isnetis-fp16.onnx',
        { ...options(), fetchImpl },
      ),
    ).rejects.toMatchObject({ code: SegmentationErrorCode.DOWNLOAD_FAILED });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
