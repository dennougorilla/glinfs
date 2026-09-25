import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import {
  computeEncoderJsSha256Hex,
  encoderHashRestartPlugin,
} from './scripts/compute-encoder-hash.js';

// Read version from package.json
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  base: '/glinfs/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // SHA-256 of public/encoder/encoder.js, computed fresh from the file on
    // every config load (dev server start and build) so it can never drift
    // out of sync with the shipped glue. In dev, encoderHashRestartPlugin
    // restarts the server when the file changes so this is re-evaluated.
    // See gifsicle-encoder.js.
    __ENCODER_JS_SHA256__: JSON.stringify(computeEncoderJsSha256Hex()),
  },
  plugins: [encoderHashRestartPlugin()],
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    // Fail instead of silently moving to another port: Playwright reuses an
    // already-running server on its configured port (see E2E_PORT in
    // playwright.config.js), so a dev server that drifted to a different port
    // could make E2E runs test some other checkout's code.
    strictPort: true,
    // Note: Screen Capture API works on localhost without HTTPS
  },
  worker: {
    format: 'es',
  },
});
