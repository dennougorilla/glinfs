#!/usr/bin/env node
/**
 * Download the AI cutout model into public/models/ and verify it.
 *
 *   npm run models:fetch            download (skipped when a verified copy exists)
 *   npm run models:fetch -- --check verify the existing file only, never download
 *
 * The model (skytnt anime-segmentation isnetis.onnx, Apache-2.0, 176 MB) is
 * too large for git, so it is fetched from a PINNED Hugging Face commit and
 * checked against a pinned size and SHA-256. Any mismatch deletes the file
 * and exits non-zero, so a deploy can never ship a different model.
 *
 * The pins are duplicated from src/features/ai-cutout/model-config.js (this
 * script must not depend on Vite's import.meta.env);
 * tests/unit/ai-cutout/model-config.test.js keeps both in sync.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} ModelPin
 * @property {string} fileName
 * @property {string} repo - Hugging Face repository
 * @property {string} revision - Pinned commit hash (never a branch)
 * @property {number} bytes - Exact size
 * @property {string} sha256 - Lowercase hex SHA-256
 */

/** @type {ModelPin[]} */
export const MODELS = [
  {
    fileName: 'isnetis.onnx',
    repo: 'skytnt/anime-seg',
    revision: '493cb60893f47441b26ec4fb9a306bce9e342982',
    bytes: 176_069_933,
    sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
  },
];

/** Default output directory, served by Vite from publicDir */
export const DEFAULT_OUT_DIR = resolve(__dirname, '../public/models');

/**
 * @param {ModelPin} pin
 * @returns {string}
 */
export function sourceUrl(pin) {
  return `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.fileName}`;
}

/**
 * Size and SHA-256 of a file, or null when it does not exist.
 * @param {string} path
 * @returns {Promise<{ bytes: number, sha256: string } | null>}
 */
export async function hashFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

/**
 * Describe why `actual` does not match `pin`, or return null when it does.
 * @param {ModelPin} pin
 * @param {{ bytes: number, sha256: string }} actual
 * @returns {string | null}
 */
export function describeMismatch(pin, actual) {
  if (actual.bytes !== pin.bytes) {
    return `size ${actual.bytes} bytes, expected ${pin.bytes}`;
  }
  if (actual.sha256 !== pin.sha256) {
    return `SHA-256 ${actual.sha256}, expected ${pin.sha256}`;
  }
  return null;
}

/**
 * Download `url` to `dest` (via a temp file), hashing while streaming.
 * @param {string} url
 * @param {string} dest
 * @param {(received: number) => void} [onProgress]
 * @returns {Promise<{ bytes: number, sha256: string, tmpPath: string }>}
 */
async function download(url, dest, onProgress) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  const tmpPath = `${dest}.download`;
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(/** @type {any} */ (response.body)),
    async function* hashChunks(/** @type {AsyncIterable<Buffer>} */ source) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
        onProgress?.(bytes);
        yield chunk;
      }
    },
    createWriteStream(tmpPath),
  );
  return { bytes, sha256: hash.digest('hex'), tmpPath };
}

/**
 * Make sure a verified copy of `pin` exists in `outDir`.
 * @param {ModelPin} pin
 * @param {{ outDir?: string, checkOnly?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<'present' | 'downloaded'>}
 */
export async function ensureModel(pin, { outDir = DEFAULT_OUT_DIR, checkOnly = false, log } = {}) {
  const say = log ?? ((msg) => console.log(msg));
  const dest = resolve(outDir, pin.fileName);

  const existing = await hashFile(dest);
  if (existing) {
    const problem = describeMismatch(pin, existing);
    if (!problem) {
      say(`${pin.fileName}: present and verified (${pin.sha256})`);
      return 'present';
    }
    await rm(dest, { force: true });
    if (checkOnly) {
      throw new Error(`${pin.fileName}: ${problem} — deleted`);
    }
    say(`${pin.fileName}: existing file rejected (${problem}), downloading again`);
  } else if (checkOnly) {
    throw new Error(`${pin.fileName}: missing in ${outDir} (run npm run models:fetch)`);
  }

  await mkdir(outDir, { recursive: true });
  const url = sourceUrl(pin);
  say(`${pin.fileName}: downloading ${url}`);
  let lastPercent = -10;
  const result = await download(url, dest, (received) => {
    const percent = Math.floor((received / pin.bytes) * 100);
    if (percent >= lastPercent + 10) {
      lastPercent = percent;
      say(`${pin.fileName}: ${percent}%`);
    }
  });
  const problem = describeMismatch(pin, result);
  if (problem) {
    await rm(result.tmpPath, { force: true });
    throw new Error(`${pin.fileName}: downloaded file rejected (${problem})`);
  }
  await rename(result.tmpPath, dest);
  say(`${pin.fileName}: downloaded and verified (${pin.sha256})`);
  return 'downloaded';
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @param {{ outDir?: string }} [options]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { outDir = DEFAULT_OUT_DIR } = {}) {
  const checkOnly = argv.includes('--check');
  try {
    for (const pin of MODELS) {
      await ensureModel(pin, { outDir, checkOnly });
    }
    return 0;
  } catch (error) {
    console.error(`\nmodels:fetch FAILED: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
