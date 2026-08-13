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
  const sources = new Map<string, Record<string, unknown>>();
  /* Ordered, because "beneath the suggestion layer" is the thing under test. */
  const layers: Array<Record<string, unknown>> = [];
  const layout = new Map<string, Record<string, unknown>>();
  return {
    listeners,
    sources,
    layers,
    layout,
    options: undefined as unknown,
    constructed: 0,
    removed: 0,
    fitted: [] as Array<[unknown, unknown]>,
    reset() {
      listeners.clear();
      sources.clear();
      layers.length = 0;
      layout.clear();
      this.options = undefined;
      this.constructed = 0;
      this.removed = 0;
      this.fitted = [];
    },
    emit(type: string, event: unknown) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    indexOf(id: string) {
      return layers.findIndex((layer) => layer.id === id);
    },
  };
});

vi.mock('maplibre-gl', () => {
  class FakeMap {
    constructor(options: FakeMapOptions) {
      harness.options = options;
      harness.constructed += 1;
    }
    on(type: string, handler: (event: unknown) => void) {
      const existing = harness.listeners.get(type) ?? [];
      harness.listeners.set(type, [...existing, handler]);
      return this;
    }
    once(_type: string, handler: () => void) {
      handler();
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
    isStyleLoaded() {
      return true;
    }
    addSource(id: string, spec: Record<string, unknown>) {
      harness.sources.set(id, spec);
    }
    getSource(id: string) {
      return harness.sources.get(id);
    }
    removeSource(id: string) {
      harness.sources.delete(id);
    }
    /* Real `addLayer` inserts *before* `beforeId`, which is what puts a layer
     * beneath another one. The fake splices so ordering is observable. */
    addLayer(layer: Record<string, unknown>, beforeId?: string) {
      const at = beforeId === undefined ? -1 : harness.indexOf(beforeId);
      if (at >= 0) harness.layers.splice(at, 0, layer);
      else harness.layers.push(layer);
      harness.layout.set(layer.id as string, { ...(layer.layout as Record<string, unknown>) });
    }
    getLayer(id: string) {
      return harness.layers.find((layer) => layer.id === id);
    }
    removeLayer(id: string) {
      const at = harness.indexOf(id);
      if (at >= 0) harness.layers.splice(at, 1);
    }
    setLayoutProperty(id: string, key: string, value: unknown) {
      harness.layout.set(id, { ...harness.layout.get(id), [key]: value });
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
import { CORRIDOR_OVERLAY_ID, IMAGERY_SOURCE_ID, type ImageOverlaySpec } from './imagerySources';

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

/**
 * R9. The corridor raster goes on the map that already exists.
 *
 * The construction effect lists the imagery `source` in its dependencies and its
 * cleanup calls `map.remove()`, so anything that changed the source to show this
 * would rebuild the map and discard every layer a caller had added. These pin
 * down that showing it costs no rebuild at all.
 */
describe('the corridor overlay', () => {
  const SPEC: ImageOverlaySpec = {
    id: CORRIDOR_OVERLAY_ID,
    url: 'https://example.invalid/corridor.png',
    coordinates: [
      [-121.95, 36.572],
      [-121.944, 36.572],
      [-121.944, 36.566],
      [-121.95, 36.566],
    ],
    attribution: 'USDA NAIP via Microsoft Planetary Computer — acquired 2022-05-18, 0.6 m/px',
    placement: 'envelope',
  };

  /** A caller-owned layer already on the map, the one the overlay must go under. */
  function withCallerLayer(map: { addSource: (id: string, spec: unknown) => void; addLayer: (l: unknown) => void }) {
    map.addSource('review-features', { type: 'geojson' });
    map.addLayer({ id: 'review-features-fill', type: 'fill', source: 'review-features' });
  }

  it('adds an image source at the bounds the service read, beneath the caller layer, without rebuilding', async () => {
    await mount(
      <BaseMap
        center={[-121.949, 36.5685]}
        onMapReady={withCallerLayer as never}
        overlay={SPEC}
        overlayBeneathLayerId="review-features-fill"
      />,
    );

    const source = harness.sources.get(CORRIDOR_OVERLAY_ID);
    expect(source?.type).toBe('image');
    expect(source?.url).toBe(SPEC.url);
    expect(source?.coordinates).toEqual(SPEC.coordinates);

    expect(harness.indexOf(CORRIDOR_OVERLAY_ID)).toBeGreaterThanOrEqual(0);
    expect(harness.indexOf(CORRIDOR_OVERLAY_ID)).toBeLessThan(harness.indexOf('review-features-fill'));

    /* One map, ever. Nothing was torn down to make room for the overlay. */
    expect(harness.constructed).toBe(1);
    expect(harness.removed).toBe(0);
  });

  it('adds it hidden and reveals it on demand, still without rebuilding', async () => {
    const { rerender } = await mount(
      <BaseMap center={[-121.949, 36.5685]} overlay={SPEC} overlayVisible={false} />,
    );
    expect(harness.layout.get(CORRIDOR_OVERLAY_ID)?.visibility).toBe('none');

    await act(async () => {
      rerender(<BaseMap center={[-121.949, 36.5685]} overlay={SPEC} overlayVisible={true} />);
    });

    expect(harness.layout.get(CORRIDOR_OVERLAY_ID)?.visibility).toBe('visible');
    expect(harness.constructed).toBe(1);
    expect(harness.removed).toBe(0);
    /* And the basemap it draws over is untouched. */
    expect((harness.options as { style: { sources: Record<string, unknown> } }).style.sources).toHaveProperty(
      IMAGERY_SOURCE_ID,
    );
  });

  it('credits the overlay while it is what the contributor is looking at', async () => {
    const { rerender } = await mount(
      <BaseMap center={[-121.949, 36.5685]} overlay={SPEC} overlayVisible={false} />,
    );
    expect(screen.queryByText(/acquired 2022-05-18/)).toBeNull();

    await act(async () => {
      rerender(<BaseMap center={[-121.949, 36.5685]} overlay={SPEC} overlayVisible={true} />);
    });
    expect(screen.getByText(/showing what the model read/)).toBeTruthy();
    expect(screen.getByText(/acquired 2022-05-18/)).toBeTruthy();
  });

  it('takes the overlay layer and source back off when there is no longer one to show', async () => {
    const { rerender } = await mount(
      <BaseMap center={[-121.949, 36.5685]} overlay={SPEC} overlayVisible={true} />,
    );
    expect(harness.sources.has(CORRIDOR_OVERLAY_ID)).toBe(true);

    await act(async () => {
      rerender(<BaseMap center={[-121.949, 36.5685]} overlay={null} />);
    });

    expect(harness.sources.has(CORRIDOR_OVERLAY_ID)).toBe(false);
    expect(harness.indexOf(CORRIDOR_OVERLAY_ID)).toBe(-1);
    expect(harness.removed).toBe(0);
  });
});
