import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { computeEncoderJsSha256Hex } from './scripts/compute-encoder-hash.js';

// Read version from package.json
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  base: '/glinfs/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // SHA-256 of public/encoder/encoder.js, computed fresh from the file on
    // every config load (dev server start and build) so it can never drift
    // out of sync with the shipped glue. See gifsicle-encoder.js.
    __ENCODER_JS_SHA256__: JSON.stringify(computeEncoderJsSha256Hex()),
  },
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    // Note: Screen Capture API works on localhost without HTTPS
  },
  worker: {
    format: 'es',
  },
});
