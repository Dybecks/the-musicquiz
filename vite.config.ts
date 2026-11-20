/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Spotify no longer accepts "localhost" redirect URIs, so the dev server runs on
// the loopback IP. Register http://127.0.0.1:5173/ as a redirect URI in your Spotify app.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // The Sonos bridge (bridge/) has its own tests: cd bridge && npm test.
  test: { include: ['src/**/*.test.ts'] },
});
