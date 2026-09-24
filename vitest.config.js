import { defineConfig } from 'vitest/config';
import { computeEncoderJsSha256Hex } from './scripts/compute-encoder-hash.js';

export default defineConfig({
  define: {
    // Kept in sync with vite.config.js so gifsicle-encoder.js's integrity
    // check has a real (non-hand-maintained) expected hash under vitest too.
    __ENCODER_JS_SHA256__: JSON.stringify(computeEncoderJsSha256Hex()),
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'jsdom',
    // No test asserts wall-clock time; the heaviest (3,600-frame frame-grid
    // renders, palette-staleness sweeps) take ~2-3s serially and blew past
    // the 5s default when another suite or a second `npm test` shared the
    // CPU. 30s keeps them deterministic under load while still catching hangs.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
      // Only worker entry points run inside a Worker context and cannot be
      // measured; handlers/manager/protocol have unit tests and stay covered.
      exclude: [
        'src/**/*.test.js',
        'src/workers/capture-worker.js',
        'src/workers/gif-encoder-worker.js',
        'src/workers/scene-detection-worker.js',
      ],
      // Conservative floors set ~5 points below the measured baseline
      // (statements 71.13%, branches 59.21%, functions 71.02%, lines
      // 72.76% as of #49's reducer/scene-detection coverage pass) so CI
      // fails on real regressions without being flaky against minor
      // fluctuation.
      thresholds: {
        statements: 66,
        branches: 54,
        functions: 66,
        lines: 67,
      },
    },
  },
});
