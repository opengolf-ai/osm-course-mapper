/**
 * @vitest-environment jsdom
 *
 * The review screen over real imagery. MapLibre needs a WebGL context jsdom has
 * not got, so it is replaced with a recording double and what is under test is
 * the screen's contract: a click becomes a WGS84 point, the drawn geometry
 * reaches the map as GeoJSON, a blank canvas takes no clicks at all (R19), and
 * the five questions after the line are asked about the shapes actually on the
 * hole — every one of them answerable yes, fixable, removable or added to.
 */
import { useEffect, useRef } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResult } from '../api/detect';
import type { SavedHole, StoreResult } from '../api/holes';

const harness = vi.hoisted(() => {
  type Handler = (event: unknown) => void;
  /** Listeners by `type`, or `type@layer` for the per-layer form the shape editor uses. */
  const listeners = new Map<string, Handler[]>();
  const sources = new Map<string, { data: unknown; spec: Record<string, unknown> }>();
  const layers: Array<Record<string, unknown>> = [];
  const layout = new Map<string, Record<string, unknown>>();
  return {
    listeners,
    sources,
    layers,
    layout,
    /** Every extent the map was asked to fit, in the order it was asked. */
    fits: [] as Array<[[number, number], [number, number]]>,
    fitOptions: [] as Array<Record<string, unknown> | undefined>,
    constructed: 0,
    removed: 0,
    /** Whether the map's own panning is on — the editor turns it off while a handle is held. */
    dragPan: true,
    /**
     * What `queryRenderedFeatures` finds under a point. Empty by default: the
     * double has no renderer, so a test that wants "the pointer is on a handle"
     * says so here.
     */
    rendered: [] as unknown[],
    /** The layers the last `queryRenderedFeatures` was asked about. */
    queried: [] as string[],
    /*
     * Real MapLibre refuses layers while the style is busy, and reports
     * `isStyleLoaded()` false long after `load` has already fired. Opt in to
     * that window to exercise the retry; off by default so every other test
     * keeps the simple immediate path.
     */
    styleBusy: false,
    reset() {
      this.styleBusy = false;
      this.fits.length = 0;
      this.fitOptions.length = 0;
      listeners.clear();
      sources.clear();
      layers.length = 0;
      layout.clear();
      this.constructed = 0;
      this.removed = 0;
      this.dragPan = true;
      this.rendered = [];
      this.queried = [];
    },
    emit(type: string, event: unknown) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    indexOf(id: string) {
      return layers.findIndex((layer) => layer.id === id);
    },
  };
});

vi.mock('maplibre-gl', () => {
  type Handler = (event: unknown) => void;
  /* `on(type, fn)` and `on(type, layerId, fn)`, both as MapLibre takes them. */
  const keyOf = (type: string, layerOrHandler: unknown) =>
    typeof layerOrHandler === 'string' ? `${type}@${layerOrHandler}` : type;
  const handlerOf = (layerOrHandler: unknown, handler?: Handler) =>
    (typeof layerOrHandler === 'function' ? layerOrHandler : handler) as Handler;

  class FakeMap {
    constructor() {
      harness.constructed += 1;
    }
    on(type: string, layerOrHandler: unknown, handler?: Handler) {
      const key = keyOf(type, layerOrHandler);
      harness.listeners.set(key, [...(harness.listeners.get(key) ?? []), handlerOf(layerOrHandler, handler)]);
      return this;
    }
    once(_type: string, handler: () => void) {
      /* A busy style stands for "load already fired": it will not fire again. */
      if (!harness.styleBusy) handler();
      return this;
    }
    off(type: string, layerOrHandler: unknown, handler?: Handler) {
      const key = keyOf(type, layerOrHandler);
      const fn = handlerOf(layerOrHandler, handler);
      harness.listeners.set(
        key,
        (harness.listeners.get(key) ?? []).filter((candidate) => candidate !== fn),
      );
      return this;
    }
    remove() {
      harness.removed += 1;
    }
    fitBounds(bounds: [[number, number], [number, number]], options?: Record<string, unknown>) {
      harness.fits.push(bounds);
      harness.fitOptions.push(options);
    }
    isStyleLoaded() {
      return !harness.styleBusy;
    }
    getSource(id: string) {
      const entry = harness.sources.get(id);
      return entry && { setData: (data: unknown) => (entry.data = data), spec: entry.spec };
    }
    addSource(id: string, spec: { data?: unknown }) {
      /* Scoped to the review source so the basemap's own setup is unaffected. */
      if (harness.styleBusy && id === 'review-features') {
        throw new Error('Style is not done loading');
      }
      harness.sources.set(id, { data: spec.data, spec: spec as Record<string, unknown> });
    }
    /* Real `addLayer` inserts *before* `beforeId` — the fake splices, so
     * "beneath the suggestion layer" is an assertion rather than a hope. */
    addLayer(layer: Record<string, unknown>, beforeId?: string) {
      const at = beforeId === undefined ? -1 : harness.indexOf(beforeId);
      if (at >= 0) harness.layers.splice(at, 0, layer);
      else harness.layers.push(layer);
      harness.layout.set(layer.id as string, { ...(layer.layout as Record<string, unknown>) });
    }
    getLayer(id: string) {
      return harness.layers.find((layer) => layer.id === id);
    }
    /* No `beforeId`: to the top, which is what the editor asks for its handles. */
    moveLayer(id: string) {
      const at = harness.indexOf(id);
      if (at >= 0) harness.layers.push(...harness.layers.splice(at, 1));
    }
    removeLayer(id: string) {
      const at = harness.indexOf(id);
      if (at >= 0) harness.layers.splice(at, 1);
    }
    removeSource(id: string) {
      harness.sources.delete(id);
    }
    setLayoutProperty(id: string, key: string, value: unknown) {
      harness.layout.set(id, { ...harness.layout.get(id), [key]: value });
    }
    dragPan = {
      enable: () => {
        harness.dragPan = true;
      },
      disable: () => {
        harness.dragPan = false;
      },
    };
    private canvas = { style: {} as Record<string, string> };
    getCanvas() {
      return this.canvas;
    }
    queryRenderedFeatures(_point: unknown, options?: { layers?: string[] }) {
      harness.queried = options?.layers ?? [];
      return harness.rendered;
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

/**
 * Detection is stubbed at the client boundary: what is under test here is what
 * the screen offers and states for each outcome, not the polling loop — that is
 * pinned down against a stubbed `fetch` in `src/api/detect.test.ts`.
 */
const detectMock = vi.hoisted(() => vi.fn());
/**
 * `recordDecisions` is stubbed alongside it: the review sequence posts every
 * decision as it is made (R15), and a unit test has no store to post to. What it
 * sends is pinned down in `src/state/useMapper.test.ts`.
 */
const recordMock = vi.hoisted(() =>
  vi.fn(
    async (_courseId: string, _holeNumber: number, decisions: Array<{ outcome: string; inPlay?: boolean }>) => ({
      status: 'ok' as const,
      recorded: decisions.length,
    }),
  ),
);
vi.mock('../api/detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/detect')>();
  return { ...actual, requestProposals: detectMock, recordDecisions: recordMock };
});

/**
 * The hole store, stubbed the same way: what the save card says for each answer
 * is the screen's business, and the wire format is `src/api/holes.ts`'s.
 */
const saveMock = vi.hoisted(() => vi.fn());
vi.mock('../api/holes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/holes')>();
  return { ...actual, saveHole: saveMock };
});

import { IMAGERY_SOURCE_ID } from '../map/imagerySources';
import { IMAGERY_UNAVAILABLE_MESSAGE } from '../map/BaseMap';
import { EDITOR_VERTEX_LAYER } from '../map/useShapeEditor';
import { buildCourseSession, type CourseSession } from '../state/courseSession';
import { useMapper } from '../state/useMapper';
import type { CourseDetail } from '../api/types';
import type { OsmHoleFeature, OsmLookup } from '../api/overpass';
import {
  CONFIRMED_COLOR,
  EXISTING_COLOR,
  PROPOSED_COLOR,
  SAVED_COLOR,
  STATUS_COLOR,
  ReviewScreen,
  summariseExisting,
} from './ReviewScreen';

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

/** The same hole with two sets on the card, for the tee step's list. */
const TWO_TEES = buildCourseSession({
  ...DETAIL,
  tees: [
    { tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', yardage: 380 },
    { tee_key: 'white-male', tee_name: 'White', tee_color: 'white', yardage: 350 },
  ],
  holes_data: [{ number: 1, par: 4, handicap_index: 6, yardages: { blue: 380, white: 350 } }],
});

/** The screen, opened on hole 1 of a course OpenStreetMap holds nothing for. */
function Harness({ now, session }: { now?: Date; session: CourseSession }) {
  const mapper = useMapper();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    mapper.actions.openCourse(session, { status: 'absent' });
  }, [mapper.actions, session]);

  useEffect(() => {
    if (mapper.state.course && mapper.state.screen !== 'review') {
      mapper.actions.patch({ screen: 'review', mode: 'locate', holeIndex: 0 });
    }
  }, [mapper.state.course, mapper.state.screen, mapper.actions]);

  if (!mapper.state.course) return null;
  return <ReviewScreen mapper={mapper} now={now} />;
}

/** Renders and lets the lazy MapLibre import settle before returning. */
async function mount(now?: Date, session: CourseSession = SESSION) {
  const result = render(<Harness now={now} session={session} />);
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

beforeEach(() => {
  harness.reset();
  detectMock.mockReset();
  recordMock.mockClear();
  saveMock.mockReset();
});

/** Click a button by its label, letting React settle afterwards. */
function press(label: string) {
  const button = screen.getByText(label);
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The `<button>` a label sits in, for asserting whether it is live. */
function buttonFor(label: string): HTMLButtonElement {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error(`"${label}" is not in a button`);
  return button as HTMLButtonElement;
}

/** Everything on the review source, as the map has it. */
function reviewFeatures() {
  const data = harness.sources.get('review-features')?.data as
    | {
        features?: Array<{
          properties: Record<string, unknown>;
          geometry: { type: string; coordinates: unknown };
        }>;
      }
    | undefined;
  return data?.features ?? [];
}

/** The editor's handles on the map: every vertex, by the path it belongs to. */
function handleVertices(pathId?: string): Array<[number, number]> {
  const data = harness.sources.get('shape-editor-handles')?.data as
    | { features: Array<{ properties: { pathId: string; role: string }; geometry: { coordinates: [number, number] } }> }
    | undefined;
  return (data?.features ?? [])
    .filter((f) => f.properties.role === 'vertex' && (pathId === undefined || f.properties.pathId === pathId))
    .map((f) => f.geometry.coordinates);
}

/** Grab a handle, drag it, let go — the three events MapLibre fires for a drag. */
async function dragVertex(pathId: string, index: number, to: [number, number]) {
  await act(async () => {
    harness.emit(`mousedown@${EDITOR_VERTEX_LAYER}`, {
      features: [{ properties: { pathId, index, role: 'vertex' } }],
      lngLat: { lng: to[0], lat: to[1] },
      preventDefault: () => {},
      /* The primary button: a right-click on a handle is the delete gesture, not a drag. */
      originalEvent: { button: 0 },
    });
  });
  await act(async () => {
    harness.emit('mousemove', { lngLat: { lng: to[0], lat: to[1] } });
    harness.emit('mouseup', {});
  });
}

const CONFIRM_LINE = 'Yes, that is the hole';
const HAND_MAPPABLE = 'Carry on and map it by hand';
const ASK_AGAIN = 'Look in the imagery again';

describe('drawing on real imagery', () => {
  it('turns a click into a WGS84 point on the map, not a viewBox coordinate', async () => {
    await mount();
    expect(screen.getByText('Walk us down the hole.')).toBeDefined();
    expect(screen.getByText('Click the tee you play from.')).toBeDefined();
    expect(handleVertices()).toEqual([]);

    await clickAt(-121_949, 36_569);

    /* One point is a handle the contributor can drag, at the real coordinate. */
    expect(handleVertices('line')).toEqual([[-121.949, 36.569]]);
    expect(screen.getByText('Click the turn in the fairway, or the green.')).toBeDefined();
    /* One point is not a line, so there is nothing to confirm yet. */
    expect(buttonFor('Click the tee and the green first').disabled).toBe(true);
  });

  it('still adds its layers when the style was busy and load had already fired', async () => {
    /*
     * The bug this pins. `isStyleLoaded()` reports false whenever any tile is
     * still loading — routinely long after `load` fired — so waiting on
     * `once('load')` waited for an event that never came again. The source was
     * never added, `setData` found nothing, and the drawn line, the points and
     * every proposal were silently absent while the HTML captions above them
     * still rendered, which is exactly what it looked like from the outside.
     */
    harness.styleBusy = true;
    await mount();
    expect(harness.sources.has('review-features')).toBe(false);

    /* The tiles land: MapLibre fires styledata, and the retry takes it. */
    harness.styleBusy = false;
    await act(async () => {
      harness.emit('styledata', {});
    });

    expect(harness.sources.has('review-features')).toBe(true);
    expect(harness.indexOf('review-features-line')).toBeGreaterThanOrEqual(0);
    expect(harness.indexOf('review-features-point')).toBeGreaterThanOrEqual(0);

    /* And what the contributor draws now reaches it. */
    await clickAt(-121_949, 36_569);
    await clickAt(-121_946, 36_570);
    expect(reviewFeatures().some((f) => f.geometry.type === 'LineString')).toBe(true);
  });

  it('shows a line drawn while the style was still loading, without another click', async () => {
    /*
     * The bug this pins, and the one a contributor actually hit: `onMapReady`
     * fires at construction, before the style will take a source, so the layers
     * land later on a style event. The source was created empty, and the effect
     * that pushes features only re-runs when they change — so everything drawn
     * during that window stayed invisible until the contributor happened to
     * click once more. Here nothing is clicked after the style lands.
     */
    harness.styleBusy = true;
    await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_946, 36_570);
    expect(harness.sources.has('review-features')).toBe(false);

    harness.styleBusy = false;
    await act(async () => {
      harness.emit('styledata', {});
    });

    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual([
      [-121.949, 36.569],
      [-121.946, 36.57],
    ]);
    /* While the line is being drawn its points are the editor's handles, not a
     * second circle under each. */
    expect(handleVertices('line')).toHaveLength(2);
  });

  it('sends the drawn line to the map as a GeoJSON LineString', async () => {
    await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_947, 36_570);
    await clickAt(-121_946, 36_570);

    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual([
      [-121.949, 36.569],
      [-121.947, 36.57],
      [-121.946, 36.57],
    ]);
    expect(screen.getByText('Does the hole run this way?')).toBeDefined();
  });

  it('takes the last point back, and starts over from nothing', async () => {
    await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_947, 36_570);
    await clickAt(-121_946, 36_570);

    await press('Undo last point');
    expect(handleVertices('line')).toEqual([
      [-121.949, 36.569],
      [-121.947, 36.57],
    ]);

    await press('Start over');
    expect(handleVertices('line')).toEqual([]);
    expect(screen.getByText('Walk us down the hole.')).toBeDefined();
  });

  it('moves a point of the line when its handle is dragged, without adding one', async () => {
    await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_946, 36_570);

    await dragVertex('line', 1, [-121.9455, 36.5702]);
    /* MapLibre fires a click on release, at wherever the pointer stopped. */
    await clickAt(-121_945.5, 36_570.2);

    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual([
      [-121.949, 36.569],
      [-121.9455, 36.5702],
    ]);
    expect(harness.dragPan).toBe(true);
  });

  it('does not add a line point for a click released on an editor handle', async () => {
    /*
     * The editor's handles are map layers, so a click on one is also a click on
     * the map. Without `hitsHandle` every grab of a handle in the line flow
     * would drop a new point wherever it was let go.
     */
    await mount();
    await clickAt(-121_949, 36_569);
    expect(handleVertices('line')).toHaveLength(1);

    /* The pointer is over a handle — no drag, just a click on it. */
    harness.rendered = [{ properties: { pathId: 'line', index: 0, role: 'vertex' } }];
    await clickAt(-121_949, 36_569);

    expect(handleVertices('line')).toHaveLength(1);
    expect(harness.queried).toContain(EDITOR_VERTEX_LAYER);

    /* And off the handles, the next click is a point again. */
    harness.rendered = [];
    await clickAt(-121_946, 36_570);
    expect(handleVertices('line')).toHaveLength(2);
  });

  it('drives every drawn status, including a saved one, from a feature property', async () => {
    await mount();

    /* The review layers only: the editor's handles are styled by role, not status. */
    const review = harness.layers.filter((layer) => layer.source === 'review-features');
    const paints = review.map((layer) => JSON.stringify(layer.paint));
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      expect(paint).toContain('match');
      expect(paint).toContain('status');
    }
    const all = paints.join(' ');
    for (const status of ['confirmed', 'active', 'pending', 'proposed', 'existing', 'saved']) {
      expect(all).toContain(status);
    }
    /* Saved earlier is the contributor's, but not the work in front of them. */
    expect(STATUS_COLOR).toContain('saved');
    expect(STATUS_COLOR[STATUS_COLOR.indexOf('saved') + 1]).toBe(SAVED_COLOR);
    expect(SAVED_COLOR).not.toBe(CONFIRMED_COLOR);
  });

  /**
   * R8. The fallback branch of the colour expression used to be the confirmed
   * colour, so any status the expression did not enumerate — `proposed`, before
   * it was one — painted as confirmed geometry. That failure is silent on a map,
   * so it is asserted here rather than left to the eye.
   */
  it('does not paint an unhandled status in the confirmed colour', async () => {
    await mount();

    expect(STATUS_COLOR).toContain('proposed');
    expect(STATUS_COLOR[STATUS_COLOR.length - 1]).not.toBe(CONFIRMED_COLOR);
    expect(PROPOSED_COLOR).not.toBe(CONFIRMED_COLOR);

    /* And an unknown status resolves through that fallback, not through a branch. */
    const branches = STATUS_COLOR.slice(2, -1);
    expect(branches).not.toContain('mystery-status');
  });

  it('draws suggestions dashed on their own layer, since line-dasharray is not data-driven', async () => {
    await mount();

    const dashed = harness.layers.filter(
      (layer) => (layer.paint as Record<string, unknown>)['line-dasharray'] !== undefined,
    );
    expect(dashed).toHaveLength(1);
    expect(JSON.stringify(dashed[0].filter)).toContain('proposed');
    /* And the solid line layer stays off them rather than drawing underneath. */
    const solid = harness.layers.find(
      (layer) =>
        layer.type === 'line' && (layer.paint as Record<string, unknown>)['line-dasharray'] === undefined,
    );
    expect(JSON.stringify(solid?.filter)).toContain('proposed');
    expect(JSON.stringify(solid?.filter)).toContain('!=');
  });

  it('ignores clicks while the imagery-error state shows (R19)', async () => {
    await mount();

    await act(async () => {
      harness.emit('error', { sourceId: IMAGERY_SOURCE_ID, error: new Error('tiles offline') });
    });
    expect(screen.getByText(IMAGERY_UNAVAILABLE_MESSAGE)).toBeDefined();

    await clickAt(-121_949, 36_569);
    await clickAt(-121_947, 36_570);

    expect(handleVertices('line')).toEqual([]);
    expect(reviewFeatures().some((f) => f.geometry.type === 'LineString')).toBe(false);
    /* And the screen stops inviting a click it will not accept. */
    expect(screen.queryByText('Click the tee you play from.')).toBeNull();
  });
});

/* --- Proposals ------------------------------------------------------------ */

const PROPOSAL = {
  id: '77d2-0',
  kind: 'green' as const,
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-121.9462, 36.5705],
        [-121.946, 36.5705],
        [-121.946, 36.5707],
        [-121.9462, 36.5707],
        [-121.9462, 36.5705],
      ],
    ],
  },
  confidence: 0.8,
  areaSquareMeters: 640,
  vertexCount: 5,
  notes: [],
  teeSet: null as { name: string; key: string; yards: number } | null,
  acquired: '2023-07-04',
  gsdMeters: 0.6,
  source: 'naip',
  modelId: 'sam2',
  itemId: 'ca_m_3612_2023',
};

/** The same proposal shape, for a kind and an id, a 0.0002° square west of `lng`. */
function like(
  id: string,
  kind: 'green' | 'bunker' | 'water' | 'tee' | 'fairway',
  lng: number,
  extra: Partial<typeof PROPOSAL> = {},
) {
  return {
    ...PROPOSAL,
    id,
    kind,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [lng, 36.5705],
          [lng + 0.0002, 36.5705],
          [lng + 0.0002, 36.5707],
          [lng, 36.5707],
          [lng, 36.5705],
        ],
      ],
    },
    ...extra,
  };
}

function resolvesWith(result: DetectResult) {
  detectMock.mockResolvedValue(result);
}

function found(proposals: unknown[], imagery: unknown = null) {
  resolvesWith({
    status: 'ok',
    jobId: '77d2',
    proposals,
    imagery,
    missingTeeSets: [],
  } as unknown as DetectResult);
}

/** Two clicks and a yes: the line confirmed, which is the request. */
async function withConfirmedLine(now?: Date, session: CourseSession = SESSION) {
  const view = await mount(now, session);
  await clickAt(-121_949, 36_569);
  await clickAt(-121_946, 36_570);
  await press(CONFIRM_LINE);
  return view;
}

/** What the map is currently holding, by proposal id. */
function statusById(): Map<string, string> {
  return new Map(
    reviewFeatures()
      .filter((f) => typeof f.properties.proposalId === 'string')
      .map((f) => [f.properties.proposalId as string, f.properties.status as string]),
  );
}

/**
 * Asking for proposals (R1), and what happens when the answer is nothing, a
 * failure, or never arrives (R12). The hole must stay hand-mappable in all three.
 */
describe('asking the detection service for proposals', () => {
  it('starts looking as soon as the line is confirmed, without a second ask', async () => {
    found([PROPOSAL]);
    await mount();

    await clickAt(-121_949, 36_569);
    /* A line still being drawn is not a question to ask the service. */
    expect(detectMock).not.toHaveBeenCalled();
    await clickAt(-121_946, 36_570);
    expect(detectMock).not.toHaveBeenCalled();

    /*
     * "Yes, that is the hole" is the request. The contributor has already said
     * where the hole runs; making them press a second button asks them to state
     * the same intent twice.
     */
    await press(CONFIRM_LINE);
    expect(detectMock).toHaveBeenCalledTimes(1);
    /* And the review opens on its first question: the card's tee. */
    expect(screen.getByText('Tee 1 of 1 · Blue')).toBeDefined();
    expect(screen.getByText('check 1 of 5')).toBeDefined();
  });

  it('asks about the drawn line with the hole card, and lands proposals in the review sequence', async () => {
    found([PROPOSAL]);
    await withConfirmedLine();

    const request = detectMock.mock.calls[0][0];
    expect(request.line).toEqual([
      [-121.949, 36.569],
      [-121.946, 36.57],
    ]);
    expect(request.par).toBe(4);
    expect(request.teeSets).toEqual([{ name: 'Blue', key: 'blue', yards: 380 }]);

    /* Out of the line flow and into the review sequence. */
    expect(screen.queryByText('Walk us down the hole.')).toBeNull();
    expect(screen.queryByText('Does the hole run this way?')).toBeNull();
    /* Everything arrives as a suggestion. Nothing is confirmed by arriving. */
    expect([...statusById().values()]).toEqual(['proposed']);
  });

  it('shows the detecting card while the imagery is read', async () => {
    detectMock.mockImplementation(() => new Promise<DetectResult>(() => {}));
    await withConfirmedLine();

    expect(screen.getByText('Reading the imagery')).toBeDefined();
    expect(screen.getByText('Your line is locked in.')).toBeDefined();
    /* The line is locked: no handles on it, and clicks add nothing. */
    expect(handleVertices('line')).toEqual([]);
    await clickAt(-121_940, 36_571);
    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toHaveLength(2);
  });

  it('states a no-coverage answer as its own outcome rather than an empty sequence', async () => {
    resolvesWith({ status: 'no_coverage', message: 'No NAIP imagery covers this location.' });
    await withConfirmedLine();

    expect(screen.getByText(/Nothing to propose on this hole/)).toBeDefined();
    expect(screen.getByText(/No NAIP imagery covers this location/)).toBeDefined();
    /* Nothing went wrong, so nothing says it did. */
    expect(screen.queryByText(/Detection did not finish/)).toBeNull();
    /* Nothing was proposed, so nothing is being asked — and the hole still maps by hand. */
    expect(screen.queryByText(/Tee 1 of 1/)).toBeNull();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    expect(screen.getByText(ASK_AGAIN)).toBeDefined();
  });

  it('states a timeout and leaves the hole hand-mappable (R12)', async () => {
    resolvesWith({
      status: 'timeout',
      message: 'Detection did not finish within the time budget.',
    });
    await withConfirmedLine();

    expect(screen.getByText(/Detection did not finish — Detection did not finish within the time budget/)).toBeDefined();
    expect(screen.getByText(/still yours to map by hand/)).toBeDefined();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    /* And the line the contributor confirmed is still on the map, as theirs. */
    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.properties.status).toBe('confirmed');
  });

  it('states a failed request the same way, without pretending detection was silent', async () => {
    resolvesWith({ status: 'failed', reason: 'network', message: 'Failed to fetch' });
    await withConfirmedLine();

    expect(screen.getByText(/Detection did not finish — Failed to fetch/)).toBeDefined();
    expect(screen.queryByText(/Nothing to propose on this hole/)).toBeNull();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
  });

  it('asks again from a failure, and carries on by hand into the questions', async () => {
    resolvesWith({ status: 'failed', reason: 'network', message: 'Failed to fetch' });
    await withConfirmedLine();

    found([PROPOSAL]);
    await press(ASK_AGAIN);
    expect(detectMock).toHaveBeenCalledTimes(2);
    /* The same line, asked about again. */
    expect(detectMock.mock.calls[1][0].line).toEqual(detectMock.mock.calls[0][0].line);
    expect(statusById().get('77d2-0')).toBe('proposed');
  });

  it('opens every question on an empty hole when carried on by hand', async () => {
    resolvesWith({ status: 'failed', reason: 'network', message: 'Failed to fetch' });
    await withConfirmedLine();

    await press(HAND_MAPPABLE);

    expect(screen.getByText('Where does the blue tee play from?')).toBeDefined();
    expect(screen.getByText('Line saved. Every step is yours to draw.')).toBeDefined();
  });

  it('cancels the working state, aborting the request and returning the hole to hand-mapping', async () => {
    let seen: AbortSignal | undefined;
    /* Never resolves on its own: the only way out of this one is the cancel. */
    detectMock.mockImplementation((_request: unknown, options: { signal?: AbortSignal }) => {
      seen = options.signal;
      return new Promise<DetectResult>(() => {});
    });
    await withConfirmedLine();

    expect(screen.getByText('Reading the imagery')).toBeDefined();
    expect(seen?.aborted).toBe(false);

    await press('Stop looking — I will map it myself');

    expect(seen?.aborted).toBe(true);
    expect(screen.queryByText('Reading the imagery')).toBeNull();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    expect(screen.getByText(ASK_AGAIN)).toBeDefined();
    expect(screen.getByText('Stopped looking. The hole is yours to map by hand.')).toBeDefined();
  });
});

/* --- The five questions --------------------------------------------------- */

/** Past the tee step on a one-set card with no box proposed. */
const NO_TEE = 'No blue tee on this hole';

describe('moving the camera to each question', () => {
  it('flies to the green when the rail asks "Is that the green?"', async () => {
    const green = like('g1', 'green', -121.946);
    found([green]);
    await withConfirmedLine();
    const before = harness.fits.length;

    await press(NO_TEE);
    expect(screen.getByText('Is that the green?')).toBeDefined();

    expect(harness.fits.length).toBe(before + 1);
    const ring = (green.geometry as { coordinates: number[][][] }).coordinates[0];
    const lngs = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    expect(harness.fits[harness.fits.length - 1]).toEqual([
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ]);
    /* Animated, and close enough to judge the edge without losing the surround. */
    expect(harness.fitOptions[harness.fitOptions.length - 1]).toMatchObject({ duration: 900, maxZoom: 18.5 });
  });

  it('does not move again while the same question is on screen', async () => {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();
    await press(NO_TEE);
    const settled = harness.fits.length;

    /* Opening and leaving the edge editor is not a new question. */
    await press('Edges look off');
    await press('Save this shape');

    const refits = harness.fitOptions.slice(settled).filter((options) => options?.duration === 900);
    expect(refits).toHaveLength(0);
  });
});

describe('the tee step', () => {
  it('lists every set on the card and asks where the first one plays from', async () => {
    found([
      like('t-blue', 'tee', -121.9491, { teeSet: { name: 'Blue', key: 'blue', yards: 380 } }),
      like('t-white', 'tee', -121.9485, { teeSet: { name: 'White', key: 'white', yards: 350 } }),
    ]);
    await withConfirmedLine(undefined, TWO_TEES);

    expect(screen.getByText('Tee 1 of 2 · Blue')).toBeDefined();
    expect(screen.getByText('Is that where the blue tee plays from?')).toBeDefined();
    /* The card, longest first, each set with its yardage and where it stands. */
    expect(screen.getByText('380 yd')).toBeDefined();
    expect(screen.getByText('350 yd')).toBeDefined();
    expect(screen.getByText('highlighted')).toBeDefined();
    expect(screen.getByText('our guess')).toBeDefined();
    /* The box asked about is the one detection matched to blue. */
    const active = reviewFeatures().find((f) => f.properties.focus === true);
    expect(active?.properties.proposalId).toBe('t-blue');

    await press('Yes, that is the blue tee');

    expect(statusById().get('t-blue')).toBe('confirmed');
    expect(statusById().get('t-white')).toBe('proposed');
    expect(screen.getByText('Tee 2 of 2 · White')).toBeDefined();
    expect(screen.getByText('Is that where the white tee plays from?')).toBeDefined();
    expect(screen.getByText('matched')).toBeDefined();
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][2][0].outcome).toBe('confirmed');
  });

  it('asks where a set plays from when no box was matched to it, with "no such tee" as an answer', async () => {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();

    expect(screen.getByText('Where does the blue tee play from?')).toBeDefined();
    expect(screen.getByText('no box yet')).toBeDefined();
    expect(screen.getByText('Pick the box')).toBeDefined();

    await press('Pick the box');
    expect(
      screen.getByText('Click the box you play the blue tee from — open ground draws a new one.'),
    ).toBeDefined();

    await press('Never mind');
    await press(NO_TEE);
    /* On to the green. */
    expect(screen.getByText('Is that the green?')).toBeDefined();
    /* The one set was answered, and the step is closed out rather than repeated. */
    expect(screen.getByText('check 2 of 5')).toBeDefined();
  });

  it('draws a new box where open ground is clicked for a set, and keeps it for that set', async () => {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();

    await press('Pick the box');
    await clickAt(-121_948.9, 36_569.1);

    expect(screen.getByText('Your new tee box')).toBeDefined();
    expect(screen.getByText('Save this tee box')).toBeDefined();
    /* It arrives with handles to pull it into place. */
    expect(handleVertices('drawn-1').length).toBeGreaterThanOrEqual(3);

    await press('Save this tee box');
    expect(screen.getByText('Drew a box for the blue tee.')).toBeDefined();
    expect(screen.getByText('Is that where the blue tee plays from?')).toBeDefined();
  });
});

describe('the green step', () => {
  it('turns down the proposed green and waits for a click on the real one', async () => {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();
    await press(NO_TEE);
    expect(screen.getByText('Is that the green?')).toBeDefined();
    expect(statusById().get('g1')).toBe('proposed');

    await press('That is not the green');

    /* Off the map, recorded as a rejection rather than dropped (R10). */
    expect(statusById().has('g1')).toBe(false);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][2][0].outcome).toBe('rejected');
    /* And the map says what the next click does. */
    expect(screen.getByRole('status').textContent).toContain('Click the green you putt on.');

    await clickAt(-121_946.1, 36_570.1);
    expect(screen.getByText('Your new green')).toBeDefined();

    await press('Save this green');
    /* The green step is answered, and the review moves on. */
    expect(screen.getByText('No fairway on this hole. Right?')).toBeDefined();
    const green = reviewFeatures().find((f) => f.properties.shapeId === 'drawn-1');
    expect(green?.properties.status).toBe('confirmed');
  });

  it('opens the edit card on "Edges look off", and puts the outline back on request', async () => {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();
    await press(NO_TEE);

    await press('Edges look off');

    expect(screen.getByText('Editing the green outline')).toBeDefined();
    expect(screen.getByText('Pull the dots until it fits.')).toBeDefined();
    expect(screen.getByText('Save this shape')).toBeDefined();
    /* The question waits while the outline is being pulled about. */
    expect(screen.queryByText('Is that the green?')).toBeNull();
    const before = handleVertices('g1');
    expect(before).toHaveLength(4);

    await dragVertex('g1', 2, [-121.9457, 36.5709]);
    expect(handleVertices('g1')[2]).toEqual([-121.9457, 36.5709]);

    await press('Put it back how we drew it');
    expect(handleVertices('g1')).toEqual(before);

    await dragVertex('g1', 2, [-121.9457, 36.5709]);
    await press('Save this shape');
    expect(screen.getByText('Edges saved.')).toBeDefined();
    expect(screen.getByText('Is that the green?')).toBeDefined();
    /* Handles off, and the reshaped outline is what the map draws. */
    expect(handleVertices()).toEqual([]);
    const green = reviewFeatures().find((f) => f.properties.proposalId === 'g1');
    expect(JSON.stringify(green?.geometry.coordinates)).toContain('-121.9457');
  });
});

describe('the sand step', () => {
  /** Tees, green and fairway answered with nothing, landing on the bunkers. */
  async function atTheSand(proposals: unknown[]) {
    found(proposals);
    await withConfirmedLine();
    await press(NO_TEE);
    await press('Skip the green for now');
    await press('No fairway on this hole');
  }

  it('counts the bunkers it asks about off the real proposals', async () => {
    await atTheSand([
      like('b1', 'bunker', -121.9465),
      like('b2', 'bunker', -121.947),
      like('b3', 'bunker', -121.9475),
    ]);

    expect(screen.getByText('We found 3 bunkers on this hole. Did we miss any?')).toBeDefined();
    expect(screen.getByText('That is all 3 of them')).toBeDefined();
    /* All three asked about at once, so all three are highlighted. */
    expect(reviewFeatures().filter((f) => f.properties.focus === true)).toHaveLength(3);

    await press('That is all 3 of them');
    expect([...statusById().values()]).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(screen.getByText('Any other hazards out there?')).toBeDefined();
  });

  it('takes out the one clicked as not sand, and recounts', async () => {
    await atTheSand([like('b1', 'bunker', -121.9465), like('b2', 'bunker', -121.947)]);
    expect(screen.getByText('We found 2 bunkers on this hole. Did we miss any?')).toBeDefined();

    await press('One of these is not sand');
    expect(screen.getByText('Click the one that is not sand.')).toBeDefined();

    /* Inside b2's square. */
    await clickAt(-121_946.9, 36_570.6);

    expect(statusById().has('b2')).toBe(false);
    expect(statusById().get('b1')).toBe('proposed');
    expect(screen.getByText('We found 1 bunker on this hole. Did we miss any?')).toBeDefined();
    expect(screen.getByText(/1 turned down on this hole/)).toBeDefined();
  });

  it('keeps a step with nothing proposed, with its add action live', async () => {
    await atTheSand([like('w1', 'water', -121.946)]);

    /* No bunkers came back. The step is shown anyway, saying so, with the
     * "we missed one" route still open — silence and absence are not the same. */
    expect(screen.getByText('No bunkers on this hole. Right?')).toBeDefined();
    expect(screen.getByText('No bunkers on this hole')).toBeDefined();
    await press('There is another bunker');
    expect(screen.getByText('Click the map where the bunker is.')).toBeDefined();

    await clickAt(-121_947.5, 36_570);
    await press('Save this bunker');
    expect(screen.getByText('We found 1 bunker on this hole. Did we miss any?')).toBeDefined();
  });
});

describe('the hazard step', () => {
  async function atTheHazards(proposals: unknown[]) {
    found(proposals);
    await withConfirmedLine();
    await press(NO_TEE);
    await press('Skip the green for now');
    await press('No fairway on this hole');
    await press('No bunkers on this hole');
  }

  it('offers proposed water as a hazard already typed water, with the other types on offer', async () => {
    await atTheHazards([like('w1', 'water', -121.946)]);

    expect(screen.getByText('1 hazard on this hole. Anything else?')).toBeDefined();
    const chips = within(screen.getByRole('radiogroup', { name: 'What hazard 1 is' }));
    expect(chips.getByRole('radio', { name: 'Water' }).getAttribute('aria-checked')).toBe('true');
    expect(chips.getByRole('radio', { name: 'Trees' }).getAttribute('aria-checked')).toBe('false');
    expect(chips.getByRole('radio', { name: 'Waste area' })).toBeDefined();
    expect(buttonFor('That is all of them').disabled).toBe(false);
  });

  it('holds the accept until every hazard is typed, and the chips set the type', async () => {
    await atTheHazards([like('w1', 'water', -121.946)]);

    await press('Draw a hazard');
    expect(screen.getByText('Click the map where the hazard is.')).toBeDefined();
    await clickAt(-121_947.5, 36_570);
    expect(screen.getByText('Your new hazard')).toBeDefined();
    await press('Save this hazard');

    expect(screen.getByText('2 hazards on this hole. Anything else?')).toBeDefined();
    /* An untyped hazard is not something to confirm: the accept is held. */
    expect(screen.getByText('Say what each one is before moving on.')).toBeDefined();
    expect(buttonFor('That is all of them').disabled).toBe(true);

    const second = within(screen.getByRole('radiogroup', { name: 'What hazard 2 is' }));
    await act(async () => {
      second.getByRole('radio', { name: 'Trees' }).click();
    });
    expect(second.getByRole('radio', { name: 'Trees' }).getAttribute('aria-checked')).toBe('true');
    expect(buttonFor('That is all of them').disabled).toBe(false);

    /* Water can be re-typed too — "we spotted it" is a suggestion, not the answer. */
    const first = within(screen.getByRole('radiogroup', { name: 'What hazard 1 is' }));
    await act(async () => {
      first.getByRole('radio', { name: 'Waste area' }).click();
    });
    expect(first.getByRole('radio', { name: 'Waste area' }).getAttribute('aria-checked')).toBe('true');
    expect(first.getByRole('radio', { name: 'Water' }).getAttribute('aria-checked')).toBe('false');

    await press('That is all of them');
    expect(screen.getByText('Hole 1, confirmed.')).toBeDefined();
    expect(screen.getByText('waste area, trees')).toBeDefined();
  });

  it('takes a hazard off the hole from its own row', async () => {
    await atTheHazards([like('w1', 'water', -121.946)]);

    await press('remove');

    expect(screen.getByText('Any other hazards out there?')).toBeDefined();
    expect(statusById().has('w1')).toBe(false);
    expect(recordMock.mock.calls[recordMock.mock.calls.length - 1][2][0].outcome).toBe('rejected');
  });
});

describe('saving the hole', () => {
  /** Every step answered, the proposed green kept: the save card on screen. */
  async function allAnswered() {
    found([like('g1', 'green', -121.946)]);
    await withConfirmedLine();
    await press(NO_TEE);
    await press('Yes, that is the green');
    await press('No fairway on this hole');
    await press('No bunkers on this hole');
    await press('Nothing else out there');
  }

  it('sums up only what the contributor decided, and sends that to the store', async () => {
    saveMock.mockImplementation(() => new Promise<StoreResult<SavedHole>>(() => {}));
    await allAnswered();

    expect(screen.getByText('Hole 1, confirmed.')).toBeDefined();
    expect(screen.getByText('all checks done')).toBeDefined();
    expect(screen.getByText('the green')).toBeDefined();
    expect(screen.getByText('no tee boxes')).toBeDefined();
    expect(screen.getByText('no bunkers')).toBeDefined();

    await press('Save hole 1');

    expect(saveMock).toHaveBeenCalledTimes(1);
    const hole = saveMock.mock.calls[0][0] as SavedHole;
    expect(hole.courseId).toBe('pebble');
    expect(hole.holeNumber).toBe(1);
    expect(hole.lineSource).toBe('drawn');
    expect(hole.playingLine.coordinates).toEqual([
      [-121.949, 36.569],
      [-121.946, 36.57],
    ]);
    expect(hole.features.map((feature) => [feature.kind, feature.origin])).toEqual([['green', 'proposed']]);
    /* While it is on its way, the button says so and cannot be pressed twice. */
    expect(buttonFor('Saving …').disabled).toBe(true);
  });

  it('says plainly when the store did not take it, and offers the save again', async () => {
    saveMock.mockResolvedValue({
      status: 'failed',
      reason: 'upstream',
      message: 'the store is not configured.',
    } satisfies StoreResult<SavedHole>);
    await allAnswered();

    await press('Save hole 1');

    expect(screen.getByText(/Not saved — the store is not configured\./)).toBeDefined();
    expect(screen.getByText(/Everything is still here/)).toBeDefined();
    /* Nothing was thrown away: the summary is still the hole. */
    expect(screen.getByText('the green')).toBeDefined();

    await press('Try saving hole 1 again');
    expect(saveMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * R5 and R9: judging a proposal against what the model actually read.
 *
 * The contributor is told the model's confidence and the year of the frame it
 * came out of before they answer, and can put that frame itself on screen. The
 * overlay must be a layer on the live map — the imagery source is what the
 * construction effect rebuilds on, so switching it would discard the review
 * layers and, worse, show NAIP pixels that are not the ones inference read.
 */
describe('provenance and the imagery the model read', () => {
  const BOUNDS: [number, number, number, number] = [-121.95, 36.566, -121.944, 36.572];

  /** What the service returns today: a signed href to the whole COG item. */
  const COG_IMAGERY = {
    source: 'USDA NAIP via Microsoft Planetary Computer',
    itemId: 'ca_m_3612_2023',
    acquired: '2023-07-04',
    gsdMeters: 0.6,
    assetHref: 'https://naipeuwest.blob.core.windows.net/naip/m_3612_2023.tif?sig=abc',
    boundsWgs84: BOUNDS,
    crs: 'EPSG:26910',
    width: 1024,
    height: 1024,
  };

  /** The same corridor window as a picture a browser can decode. */
  const RENDITION = {
    ...COG_IMAGERY,
    assetHref: 'https://example.invalid/corridor/m_3612_2023.png?sig=abc',
  };

  function proposal(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      ...PROPOSAL,
      source: 'USDA NAIP via Microsoft Planetary Computer',
      ...overrides,
    };
  }

  /**
   * Confirm the line, land the proposals with the given corridor imagery, and
   * answer the tee step — the card's one set has no box proposed — so the
   * green, the proposal being judged, is the question on screen.
   */
  async function withProposals(imagery: unknown, options: { now?: Date; proposals?: unknown[] } = {}) {
    found(options.proposals ?? [proposal()], imagery);
    const view = await withConfirmedLine(options.now);
    await press(NO_TEE);
    return view;
  }

  it("renders the proposal's confidence and the NAIP acquisition year in the rail", async () => {
    await withProposals(COG_IMAGERY, { now: new Date('2024-01-01T00:00:00Z') });

    expect(screen.getByText('Is that the green?')).toBeDefined();
    /* Always there, not only when something is wrong: 2023 is inside the
     * three-year window, so this render carries no warning at all. */
    expect(screen.getByText('What the model read')).toBeDefined();
    expect(screen.getByText('80%')).toBeDefined();
    expect(screen.getByText('NAIP 2023')).toBeDefined();
    expect(screen.queryByText(/more than 3 years old/)).toBeNull();
  });

  it('shows the corridor raster the service read, under the proposals, without rebuilding the map', async () => {
    await withProposals(RENDITION, { now: new Date('2024-01-01T00:00:00Z') });

    /* Added hidden — nobody asked for it yet. */
    expect(harness.layout.get('detection-corridor')?.visibility).toBe('none');

    await press('Show me the imagery you read');

    const source = harness.sources.get('detection-corridor')?.spec;
    expect(source?.type).toBe('image');
    expect(source?.url).toBe(RENDITION.assetHref);
    /* The window the service actually read, as MapLibre's four corners. */
    expect(source?.coordinates).toEqual([
      [-121.95, 36.572],
      [-121.944, 36.572],
      [-121.944, 36.566],
      [-121.95, 36.566],
    ]);

    expect(harness.layout.get('detection-corridor')?.visibility).toBe('visible');
    /* Beneath the suggestion fill, so the shape being judged stays on top. */
    expect(harness.indexOf('detection-corridor')).toBeLessThan(harness.indexOf('review-features-fill'));

    /* One map for the whole exchange: the overlay is a layer, not a source swap. */
    expect(harness.constructed).toBe(1);
    expect(harness.removed).toBe(0);
    /* And the proposal on top of it is untouched by the toggle. */
    expect(screen.getByText('Is that the green?')).toBeDefined();

    /* The credit on the map names the same acquisition the rail states. */
    expect(screen.getByText(/acquired 2023-07-04/)).toBeDefined();
    expect(screen.getByText('NAIP 2023')).toBeDefined();

    await press('Back to the display imagery');
    expect(harness.layout.get('detection-corridor')?.visibility).toBe('none');
  });

  it('states the gap rather than offering a toggle when the frame is a GeoTIFF', async () => {
    await withProposals(COG_IMAGERY, { now: new Date('2024-01-01T00:00:00Z') });

    expect(screen.queryByText('Show me the imagery you read')).toBeNull();
    expect(screen.getByText(/We cannot put that frame on screen yet/)).toBeDefined();
    /* Nothing was drawn in its place — no overlay layer at all. */
    expect(harness.indexOf('detection-corridor')).toBe(-1);
  });

  it('warns past three years and not at exactly three, showing the year either way', async () => {
    /* Acquired 2023-07-04. Three years to the day is not "more than three". */
    await withProposals(COG_IMAGERY, { now: new Date('2026-07-04T00:00:00Z') });
    expect(screen.getByText('NAIP 2023')).toBeDefined();
    expect(screen.queryByText(/more than 3 years old/)).toBeNull();
  });

  it('warns on a proposal read from imagery more than three years old', async () => {
    await withProposals(COG_IMAGERY, { now: new Date('2026-07-05T00:00:00Z') });

    expect(screen.getByText('NAIP 2023')).toBeDefined();
    expect(screen.getByText(/This came out of 2023 imagery — more than 3 years old/)).toBeDefined();
    expect(screen.getByText(/not in what the model saw/)).toBeDefined();
  });

  it('shows a newer proposal its year with no warning attached', async () => {
    await withProposals(
      { ...COG_IMAGERY, acquired: '2025-06-01' },
      {
        now: new Date('2026-07-05T00:00:00Z'),
        proposals: [proposal({ acquired: '2025-06-01' })],
      },
    );

    expect(screen.getByText('NAIP 2025')).toBeDefined();
    expect(screen.queryByText(/more than 3 years old/)).toBeNull();
  });

  it('states the imagery year even on a step with nothing proposed to judge', async () => {
    /* The tee step here has no box: no confidence to give, but the frame is still named. */
    found([proposal()], COG_IMAGERY);
    await withConfirmedLine(new Date('2024-01-01T00:00:00Z'));

    expect(screen.getByText('Where does the blue tee play from?')).toBeDefined();
    expect(screen.getByText('NAIP 2023')).toBeDefined();
    expect(screen.queryByText('80%')).toBeNull();
  });

  it('gives the confidence of the bunker being asked about on the sand step', async () => {
    await withProposals(COG_IMAGERY, {
      now: new Date('2024-01-01T00:00:00Z'),
      proposals: [
        proposal({ id: 'b1', kind: 'bunker', confidence: 0.91 }),
        proposal({ id: 'b2', kind: 'bunker', confidence: 0.42 }),
      ],
    });
    await press('Skip the green for now');
    await press('No fairway on this hole');

    expect(screen.getByText('We found 2 bunkers on this hole. Did we miss any?')).toBeDefined();
    expect(screen.getByText('91%')).toBeDefined();
    /* And every bunker carries its own confidence on the map, for its caption. */
    const confidences = reviewFeatures()
      .filter((f) => f.properties.proposalId !== undefined)
      .map((f) => f.properties.confidence);
    expect(confidences).toEqual([0.91, 0.42]);
  });
});

/* --- A hole OpenStreetMap already holds ----------------------------------- */

/** The line OSM holds for hole 1: Pebble Beach way 671717506, tee to green. */
const OSM_LINE: [number, number][] = [
  [-121.9495343, 36.5693904],
  [-121.9477382, 36.5705598],
  [-121.9461359, 36.5706059],
];

/** A small square outline, as a `golf=*` way comes back. */
function outline(id: string, tag: string, kind: OsmHoleFeature['kind'], at: [number, number]): OsmHoleFeature {
  const d = 0.00015;
  return {
    id,
    kind,
    tag,
    name: null,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [at[0] - d, at[1] - d],
          [at[0] + d, at[1] - d],
          [at[0] + d, at[1] + d],
          [at[0] - d, at[1] + d],
          [at[0] - d, at[1] - d],
        ],
      ],
    },
  };
}

const MAPPED: OsmLookup = {
  status: 'found',
  course: {
    osmId: 'relation/3741806',
    name: 'Pebble Beach Golf Links',
    boundary: {
      type: 'Polygon',
      coordinates: [[[-121.955, 36.563], [-121.943, 36.563], [-121.943, 36.574], [-121.955, 36.563]]],
    },
    acres: 176,
    bbox: [-121.955, 36.563, -121.943, 36.574],
    mappedHoleRefs: [1],
    holes: [
      {
        osmId: 'way/671717506',
        ref: 1,
        nine: null,
        osmRef: '1',
        par: 4,
        line: { type: 'LineString', coordinates: OSM_LINE },
        features: [
          outline('way/820001', 'green', 'green', [-121.9461359, 36.5706059]),
          outline('way/820002', 'bunker', 'bunker', [-121.9466, 36.5703]),
          outline('way/820003', 'bunker', 'bunker', [-121.9464, 36.5709]),
        ],
      },
    ],
    landmarks: [],
    matchedBy: 'name',
  },
};

/** The screen, opened on a hole the map already holds — the way a click does it. */
function MappedHarness() {
  const mapper = useMapper();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    mapper.actions.openCourse(SESSION, MAPPED);
  }, [mapper.actions]);

  useEffect(() => {
    if (mapper.state.course && mapper.state.screen === 'boundary') mapper.actions.openHole(0);
  }, [mapper.state.course, mapper.state.screen, mapper.actions]);

  if (!mapper.state.course || mapper.state.screen !== 'review') return null;
  return <ReviewScreen mapper={mapper} />;
}

async function mountMapped() {
  const result = render(<MappedHarness />);
  for (let tick = 0; tick < 20 && harness.sources.size === 0; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return result;
}

describe('a hole OpenStreetMap already holds', () => {
  it('draws the playing line and the outlines OSM holds, without a click', async () => {
    await mountMapped();

    const features = reviewFeatures();
    const line = features.find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual(OSM_LINE);
    expect(features.filter((f) => f.properties.kind === 'bunker')).toHaveLength(2);
    expect(features.some((f) => f.properties.kind === 'green')).toBe(true);
  });

  it('zooms to the hole rather than opening on the whole course', async () => {
    await mountMapped();

    const fitted = harness.fits[harness.fits.length - 1];
    expect(fitted).toBeDefined();
    const [[west, south], [east, north]] = fitted;
    /* The course is 0.012 by 0.011 degrees; the hole and its margin are a
     * fraction of that, and hold every point of the line. */
    expect(east - west).toBeLessThan(0.006);
    expect(north - south).toBeLessThan(0.006);
    for (const [lng, lat] of OSM_LINE) {
      expect(lng).toBeGreaterThan(west);
      expect(lng).toBeLessThan(east);
      expect(lat).toBeGreaterThan(south);
      expect(lat).toBeLessThan(north);
    }
  });

  it('draws none of it as the contributor’s own confirmed work (R8)', async () => {
    await mountMapped();

    const statuses = reviewFeatures().map((f) => f.properties.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain('confirmed');
    expect(new Set(statuses)).toEqual(new Set(['existing']));
    /* And that status has a colour of its own, not the confirmed one. */
    expect(STATUS_COLOR).toContain('existing');
    expect(EXISTING_COLOR).not.toBe(CONFIRMED_COLOR);
    expect(EXISTING_COLOR).not.toBe(PROPOSED_COLOR);
  });

  it('asks whether the hole runs the way OSM has it, names what is outlined, and offers a redraw', async () => {
    await mountMapped();

    expect(screen.getByText('Already in OpenStreetMap')).toBeDefined();
    expect(screen.getByText('Does the hole run this way?')).toBeDefined();
    expect(screen.getByText('a green and 2 bunkers')).toBeDefined();
    /* Never "your line" over a line nobody in this session drew. */
    expect(screen.queryByText('yd along this line')).toBeNull();
    expect(screen.getByText("yd along OpenStreetMap's line")).toBeDefined();
    /* A line on screen is a line detection can be asked about (R1). */
    expect(buttonFor(CONFIRM_LINE).disabled).toBe(false);
    /* And the redraw is offered rather than a prompt to click a tee that is
     * already on screen — or an undo for points nobody here placed. */
    expect(screen.getByText('Draw it myself')).toBeDefined();
    expect(screen.queryByText('Undo last point')).toBeNull();
    expect(screen.queryByText('Click the tee you play from.')).toBeNull();
    expect(screen.getByText('Drag any dot that misses a bend.')).toBeDefined();
  });

  it('does not extend OpenStreetMap’s line past its green on a click', async () => {
    await mountMapped();

    await clickAt(-121_945, 36_571);

    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual(OSM_LINE);
  });

  it('makes the line the contributor’s once they drag a point of it', async () => {
    await mountMapped();
    expect(handleVertices('line')).toHaveLength(3);

    await dragVertex('line', 1, [-121.9478, 36.5703]);

    const line = reviewFeatures().find((f) => f.geometry.type === 'LineString');
    expect(line?.geometry.coordinates).toEqual([OSM_LINE[0], [-121.9478, 36.5703], OSM_LINE[2]]);
    /* No longer OpenStreetMap's line, so no longer drawn or described as theirs. */
    expect(line?.properties.status).toBe('active');
    expect(screen.getByText('yd along this line')).toBeDefined();
    expect(screen.queryByText("yd along OpenStreetMap's line")).toBeNull();
  });

  it('asks about OpenStreetMap’s line on "yes", exactly as about a drawn one', async () => {
    found([]);
    await mountMapped();

    await press(CONFIRM_LINE);

    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(detectMock.mock.calls[0][0].line).toEqual(OSM_LINE);
  });

  it('counts what it names off the real features', () => {
    expect(summariseExisting([])).toBe('');
    expect(summariseExisting([{ tag: 'green' }])).toBe('a green');
    expect(summariseExisting([{ tag: 'bunker' }, { tag: 'bunker' }])).toBe('2 bunkers');
    expect(summariseExisting([{ tag: 'green' }, { tag: 'water_hazard' }])).toBe(
      'a green and a water hazard',
    );
  });
});
