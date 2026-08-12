/**
 * @vitest-environment jsdom
 *
 * The review screen over real imagery. MapLibre needs a WebGL context jsdom has
 * not got, so it is replaced with a recording double and what is under test is
 * the screen's contract: a click becomes a WGS84 point, the drawn geometry
 * reaches the map as GeoJSON, and a blank canvas takes no clicks at all (R19).
 */
import { useEffect, useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const sources = new Map<string, { data: unknown }>();
  const layers: Array<Record<string, unknown>> = [];
  return {
    listeners,
    sources,
    layers,
    reset() {
      listeners.clear();
      sources.clear();
      layers.length = 0;
    },
    emit(type: string, event: unknown) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
  };
});

vi.mock('maplibre-gl', () => {
  class FakeMap {
    on(type: string, handler: (event: unknown) => void) {
      harness.listeners.set(type, [...(harness.listeners.get(type) ?? []), handler]);
      return this;
    }
    once(_type: string, handler: () => void) {
      handler();
      return this;
    }
    off() {
      return this;
    }
    remove() {}
    fitBounds() {}
    isStyleLoaded() {
      return true;
    }
    getSource(id: string) {
      const entry = harness.sources.get(id);
      return entry && { setData: (data: unknown) => (entry.data = data) };
    }
    addSource(id: string, spec: { data?: unknown }) {
      harness.sources.set(id, { data: spec.data });
    }
    addLayer(layer: Record<string, unknown>) {
      harness.layers.push(layer);
    }
    getLayer() {
      return undefined;
    }
    touchZoomRotate = { disableRotation: () => {} };
    /* A thousandth of a degree per pixel, both ways, so the two are inverses. */
    unproject(point: { x: number; y: number }) {
      return { lng: point.x / 1000, lat: point.y / 1000 };
    }
    project(position: [number, number]) {
      return { x: position[0] * 1000, y: position[1] * 1000 };
    }
  }
  return { Map: FakeMap };
});

import { IMAGERY_SOURCE_ID } from '../map/imagerySources';
import { IMAGERY_UNAVAILABLE_MESSAGE } from '../map/BaseMap';
import { buildCourseSession } from '../state/courseSession';
import { useMapper } from '../state/useMapper';
import type { CourseDetail } from '../api/types';
import { ReviewScreen } from './ReviewScreen';

const DETAIL: CourseDetail = {
  id: 'pebble',
  course_name: 'Pebble Beach Golf Links',
  latitude: 36.5685,
  longitude: -121.949,
  par: 72,
  holes: 1,
  tees: [{ tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', yardage: 380 }],
  holes_data: [{ number: 1, par: 4, handicap_index: 6, yardages: { blue: 380 } }],
};

const SESSION = buildCourseSession(DETAIL);

/** The screen, opened on hole 1 of a course OpenStreetMap holds nothing for. */
function Harness() {
  const mapper = useMapper();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    mapper.actions.openCourse(SESSION, { status: 'absent' });
  }, [mapper.actions]);

  useEffect(() => {
    if (mapper.state.course && mapper.state.screen !== 'review') {
      mapper.actions.patch({ screen: 'review', mode: 'locate', holeIndex: 0 });
    }
  }, [mapper.state.course, mapper.state.screen, mapper.actions]);

  if (!mapper.state.course) return null;
  return <ReviewScreen mapper={mapper} />;
}

/** Renders and lets the lazy MapLibre import settle before returning. */
async function mount() {
  const result = render(<Harness />);
  for (let tick = 0; tick < 20 && harness.sources.size === 0; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return result;
}

function clickAt(x: number, y: number) {
  return act(async () => {
    harness.emit('click', { point: { x, y } });
  });
}

beforeEach(() => harness.reset());

describe('drawing on real imagery', () => {
  it('turns a click into a WGS84 point on the map, not a viewBox coordinate', async () => {
    await mount();
    expect(screen.getByText('0 points marked')).toBeDefined();

    await clickAt(-121_949, 36_569);

    expect(screen.getByText('1 point marked')).toBeDefined();
    const data = JSON.stringify([...harness.sources.values()].map((s) => s.data));
    expect(data).toContain('-121.949');
    expect(data).toContain('36.569');
  });

  it('sends the finished line to the map as a GeoJSON LineString', async () => {
    await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_947, 36_570);
    await clickAt(-121_946, 36_570);

    const collection = harness.sources.get('review-features')?.data as {
      features: Array<{ geometry: { type: string; coordinates: unknown } }>;
    };
    const line = collection.features.find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual([
      [-121.949, 36.569],
      [-121.947, 36.57],
      [-121.946, 36.57],
    ]);
  });

  it('drives pending, active and confirmed styling from a feature property', async () => {
    await mount();

    const paints = harness.layers.map((layer) => JSON.stringify(layer.paint));
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      expect(paint).toContain('match');
      expect(paint).toContain('status');
    }
    const all = paints.join(' ');
    expect(all).toContain('confirmed');
    expect(all).toContain('active');
    expect(all).toContain('pending');
  });

  it('ignores clicks while the imagery-error state shows (R19)', async () => {
    await mount();

    await act(async () => {
      harness.emit('error', { sourceId: IMAGERY_SOURCE_ID, error: new Error('tiles offline') });
    });
    expect(screen.getByText(IMAGERY_UNAVAILABLE_MESSAGE)).toBeDefined();

    await clickAt(-121_949, 36_569);
    await clickAt(-121_947, 36_570);

    expect(screen.getByText('0 points marked')).toBeDefined();
    /* And the screen stops inviting a click it will not accept. */
    expect(screen.queryByText('Click where you tee off.')).toBeNull();
  });
});
