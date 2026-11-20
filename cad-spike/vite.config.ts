import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: true },
  preview: { host: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
