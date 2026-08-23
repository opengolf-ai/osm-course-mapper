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
import type { DetectResult } from '../api/detect';

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const sources = new Map<string, { data: unknown; spec: Record<string, unknown> }>();
  const layers: Array<Record<string, unknown>> = [];
  const layout = new Map<string, Record<string, unknown>>();
  return {
    listeners,
    sources,
    layers,
    layout,
    constructed: 0,
    removed: 0,
    /*
     * Real MapLibre refuses layers while the style is busy, and reports
     * `isStyleLoaded()` false long after `load` has already fired. Opt in to
     * that window to exercise the retry; off by default so every other test
     * keeps the simple immediate path.
     */
    styleBusy: false,
    reset() {
      this.styleBusy = false;
      listeners.clear();
      sources.clear();
      layers.length = 0;
      layout.clear();
      this.constructed = 0;
      this.removed = 0;
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
  class FakeMap {
    constructor() {
      harness.constructed += 1;
    }
    on(type: string, handler: (event: unknown) => void) {
      harness.listeners.set(type, [...(harness.listeners.get(type) ?? []), handler]);
      return this;
    }
    once(_type: string, handler: () => void) {
      /* A busy style stands for "load already fired": it will not fire again. */
      if (!harness.styleBusy) handler();
      return this;
    }
    off() {
      return this;
    }
    remove() {
      harness.removed += 1;
    }
    fitBounds() {}
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
    async (_courseId: string, _holeNumber: number, decisions: Array<{ outcome: string }>) => ({
      status: 'ok' as const,
      recorded: decisions.length,
    }),
  ),
);
vi.mock('../api/detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/detect')>();
  return { ...actual, requestProposals: detectMock, recordDecisions: recordMock };
});

import { IMAGERY_SOURCE_ID } from '../map/imagerySources';
import { IMAGERY_UNAVAILABLE_MESSAGE } from '../map/BaseMap';
import { buildCourseSession } from '../state/courseSession';
import { useMapper } from '../state/useMapper';
import type { CourseDetail } from '../api/types';
import { CONFIRMED_COLOR, PROPOSED_COLOR, STATUS_COLOR, ReviewScreen } from './ReviewScreen';

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
function Harness({ now }: { now?: Date }) {
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
  return <ReviewScreen mapper={mapper} now={now} />;
}

/** Renders and lets the lazy MapLibre import settle before returning. */
async function mount(now?: Date) {
  const result = render(<Harness now={now} />);
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
});

/** Click a button by its label, letting React settle afterwards. */
function press(label: string) {
  const button = screen.getByText(label);
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const ASK = 'Look for features in the imagery';
const HAND_MAPPABLE = 'Save this line and carry on';

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
    const collection = harness.sources.get('review-features')?.data as {
      features: Array<{ geometry: { type: string } }>;
    };
    expect(collection.features.some((f) => f.geometry.type === 'LineString')).toBe(true);
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

    const collection = harness.sources.get('review-features')?.data as {
      features: Array<{ geometry: { type: string } }>;
    };
    expect(collection.features.some((f) => f.geometry.type === 'LineString')).toBe(true);
    expect(collection.features.filter((f) => f.geometry.type === 'Point')).toHaveLength(2);
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

  it('drives pending, active, proposed and confirmed styling from a feature property', async () => {
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
    expect(all).toContain('proposed');
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

    expect(screen.getByText('0 points marked')).toBeDefined();
    /* And the screen stops inviting a click it will not accept. */
    expect(screen.queryByText('Click where you tee off.')).toBeNull();
  });
});

/**
 * Asking for proposals (R1), and what happens when the answer is nothing, a
 * failure, or never arrives (R12). The hole must stay hand-mappable in all three.
 */
describe('asking the detection service for proposals', () => {
  /** Two clicks and a finish: the state in which the request becomes available. */
  async function withFinishedLine() {
    const view = await mount();
    await clickAt(-121_949, 36_569);
    await clickAt(-121_946, 36_570);
    await press('Finish the line');
    return view;
  }

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
    teeSet: null,
    acquired: '2023-07-04',
    gsdMeters: 0.6,
    source: 'naip',
    modelId: 'sam2',
    itemId: 'ca_m_3612_2023',
  };

  function resolvesWith(result: DetectResult) {
    detectMock.mockResolvedValue(result);
  }

  it('starts looking as soon as the line is finished, without a second ask', async () => {
    resolvesWith({
      status: 'ok',
      jobId: '77d2',
      proposals: [PROPOSAL],
      imagery: null,
      missingTeeSets: [],
    });
    await mount();

    await clickAt(-121_949, 36_569);
    /* A line still being drawn is not a question to ask the service. */
    expect(detectMock).not.toHaveBeenCalled();
    await clickAt(-121_946, 36_570);
    expect(detectMock).not.toHaveBeenCalled();

    /*
     * Finishing at the green is the request. The contributor has already said
     * where the hole runs; making them press a second button asks them to state
     * the same intent twice.
     */
    await press('Finish the line');
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Is that the green?')).toBeDefined();
  });

  it('asks about the drawn line with the hole card, and lands proposals in the review sequence', async () => {
    resolvesWith({
      status: 'ok',
      jobId: '77d2',
      proposals: [PROPOSAL],
      imagery: null,
      missingTeeSets: [],
    });
    await withFinishedLine();


    const request = detectMock.mock.calls[0][0];
    expect(request.line).toEqual([
      [-121.949, 36.569],
      [-121.946, 36.57],
    ]);
    expect(request.par).toBe(4);
    expect(request.teeSets).toEqual([{ name: 'Blue', key: 'blue', yards: 380 }]);

    /* Out of the drawing flow and into the review sequence's first question. */
    expect(screen.queryByText('Show us where this hole plays.')).toBeNull();
    expect(screen.getByText('Is that the green?')).toBeDefined();
  });

  it('states a no-coverage answer as its own outcome rather than an empty sequence', async () => {
    resolvesWith({ status: 'no_coverage', message: 'No NAIP imagery covers this location.' });
    await withFinishedLine();


    expect(screen.getByText(/No proposals for this hole/)).toBeDefined();
    expect(screen.getByText(/No NAIP imagery covers this location/)).toBeDefined();
    /* Nothing was proposed, so nothing is being reviewed — and the line still saves. */
    expect(screen.queryByText('Is that the green?')).toBeNull();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    expect(screen.getByText(ASK)).toBeDefined();
  });

  it('states a timeout and leaves the hole hand-mappable (R12)', async () => {
    resolvesWith({
      status: 'timeout',
      message: 'Detection did not finish within the time budget.',
    });
    await withFinishedLine();


    expect(screen.getByText(/Detection did not finish/)).toBeDefined();
    expect(screen.getByText(/still yours to map by hand/)).toBeDefined();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    /* And the drawing controls are untouched. */
    expect(screen.getByText('Undo last point')).toBeDefined();
    expect(screen.getByText('2 points marked')).toBeDefined();
  });

  it('states a failed request the same way, without pretending detection was silent', async () => {
    resolvesWith({ status: 'failed', reason: 'network', message: 'Failed to fetch' });
    await withFinishedLine();


    expect(screen.getByText(/Detection did not finish/)).toBeDefined();
    expect(screen.queryByText(/No proposals for this hole/)).toBeNull();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
  });

  /** The same proposal shape, for a kind and an id. */
  function like(id: string, kind: 'green' | 'bunker' | 'water', lng: number) {
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
    };
  }

  /** What the map is currently holding, by proposal id. */
  function statusById(): Map<string, string> {
    const collection = harness.sources.get('review-features')?.data as {
      features: Array<{ properties: Record<string, unknown> }>;
    };
    return new Map(
      collection.features
        .filter((f) => typeof f.properties.proposalId === 'string')
        .map((f) => [f.properties.proposalId as string, f.properties.status as string]),
    );
  }

  it('walks the contributor through the proposals one at a time, confirming only what they answer', async () => {
    resolvesWith({
      status: 'ok',
      jobId: '77d2',
      proposals: [like('g1', 'green', -121.946), like('b1', 'bunker', -121.9465), like('b2', 'bunker', -121.947)],
      imagery: null,
      missingTeeSets: [],
    });
    await withFinishedLine();

    /* Everything arrives as a suggestion. Nothing is confirmed by arriving. */
    expect([...statusById().values()]).toEqual(['proposed', 'proposed', 'proposed']);

    await press('Yes, that is the green');
    expect(statusById().get('g1')).toBe('confirmed');
    expect(statusById().get('b1')).toBe('proposed');

    /* The bunker step opens on the first of two, and says which. */
    expect(screen.getByText('Bunker 1 of 2 — is that sand?')).toBeDefined();

    await press('Yes, that is sand');
    /* One confirmation, one feature: the second bunker is still being asked about. */
    expect(statusById().get('b1')).toBe('confirmed');
    expect(statusById().get('b2')).toBe('proposed');
    expect(screen.getByText('Bunker 2 of 2 — is that sand?')).toBeDefined();

    await press('That is not sand');
    /* Rejected: off the map, and recorded rather than dropped. */
    expect(statusById().has('b2')).toBe(false);
    expect(screen.getByText(/1 turned down on this hole/)).toBeDefined();
    expect(recordMock).toHaveBeenCalledTimes(3);
    expect(recordMock.mock.calls[2][2][0].outcome).toBe('rejected');
  });

  it('keeps a step with nothing proposed, with its add action live', async () => {
    resolvesWith({
      status: 'ok',
      jobId: '77d2',
      proposals: [like('g1', 'green', -121.946)],
      imagery: null,
      missingTeeSets: [],
    });
    await withFinishedLine();
    await press('Yes, that is the green');

    /* No bunkers came back. The step is shown anyway, saying so, with the
     * "we missed one" route still open — silence and absence are not the same. */
    expect(screen.getByText('No bunkers proposed on this hole.')).toBeDefined();
    expect(screen.getByText('There are no bunkers here')).toBeDefined();
    await press('There is another bunker');
    expect(screen.getByText('Click the map where the bunker is.')).toBeDefined();
  });

  it('marks a proposed water body a hazard only on an explicit in-play answer (R14)', async () => {
    resolvesWith({
      status: 'ok',
      jobId: '77d2',
      proposals: [like('w1', 'water', -121.946), like('w2', 'water', -121.9465)],
      imagery: null,
      missingTeeSets: [],
    });
    await withFinishedLine();

    /* Straight to the water step: nothing else was proposed. */
    await press('Nothing to confirm — carry on');
    await press('There are no bunkers here');
    await press('Leave the tees for now');
    await press('No fairway to confirm');

    expect(screen.getByText('Water 1 of 2 — can a ball find it?')).toBeDefined();
    const hazardOf = (id: string) => {
      const collection = harness.sources.get('review-features')?.data as {
        features: Array<{ properties: Record<string, unknown> }>;
      };
      return collection.features.find((f) => f.properties.proposalId === id)?.properties.hazard;
    };
    /* Proposed water is water on the imagery, not a hazard on the map. */
    expect(hazardOf('w1')).toBe(false);

    await press('It is water, but out of play');
    /* Confirmed as water, and still not a hazard — the answer was no. */
    expect(statusById().get('w1')).toBe('confirmed');
    expect(hazardOf('w1')).toBe(false);

    await press('Yes — it is in play');
    expect(statusById().get('w2')).toBe('confirmed');
    expect(hazardOf('w2')).toBe(true);
  });

  it('cancels the working state, aborting the request and returning the hole to hand-mapping', async () => {
    let seen: AbortSignal | undefined;
    /* Never resolves on its own: the only way out of this one is the cancel. */
    detectMock.mockImplementation((_request: unknown, options: { signal?: AbortSignal }) => {
      seen = options.signal;
      return new Promise<DetectResult>(() => {});
    });
    await withFinishedLine();

    expect(screen.getByText(/Reading the imagery for hole 1/)).toBeDefined();
    expect(seen?.aborted).toBe(false);

    await press('cancel and map it myself');

    expect(seen?.aborted).toBe(true);
    expect(screen.queryByText(/Reading the imagery for hole 1/)).toBeNull();
    expect(screen.getByText(ASK)).toBeDefined();
    expect(screen.getByText(HAND_MAPPABLE)).toBeDefined();
    expect(screen.getByText('Stopped looking. The hole is yours to map by hand.')).toBeDefined();
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
      teeSet: null,
      acquired: '2023-07-04',
      gsdMeters: 0.6,
      source: 'USDA NAIP via Microsoft Planetary Computer',
      modelId: 'sam2',
      itemId: 'ca_m_3612_2023',
      ...overrides,
    };
  }

  /** Draw, finish, ask, and land one proposal with the given corridor imagery. */
  async function withProposals(
    imagery: unknown,
    options: { now?: Date; proposals?: unknown[] } = {},
  ) {
    detectMock.mockResolvedValue({
      status: 'ok',
      jobId: '77d2',
      proposals: options.proposals ?? [proposal()],
      imagery,
      missingTeeSets: [],
    } as unknown as DetectResult);
    const view = await mount(options.now);
    await clickAt(-121_949, 36_569);
    await clickAt(-121_946, 36_570);
    await press('Finish the line');
    return view;
  }

  it("renders the proposal's confidence and the NAIP acquisition year in the rail", async () => {
    await withProposals(COG_IMAGERY, { now: new Date('2024-01-01T00:00:00Z') });

    expect(screen.getByText('Is that the green?')).toBeDefined();
    /* Always there, not only when something is wrong: 2023 is inside the
     * three-year window, so this render carries no warning at all. */
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

  it('puts a confidence beside every proposal queued in the step, not just the active one', async () => {
    await withProposals(COG_IMAGERY, {
      now: new Date('2024-01-01T00:00:00Z'),
      proposals: [
        proposal({ id: 'b1', kind: 'bunker', confidence: 0.91 }),
        proposal({ id: 'b2', kind: 'bunker', confidence: 0.42 }),
      ],
    });
    await press('Nothing to confirm — carry on');

    expect(screen.getByText('Bunker 1 of 2 — is that sand?')).toBeDefined();
    expect(screen.getByText('bunker 1 — asking now')).toBeDefined();
    expect(screen.getByText('bunker 2')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
  });
});
