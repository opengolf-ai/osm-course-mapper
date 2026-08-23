/**
 * @vitest-environment jsdom
 *
 * The boundary screen is orientation, not a decision (R11): OpenStreetMap already
 * holds the line, so the screen presents it and moves on. MapLibre needs a WebGL
 * context jsdom has not got, so it is replaced with a recording double.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  sources: [] as Array<[string, unknown]>,
  layers: [] as unknown[],
  created: 0,
  reset() {
    this.sources = [];
    this.layers = [];
    this.created = 0;
  },
}));

vi.mock('maplibre-gl', () => {
  class FakeMap {
    constructor() {
      harness.created += 1;
    }
    on() {
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
      return harness.sources.find(([key]) => key === id)?.[1];
    }
    addSource(id: string, spec: unknown) {
      harness.sources.push([id, spec]);
    }
    getLayer() {
      return undefined;
    }
    addLayer(layer: unknown) {
      harness.layers.push(layer);
    }
    removeLayer() {}
    removeSource() {}
    touchZoomRotate = { disableRotation: () => {} };
    unproject(point: { x: number; y: number }) {
      return { lng: point.x / 1000, lat: point.y / 1000 };
    }
  }
  return { Map: FakeMap };
});

import App from '../App';
import { clearOsmCache, type OsmCourse } from '../api/overpass';
import type { CourseDetail } from '../api/types';
import { BoundaryScreen } from './BoundaryScreen';
import { SEARCH_DEBOUNCE_MS } from './SearchScreen';

const SQUARE: OsmCourse['boundary'] = {
  type: 'Polygon',
  coordinates: [
    [
      [-121.955, 36.563],
      [-121.943, 36.563],
      [-121.943, 36.574],
      [-121.955, 36.574],
      [-121.955, 36.563],
    ],
  ],
};

function osmCourse(overrides: Partial<OsmCourse> = {}): OsmCourse {
  return {
    osmId: 'relation/3741806',
    name: 'Pebble Beach Golf Course',
    boundary: SQUARE,
    acres: 176.4,
    bbox: [-121.955, 36.563, -121.943, 36.574],
    mappedHoleRefs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    holes: [],
    landmarks: [
      { id: 'way/700001', name: 'Pebble Beach Clubhouse', kind: 'Clubhouse', position: [-121.949, 36.5688] },
      { id: 'node/700002', name: 'Peter Hay Practice Range', kind: 'Driving range', position: [-121.95, 36.5701] },
    ],
    matchedBy: 'name',
    ...overrides,
  };
}

/** Let the lazy MapLibre import settle so the effect does not warn out of act(). */
async function mount(ui: React.ReactElement) {
  const result = render(ui);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return result;
}

beforeEach(() => {
  harness.reset();
  clearOsmCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the adopted boundary', () => {
  it('presents the line with its acreage and hole count, and asks for no approval', async () => {
    await mount(
      <BoundaryScreen course={osmCourse()} courseName="Pebble Beach Golf Links" onContinue={() => {}} onBack={() => {}} />,
    );

    expect(screen.getByText(/176/)).toBeDefined();
    expect(document.body.textContent).toContain('acres');
    expect(screen.getByText('Holes already on the map')).toBeDefined();
    expect(screen.getByText('18')).toBeDefined();

    /* R11: no approve, no reject, no per-landmark verdict to argue with. */
    expect(screen.queryByText(/Yes, that is the course/i)).toBeNull();
    expect(screen.queryByText(/approve/i)).toBeNull();
    expect(screen.queryByText(/^reject$/i)).toBeNull();
    expect(screen.queryByText(/not inside/i)).toBeNull();
    expect(screen.queryByText(/should be in/i)).toBeNull();
  });

  it('offers one action onward to the board', async () => {
    const onContinue = vi.fn();
    await mount(
      <BoundaryScreen
        course={osmCourse()}
        courseName="Pebble Beach Golf Links"
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /continue to the holes/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('draws the adopted geometry over the imagery rather than a traced fixture', async () => {
    await mount(
      <BoundaryScreen course={osmCourse()} courseName="Pebble Beach Golf Links" onContinue={() => {}} onBack={() => {}} />,
    );

    const added = harness.sources.map(([, spec]) => JSON.stringify(spec)).join(' ');
    expect(added).toContain('36.563');
    expect(harness.layers.length).toBeGreaterThan(0);
  });

  it('lists the landmarks Overpass returned, and no Pebble Beach copy for another course', async () => {
    await mount(
      <BoundaryScreen
        course={osmCourse({
          name: 'Bethpage Black Course',
          landmarks: [
            { id: 'way/1', name: 'Bethpage Clubhouse', kind: 'Clubhouse', position: [-73.457, 40.744] },
          ],
        })}
        courseName="Bethpage Black"
        onContinue={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText('Bethpage Clubhouse')).toBeDefined();
    expect(screen.queryByText(/The Lodge at Pebble Beach/)).toBeNull();
    expect(screen.queryByText(/Carmel Bay/)).toBeNull();
    expect(screen.queryByText(/17-Mile Drive/)).toBeNull();
  });

  it('explains an empty landmark list rather than rendering a blank section', async () => {
    await mount(
      <BoundaryScreen
        course={osmCourse({ landmarks: [] })}
        courseName="Pebble Beach Golf Links"
        onContinue={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText(/no clubhouse|nothing else inside|holds no landmarks/i)).toBeDefined();
  });
});

/* --- Routing: the boundary screen exists only when OSM holds a boundary. --- */

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function detailFixture(): CourseDetail {
  return {
    id: 'course-1',
    course_name: 'Pebble Beach Golf Links',
    latitude: 36.5685,
    longitude: -121.949,
    par: 72,
    holes: 3,
    tees: [{ tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', yardage: 1270 }],
    holes_data: [
      { number: 1, par: 4, handicap_index: 6, yardages: { blue: 378 } },
      { number: 2, par: 5, handicap_index: 10, yardages: { blue: 502 } },
      { number: 3, par: 4, handicap_index: 2, yardages: { blue: 390 } },
    ],
  };
}

const PEBBLE_RELATION = {
  type: 'relation',
  id: 3741806,
  tags: { type: 'multipolygon', leisure: 'golf_course', name: 'Pebble Beach Golf Course' },
  members: [
    {
      type: 'way',
      ref: 1,
      role: 'outer',
      geometry: [
        { lat: 36.563, lon: -121.955 },
        { lat: 36.563, lon: -121.943 },
        { lat: 36.574, lon: -121.943 },
        { lat: 36.574, lon: -121.955 },
        { lat: 36.563, lon: -121.955 },
      ],
    },
  ],
};

const HOLE_ONE = {
  type: 'way',
  id: 800001,
  tags: { golf: 'hole', ref: '1' },
  geometry: [
    { lat: 36.5685, lon: -121.949 },
    { lat: 36.569, lon: -121.9485 },
  ],
};

/** Search and detail always resolve; the Overpass answer is what each test varies. */
function routeFetch(overpass: () => Promise<Response>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/courses/search')) {
      return jsonResponse({
        courses: [
          { id: 'course-1', name: 'Pebble Beach Golf Links', latitude: 36.5685, longitude: -121.949 },
        ],
      });
    }
    if (url.includes('overpass')) return overpass();
    return jsonResponse(detailFixture());
  });
}

async function openTheCourse() {
  render(<App />);
  fireEvent.change(screen.getByPlaceholderText(/course name/i), { target: { value: 'pebble' } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
  });
  fireEvent.click(screen.getByText('Pebble Beach Golf Links'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('routing on what OpenStreetMap holds', () => {
  it('opens the boundary screen when a course boundary is adopted', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(async () => jsonResponse({ elements: [PEBBLE_RELATION, HOLE_ONE] })),
    );

    await openTheCourse();

    expect(screen.getByRole('button', { name: /continue to the holes/i })).toBeDefined();
    expect(document.body.textContent).toContain('acres');
    expect(screen.queryByText(/holes on the map/)).toBeNull();
  });

  it('opens the board directly, with a stated banner, when no boundary exists', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(async () => jsonResponse({ elements: [] })),
    );

    await openTheCourse();

    expect(screen.getByText(/holds no boundary/i)).toBeDefined();
    expect(screen.getByText(/of 3 holes on the map/)).toBeDefined();
  });

  it('opens the board with mapped state unknown when Overpass fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(async () => jsonResponse({ error: 'gateway timeout' }, 504)),
    );

    await openTheCourse();
    /* Past the retry backoff, then the failure resolves. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });

    expect(screen.getByText(/mapped state unknown/i)).toBeDefined();
    expect(screen.queryByText(/holes on the map/)).toBeNull();
  });
});
