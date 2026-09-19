/**
 * @vitest-environment jsdom
 *
 * The boundary screen asks one question — is this the whole course? — and
 * answers it with facts rather than an eyeball: the acreage the line encloses and
 * whether each landmark OpenStreetMap holds falls inside it. A wrong edge is
 * dragged, and the facts follow the drag. MapLibre needs a WebGL context jsdom
 * has not got, so it is replaced with a recording double.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Handler = (event: unknown) => void;
  return {
    sources: [] as Array<[string, { data?: unknown }]>,
    layers: [] as Array<{ id: string }>,
    /** Listeners by `type` or `type@layer`, the way the shape editor registers them. */
    listeners: new Map<string, Handler[]>(),
    /** What each `setData` last pushed, by source id. */
    pushed: new Map<string, unknown>(),
    dragPan: { enabled: true },
    created: 0,
    reset() {
      this.sources = [];
      this.layers = [];
      this.listeners.clear();
      this.pushed.clear();
      this.dragPan.enabled = true;
      this.created = 0;
    },
    emit(key: string, event: unknown) {
      for (const handler of [...(this.listeners.get(key) ?? [])]) handler(event);
    },
  };
});

vi.mock('maplibre-gl', () => {
  type Handler = (event: unknown) => void;
  /* `on(type, fn)` and `on(type, layerId, fn)` both, as MapLibre takes them. */
  const keyOf = (type: string, layerOrHandler: unknown) =>
    typeof layerOrHandler === 'string' ? `${type}@${layerOrHandler}` : type;
  const handlerOf = (layerOrHandler: unknown, handler?: Handler) =>
    (typeof layerOrHandler === 'function' ? layerOrHandler : handler) as Handler;

  class FakeMap {
    constructor() {
      harness.created += 1;
    }
    on(type: string, layerOrHandler: unknown, handler?: Handler) {
      const key = keyOf(type, layerOrHandler);
      harness.listeners.set(key, [...(harness.listeners.get(key) ?? []), handlerOf(layerOrHandler, handler)]);
      return this;
    }
    once(_type: string, handler: () => void) {
      handler();
      return this;
    }
    off(type: string, layerOrHandler: unknown, handler?: Handler) {
      const key = keyOf(type, layerOrHandler);
      const fn = handlerOf(layerOrHandler, handler);
      harness.listeners.set(key, (harness.listeners.get(key) ?? []).filter((h) => h !== fn));
      return this;
    }
    remove() {}
    fitBounds() {}
    isStyleLoaded() {
      return true;
    }
    getSource(id: string) {
      const entry = harness.sources.find(([key]) => key === id);
      return entry && { ...entry[1], setData: (data: unknown) => harness.pushed.set(id, data) };
    }
    addSource(id: string, spec: { data?: unknown }) {
      harness.sources.push([id, spec]);
    }
    getLayer(id: string) {
      return harness.layers.find((layer) => layer.id === id);
    }
    addLayer(layer: { id: string }) {
      harness.layers.push(layer);
    }
    moveLayer() {}
    removeLayer(id: string) {
      harness.layers = harness.layers.filter((layer) => layer.id !== id);
    }
    removeSource(id: string) {
      harness.sources = harness.sources.filter(([key]) => key !== id);
    }
    dragPan = {
      enable: () => (harness.dragPan.enabled = true),
      disable: () => (harness.dragPan.enabled = false),
    };
    getCanvas() {
      return { style: {} as Record<string, string> };
    }
    project(position: [number, number]) {
      return { x: position[0] * 1000, y: position[1] * 1000 };
    }
    queryRenderedFeatures() {
      return [];
    }
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
import { areaAcres } from '../geo/coords';
import { EDITOR_VERTEX_LAYER } from '../map/useShapeEditor';
import type { SaveState } from '../state/useMapper';
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

type Props = React.ComponentProps<typeof BoundaryScreen>;

/** The screen as App wires it for an untouched OpenStreetMap edge, with any prop overridden. */
function boundary(overrides: Partial<Props> = {}) {
  const course = overrides.course ?? osmCourse();
  const props: Props = {
    course,
    geometry: course.boundary,
    edited: false,
    save: { status: 'idle' },
    courseName: 'Pebble Beach Golf Links',
    onChange: () => {},
    onReset: () => {},
    onSave: () => {},
    onContinue: () => {},
    onBack: () => {},
    ...overrides,
  };
  return <BoundaryScreen {...props} />;
}

/** The landmark row a name sits in, so its verdict is read off the same row. */
function landmarkRow(name: string): string {
  return screen.getByText(name).closest('div')?.textContent ?? '';
}

/** The western part of SQUARE: it keeps the clubhouse (-121.949) and cuts off the range (-121.95). */
const WEST_CUT: OsmCourse['boundary'] = {
  type: 'Polygon',
  coordinates: [
    [
      [-121.9495, 36.563],
      [-121.943, 36.563],
      [-121.943, 36.574],
      [-121.9495, 36.574],
      [-121.9495, 36.563],
    ],
  ],
};

beforeEach(() => {
  harness.reset();
  clearOsmCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the adopted boundary', () => {
  it('asks whether this is the whole course, with the acreage and the hole count beside it', async () => {
    await mount(boundary());

    expect(screen.getByText('Is this the whole course?')).toBeDefined();
    /* OpenStreetMap's own figure, while nobody has moved the edge. */
    expect(screen.getByText(/^176/)).toBeDefined();
    expect(document.body.textContent).toContain('acres');
    expect(screen.getByText('measured from the line itself')).toBeDefined();
    expect(screen.getByText('Holes already on the map')).toBeDefined();
    expect(screen.getByText('18')).toBeDefined();
    expect(screen.getByText('This is the line OpenStreetMap already holds', { exact: false })).toBeDefined();
  });

  it('moves on to the board on a plain yes', async () => {
    const onContinue = vi.fn();
    await mount(boundary({ onContinue }));

    fireEvent.click(screen.getByRole('button', { name: 'Yes, that is the course' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('draws the adopted geometry over the imagery rather than a traced fixture', async () => {
    await mount(boundary());

    const added = harness.sources.map(([, spec]) => JSON.stringify(spec)).join(' ');
    expect(added).toContain('36.563');
    expect(harness.layers.length).toBeGreaterThan(0);
  });

  it('lists the landmarks Overpass returned, and no Pebble Beach copy for another course', async () => {
    await mount(
      boundary({
        course: osmCourse({
          name: 'Bethpage Black Course',
          landmarks: [{ id: 'way/1', name: 'Bethpage Clubhouse', kind: 'Clubhouse', position: [-73.457, 40.744] }],
        }),
        courseName: 'Bethpage Black',
      }),
    );

    expect(screen.getByText('Bethpage Clubhouse')).toBeDefined();
    expect(screen.queryByText(/The Lodge at Pebble Beach/)).toBeNull();
    expect(screen.queryByText(/Carmel Bay/)).toBeNull();
    expect(screen.queryByText(/17-Mile Drive/)).toBeNull();
  });

  it('explains an empty landmark list rather than rendering a blank section', async () => {
    await mount(boundary({ course: osmCourse({ landmarks: [] }) }));

    expect(screen.getByText(/holds no clubhouse/i)).toBeDefined();
  });
});

/**
 * The facts are only worth checking if they are the facts of the edge on screen.
 * A verdict computed once off OpenStreetMap's line would keep saying "inside"
 * about a range the contributor has just dragged the edge away from.
 */
describe('the checks follow the edge', () => {
  it('marks each landmark inside or outside the edge on screen, and re-reads it when the edge changes', async () => {
    const view = await mount(boundary());

    expect(landmarkRow('Pebble Beach Clubhouse')).toContain('inside');
    expect(landmarkRow('Peter Hay Practice Range')).toContain('inside');

    await act(async () => {
      view.rerender(boundary({ geometry: WEST_CUT, edited: true }));
    });

    expect(landmarkRow('Pebble Beach Clubhouse')).toContain('inside');
    expect(landmarkRow('Peter Hay Practice Range')).toContain('outside');
    expect(landmarkRow('Peter Hay Practice Range')).not.toContain('inside');
  });

  it('measures the acreage off a corrected edge live, and says what OpenStreetMap had', async () => {
    const view = await mount(boundary());
    expect(screen.getByText(/^176/)).toBeDefined();

    await act(async () => {
      view.rerender(boundary({ geometry: WEST_CUT, edited: true }));
    });

    /* Measured from the dragged line, not OSM's 176 carried over. */
    const live = Math.round(areaAcres(WEST_CUT));
    expect(live).not.toBe(176);
    expect(screen.getByText(new RegExp(`^${live.toLocaleString('en-US')}`))).toBeDefined();
    expect(screen.getByText('was 176 in OpenStreetMap')).toBeDefined();
    expect(screen.getByText('This is your corrected edge', { exact: false })).toBeDefined();
  });

  it('pushes a changed edge onto the map source rather than leaving the first one drawn', async () => {
    const view = await mount(boundary());

    await act(async () => {
      view.rerender(boundary({ geometry: WEST_CUT, edited: true }));
    });

    expect(JSON.stringify(harness.pushed.get('osm-course-boundary'))).toContain('-121.9495');
  });
});

describe('correcting the edge', () => {
  it('opens the edit card and puts handles on every corner of the edge', async () => {
    await mount(boundary());
    expect(screen.queryByText('Pull the dots until it fits.')).toBeNull();

    fireEvent.click(screen.getByText('The edge is wrong somewhere — let me drag it'));

    expect(screen.getByText('Pull the dots until it fits.')).toBeDefined();
    expect(screen.getByText('Save this edge')).toBeDefined();
    expect(screen.getByText('Put it back how OpenStreetMap has it')).toBeDefined();
    /* The toggle now offers the way back out. */
    expect(screen.getByText('Leave the edge alone')).toBeDefined();

    /* Four corners — the closing duplicate is not a fifth handle. */
    const handles = harness.pushed.get('shape-editor-handles') as {
      features: Array<{ properties: { role: string } }>;
    };
    expect(handles.features.filter((f) => f.properties.role === 'vertex')).toHaveLength(4);
  });

  it('hands a dragged corner back as a whole closed edge', async () => {
    const onChange = vi.fn();
    await mount(boundary({ onChange }));
    fireEvent.click(screen.getByText('The edge is wrong somewhere — let me drag it'));

    /* Grab the north-east corner (index 2) and drag it in. */
    await act(async () => {
      harness.emit(`mousedown@${EDITOR_VERTEX_LAYER}`, {
        features: [{ properties: { pathId: '0:0', index: 2, role: 'vertex' } }],
        lngLat: { lng: -121.943, lat: 36.574 },
        preventDefault: () => {},
      /* The primary button: a right-click on a handle is the delete gesture, not a drag. */
      originalEvent: { button: 0 },
      });
    });
    expect(harness.dragPan.enabled).toBe(false);
    await act(async () => {
      harness.emit('mousemove', { lngLat: { lng: -121.945, lat: 36.572 } });
      harness.emit('mouseup', {});
    });

    expect(harness.dragPan.enabled).toBe(true);
    const edge = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(edge.type).toBe('Polygon');
    const ring = edge.coordinates[0];
    expect(ring[2]).toEqual([-121.945, 36.572]);
    /* Closed again for GeoJSON, and nothing else moved. */
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
    expect(ring[0]).toEqual([-121.955, 36.563]);
  });

  it('saves a moved edge from the edit card and closes it', async () => {
    const onSave = vi.fn();
    await mount(boundary({ geometry: WEST_CUT, edited: true, onSave }));
    fireEvent.click(screen.getByText('The edge is wrong somewhere — let me drag it'));

    fireEvent.click(screen.getByText('Save this edge'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pull the dots until it fits.')).toBeNull();
  });

  it('sends nothing when the edit card is closed on an edge nobody moved', async () => {
    const onSave = vi.fn();
    await mount(boundary({ onSave }));
    fireEvent.click(screen.getByText('The edge is wrong somewhere — let me drag it'));

    fireEvent.click(screen.getByText('Save this edge'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText('Pull the dots until it fits.')).toBeNull();
  });

  it('puts the edge back how OpenStreetMap has it', async () => {
    const onReset = vi.fn();
    await mount(boundary({ geometry: WEST_CUT, edited: true, onReset }));
    fireEvent.click(screen.getByText('The edge is wrong somewhere — let me drag it'));

    fireEvent.click(screen.getByText('Put it back how OpenStreetMap has it'));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the edge did not save, and retries from the notice', async () => {
    const onSave = vi.fn();
    const failed: SaveState = { status: 'failed', message: 'the service did not answer.' };
    await mount(boundary({ geometry: WEST_CUT, edited: true, save: failed, onSave }));

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain('Your edge is not saved — the service did not answer.');
    /* Never the saved line at the same time. */
    expect(screen.queryByText(/Your corrected edge is saved/)).toBeNull();

    fireEvent.click(screen.getByText('Try again'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('says a saved edge is saved, and not that it is on OpenStreetMap', async () => {
    await mount(boundary({ geometry: WEST_CUT, edited: true, save: { status: 'saved', at: null } }));

    expect(screen.getByText(/Your corrected edge is saved/)).toBeDefined();
    expect(screen.getByText(/goes to OpenStreetMap when uploading is switched on/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
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

/**
 * Search and detail always resolve; the Overpass answer is what each test varies.
 * Our own store (the saved holes and boundary App reads on open) answers at
 * once, holding nothing — otherwise its reads would fall through to the detail
 * record, and opening would be testing a store that answers nonsense.
 */
function routeFetch(
  overpass: () => Promise<Response>,
  store: { holes?: () => Response; boundary?: () => Response } = {},
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/v1/holes/')) return store.holes?.() ?? jsonResponse({ status: 'ok', holes: [] });
    if (url.includes('/v1/courses/') && url.includes('/boundary')) {
      return store.boundary?.() ?? jsonResponse({ status: 'ok', boundary: null });
    }
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

    expect(screen.getByRole('button', { name: 'Yes, that is the course' })).toBeDefined();
    expect(screen.getByText('Is this the whole course?')).toBeDefined();
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

  it('opens on the edge the contributor saved last time, not OpenStreetMap\'s', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(async () => jsonResponse({ elements: [PEBBLE_RELATION, HOLE_ONE] }), {
        boundary: () =>
          jsonResponse({
            status: 'ok',
            boundary: {
              course_id: 'course-1',
              osm_id: 'relation/3741806',
              geometry: WEST_CUT,
              edited: true,
              saved_at: '2026-09-01T10:00:00Z',
            },
          }),
      }),
    );

    await openTheCourse();

    expect(screen.getByText('This is your corrected edge', { exact: false })).toBeDefined();
    expect(screen.getByText(/Your corrected edge is saved/)).toBeDefined();
    /* And its acreage is the saved edge's, measured, with OSM's figure beside it. */
    expect(screen.getByText(/^was \d+ in OpenStreetMap$/)).toBeDefined();
  });

  it('still opens the boundary screen when our store is not configured', async () => {
    /* A 502 `upstream` is the service running without a store. Opening must not care. */
    const upstream = () =>
      jsonResponse({ status: 'upstream', message: 'The store is not configured.' }, 502);
    vi.stubGlobal(
      'fetch',
      routeFetch(async () => jsonResponse({ elements: [PEBBLE_RELATION, HOLE_ONE] }), {
        holes: upstream,
        boundary: upstream,
      }),
    );

    await openTheCourse();

    expect(screen.getByText('Is this the whole course?')).toBeDefined();
    expect(screen.getByText('This is the line OpenStreetMap already holds', { exact: false })).toBeDefined();
  });
});
