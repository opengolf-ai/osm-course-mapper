import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
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
