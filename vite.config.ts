import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // `npm run dev` serves the client only (play vs AI works offline).
    // For online rooms run `npm run preview` (wrangler dev) instead.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
