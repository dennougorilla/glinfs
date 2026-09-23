import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the bundled Emscripten glue JS whose digest is injected
 * as `__ENCODER_JS_SHA256__`. Posix separators, matching the ids Vite passes
 * to plugin `watchChange` hooks.
 */
export const ENCODER_JS_PATH = resolve(__dirname, '../public/encoder/encoder.js').replaceAll(
  '\\',
  '/',
);

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
 * @param {string} [encoderJsPath] - defaults to ENCODER_JS_PATH
 * @returns {string} lowercase hex-encoded SHA-256 digest
 */
export function computeEncoderJsSha256Hex(encoderJsPath = ENCODER_JS_PATH) {
  const contents = readFileSync(encoderJsPath, 'utf-8');
  return createHash('sha256').update(contents, 'utf-8').digest('hex');
}

/**
 * Dev-server-only Vite plugin that keeps `__ENCODER_JS_SHA256__` in sync with
 * public/encoder/encoder.js while `vite` is running.
 *
 * `define` values are fixed when the config is evaluated, so without this a
 * glue change during `vite` dev would be served next to the stale hash and
 * every export would fail the integrity check until a manual restart.
 * Restarting re-evaluates vite.config.js (recomputing the digest) and the
 * client reloads once it reconnects. Every watcher event for the file
 * restarts — editors and emcc often replace files via delete + create; a
 * restart attempted while the file is missing fails and Vite keeps the old
 * server (still fail-closed), then the `create` event restarts successfully.
 * Vite dedupes concurrent restarts (one watchChange call per environment).
 *
 * `apply: 'serve'` leaves `vite build` untouched: there the hash is baked in
 * once from the file being shipped.
 *
 * @returns {import('vite').Plugin}
 */
export function encoderHashRestartPlugin() {
  /** @type {import('vite').ViteDevServer | undefined} */
  let server;
  return {
    name: 'glinfs:encoder-hash-restart',
    apply: 'serve',
    configureServer(devServer) {
      server = devServer;
    },
    async watchChange(id) {
      if (!server || id.replaceAll('\\', '/') !== ENCODER_JS_PATH) return;
      server.config.logger.info(
        'public/encoder/encoder.js changed; restarting to recompute its integrity hash',
        { timestamp: true },
      );
      await server.restart();
    },
  };
}
