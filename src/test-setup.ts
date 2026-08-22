import { beforeEach } from 'vitest';

/**
 * jsdom keeps one `window` for every test in a file, so `history` carries over
 * between them. The app reads the address on mount, which means without this a
 * test would start wherever the previous one navigated to — and a suite that
 * passes or fails on file order is worse than no suite.
 *
 * Real browsers get a fresh document per load, so this restores the condition
 * the app actually ships into rather than papering over app behavior.
 */
beforeEach(() => {
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});
