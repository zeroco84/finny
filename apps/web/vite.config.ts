import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@finny/shared': path.resolve(__dirname, '../../packages/shared/src/types.ts'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '../..')] },
    proxy: {
      '/api': { target: 'http://localhost:4787', changeOrigin: false },
    },
  },
});
