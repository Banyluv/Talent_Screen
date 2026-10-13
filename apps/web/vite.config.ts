import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser calls the API directly (VITE_API_URL), so this dev server does not
// proxy /api. In Docker, nginx still proxies /api for a same-origin deployment.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
});
