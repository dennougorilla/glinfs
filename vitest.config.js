import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'jsdom',
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
