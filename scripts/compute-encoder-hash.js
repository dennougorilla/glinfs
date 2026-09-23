import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Compute the SHA-256 hex digest of the bundled Emscripten glue JS
 * (public/encoder/encoder.js) at config-evaluation time (both `vite`/`vite
 * build` and `vitest`, since both load their config module before running).
 *
 * This is the single source of truth for the expected hash injected via
 * Vite's `define` as `__ENCODER_JS_SHA256__` — it must never be hand copied
 * into source, so that replacing the WASM glue automatically produces a
 * matching expected hash instead of silently breaking integrity checks.
 *
 * @returns {string} lowercase hex-encoded SHA-256 digest
 */
export function computeEncoderJsSha256Hex() {
  const encoderJsPath = resolve(__dirname, '../public/encoder/encoder.js');
  const contents = readFileSync(encoderJsPath, 'utf-8');
  return createHash('sha256').update(contents, 'utf-8').digest('hex');
}
