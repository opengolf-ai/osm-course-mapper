import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Most of what we test is pure — the API client, the geometry helpers — and those
 * run fastest in node. Screens render React and the state hook attaches window
 * listeners, so those two trees need a DOM.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      environmentMatchGlobs: [
        ['src/screens/**', 'jsdom'],
        ['src/state/**', 'jsdom'],
      ],
      globals: true,
      /* Only the DOM trees need it; the node-environment tests have no window. */
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
  }),
);
