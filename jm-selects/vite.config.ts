import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://localhost:8080', '/img': 'http://localhost:8080' } },
  test: { root: '.', include: ['test/**/*.test.ts'] },
});
