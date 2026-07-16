import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Read version from package.json
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  base: '/glinfs/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
