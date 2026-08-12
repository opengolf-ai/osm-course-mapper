/**
 * @vitest-environment jsdom
 *
 * MapLibre needs a WebGL context jsdom does not have, so the library is replaced
 * with a recording double. What is under test here is the component's contract:
 * what it does with a source error, and what it does with a click.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeMapOptions {
  container: HTMLElement;
  style: unknown;
  center?: [number, number];
  zoom?: number;
}

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    listeners,
    options: undefined as unknown,
    removed: 0,
    fitted: [] as Array<[unknown, unknown]>,
    reset() {
      listeners.clear();
      this.options = undefined;
      this.removed = 0;
      this.fitted = [];
    },
    emit(type: string, event: unknown) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
});

vi.mock('maplibre-gl', () => {
  class FakeMap {
    constructor(options: FakeMapOptions) {
      harness.options = options;
    }
    on(type: string, handler: (event: unknown) => void) {
      const existing = harness.listeners.get(type) ?? [];
      harness.listeners.set(type, [...existing, handler]);
      return this;
    }
    off() {
      return this;
    }
    remove() {
      harness.removed += 1;
    }
    fitBounds(bounds: unknown, options: unknown) {
      harness.fitted.push([bounds, options]);
    }
    touchZoomRotate = { disableRotation: () => {} };
    /* Screen pixels back to WGS84 — a thousandth of a degree per pixel. */
    unproject(point: { x: number; y: number }) {
      return { lng: point.x / 1000, lat: point.y / 1000 };
    }
  }
  return { Map: FakeMap };
});

import { BaseMap, IMAGERY_UNAVAILABLE_MESSAGE } from './BaseMap';
import { IMAGERY_SOURCE_ID } from './imagerySources';

/** Renders and lets the lazy MapLibre import settle before returning. */
async function mount(ui: React.ReactElement) {
  const result = render(ui);
  for (let tick = 0; tick < 20 && harness.options === undefined; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return result;
}

beforeEach(() => harness.reset());
afterEach(() => vi.clearAllMocks());

describe('BaseMap in the browser', () => {
  it('constructs a map once the lazy import resolves', async () => {
    await mount(<BaseMap center={[-121.949, 36.5685]} zoom={15} />);
    expect(harness.options).toBeTruthy();
    expect(screen.queryByText(IMAGERY_UNAVAILABLE_MESSAGE)).toBeNull();
  });

  it('surfaces the imagery-unavailable state when the imagery source errors', async () => {
    const onImageryStatusChange = vi.fn();
    await mount(<BaseMap center={[-121.949, 36.5685]} onImageryStatusChange={onImageryStatusChange} />);

    await act(async () => {
      harness.emit('error', { sourceId: IMAGERY_SOURCE_ID, error: new Error('tile fetch failed') });
    });

    expect(screen.getByText(IMAGERY_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(onImageryStatusChange).toHaveBeenCalledWith('error');
  });

  it('reports a click as a WGS84 coordinate, and stops reporting once imagery fails', async () => {
    const onMapClick = vi.fn();
    await mount(<BaseMap center={[-121.949, 36.5685]} onMapClick={onMapClick} />);

    await act(async () => {
      harness.emit('click', { point: { x: -121_949, y: 36_568 } });
    });
    expect(onMapClick).toHaveBeenCalledWith([-121.949, 36.568]);

    await act(async () => {
      harness.emit('error', { sourceId: IMAGERY_SOURCE_ID, error: new Error('offline') });
      harness.emit('click', { point: { x: 1000, y: 2000 } });
    });
    expect(onMapClick).toHaveBeenCalledTimes(1);
  });

  it('fits the map to a supplied bounding box', async () => {
    await mount(<BaseMap bounds={[-121.96, 36.56, -121.93, 36.58]} />);
    expect(harness.fitted).toHaveLength(1);
    expect(harness.fitted[0][0]).toEqual([
      [-121.96, 36.56],
      [-121.93, 36.58],
    ]);
  });

  it('tears the map down on unmount', async () => {
    const { unmount } = await mount(<BaseMap center={[-121.949, 36.5685]} />);
    unmount();
    expect(harness.removed).toBe(1);
  });
});
