#!/usr/bin/env node
/**
 * Download the AI cutout models into public/models/ and verify them.
 *
 *   npm run models:fetch            download (skipped when a verified copy exists)
 *   npm run models:fetch -- --check verify the existing files only, never download
 *
 * The models (src/features/ai-cutout/model-registry.js: the anime and the
 * general IS-Net, Apache-2.0, about 176 and 179 MB) are too large for the
 * repository, so each one is fetched from a PINNED Hugging Face commit and
 * checked against a pinned size and SHA-256. Any mismatch deletes the file
 * and exits non-zero, so a deploy can never ship a different model.
 *
 * The pins come straight from the registry (plain data without Vite
 * imports); tests/unit/ai-cutout/model-config.test.js checks that the Pages
 * deploy workflow uses the same hashes and file names.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_REGISTRY } from '../src/features/ai-cutout/model-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} ModelPin
 * @property {string} fileName - Local file name under the output directory
 * @property {string} repo - Hugging Face repository
 * @property {string} revision - Pinned commit hash (never a branch)
 * @property {string} [path] - File path inside the repository (default: fileName)
 * @property {number} bytes - Exact size
 * @property {string} sha256 - Lowercase hex SHA-256
 */

/** @type {ModelPin[]} */
export const MODELS = MODEL_REGISTRY.map((entry) => ({
  fileName: entry.fileName,
  repo: entry.source.repo,
  revision: entry.source.revision,
  path: entry.source.path,
  bytes: entry.bytes,
  sha256: entry.sha256,
}));

/** Default output directory, served by Vite from publicDir */
export const DEFAULT_OUT_DIR = resolve(__dirname, '../public/models');

/**
 * @param {ModelPin} pin
 * @returns {string}
 */
export function sourceUrl(pin) {
  return `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.path ?? pin.fileName}`;
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
