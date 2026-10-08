import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :3000; in Docker nginx serves the build and proxies /api.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: true } } },
  build: { outDir: 'dist', sourcemap: false },
});
