import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything (engine, pdf.js worker, UI, styles) is inlined into dist/index.html.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 10000 },
  worker: { format: 'es' },
});
