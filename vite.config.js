import { defineConfig } from 'vite';

export default defineConfig({
  base: '/glinfs/',
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
