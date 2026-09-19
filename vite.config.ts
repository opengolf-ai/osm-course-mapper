import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /*
   * IPv4 loopback, not "localhost": Node resolves that to `::1` first, and a
   * dev server listening only there is unreachable through the devcontainer's
   * port forward, which connects to 127.0.0.1 — the browser just spins.
   */
  server: {
    port: 5173,
    host: '127.0.0.1',
    /*
     * The detection service and store (`uvicorn service.local:app`, port 8000),
     * reached through this server so the browser needs one forwarded port, not
     * two. Setting `VITE_DETECT_API_BASE` bypasses this and talks to a service
     * directly.
     */
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/healthz': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  /*
   * MapLibre parses GeoJSON and builds its tiles in a web worker, shipped as a
   * separate `maplibre-gl-worker.mjs`. Vite's dependency optimizer rewrites the
   * entry but does not emit that worker chunk, so the worker fails to load and
   * every GeoJSON source silently stops short: its data is set, `isSourceLoaded`
   * never turns true, and nothing it holds is ever drawn.
   *
   * Raster imagery keeps working throughout — tiles are plain images and never
   * reach the worker — so the failure looks like "only my own geometry is
   * missing" rather than like a broken map, which is what makes it hard to place.
   */
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
