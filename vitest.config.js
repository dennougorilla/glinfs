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
      // Deliberately conservative global floor. This catches a large loss of
      // production-path coverage without making ordinary refactors fail for
      // small line-count changes.
      thresholds: {
        statements: 55,
        branches: 45,
        functions: 55,
        lines: 55,
      },
    },
  },
});
