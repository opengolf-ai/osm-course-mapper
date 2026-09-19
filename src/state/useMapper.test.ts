/**
 * @vitest-environment jsdom
 *
 * The playing line is the only path in the app that produces real geometry, so
 * this is where the measurement is pinned down.
 *
 * The dogleg fixture is not invented: it is OpenStreetMap way 671717506, Pebble
 * Beach hole 1, three nodes, carded at 380 yards. Measured along its path it is
 * 382.40 yards; measured as a straight tee-to-green chord it is 363.32. Those two
 * numbers are the whole reason KTD7 exists, so they are asserted directly.
 *
 * After the line, the hole is reviewed one step at a time — tees off the card,
 * the green, the fairway, the sand, anything else — and then saved to our own
 * store. Every step's question is templated off the shapes actually on the
 * hole, so the copy is asserted here as well as the state.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import {
  labelPoint,
  lineYards,
  openRing,
  outlinePolygon,
  pointInRing,
  yardsBetween,
  type LngLat,
} from '../geo/coords';
import type { CourseDetail } from '../api/types';
import type { OsmHoleFeature, OsmLookup } from '../api/overpass';
import type { SavedFeature, SavedHole } from '../api/holes';
import type { DetectResult, Proposal, ProposalKind, TeeSetRef } from '../api/detect';

/**
 * Detection is stubbed at the client boundary, with every request left hanging
 * until a test resolves it by hand. That is the only way to say *when* an answer
 * lands, and "after the contributor gave up on it" is the case that matters.
 *
 * `recordDecisions`, `saveHole` and `saveBoundary` stay real: what they post is
 * asserted below against a stubbed `fetch`.
 */
const detection = vi.hoisted(() => {
  const pending: Array<(result: DetectResult) => void> = [];
  return {
    pending,
    request: vi.fn(
      (..._args: unknown[]) =>
        new Promise<DetectResult>((resolve) => {
          pending.push(resolve);
        }),
    ),
  };
});
vi.mock('../api/detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/detect')>();
  return { ...actual, requestProposals: detection.request };
});

import { STEPS, type StepId } from '../data/course';
import { buildCourseSession, teeSetsFor } from './courseSession';
import {
  INITIAL,
  LOCATE_CHECK_YOUR_WORK,
  LOCATE_CLOSE_ENOUGH,
  YARDAGE_TOLERANCE_FRACTION,
  computeDerived,
  guessTeeBoxes,
  holeToSave,
  nextHoleIndex,
  reviewShapes,
  savedShapes,
  shapesFromProposals,
  useMapper,
  type HoleShape,
  type MapperState,
} from './useMapper';

/* Pebble Beach hole 1, OSM way 671717506: tee, the corner, the green. */
const PEBBLE_TEE: LngLat = [-121.9495343, 36.5693904];
const PEBBLE_TURN: LngLat = [-121.9477382, 36.5705598];
const PEBBLE_GREEN: LngLat = [-121.9461359, 36.5706059];
const PEBBLE_LINE: LngLat[] = [PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN];

/** Yardages for the three holes the fixtures below use, per tee colour. */
const CARD: Array<{ number: number; par: number; blue: number; red: number }> = [
  { number: 1, par: 4, blue: 380, red: 310 },
  /* A par 5 and a par 3, so a fixed tolerance and a proportional one disagree. */
  { number: 2, par: 5, blue: 543, red: 470 },
  { number: 3, par: 3, blue: 106, red: 92 },
];

function detail(): CourseDetail {
  return {
    id: 'pebble',
    course_name: 'Pebble Beach Golf Links',
    latitude: 36.5685,
    longitude: -121.949,
    par: 72,
    holes: 3,
    tees: [
      { tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', yardage: 1029 },
      { tee_key: 'red-female', tee_name: 'Red', tee_color: 'red', yardage: 872 },
    ],
    holes_data: CARD.map((hole) => ({
      number: hole.number,
      par: hole.par,
      handicap_index: hole.number,
      yardages: { blue: hole.blue, red: hole.red },
    })),
  };
}

const SESSION = buildCourseSession(detail());

function stateWith(overrides: Partial<MapperState>): MapperState {
  return {
    ...INITIAL,
    screen: 'review',
    mode: 'locate',
    course: SESSION,
    teeSet: 'blue',
    ...overrides,
  };
}

function drawn(points: LngLat[], overrides: Partial<MapperState> = {}) {
  return computeDerived(
    stateWith({ locate: { points, finished: true, source: 'drawn' as const, edited: false }, ...overrides }),
  );
}

/**
 * A due-north line of a given length. Turf measures on a sphere of radius
 * 6371008.8 m, so a degree of latitude is 111,194.9 m — close enough that the
 * built line lands inside a yard of what was asked for.
 */
const METRES_PER_DEGREE = (Math.PI * 6371008.8) / 180;
function lineOf(yards: number, from: LngLat = [-121.95, 36.57]): LngLat[] {
  return [from, [from[0], from[1] + (yards * 0.9144) / METRES_PER_DEGREE]];
}

/**
 * The point on hole 1's first leg that is `yards` from the green, measured
 * along the line — where a tee set carded at that length would stand.
 */
function onFirstLegAt(yards: number): LngLat {
  const fromTee = lineYards(PEBBLE_LINE) - yards;
  const f = fromTee / lineYards([PEBBLE_TEE, PEBBLE_TURN]);
  return [PEBBLE_TEE[0] + (PEBBLE_TURN[0] - PEBBLE_TEE[0]) * f, PEBBLE_TEE[1] + (PEBBLE_TURN[1] - PEBBLE_TEE[1]) * f];
}

/** A small closed square around a point: about ten yards either side of it. */
function squareAround([lng, lat]: LngLat, half = 0.00008): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - half, lat - half],
        [lng + half, lat - half],
        [lng + half, lat + half],
        [lng - half, lat + half],
        [lng - half, lat - half],
      ],
    ],
  };
}

/** A proposal as the client hands it over, with full provenance unless told otherwise. */
function proposal(id: string, kind: ProposalKind, at: LngLat, teeSet: TeeSetRef | null = null): Proposal {
  return {
    id,
    kind,
    geometry: squareAround(at),
    confidence: 0.82,
    areaSquareMeters: 640,
    vertexCount: 5,
    notes: [],
    teeSet,
    acquired: '2023-07-04',
    gsdMeters: 0.6,
    source: 'USDA NAIP via Microsoft Planetary Computer',
    modelId: 'facebook/sam2-hiera-large',
    itemId: 'ca_m_3812_2023',
  };
}

/* Where things sit on hole 1. Far enough apart that no two squares overlap. */
const AT = {
  backTee: PEBBLE_TEE,
  redTee: onFirstLegAt(310),
  /* A tee 200 yards out: no card set on hole 1 plays that length. */
  strayTee: onFirstLegAt(200),
  green: PEBBLE_GREEN,
  /* The green of the hole next door, inside the corridor detection read. */
  nextGreen: [-121.9452, 36.5716] as LngLat,
  fairway: PEBBLE_TURN,
  bunker1: [-121.947, 36.5712] as LngLat,
  bunker2: [-121.9466, 36.5701] as LngLat,
  bunker3: [-121.9486, 36.5705] as LngLat,
  water: [-121.9481, 36.5714] as LngLat,
  /* Nothing here: a click on open ground. */
  openGround: [-121.9452, 36.5694] as LngLat,
};

const stepIndex = (id: StepId) => STEPS.findIndex((step) => step.id === id);

/* --- The stubbed network ---------------------------------------------------- */

/** What the store answers to a hole save. Tests set it; the default echoes the hole back. */
let holeAnswer: (body: Record<string, unknown>) => { status: number; body: unknown };

function echoSavedHole(body: Record<string, unknown>) {
  return { status: 200, body: { status: 'ok', hole: { ...body, saved_at: '2026-09-19T10:00:00Z' } } };
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const answer = String(url).includes('/v1/holes')
        ? holeAnswer(body)
        : String(url).includes('/boundary')
          ? { status: 200, body: { status: 'ok', boundary: { course_id: 'pebble', ...body, saved_at: '2026-09-19T10:00:00Z' } } }
          : { status: 200, body: { status: 'ok' } };
      return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
    }),
  );
}

type FetchCall = [string, { body: string }];
const fetchCalls = () => (globalThis.fetch as unknown as { mock: { calls: FetchCall[] } }).mock.calls;

/** Every decision posted to the store, flattened across calls. */
function postedDecisions(): Array<Record<string, unknown> & { geometry: Polygon }> {
  return fetchCalls()
    .filter(([url]) => String(url).includes('/v1/decisions'))
    .flatMap(([, init]) => JSON.parse(init.body).decisions);
}

/** Which proposal a posted decision is about, recovered from its geometry. */
function decisionFor(proposals: Proposal[], decision: { geometry: Polygon }) {
  return proposals.find((p) => JSON.stringify(p.geometry) === JSON.stringify(decision.geometry))?.id;
}

/** Let every promise chain in flight settle — a store answer is several hops deep. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  detection.pending.length = 0;
  detection.request.mockClear();
  holeAnswer = echoSavedHole;
  /* No service in a unit test: decisions and saves post into a stub and nothing waits. */
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* --- Opening a course and a hole -------------------------------------------- */

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useMapper>, unknown>>;

function openedOnHole(holeIndex = 0, osm: OsmLookup = { status: 'absent' }): Hook {
  const hook = renderHook(() => useMapper());
  act(() => hook.result.current.actions.openCourse(SESSION, osm));
  act(() => hook.result.current.actions.openHole(holeIndex));
  return hook;
}

/**
 * The hook on a hole whose line was drawn, confirmed, and answered by detection
 * with these proposals — the real path, so the answer goes through
 * `shapesFromProposals` and `guessTeeBoxes` exactly as it does in the app.
 */
async function openedWith(proposals: Proposal[], holeIndex = 0): Promise<Hook> {
  const hook = openedOnHole(holeIndex);
  for (const point of PEBBLE_LINE) act(() => hook.result.current.actions.onMapClick(point));
  act(() => hook.result.current.actions.confirmLine());
  expect(detection.pending).toHaveLength(1);
  await act(async () => {
    detection.pending[0]({ status: 'ok', jobId: 'job-1', proposals, imagery: null, missingTeeSets: [] });
  });
  expect(hook.result.current.state.mode).toBe('ready');
  return hook;
}

/** Say yes to every question until the named step is on screen. */
function acceptUntil(hook: Hook, id: StepId) {
  for (let guard = 0; guard < 20 && STEPS[hook.result.current.state.step]?.id !== id; guard += 1) {
    act(() => hook.result.current.actions.accept());
  }
  expect(STEPS[hook.result.current.state.step]?.id).toBe(id);
}

const shapeById = (hook: Hook, id: string) => hook.result.current.state.shapes.find((shape) => shape.id === id);

/** A lookup that holds hole 1 — its line, and whatever is outlined on it. */
function osmHolding(features: OsmHoleFeature[] = []): OsmLookup {
  return {
    status: 'found',
    course: {
      osmId: 'relation/3741806',
      name: 'Pebble Beach Golf Links',
      boundary: { type: 'Polygon', coordinates: [[[-121.95, 36.56], [-121.94, 36.56], [-121.94, 36.57], [-121.95, 36.56]]] },
      acres: 176,
      bbox: [-121.95, 36.56, -121.94, 36.57],
      /* Hole 1 is already on the map, so its status is `complete`. */
      mappedHoleRefs: [1],
      holes: [
        {
          osmId: 'way/671717506',
          ref: 1,
          nine: null,
          osmRef: '1',
          par: 4,
          line: { type: 'LineString', coordinates: PEBBLE_LINE },
          features,
        },
      ],
      landmarks: [],
      matchedBy: 'name',
    },
  };
}

/** A green, as OSM holds it: a small square by the end of hole 1's line. */
function osmGreen(): OsmHoleFeature {
  return { id: 'way/820001', kind: 'green', tag: 'green', name: null, geometry: squareAround(PEBBLE_GREEN, 0.00015) };
}

describe('the drawn playing line', () => {
  it('measures a dogleg along its path, longer than its chord and inside the card tolerance', () => {
    const derived = drawn(PEBBLE_LINE);

    const chord = yardsBetween(PEBBLE_TEE, PEBBLE_GREEN);
    expect(Math.round(chord)).toBe(363);
    expect(derived.locateYds).toBe(382);
    expect(derived.locateYds).toBeGreaterThan(chord);

    expect(derived.cardYds).toBe(380);
    expect(derived.locateWithinTolerance).toBe(true);
    expect(derived.locateVerdict).toBe(LOCATE_CLOSE_ENOUGH);
  });

  it('stores the line as an ordered WGS84 LineString, the geometry OSM holds for golf=hole', () => {
    const derived = drawn(PEBBLE_LINE);

    expect(derived.locateLine).toEqual({ type: 'LineString', coordinates: PEBBLE_LINE });
    const hole = derived.features.find((f) => f.properties.kind === 'hole');
    expect(hole?.geometry.type).toBe('LineString');
  });

  it('tells a contributor to check their work when a straight line falls short of the card', () => {
    /* Tee to the corner and stop: the shape of the mistake this catches. */
    const derived = drawn([PEBBLE_TEE, PEBBLE_TURN]);

    expect(derived.locateYds).toBeLessThan(derived.cardYds ?? 0);
    expect(derived.locateWithinTolerance).toBe(false);
    expect(derived.locateVerdict).toBe(LOCATE_CHECK_YOUR_WORK);
  });

  it('scales tolerance to the tee set, so one absolute error passes a par 5 and fails a par 3', () => {
    const par5 = drawn(lineOf(543 - 30), { holeIndex: 1 });
    const par3 = drawn(lineOf(106 + 30), { holeIndex: 2 });

    expect(par5.cardYds).toBe(543);
    expect(par3.cardYds).toBe(106);
    expect(Math.abs(par5.locateOff - 30)).toBeLessThan(1);
    expect(Math.abs(par3.locateOff - 30)).toBeLessThan(1);

    expect(par5.locateTolerance).toBeCloseTo(543 * YARDAGE_TOLERANCE_FRACTION, 6);
    expect(par3.locateTolerance).toBeCloseTo(106 * YARDAGE_TOLERANCE_FRACTION, 6);
    expect(par5.locateWithinTolerance).toBe(true);
    expect(par3.locateWithinTolerance).toBe(false);
  });

  it('measures against the tee set the contributor started from, not a fixed tee (R15)', () => {
    const fromBlue = drawn(PEBBLE_LINE, { teeSet: 'blue' });
    const fromRed = drawn(PEBBLE_LINE, { teeSet: 'red' });

    expect(fromBlue.cardYds).toBe(380);
    expect(fromRed.cardYds).toBe(310);
    expect(fromBlue.locateTolerance).not.toBe(fromRed.locateTolerance);
    /* The same 382-yard line: fine off the blues, long off the reds. */
    expect(fromBlue.locateWithinTolerance).toBe(true);
    expect(fromRed.locateWithinTolerance).toBe(false);
  });
});

describe('drawing the line, and the line OpenStreetMap already holds', () => {
  it('opens a hole OpenStreetMap already holds on its line and outlines, asking about the line first', () => {
    /*
     * The lookup carries geometry, not only hole numbers, so a mapped hole opens
     * showing what is there rather than an empty frame over the course. But the
     * line is not taken as read: the flow asks "does the hole run this way?"
     * about OSM's line exactly as it does about a drawn one.
     */
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding([osmGreen()])));
    expect(hook.result.current.state.holeStatus[0]).toBe('complete');

    act(() => hook.result.current.actions.openHole(0));

    const { state, derived } = hook.result.current;
    expect(state.mode).toBe('locate');
    expect(state.locate).toEqual({ points: PEBBLE_LINE, finished: false, source: 'osm', edited: false });
    expect(state.osmHoleId).toBe('way/671717506');
    expect(derived.canConfirmLine).toBe(true);
    /* Nothing is asked of detection until the line is confirmed. */
    expect(derived.canRequestProposals).toBe(false);
    expect(detection.request).not.toHaveBeenCalled();
    expect(state.existing.map((f) => f.id)).toEqual(['way/820001']);
    expect(state.lastAction).toMatch(/OpenStreetMap already holds this hole/);
    /* And nothing is being reviewed, so no empty question is asked. */
    expect(derived.proposals).toEqual([]);
    expect(derived.question).toBeNull();
  });

  it('carries what OpenStreetMap calls the hole when that is not the card number', () => {
    /*
     * A club that plays three nines as three eighteens files the contributor's
     * hole 10 as somebody's 1st. The screen quotes the OSM name so the two read
     * as the same hole rather than as a mistake.
     */
    const lookup = osmHolding();
    if (lookup.status !== 'found') throw new Error('expected a lookup');
    lookup.course.holes[0] = { ...lookup.course.holes[0], nine: 'Lakes', osmRef: 'Lakes #1' };

    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, lookup));
    act(() => hook.result.current.actions.openHole(0));

    expect(hook.result.current.derived.osmHoleRef).toBe('Lakes #1');

    /* A plain eighteen says nothing: "hole 1, which OSM calls 1" is noise. */
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding()));
    act(() => hook.result.current.actions.openHole(0));
    expect(hook.result.current.derived.osmHoleRef).toBeNull();
  });

  it('never draws what OpenStreetMap holds as though the contributor confirmed it', () => {
    /* R8: `confirmed` is reserved for what a human said yes to, and nobody has
     * been asked about a shape that was already in the map. */
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));

    const statuses = result.current.derived.features.map((f) => f.properties.status);
    expect(statuses).not.toContain('confirmed');
    expect(new Set(statuses)).toEqual(new Set(['existing']));
    expect(result.current.derived.lineFromOsm).toBe(true);
  });

  it('makes OpenStreetMap’s line the contributor’s once they drag it, and draws it as theirs', () => {
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));
    const moved: LngLat[] = [PEBBLE_TEE, [PEBBLE_TURN[0], PEBBLE_TURN[1] + 0.0001], PEBBLE_GREEN];

    act(() => result.current.actions.moveLine(moved));

    expect(result.current.state.locate).toEqual({ points: moved, finished: false, source: 'osm', edited: true });
    expect(result.current.derived.lineFromOsm).toBe(false);
    const line = result.current.derived.features.find((f) => f.properties.label === 'playing line');
    expect(line?.properties.status).toBe('active');
    /* And it is saved as OSM's line edited, not as OSM's line or a drawn one. */
    expect(holeToSave(result.current.state)?.lineSource).toBe('osm_edited');
  });

  it('never marks a drawn line edited by dragging it — `edited` is about OpenStreetMap’s line', () => {
    const { result } = openedOnHole(0);
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));
    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));

    act(() => result.current.actions.moveLine([PEBBLE_TEE, PEBBLE_TURN]));

    expect(result.current.state.locate).toEqual({
      points: [PEBBLE_TEE, PEBBLE_TURN],
      finished: false,
      source: 'drawn',
      edited: false,
    });
  });

  it('does not extend OpenStreetMap’s line past its green on a click — its handles reshape it', () => {
    const { result } = openedOnHole(0, osmHolding());

    act(() => result.current.actions.onMapClick(AT.openGround));

    expect(result.current.state.locate.points).toEqual(PEBBLE_LINE);
  });

  it('frames a mapped hole on its own line rather than on the whole course', () => {
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));

    const bounds = result.current.derived.mapBounds;
    if (!bounds) throw new Error('expected an extent');
    const [west, south, east, north] = bounds;
    /* A frame on the hole, not on the course: the line spans 0.0034 degrees of
     * longitude, and the course bbox this would otherwise have used spans 0.01
     * by 0.01. */
    expect(east - west).toBeLessThan(0.006);
    expect(north - south).toBeLessThan(0.006);
    /* And it holds every point of the line it is framing. */
    for (const [lng, lat] of PEBBLE_LINE) {
      expect(lng).toBeGreaterThan(west);
      expect(lng).toBeLessThan(east);
      expect(lat).toBeGreaterThan(south);
      expect(lat).toBeLessThan(north);
    }
  });

  it('opens a hole OpenStreetMap does not hold exactly as before: empty, on the course', () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding()));

    /* Hole 2 is not one of the holes the lookup carried. */
    act(() => hook.result.current.actions.openHole(1));

    expect(hook.result.current.state.locate).toEqual({ points: [], finished: false, source: 'drawn', edited: false });
    expect(hook.result.current.state.existing).toEqual([]);
    expect(hook.result.current.state.osmHoleId).toBeNull();
    expect(hook.result.current.derived.mapBounds).toEqual([-121.95, 36.56, -121.94, 36.57]);
  });

  it('hands the line to the contributor the moment they take a point off it', () => {
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));

    act(() => result.current.actions.undoLastPoint());

    expect(result.current.state.locate).toEqual({
      points: [PEBBLE_TEE, PEBBLE_TURN],
      finished: false,
      source: 'drawn',
      edited: false,
    });
  });

  it('keeps what OpenStreetMap outlines when the contributor starts the line again', () => {
    /* The green is not a draft of theirs to throw away — and they are about to
     * draw a line past it. */
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));

    act(() => result.current.actions.resetLocate());

    expect(result.current.state.locate).toEqual({ points: [], finished: false, source: 'drawn', edited: false });
    expect(result.current.state.existing.map((f) => f.id)).toEqual(['way/820001']);
  });

  it('leaves one hole’s outlines behind when another is opened', () => {
    const { result } = openedOnHole(0, osmHolding([osmGreen()]));
    expect(result.current.state.existing).toHaveLength(1);

    act(() => result.current.actions.openHole(1));

    expect(result.current.state.existing).toEqual([]);
  });

  it('places tee, turn points and green in the order they are clicked', () => {
    const { result } = openedOnHole(0);
    expect(result.current.state.mode).toBe('locate');

    for (const point of PEBBLE_LINE) act(() => result.current.actions.onMapClick(point));

    expect(result.current.state.locate.points).toEqual(PEBBLE_LINE);
    expect(result.current.state.locate.source).toBe('drawn');
    expect(result.current.derived.locateYds).toBe(382);
  });

  it('undoes the last placed point and restores the measurement before it', () => {
    const { result } = openedOnHole(0);
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));
    act(() => result.current.actions.onMapClick(PEBBLE_TURN));
    const twoPoints = result.current.derived.locateYds;

    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));
    expect(result.current.derived.locateYds).not.toBe(twoPoints);

    act(() => result.current.actions.undoLastPoint());
    expect(result.current.state.locate.points).toEqual([PEBBLE_TEE, PEBBLE_TURN]);
    expect(result.current.derived.locateYds).toBe(twoPoints);
    expect(twoPoints).toBe(Math.round(lineYards([PEBBLE_TEE, PEBBLE_TURN])));
  });

  it('refuses to confirm a line of fewer than two points, and asks detection nothing', () => {
    const { result } = openedOnHole(0);
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));

    expect(result.current.derived.canConfirmLine).toBe(false);
    act(() => result.current.actions.confirmLine());
    expect(result.current.state.locate.finished).toBe(false);
    expect(result.current.derived.locateDone).toBe(false);
    expect(detection.request).not.toHaveBeenCalled();

    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));
    expect(result.current.derived.canConfirmLine).toBe(true);
    act(() => result.current.actions.confirmLine());
    expect(result.current.derived.locateDone).toBe(true);
    expect(result.current.derived.canConfirmLine).toBe(false);
  });

  it('asks detection about the confirmed line with the par and every card tee set, once', () => {
    /* Confirming the line *is* the request — a second button would ask the
     * contributor to state the same intent twice. */
    const { result } = openedOnHole(0);
    for (const point of PEBBLE_LINE) act(() => result.current.actions.onMapClick(point));

    act(() => result.current.actions.confirmLine());

    expect(result.current.state.detect.status).toBe('working');
    expect(detection.request).toHaveBeenCalledTimes(1);
    expect(detection.request.mock.calls[0][0]).toEqual({
      line: PEBBLE_LINE,
      par: 4,
      teeSets: [
        { name: 'Blue', key: 'blue', yards: 380 },
        { name: 'Red', key: 'red', yards: 310 },
      ],
    });

    /* A locked line takes no more points and no more drags. */
    act(() => result.current.actions.onMapClick(AT.openGround));
    act(() => result.current.actions.moveLine([PEBBLE_TEE, PEBBLE_GREEN]));
    act(() => result.current.actions.confirmLine());
    expect(result.current.state.locate.points).toEqual(PEBBLE_LINE);
    expect(detection.request).toHaveBeenCalledTimes(1);
  });

  it('opens the review on the tee step once detection answers, every proposal a shape to check', async () => {
    const proposals = [
      proposal('p-tee', 'tee', AT.backTee),
      proposal('p-green', 'green', AT.green),
      proposal('p-water', 'water', AT.water),
    ];
    const { result } = await openedWith(proposals);

    expect(result.current.state.step).toBe(stepIndex('tees'));
    expect(result.current.state.teeIndex).toBe(0);
    expect(result.current.state.detect.status).toBe('ready');
    expect(result.current.state.shapes.map((s) => [s.id, s.kind, s.hazardType])).toEqual([
      ['p-tee', 'tee', null],
      ['p-green', 'green', null],
      /* Water is a hazard of type water: whether it is in play is the hazard step's question. */
      ['p-water', 'hazard', 'water'],
    ]);
    /* "To check with you", never "found": nothing is settled until answered (R7). */
    expect(result.current.state.lastAction).toMatch(/3 shapes to check with you/);
    expect(result.current.state.shapes.every((s) => !s.confirmed && !s.removed)).toBe(true);
  });

  it('lets the contributor carry on by hand after detection fails, with every step theirs to draw', async () => {
    const { result } = openedOnHole(0);
    for (const point of PEBBLE_LINE) act(() => result.current.actions.onMapClick(point));
    act(() => result.current.actions.confirmLine());
    await act(async () => {
      detection.pending[0]({ status: 'failed', reason: 'network', message: 'could not reach it' });
    });
    expect(result.current.state.detect).toEqual({ status: 'failed', message: 'could not reach it' });
    expect(result.current.state.mode).toBe('locate');

    act(() => result.current.actions.confirmLocate());

    expect(result.current.state.mode).toBe('ready');
    expect(result.current.state.step).toBe(0);
    expect(result.current.state.shapes).toEqual([]);
    expect(result.current.state.locate.finished).toBe(true);
    expect(result.current.derived.question?.title).toBe('Where does the blue tee play from?');
  });
});

describe('the keyboard', () => {
  it('keeps the A / N / M shortcuts inert while the line is being drawn', () => {
    const { result } = openedOnHole(0);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });

    expect(result.current.state.step).toBe(0);
    expect(result.current.state.teeIndex).toBe(0);
    expect(result.current.state.teeBoxes).toEqual({});
    expect(result.current.state.interaction).toEqual({ kind: 'none' });

    /* Out of the line flow, the same key answers the question on screen: no box
     * for the blue tee, so "a" says there is no blue tee and moves to the red. */
    act(() => result.current.actions.patch({ mode: 'ready' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.state.teeBoxes).toEqual({ blue: null });
    expect(result.current.state.teeIndex).toBe(1);
  });

  it('confirms nothing while the A key auto-repeats under a held finger', async () => {
    const proposals = [proposal('p-b1', 'bunker', AT.bunker1), proposal('p-b2', 'bunker', AT.bunker2)];
    const hook = await openedWith(proposals);
    const { result } = hook;
    acceptUntil(hook, 'bunkers');
    fetchCalls().length = 0;

    /* What the OS sends while `a` is held down. Without the repeat guard this
     * would confirm the sand, then the hazards, and post every decision. */
    act(() => {
      for (let repeat = 0; repeat < 6; repeat += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true }));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', repeat: true }));
    });

    expect(result.current.state.step).toBe(stepIndex('bunkers'));
    expect(result.current.state.interaction).toEqual({ kind: 'none' });
    expect(result.current.state.shapes.some((s) => s.confirmed || s.removed)).toBe(false);
    /* Nothing reached the decision store either — a held key is not a decision. */
    expect(fetchCalls()).toHaveLength(0);

    /* A deliberate press still answers the question on screen, once. */
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.state.step).toBe(stepIndex('hazards'));
    expect(postedDecisions().map((d) => decisionFor(proposals, d))).toEqual(['p-b1', 'p-b2']);
  });

  it('drives N and M off the step: N picks the one to drop, M drops a new one', async () => {
    const hook = await openedWith([proposal('p-b1', 'bunker', AT.bunker1)]);
    acceptUntil(hook, 'bunkers');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
    });
    expect(hook.result.current.state.interaction).toEqual({ kind: 'pick', purpose: 'remove' });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });
    expect(hook.result.current.state.interaction).toEqual({ kind: 'place', shape: 'bunker', forTee: null, replacing: false });
  });
});

describe('the tee step, one card set at a time', () => {
  it('walks the card’s tee sets longest first', () => {
    expect(teeSetsFor(SESSION, 0).map((tee) => [tee.key, tee.yards])).toEqual([
      ['blue', 380],
      ['red', 310],
    ]);
  });

  it('opens each set on the box detection matched to it, whatever its yardage', async () => {
    /* The service matched this mask to the reds. It stands 200 yards out, which
     * is nothing like the card's 310 — detection's own match still wins. */
    const red: TeeSetRef = { name: 'Red', key: 'red', yards: 310 };
    const { result } = await openedWith([proposal('p-tee-red', 'tee', AT.strayTee, red)]);

    expect(result.current.state.teeBoxes).toEqual({ red: 'p-tee-red' });
  });

  it('guesses a box for a set when it stands within reach of the card yardage along the line', async () => {
    const { result } = await openedWith([
      proposal('p-tee-back', 'tee', AT.backTee),
      proposal('p-tee-310', 'tee', AT.redTee),
      proposal('p-tee-stray', 'tee', AT.strayTee),
    ]);

    /* The box at the start of the line measures 382 along it — the blues' 380.
     * The one 310 out is the reds'. The stray is nobody's. */
    expect(result.current.state.teeBoxes).toEqual({ blue: 'p-tee-back', red: 'p-tee-310' });
  });

  it('takes the box at the start of the line for the back tee when no yardage fits', async () => {
    /* Hole 2 is carded at 543 off the blues, and this line is 382: nothing fits
     * by length. But the contributor was asked to start the line on the
     * furthest-back tee, so the box under its first point is the blues'. */
    const { result } = await openedWith([proposal('p-tee-back', 'tee', AT.backTee)], 1);

    expect(result.current.state.teeBoxes).toEqual({ blue: 'p-tee-back' });
    /* Only the longest set gets that rule: the reds are left to the contributor. */
    act(() => result.current.actions.accept());
    expect(result.current.derived.question?.title).toBe('Where does the red tee play from?');
  });

  it('asks about the highlighted box for each set, and confirms it on yes', async () => {
    const proposals = [proposal('p-tee-back', 'tee', AT.backTee), proposal('p-tee-310', 'tee', AT.redTee)];
    const { result } = await openedWith(proposals);

    const blue = result.current.derived.question;
    expect(blue).toMatchObject({
      kicker: 'Tee 1 of 2 · Blue',
      title: 'Is that where the blue tee plays from?',
      accept: 'Yes, that is the blue tee',
      acceptDisabled: false,
    });
    expect(blue?.actions.map((a) => [a.id, a.label])).toEqual([
      ['pick-tee', 'Pick a different box'],
      ['edit', 'Edges look off'],
      ['no-tee', 'No blue tee here'],
    ]);
    expect(result.current.derived.activeShapeIds).toEqual(['p-tee-back']);

    act(() => result.current.actions.accept());

    expect(shapeById({ result } as Hook, 'p-tee-back')?.confirmed).toBe(true);
    /* Only that box: the reds' is still a question. */
    expect(shapeById({ result } as Hook, 'p-tee-310')?.confirmed).toBe(false);
    expect(result.current.state.teeIndex).toBe(1);
    expect(result.current.state.step).toBe(stepIndex('tees'));
    expect(result.current.derived.question?.kicker).toBe('Tee 2 of 2 · Red');
    expect(result.current.derived.activeShapeIds).toEqual(['p-tee-310']);

    act(() => result.current.actions.accept());
    expect(shapeById({ result } as Hook, 'p-tee-310')?.confirmed).toBe(true);
    expect(result.current.state.step).toBe(stepIndex('green'));
    expect(result.current.state.teeIndex).toBe(0);
  });

  it('asks where a set plays from when no box is guessed, and records “no such tee” as an explicit answer', async () => {
    const { result } = await openedWith([proposal('p-tee-back', 'tee', AT.backTee)]);
    act(() => result.current.actions.accept());

    const red = result.current.derived.question;
    expect(red).toMatchObject({
      title: 'Where does the red tee play from?',
      accept: 'No red tee on this hole',
      note: 'Click the box on the map. Click open ground instead and you can draw one.',
    });
    expect(red?.actions.map((a) => a.id)).toEqual(['pick-tee']);

    act(() => result.current.actions.accept());

    /* `null`, not absent: the contributor said so, which is not the same as nobody asking. */
    expect(result.current.state.teeBoxes).toHaveProperty('red', null);
    expect(result.current.state.step).toBe(stepIndex('green'));
  });

  it('says “no blue tee here” about a highlighted box without confirming or rejecting it', async () => {
    const proposals = [proposal('p-tee-back', 'tee', AT.backTee)];
    const hook = await openedWith(proposals);
    const { result } = hook;

    act(() => result.current.actions.runAction('no-tee'));

    expect(result.current.state.teeBoxes).toEqual({ blue: null });
    expect(result.current.state.teeIndex).toBe(1);
    expect(shapeById(hook, 'p-tee-back')).toMatchObject({ confirmed: false, removed: false });
    /* Not a rejection of the box: it may well be the reds'. */
    expect(postedDecisions()).toEqual([]);
  });

  it('moves a set to a different box when the contributor picks one on the map', async () => {
    const hook = await openedWith([proposal('p-tee-back', 'tee', AT.backTee), proposal('p-tee-stray', 'tee', AT.strayTee)]);
    const { result } = hook;
    expect(result.current.state.teeBoxes.blue).toBe('p-tee-back');

    act(() => result.current.actions.runAction('pick-tee'));
    expect(result.current.state.interaction).toEqual({ kind: 'pick', purpose: 'tee' });
    act(() => result.current.actions.onMapClick(AT.strayTee));

    expect(result.current.state.teeBoxes.blue).toBe('p-tee-stray');
    expect(result.current.state.interaction).toEqual({ kind: 'none' });
    /* Picking is not answering: the question is now about the other box. */
    expect(result.current.derived.question?.title).toBe('Is that where the blue tee plays from?');
    expect(result.current.derived.activeShapeIds).toEqual(['p-tee-stray']);
    expect(shapeById(hook, 'p-tee-stray')?.confirmed).toBe(false);
  });

  it('lets two sets share one box — a combo tee — and posts its decision once', async () => {
    const proposals = [proposal('p-tee-back', 'tee', AT.backTee)];
    const hook = await openedWith(proposals);
    const { result } = hook;
    act(() => result.current.actions.accept());

    act(() => result.current.actions.startPick('tee'));
    act(() => result.current.actions.onMapClick(AT.backTee));
    expect(result.current.state.teeBoxes).toEqual({ blue: 'p-tee-back', red: 'p-tee-back' });

    act(() => result.current.actions.accept());

    const label = result.current.derived.labels.find((l) => l.key === 'p-tee-back');
    expect(label?.text).toBe('blue + red tee');
    expect(postedDecisions()).toHaveLength(1);
    expect(holeToSave(result.current.state)?.features[0].teeSets.map((t) => t.key)).toEqual(['blue', 'red']);
  });

  it('drops a new box for the set on a click on open ground, and keeps it on confirm', async () => {
    const hook = await openedWith([]);
    const { result } = hook;

    act(() => result.current.actions.runAction('pick-tee'));
    act(() => result.current.actions.onMapClick(AT.openGround));

    const drawnTee = shapeById(hook, 'drawn-1');
    expect(drawnTee).toMatchObject({ kind: 'tee', origin: 'drawn', proposal: null, confirmed: false });
    /* A rough box around the click, for the contributor to pull into place. */
    expect(pointInRing(AT.openGround, drawnTee!.ring)).toBe(true);
    expect(drawnTee!.ring).toHaveLength(8);
    expect(result.current.state.teeBoxes.blue).toBe('drawn-1');
    expect(result.current.state.interaction).toEqual({ kind: 'new', shapeId: 'drawn-1' });
    expect(result.current.derived.editablePaths.map((p) => p.id)).toEqual(['drawn-1']);

    act(() => result.current.actions.confirmNew());
    expect(result.current.state.interaction).toEqual({ kind: 'none' });
    expect(result.current.state.lastAction).toBe('Drew a box for the blue tee.');

    act(() => result.current.actions.accept());
    expect(shapeById(hook, 'drawn-1')?.confirmed).toBe(true);
    /* A box the contributor drew is not a proposal: nothing to tell the decision store. */
    expect(postedDecisions()).toEqual([]);
  });

  it('stops drawing a box nobody chose once the tee step has moved on', async () => {
    /* A tee box no set plays from was passed over. Leaving it on the imagery for
     * the rest of the review would keep asking a question already answered. */
    const hook = await openedWith([proposal('p-tee-back', 'tee', AT.backTee), proposal('p-tee-stray', 'tee', AT.strayTee)]);
    const shownIds = () => hook.result.current.derived.features.map((f) => f.properties.shapeId).filter(Boolean);
    expect(shownIds()).toContain('p-tee-stray');

    acceptUntil(hook, 'green');

    expect(shownIds()).toContain('p-tee-back');
    expect(shownIds()).not.toContain('p-tee-stray');
  });
});

describe('guessTeeBoxes, on its own', () => {
  const box = (id: string, at: LngLat, teeSet: TeeSetRef | null = null): HoleShape =>
    shapesFromProposals([proposal(id, 'tee', at, teeSet)])[0];
  const sets = (...yards: number[]) =>
    yards.map((y, i) => ({ key: `set${i}`, name: `Set ${i}`, swatch: '#000', yards: y }));

  it('gives the longest set the box under the start of the line when nothing matches by length', () => {
    expect(guessTeeBoxes(sets(600, 500), [box('start', PEBBLE_TEE)], PEBBLE_LINE)).toEqual({ set0: 'start' });
  });

  it('reaches a back tee near the start of the line but not one well away from it', () => {
    /* About 30 yards north of the first point: near enough to be the back tee. */
    const near = box('near', [PEBBLE_TEE[0], PEBBLE_TEE[1] + 0.00027]);
    /* About 90 yards off: someone else's box. */
    const far = box('far', [PEBBLE_TEE[0], PEBBLE_TEE[1] - 0.0008]);

    expect(guessTeeBoxes(sets(600), [near], PEBBLE_LINE)).toEqual({ set0: 'near' });
    expect(guessTeeBoxes(sets(600), [far], PEBBLE_LINE)).toEqual({});
  });

  it('prefers the box closest to the card yardage when two are within reach', () => {
    const at320 = box('at320', onFirstLegAt(320));
    const at305 = box('at305', onFirstLegAt(305));

    expect(guessTeeBoxes(sets(310), [at320, at305], PEBBLE_LINE)).toEqual({ set0: 'at305' });
  });

  it('never guesses a box that has been removed, nor guesses at all without boxes', () => {
    const removed = { ...box('gone', PEBBLE_TEE), removed: true };
    expect(guessTeeBoxes(sets(380), [removed], PEBBLE_LINE)).toEqual({});
    expect(guessTeeBoxes(sets(380), [], PEBBLE_LINE)).toEqual({});
  });
});

describe('tee boxes OpenStreetMap already holds', () => {
  /* Hole 1 as OSM might hold it: the back box under the line's first point, one
   * at the red tee's distance, and a stray box 200 yards out nobody's card uses. */
  const osmTee = (id: string, at: LngLat): OsmHoleFeature => ({
    id,
    kind: 'tee',
    tag: 'tee',
    name: null,
    geometry: squareAround(at),
  });
  const OSM_TEES = [
    osmTee('way/900001', AT.backTee),
    osmTee('way/900002', AT.redTee),
    osmTee('way/900003', AT.strayTee),
  ];

  /** Hole 1 on OSM's line, detection answered with these proposals. */
  async function onOsmHole(proposals: Proposal[], features: OsmHoleFeature[] = OSM_TEES): Promise<Hook> {
    const hook = openedOnHole(0, osmHolding(features));
    act(() => hook.result.current.actions.confirmLine());
    await act(async () => {
      detection.pending[0]({ status: 'ok', jobId: 'job-1', proposals, imagery: null, missingTeeSets: [] });
    });
    return hook;
  }

  it('offers them as tee boxes, and guesses the card sets onto them by the same rules', async () => {
    const { result } = await onOsmHole([]);

    const tees = result.current.state.shapes.filter((shape) => shape.kind === 'tee');
    expect(tees.map((shape) => shape.osmId)).toEqual(['way/900001', 'way/900002', 'way/900003']);
    expect(tees.every((shape) => shape.origin === 'osm' && !shape.confirmed)).toBe(true);
    /* Back tee under the start of the line; red by its 310 yards along it. */
    expect(result.current.state.teeBoxes).toEqual({ blue: 'osm:way/900001', red: 'osm:way/900002' });
    expect(result.current.derived.question?.title).toBe('Is that where the blue tee plays from?');
    expect(result.current.derived.question?.note).toMatch(/already in OpenStreetMap/);
  });

  it('offers them when the hole is mapped by hand too, with nothing detected', async () => {
    const hook = openedOnHole(0, osmHolding(OSM_TEES));
    act(() => hook.result.current.actions.confirmLine());
    act(() => hook.result.current.actions.cancelProposals());
    act(() => hook.result.current.actions.confirmLocate());

    expect(hook.result.current.state.teeBoxes.blue).toBe('osm:way/900001');
    expect(hook.result.current.state.lastAction).toMatch(/OpenStreetMap already outlines 3 shapes/);
  });

  it('lets a card set be picked onto a box only OpenStreetMap holds', async () => {
    const { result } = await onOsmHole([]);
    act(() => result.current.actions.accept()); /* blue: the back box */
    expect(result.current.derived.currentTee?.key).toBe('red');

    act(() => result.current.actions.startPick('tee'));
    act(() => result.current.actions.onMapClick(AT.strayTee));

    expect(result.current.state.teeBoxes.red).toBe('osm:way/900003');
    expect(result.current.state.interaction.kind).toBe('none');
    /* Picking is not drawing: no new shape appeared. */
    expect(result.current.state.shapes.filter((shape) => shape.origin === 'drawn')).toHaveLength(0);
  });

  it('draws a picked box once, as the box under review, and hands it back to OSM once passed over', async () => {
    const hook = await onOsmHole([]);
    const { result } = hook;
    const drawnFor = (osmId: string) =>
      result.current.derived.features.filter((feature) => feature.properties.osmId === osmId || feature.properties.shapeId === `osm:${osmId}`);

    /* Under review: one feature, as the active shape rather than as OSM context. */
    expect(drawnFor('way/900001')).toHaveLength(1);
    expect(drawnFor('way/900001')[0].properties).toMatchObject({ status: 'active', shapeId: 'osm:way/900001' });
    /* Not asked about yet: still OSM's colour. */
    expect(drawnFor('way/900003')[0].properties.status).toBe('existing');

    acceptUntil(hook, 'green');
    /* The stray box was never picked: it is OSM's again, drawn as context. */
    expect(drawnFor('way/900003')).toHaveLength(1);
    expect(drawnFor('way/900003')[0].properties).toMatchObject({ status: 'existing', osmId: 'way/900003' });
    expect(drawnFor('way/900001')[0].properties.status).toBe('confirmed');
  });

  it('folds a detected tee lying on an OSM box into that box, keeping the tee set it matched', () => {
    const shapes = reviewShapes(
      [proposal('p-tee', 'tee', AT.strayTee, { key: 'red', name: 'Red', yards: 310 }), proposal('p-green', 'green', AT.green)],
      OSM_TEES,
    );

    expect(shapes.map((shape) => shape.id)).toEqual(['osm:way/900001', 'osm:way/900002', 'osm:way/900003', 'p-green']);
    expect(shapes.find((shape) => shape.id === 'osm:way/900003')?.teeSetKey).toBe('red');
    /* The match beats the yardage rule, exactly as it would on the proposal. */
    expect(guessTeeBoxes(teeSetsFor(SESSION, 0), shapes, PEBBLE_LINE).red).toBe('osm:way/900003');
  });

  it('keeps a detected tee that no OSM box covers', () => {
    const shapes = reviewShapes([proposal('p-tee', 'tee', AT.openGround)], OSM_TEES);
    expect(shapes.map((shape) => shape.id)).toContain('p-tee');
  });

  it('leaves an OSM tee that is not a closed outline as context only', () => {
    const point = { ...osmTee('node/1', AT.openGround), geometry: { type: 'LineString' as const, coordinates: [AT.openGround, AT.green] } };
    expect(reviewShapes([], [point])).toEqual([]);
  });

  it('saves a confirmed OSM box as that OSM element, marked edited once it is reshaped', async () => {
    const { result } = await onOsmHole([]);
    const ring = result.current.state.shapes[0].ring;
    act(() => result.current.actions.moveShape('osm:way/900001', [[ring[0][0] - 0.00002, ring[0][1]], ...ring.slice(1)]));
    act(() => result.current.actions.accept()); /* blue */
    act(() => result.current.actions.accept()); /* red */

    const saved = holeToSave(result.current.state)?.features.filter((feature) => feature.kind === 'tee');
    expect(saved).toEqual([
      expect.objectContaining({
        origin: 'osm',
        osmId: 'way/900001',
        edited: true,
        proposal: null,
        teeSets: [expect.objectContaining({ key: 'blue' })],
      }),
      expect.objectContaining({ origin: 'osm', osmId: 'way/900002', edited: false }),
    ]);
  });

  it('records no decision for an OSM box — nobody proposed it', async () => {
    const { result } = await onOsmHole([]);
    act(() => result.current.actions.accept());
    await settle();
    expect(postedDecisions()).toHaveLength(0);
  });
});

describe('everything else OpenStreetMap already outlines on the hole', () => {
  const osmFeature = (id: string, kind: OsmHoleFeature['kind'], tag: string, at: LngLat, half = 0.00008): OsmHoleFeature => ({
    id,
    kind,
    tag,
    name: null,
    geometry: squareAround(at, half),
  });
  const GREEN = osmFeature('way/910001', 'green', 'green', AT.green, 0.00012);
  const FAIRWAY = osmFeature('way/910002', 'fairway', 'fairway', AT.fairway, 0.0002);
  const BUNKER_1 = osmFeature('way/910003', 'bunker', 'bunker', AT.bunker1);
  const BUNKER_2 = osmFeature('way/910004', 'bunker', 'bunker', AT.bunker2);
  const POND = osmFeature('way/910005', 'water', 'lateral_water_hazard', AT.water, 0.00015);
  const PATH: OsmHoleFeature = {
    id: 'way/910006',
    kind: 'path',
    tag: 'cartpath',
    name: null,
    geometry: { type: 'LineString', coordinates: [AT.openGround, AT.green] },
  };
  const ALL = [GREEN, FAIRWAY, BUNKER_1, BUNKER_2, POND, PATH];

  /** Hole 1 on OSM's line, mapped by hand after detection is stopped. */
  function byHandOnOsmHole(features: OsmHoleFeature[] = ALL): Hook {
    const hook = openedOnHole(0, osmHolding(features));
    act(() => hook.result.current.actions.confirmLine());
    act(() => hook.result.current.actions.cancelProposals());
    act(() => hook.result.current.actions.confirmLocate());
    return hook;
  }

  it('turns every outline the review has a step for into a shape, water as a water hazard', () => {
    const { result } = byHandOnOsmHole();
    const shapes = result.current.state.shapes;

    expect(shapes.map((shape) => [shape.osmId, shape.kind])).toEqual([
      ['way/910001', 'green'],
      ['way/910002', 'fairway'],
      ['way/910003', 'bunker'],
      ['way/910004', 'bunker'],
      ['way/910005', 'hazard'],
    ]);
    expect(shapes.find((shape) => shape.osmId === 'way/910005')?.hazardType).toBe('water');
    /* The cart path is context: no step asks about it. */
    expect(shapes.some((shape) => shape.osmId === 'way/910006')).toBe(false);
  });

  it('asks about OSM’s green first, and saves it as that element, untouched', () => {
    const hook = byHandOnOsmHole();
    acceptUntil(hook, 'green');
    expect(hook.result.current.derived.question?.title).toBe('Is that the green?');
    expect(hook.result.current.derived.question?.note).toMatch(/already in OpenStreetMap/);

    act(() => hook.result.current.actions.accept());
    const green = holeToSave(hook.result.current.state)?.features.find((feature) => feature.kind === 'green');
    expect(green).toMatchObject({ origin: 'osm', osmId: 'way/910001', osmAction: 'keep', edited: false });
  });

  it('marks an edited OSM outline to be modified, and "put it back" undoes that', () => {
    const hook = byHandOnOsmHole();
    acceptUntil(hook, 'fairway');
    const id = 'osm:way/910002';
    const ring = shapeById(hook, id)!.ring;

    act(() => hook.result.current.actions.startEdit());
    act(() => hook.result.current.actions.moveShape(id, [[ring[0][0] - 0.00003, ring[0][1]], ...ring.slice(1)]));
    expect(shapeById(hook, id)?.edited).toBe(true);
    act(() => hook.result.current.actions.resetEdit());
    expect(shapeById(hook, id)).toMatchObject({ edited: false, ring });

    act(() => hook.result.current.actions.moveShape(id, [[ring[0][0] - 0.00003, ring[0][1]], ...ring.slice(1)]));
    act(() => hook.result.current.actions.finishEdit());
    act(() => hook.result.current.actions.accept());
    const fairway = holeToSave(hook.result.current.state)?.features.find((feature) => feature.kind === 'fairway');
    expect(fairway).toMatchObject({ origin: 'osm', osmId: 'way/910002', osmAction: 'modify', edited: true });
  });

  it('says OpenStreetMap’s bunkers are OpenStreetMap’s, not something we found', () => {
    const hook = byHandOnOsmHole();
    acceptUntil(hook, 'bunkers');
    expect(hook.result.current.derived.question?.title).toBe('OpenStreetMap has 2 bunkers on this hole. Did it miss any?');
  });

  it('keeps a disputed OSM outline in the record as disputed, and off the map', () => {
    const hook = byHandOnOsmHole();
    acceptUntil(hook, 'green');
    act(() => hook.result.current.actions.notGreen());
    act(() => hook.result.current.actions.cancelInteraction());

    const saved = holeToSave(hook.result.current.state)?.features.find((feature) => feature.osmId === 'way/910001');
    expect(saved).toMatchObject({ kind: 'green', origin: 'osm', osmAction: 'dispute' });
    /* Not redrawn as OSM context either: the contributor just said it is not this green. */
    expect(
      hook.result.current.derived.features.some(
        (feature) => feature.properties.osmId === 'way/910001' || feature.properties.shapeId === 'osm:way/910001',
      ),
    ).toBe(false);
  });

  it('keeps OSM’s own golf tag — a lateral water hazard stays one', () => {
    const hook = byHandOnOsmHole();
    acceptUntil(hook, 'hazards');
    act(() => hook.result.current.actions.accept());
    const pond = holeToSave(hook.result.current.state)?.features.find((feature) => feature.osmId === 'way/910005');
    expect(pond).toMatchObject({ kind: 'water', osmTags: { golf: 'lateral_water_hazard', natural: 'water' } });
  });

  it('folds a proposal lying on an OSM outline of the same kind into it, and keeps one of another kind', () => {
    const shapes = reviewShapes(
      [proposal('p-green', 'green', AT.green), proposal('p-bunker-on-green', 'bunker', AT.green)],
      [GREEN],
    );
    expect(shapes.map((shape) => shape.id)).toEqual(['osm:way/910001', 'p-bunker-on-green']);
  });
});

describe('review the next hole', () => {
  it('moves to the next hole even when OpenStreetMap already holds every hole on the course', () => {
    /* Pebble Beach: all eighteen in OSM. This used to leave the contributor on hole 1. */
    const allInOsm = Array.from({ length: 18 }, () => 'complete' as const);
    expect(nextHoleIndex(allInOsm, 0)).toBe(1);
    expect(nextHoleIndex(allInOsm, 16)).toBe(17);
  });

  it('skips holes saved here, and wraps round to the first one still to do', () => {
    /* Every other hole is saved: move on in order rather than reopen this one. */
    expect(nextHoleIndex(['saved', 'saved', 'complete', 'saved'], 2)).toBe(3);
    expect(nextHoleIndex(['unmapped', 'saved', 'saved', 'saved'], 1)).toBe(0);
    expect(nextHoleIndex(['saved', 'unmapped', 'saved', 'unmapped'], 3)).toBe(1);
  });

  it('just goes on to the next hole once every hole is saved', () => {
    expect(nextHoleIndex(['saved', 'saved', 'saved'], 0)).toBe(1);
    expect(nextHoleIndex(['saved', 'saved', 'saved'], 2)).toBe(0);
  });

  it('opens hole 2 after saving hole 1 on a course OSM has fully mapped', async () => {
    const hook = openedOnHole(0, osmHolding());
    expect(hook.result.current.state.holeStatus).toEqual(['complete', 'unmapped', 'unmapped']);
    act(() => hook.result.current.actions.patch({ holeStatus: ['saved', 'complete', 'complete'], screen: 'complete' }));

    act(() => hook.result.current.actions.nextHole());

    expect(hook.result.current.state.holeIndex).toBe(1);
    expect(hook.result.current.state.screen).toBe('review');
  });
});

describe('editing a hole saved on an earlier visit', () => {
  const featureOf = (overrides: Partial<SavedFeature>): SavedFeature => ({
    kind: 'tee',
    geometry: squareAround(AT.backTee),
    origin: 'drawn',
    edited: false,
    osmId: null,
    osmAction: 'create',
    teeSets: [],
    label: null,
    osmTags: { golf: 'tee' },
    proposal: null,
    ...overrides,
  });
  /* Hole 1 as saved last time: a tee box drawn by hand for blue, OSM's green
   * edited, a proposed bunker with its provenance, and an OSM bunker disputed. */
  const savedHoleOne: SavedHole = {
    courseId: 'pebble',
    holeNumber: 1,
    par: 4,
    playingLine: { type: 'LineString', coordinates: PEBBLE_LINE },
    lineSource: 'drawn',
    osmHoleId: null,
    features: [
      featureOf({ teeSets: [{ key: 'blue', name: 'Blue', yards: 380 }] }),
      featureOf({
        kind: 'green',
        geometry: squareAround(AT.green, 0.00012),
        origin: 'osm',
        osmId: 'way/920001',
        osmAction: 'modify',
        edited: true,
        osmTags: { golf: 'green' },
      }),
      featureOf({
        kind: 'bunker',
        geometry: squareAround(AT.bunker1),
        origin: 'proposed',
        osmAction: 'create',
        osmTags: { golf: 'bunker', natural: 'sand' },
        proposal: {
          confidence: 0.71,
          provenance: { acquired: '2023-07-04', gsdMeters: 0.6, source: 'naip', modelId: 'sam2', itemId: 'item-1' },
        },
      }),
      featureOf({
        kind: 'bunker',
        geometry: squareAround(AT.bunker2),
        origin: 'osm',
        osmId: 'way/920002',
        osmAction: 'dispute',
        osmTags: { golf: 'bunker', natural: 'sand' },
      }),
    ],
  };
  /* What OSM holds for hole 1: the green and bunker already in the save, and a
   * second tee box the save never mentioned. */
  const OSM = [
    { id: 'way/920001', kind: 'green' as const, tag: 'green', name: null, geometry: squareAround(AT.green, 0.00012) },
    { id: 'way/920002', kind: 'bunker' as const, tag: 'bunker', name: null, geometry: squareAround(AT.bunker2) },
    { id: 'way/920003', kind: 'tee' as const, tag: 'tee', name: null, geometry: squareAround(AT.redTee) },
  ];

  /** Reopen hole 1 with that save, confirm its line, and map on by hand. */
  function reopened(): Hook {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(OSM), { holes: [savedHoleOne] }));
    act(() => hook.result.current.actions.openHole(0));
    act(() => hook.result.current.actions.confirmLine());
    act(() => hook.result.current.actions.cancelProposals());
    act(() => hook.result.current.actions.confirmLocate());
    return hook;
  }

  it('remembers which box the blue tee plays from', () => {
    const { result } = reopened();

    expect(result.current.state.teeBoxes.blue).toBe('saved:0');
    expect(result.current.derived.question?.title).toBe('Is that where the blue tee plays from?');
    expect(result.current.derived.question?.note).toMatch(/the box you saved for the blue tee/);
  });

  it('lets "Pick the box" choose a box the contributor drew and saved, not yet in OSM', () => {
    const { result } = reopened();
    act(() => result.current.actions.accept()); /* blue */
    expect(result.current.derived.currentTee?.key).toBe('red');

    act(() => result.current.actions.startPick('tee'));
    act(() => result.current.actions.onMapClick(AT.backTee));

    expect(result.current.state.teeBoxes.red).toBe('saved:0');
    expect(result.current.state.shapes.filter((shape) => shape.origin === 'drawn' && !shape.fromSaved)).toHaveLength(0);
  });

  it('takes the saved copy of an OSM outline over OSM’s raw one, so it is offered once', () => {
    const { result } = reopened();
    const ids = result.current.state.shapes.map((shape) => shape.osmId ?? shape.id);

    expect(ids.filter((id) => id === 'way/920001')).toHaveLength(1);
    expect(result.current.state.shapes.find((shape) => shape.osmId === 'way/920001')).toMatchObject({
      fromSaved: true,
      edited: true,
      kind: 'green',
    });
    /* OSM's other tee box, never in the save, is still there to pick. */
    expect(ids).toContain('way/920003');
  });

  it('keeps a disputed OSM outline disputed: off the question, still in the record', () => {
    const hook = reopened();
    acceptUntil(hook, 'bunkers');
    expect(hook.result.current.derived.question?.title).toBe('We found 1 bunker on this hole. Did we miss any?');

    acceptUntil(hook, 'hazards');
    act(() => hook.result.current.actions.accept());
    const disputed = holeToSave(hook.result.current.state)?.features.find((feature) => feature.osmId === 'way/920002');
    expect(disputed).toMatchObject({ origin: 'osm', osmAction: 'dispute' });
  });

  it('saves every shape again as what it was: origin, OSM element, edit and provenance', () => {
    const hook = reopened();
    acceptUntil(hook, 'hazards');
    act(() => hook.result.current.actions.accept());
    const features = holeToSave(hook.result.current.state)?.features ?? [];

    expect(features.find((feature) => feature.kind === 'tee')).toMatchObject({
      origin: 'drawn',
      osmAction: 'create',
      teeSets: [expect.objectContaining({ key: 'blue' })],
    });
    expect(features.find((feature) => feature.kind === 'green')).toMatchObject({
      origin: 'osm',
      osmId: 'way/920001',
      osmAction: 'modify',
      edited: true,
    });
    expect(features.find((feature) => feature.kind === 'bunker' && feature.origin === 'proposed')).toMatchObject({
      proposal: { confidence: 0.71, provenance: expect.objectContaining({ itemId: 'item-1' }) },
    });
  });

  it('draws the saved shapes once the review has them, not also as context behind them', () => {
    const { result } = reopened();
    expect(result.current.derived.features.some((feature) => feature.properties.savedIndex !== undefined)).toBe(false);
    expect(
      result.current.derived.features.some((feature) => feature.properties.shapeId === 'saved:0'),
    ).toBe(true);
  });

  it('shows the saved version of an edited OSM outline on reload, not OSM’s original beside it', () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(OSM), { holes: [savedHoleOne] }));
    act(() => hook.result.current.actions.openHole(0));

    /* Checking the line: the review has no shapes yet, only what is on the map. */
    const drawn = hook.result.current.derived.features;
    const greens = drawn.filter((feature) => feature.properties.kind === 'green');
    expect(greens).toHaveLength(1);
    expect(greens[0].properties.status).toBe('saved');
    expect(drawn.some((feature) => feature.properties.osmId === 'way/920001')).toBe(false);
    /* The disputed bunker: neither OSM's copy nor the saved one. */
    expect(drawn.some((feature) => feature.properties.osmId === 'way/920002')).toBe(false);
    expect(drawn.filter((feature) => feature.properties.kind === 'bunker')).toHaveLength(1);
    /* OSM's tee box the save never mentioned is still on the map. */
    expect(drawn.some((feature) => feature.properties.osmId === 'way/920003')).toBe(true);
  });

  it('shows the playing line as saved, not the one OpenStreetMap holds', () => {
    const editedLine: LngLat[] = [PEBBLE_TEE, [PEBBLE_TURN[0], PEBBLE_TURN[1] + 0.0002], PEBBLE_GREEN];
    const hook = renderHook(() => useMapper());
    act(() =>
      hook.result.current.actions.openCourse(SESSION, osmHolding(OSM), {
        holes: [{ ...savedHoleOne, playingLine: { type: 'LineString', coordinates: editedLine }, lineSource: 'osm_edited' }],
      }),
    );
    act(() => hook.result.current.actions.openHole(0));

    const lines = hook.result.current.derived.features.filter((feature) => feature.geometry.type === 'LineString');
    expect(lines).toHaveLength(1);
    expect((lines[0].geometry as LineString).coordinates).toEqual(editedLine);
    expect(hook.result.current.state.locate).toMatchObject({ source: 'osm', edited: true });
  });

  it('turns saved hazards back into hazards of the type they were saved as', () => {
    const shapes = savedShapes([featureOf({ kind: 'trees', geometry: squareAround(AT.water), osmTags: { natural: 'wood' } })]);
    expect(shapes[0]).toMatchObject({ kind: 'hazard', hazardType: 'trees', fromSaved: true });
  });
});

describe('the green step', () => {
  const greens = () => [proposal('p-green', 'green', AT.green), proposal('p-green-next', 'green', AT.nextGreen)];

  it('asks about the proposal nearest the end of the line, not the next hole’s green', async () => {
    /* The next hole's green is listed first, so a "first green wins" would pick it. */
    const [ours, next] = greens();
    const hook = await openedWith([next, ours]);
    acceptUntil(hook, 'green');

    expect(hook.result.current.derived.question).toMatchObject({
      kicker: 'The green',
      title: 'Is that the green?',
      accept: 'Yes, that is the green',
    });
    expect(hook.result.current.derived.question?.actions.map((a) => a.id)).toEqual(['not-green', 'edit']);
    expect(hook.result.current.derived.activeShapeIds).toEqual(['p-green']);

    act(() => hook.result.current.actions.accept());
    expect(shapeById(hook, 'p-green')?.confirmed).toBe(true);
    expect(shapeById(hook, 'p-green-next')?.confirmed).toBe(false);
    expect(hook.result.current.state.step).toBe(stepIndex('fairway'));
  });

  it('rejects a wrong green and takes another proposal the contributor clicks on', async () => {
    const proposals = greens();
    const hook = await openedWith(proposals);
    acceptUntil(hook, 'green');

    act(() => hook.result.current.actions.runAction('not-green'));

    expect(shapeById(hook, 'p-green')).toMatchObject({ removed: true, confirmed: false });
    expect(hook.result.current.derived.rejectedHere.map((p) => p.id)).toEqual(['p-green']);
    expect(hook.result.current.state.interaction).toEqual({ kind: 'place', shape: 'green', forTee: null, replacing: true });

    act(() => hook.result.current.actions.onMapClick(AT.nextGreen));
    /* The proposal itself, to pull into shape — not a new outline on top of it. */
    expect(hook.result.current.state.interaction).toEqual({ kind: 'new', shapeId: 'p-green-next' });
    expect(hook.result.current.state.shapes).toHaveLength(2);

    act(() => hook.result.current.actions.confirmNew());
    expect(shapeById(hook, 'p-green-next')?.confirmed).toBe(true);
    expect(hook.result.current.state.step).toBe(stepIndex('fairway'));
    expect(postedDecisions().map((d) => [decisionFor(proposals, d), d.outcome])).toEqual([
      ['p-green', 'rejected'],
      ['p-green-next', 'confirmed'],
    ]);
  });

  it('drops a new green where the contributor clicks when no proposal is there', async () => {
    const hook = await openedWith([proposal('p-green', 'green', AT.green)]);
    acceptUntil(hook, 'green');

    act(() => hook.result.current.actions.notGreen());
    act(() => hook.result.current.actions.onMapClick(AT.openGround));

    const dropped = shapeById(hook, 'drawn-1');
    expect(dropped).toMatchObject({ kind: 'green', origin: 'drawn', confirmed: false });
    expect(dropped!.ring).toHaveLength(12);
    expect(hook.result.current.state.interaction).toEqual({ kind: 'new', shapeId: 'drawn-1' });

    act(() => hook.result.current.actions.confirmNew());
    expect(shapeById(hook, 'drawn-1')?.confirmed).toBe(true);
    expect(hook.result.current.state.step).toBe(stepIndex('fairway'));
    expect(hook.result.current.state.lastAction).toBe('That is the green.');
  });

  it('asks where the green is when detection proposed none, and lets it be skipped', async () => {
    const hook = await openedWith([]);
    acceptUntil(hook, 'green');

    expect(hook.result.current.derived.question).toMatchObject({
      title: 'Where is the green?',
      accept: 'Skip the green for now',
    });
    expect(hook.result.current.derived.question?.actions.map((a) => a.id)).toEqual(['find-green']);

    act(() => hook.result.current.actions.accept());
    expect(hook.result.current.state.step).toBe(stepIndex('fairway'));
    expect(hook.result.current.state.lastAction).toBe('Green left for later.');
  });
});

describe('the fairway step', () => {
  it('templates the question off the pieces actually on the hole', async () => {
    const one = await openedWith([proposal('p-fw1', 'fairway', AT.fairway)]);
    acceptUntil(one, 'fairway');
    expect(one.result.current.derived.question).toMatchObject({
      title: 'Is this outline of the fairway right?',
      accept: 'Yes, that is the fairway',
    });

    detection.pending.length = 0;
    const two = await openedWith([proposal('p-fw1', 'fairway', AT.fairway), proposal('p-fw2', 'fairway', AT.bunker3)]);
    acceptUntil(two, 'fairway');
    expect(two.result.current.derived.question).toMatchObject({
      title: 'Do all 2 pieces of fairway look right?',
      accept: 'Yes, all 2 pieces',
    });
    expect(two.result.current.derived.question?.actions.map((a) => a.id)).toEqual(['add', 'remove-one', 'edit']);

    detection.pending.length = 0;
    const none = await openedWith([]);
    acceptUntil(none, 'fairway');
    expect(none.result.current.derived.question).toMatchObject({
      title: 'No fairway on this hole. Right?',
      accept: 'No fairway on this hole',
    });
    expect(none.result.current.derived.question?.actions.map((a) => a.id)).toEqual(['add']);
  });
});

describe('the sand step', () => {
  const bunkers = () => [
    proposal('p-b1', 'bunker', AT.bunker1),
    proposal('p-b2', 'bunker', AT.bunker2),
    proposal('p-b3', 'bunker', AT.bunker3),
  ];

  it('says how many bunkers it found, by the real count', async () => {
    const hook = await openedWith(bunkers());
    acceptUntil(hook, 'bunkers');

    const question = hook.result.current.derived.question;
    expect(question).toMatchObject({
      kicker: 'Sand',
      title: 'We found 3 bunkers on this hole. Did we miss any?',
      accept: 'That is all 3 of them',
    });
    expect(question?.actions.map((a) => [a.id, a.label])).toEqual([
      ['remove-one', 'One of these is not sand'],
      ['add', 'There is another bunker'],
      ['edit', 'Edges are off — let me fix them'],
    ]);
    expect(hook.result.current.derived.activeShapeIds).toEqual(['p-b1', 'p-b2', 'p-b3']);
  });

  it('removes the one bunker picked on the map, records it as a rejection with its geometry, and recounts', async () => {
    const proposals = bunkers();
    const hook = await openedWith(proposals);
    acceptUntil(hook, 'bunkers');

    act(() => hook.result.current.actions.runAction('remove-one'));
    expect(hook.result.current.state.interaction).toEqual({ kind: 'pick', purpose: 'remove' });
    /* A click that hits no bunker does nothing — the pick stays open. */
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    expect(hook.result.current.state.interaction).toEqual({ kind: 'pick', purpose: 'remove' });

    act(() => hook.result.current.actions.onMapClick(AT.bunker2));

    expect(hook.result.current.state.interaction).toEqual({ kind: 'none' });
    expect(shapeById(hook, 'p-b2')).toMatchObject({ removed: true, confirmed: false });
    const recorded = hook.result.current.derived.rejectedHere;
    expect(recorded.map((p) => p.id)).toEqual(['p-b2']);
    expect(recorded[0].kind).toBe('bunker');
    expect(recorded[0].geometry).toEqual(proposals[1].geometry);
    expect(recorded[0].acquired).toBe('2023-07-04');
    /* It leaves the map, and the question counts what is left. */
    expect(hook.result.current.derived.features.some((f) => f.properties.shapeId === 'p-b2')).toBe(false);
    expect(hook.result.current.derived.question).toMatchObject({
      title: 'We found 2 bunkers on this hole. Did we miss any?',
      accept: 'That is all 2 of them',
    });
    const [decision] = postedDecisions();
    expect(decision).toMatchObject({ kind: 'bunker', outcome: 'rejected', geometry: proposals[1].geometry });
  });

  it('keeps a rejection after navigating to another hole and back (R10)', async () => {
    const hook = await openedWith(bunkers());
    acceptUntil(hook, 'bunkers');
    act(() => hook.result.current.actions.startPick('remove'));
    act(() => hook.result.current.actions.onMapClick(AT.bunker1));
    expect(hook.result.current.derived.rejectedHere).toHaveLength(1);

    act(() => hook.result.current.actions.openHole(1));
    expect(hook.result.current.derived.rejectedHere).toHaveLength(0);

    act(() => hook.result.current.actions.openHole(0));
    expect(hook.result.current.derived.rejectedHere.map((p) => p.id)).toEqual(['p-b1']);
    /* Keyed by hole number, not by array position in the session. */
    expect(Object.keys(hook.result.current.state.rejections)).toEqual(['1']);
  });

  it('adds a bunker the model missed where the contributor clicks, and counts it in', async () => {
    const hook = await openedWith([proposal('p-b1', 'bunker', AT.bunker1)]);
    acceptUntil(hook, 'bunkers');
    expect(hook.result.current.derived.question?.accept).toBe('That is the only one');

    act(() => hook.result.current.actions.runAction('add'));
    expect(hook.result.current.state.interaction).toEqual({ kind: 'place', shape: 'bunker', forTee: null, replacing: false });
    act(() => hook.result.current.actions.onMapClick(AT.openGround));

    const added = shapeById(hook, 'drawn-1');
    expect(added).toMatchObject({ kind: 'bunker', origin: 'drawn', proposal: null, confirmed: false });
    /* Real coordinates around the click, not viewBox units, and a handful of handles. */
    expect(added!.ring).toHaveLength(10);
    expect(pointInRing(AT.openGround, added!.ring)).toBe(true);
    for (const [lng, lat] of added!.ring) {
      expect(Math.abs(lng - AT.openGround[0])).toBeLessThan(0.001);
      expect(Math.abs(lat - AT.openGround[1])).toBeLessThan(0.001);
    }

    act(() => hook.result.current.actions.confirmNew());
    expect(hook.result.current.state.interaction).toEqual({ kind: 'none' });
    /* Keeping it is not the answer to the step: that still waits for "that is all". */
    expect(hook.result.current.state.step).toBe(stepIndex('bunkers'));
    expect(shapeById(hook, 'drawn-1')?.confirmed).toBe(false);
    expect(hook.result.current.derived.question?.title).toBe('We found 2 bunkers on this hole. Did we miss any?');

    act(() => hook.result.current.actions.accept());
    expect(shapeById(hook, 'p-b1')?.confirmed).toBe(true);
    expect(shapeById(hook, 'drawn-1')?.confirmed).toBe(true);
    expect(hook.result.current.state.step).toBe(stepIndex('hazards'));
  });

  it('says there are no bunkers left once every one is removed', async () => {
    const hook = await openedWith([proposal('p-b1', 'bunker', AT.bunker1)]);
    acceptUntil(hook, 'bunkers');
    act(() => hook.result.current.actions.startPick('remove'));
    act(() => hook.result.current.actions.onMapClick(AT.bunker1));

    expect(hook.result.current.derived.question).toMatchObject({
      title: 'No bunkers on this hole. Right?',
      accept: 'No bunkers on this hole',
    });
    expect(hook.result.current.derived.question?.actions.map((a) => a.id)).toEqual(['add']);
  });

  it('holds the answer while a pick is open, so a stray accept confirms nothing', async () => {
    const hook = await openedWith(bunkers());
    acceptUntil(hook, 'bunkers');
    fetchCalls().length = 0;
    act(() => hook.result.current.actions.runAction('remove-one'));

    act(() => hook.result.current.actions.accept());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });

    expect(hook.result.current.state.step).toBe(stepIndex('bunkers'));
    expect(hook.result.current.state.shapes.some((s) => s.confirmed && s.kind === 'bunker')).toBe(false);
    expect(fetchCalls()).toHaveLength(0);
  });
});

describe('editing outlines', () => {
  it('puts handles on the shapes being asked about, and marks a dragged proposal edited', async () => {
    const hook = await openedWith([proposal('p-b1', 'bunker', AT.bunker1), proposal('p-b2', 'bunker', AT.bunker2)]);
    acceptUntil(hook, 'bunkers');
    const original = shapeById(hook, 'p-b1')!.ring;

    act(() => hook.result.current.actions.runAction('edit'));
    expect(hook.result.current.state.interaction).toEqual({ kind: 'edit', shapeIds: ['p-b1', 'p-b2'] });
    expect(hook.result.current.derived.editablePaths.map((p) => [p.id, p.closed])).toEqual([
      ['p-b1', true],
      ['p-b2', true],
    ]);

    const pulled: LngLat[] = original.map(([lng, lat], i) => (i === 0 ? [lng - 0.00005, lat - 0.00005] : [lng, lat]));
    act(() => hook.result.current.actions.moveShape('p-b1', pulled));
    expect(shapeById(hook, 'p-b1')).toMatchObject({ ring: pulled, edited: true, original });

    act(() => hook.result.current.actions.resetEdit());
    expect(shapeById(hook, 'p-b1')).toMatchObject({ ring: original, edited: false });
    /* Still editing: putting it back is not finishing. */
    expect(hook.result.current.state.interaction.kind).toBe('edit');

    act(() => hook.result.current.actions.finishEdit());
    expect(hook.result.current.state.interaction).toEqual({ kind: 'none' });
    expect(hook.result.current.state.lastAction).toBe('Edges saved.');
  });

  it('never calls a shape the contributor drew “edited” — it was theirs from the start', async () => {
    const hook = await openedWith([]);
    acceptUntil(hook, 'bunkers');
    act(() => hook.result.current.actions.startPlace('bunker'));
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    const ring = shapeById(hook, 'drawn-1')!.ring;

    act(() => hook.result.current.actions.moveShape('drawn-1', ring.slice(1)));

    expect(shapeById(hook, 'drawn-1')).toMatchObject({ ring: ring.slice(1), edited: false });
  });
});

describe('Esc', () => {
  it('backs out of a drop and throws away the shape that was never kept', async () => {
    const hook = await openedWith([]);
    acceptUntil(hook, 'bunkers');
    act(() => hook.result.current.actions.runAction('add'));
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    expect(shapeById(hook, 'drawn-1')).toBeDefined();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(hook.result.current.state.interaction).toEqual({ kind: 'none' });
    expect(hook.result.current.state.shapes).toEqual([]);
    /* A drawn shape is not a proposal: going away is not a rejection. */
    expect(hook.result.current.state.rejections).toEqual({});
  });

  it('takes a half-drawn tee box away from the set it was drawn for', async () => {
    const hook = await openedWith([]);
    act(() => hook.result.current.actions.startPick('tee'));
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    expect(hook.result.current.state.teeBoxes).toEqual({ blue: 'drawn-1' });

    act(() => hook.result.current.actions.cancelInteraction());

    expect(hook.result.current.state.shapes).toEqual([]);
    expect(hook.result.current.state.teeBoxes).toEqual({});
    expect(hook.result.current.derived.question?.title).toBe('Where does the blue tee play from?');
  });

  it('puts a picked proposal back to waiting rather than removing it', async () => {
    const hook = await openedWith([proposal('p-green', 'green', AT.green), proposal('p-green-next', 'green', AT.nextGreen)]);
    acceptUntil(hook, 'green');
    act(() => hook.result.current.actions.notGreen());
    act(() => hook.result.current.actions.onMapClick(AT.nextGreen));

    act(() => hook.result.current.actions.cancelInteraction());

    expect(shapeById(hook, 'p-green-next')).toMatchObject({ removed: false, confirmed: false });
    expect(hook.result.current.state.step).toBe(stepIndex('green'));
  });
});

describe('the hazard step', () => {
  it('holds “that is all” until every hazard says what it is', async () => {
    const hook = await openedWith([proposal('p-water', 'water', AT.water)]);
    acceptUntil(hook, 'hazards');

    /* Water detection saw arrives already typed. */
    expect(hook.result.current.derived.question).toMatchObject({
      kicker: 'Anything else',
      title: '1 hazard on this hole. Anything else?',
      accept: 'That is all of them',
      acceptDisabled: false,
    });

    act(() => hook.result.current.actions.runAction('draw-hazard'));
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    act(() => hook.result.current.actions.confirmNew());

    expect(hook.result.current.derived.question).toMatchObject({
      title: '2 hazards on this hole. Anything else?',
      acceptDisabled: true,
      note: 'Say what each one is before moving on.',
    });
    act(() => hook.result.current.actions.accept());
    expect(hook.result.current.state.step).toBe(stepIndex('hazards'));
    expect(shapeById(hook, 'p-water')?.confirmed).toBe(false);

    act(() => hook.result.current.actions.setHazardType('drawn-1', 'trees'));
    expect(hook.result.current.derived.question?.acceptDisabled).toBe(false);
    act(() => hook.result.current.actions.accept());

    expect(hook.result.current.state.step).toBe(STEPS.length);
    expect(hook.result.current.derived.allDone).toBe(true);
    expect(shapeById(hook, 'p-water')?.confirmed).toBe(true);
    expect(shapeById(hook, 'drawn-1')).toMatchObject({ confirmed: true, hazardType: 'trees' });
    expect(hook.result.current.derived.summary).toContain('water, trees');
  });

  it('lets an untyped hazard be removed instead of typed', async () => {
    const hook = await openedWith([]);
    acceptUntil(hook, 'hazards');
    expect(hook.result.current.derived.question).toMatchObject({
      title: 'Any other hazards out there?',
      accept: 'Nothing else out there',
    });
    act(() => hook.result.current.actions.startPlace('hazard'));
    act(() => hook.result.current.actions.onMapClick(AT.openGround));
    act(() => hook.result.current.actions.confirmNew());
    expect(hook.result.current.derived.question?.acceptDisabled).toBe(true);

    act(() => hook.result.current.actions.removeShape('drawn-1'));

    expect(hook.result.current.state.shapes).toEqual([]);
    expect(hook.result.current.derived.question?.acceptDisabled).toBe(false);
  });
});

/**
 * The decision store (R14, R15, KTD10): every proposal answered is posted once,
 * at the moment it is answered, with its geometry and provenance — and with
 * nothing that identifies who answered.
 */
describe('decisions', () => {
  it('posts each decision exactly once over a whole hole, with provenance and no identifier', async () => {
    const proposals = [
      proposal('p-tee', 'tee', AT.backTee, { name: 'Blue', key: 'blue', yards: 380 }),
      proposal('p-green', 'green', AT.green),
      proposal('p-fw', 'fairway', AT.fairway),
      proposal('p-b1', 'bunker', AT.bunker1),
      proposal('p-b2', 'bunker', AT.bunker2),
      proposal('p-water', 'water', AT.water),
    ];
    const hook = await openedWith(proposals);
    const { result } = hook;

    /* Blue plays from the matched box; the reds from the same box (a combo). */
    act(() => result.current.actions.accept());
    act(() => result.current.actions.startPick('tee'));
    act(() => result.current.actions.onMapClick(AT.backTee));
    act(() => result.current.actions.accept());
    act(() => result.current.actions.accept()); // green
    /* Edges look off, then fine after all: an edit is not a decision. */
    act(() => result.current.actions.startEdit());
    act(() => result.current.actions.finishEdit());
    act(() => result.current.actions.accept()); // fairway
    act(() => result.current.actions.startPick('remove'));
    act(() => result.current.actions.onMapClick(AT.bunker2));
    act(() => result.current.actions.accept()); // sand
    act(() => result.current.actions.accept()); // hazards
    expect(result.current.derived.allDone).toBe(true);
    /* And answering again past the end changes nothing. */
    act(() => result.current.actions.accept());

    const posted = postedDecisions();
    expect(posted.map((d) => [decisionFor(proposals, d), d.outcome])).toEqual([
      ['p-tee', 'confirmed'],
      ['p-green', 'confirmed'],
      ['p-fw', 'confirmed'],
      ['p-b2', 'rejected'],
      ['p-b1', 'confirmed'],
      ['p-water', 'confirmed'],
    ]);
    /* Kept water is the contributor saying a ball can find it (R14). Nothing else is asked that. */
    const water = posted.find((d) => decisionFor(proposals, d) === 'p-water');
    expect(water?.in_play).toBe(true);
    expect(posted.filter((d) => 'in_play' in d)).toHaveLength(1);

    for (const decision of posted) {
      expect(decision).toMatchObject({
        confidence: 0.82,
        provenance: {
          acquired: '2023-07-04',
          gsd_meters: 0.6,
          source: 'USDA NAIP via Microsoft Planetary Computer',
          model_id: 'facebook/sam2-hiera-large',
          item_id: 'ca_m_3812_2023',
        },
      });
    }

    const bodies = fetchCalls()
      .filter(([url]) => String(url).includes('/v1/decisions'))
      .map(([, init]) => JSON.parse(init.body));
    for (const body of bodies) {
      expect(body.course_id).toBe('pebble');
      expect(body.hole_number).toBe(1);
      /* The store holds no contributor, session or device identifier — and is sent none. */
      expect(JSON.stringify(body)).not.toMatch(/user|session|device|contributor/i);
    }
    expect(new Set(result.current.state.decided)).toEqual(new Set(proposals.map((p) => p.id)));
  });

  /*
   * Pins a fixed bug: `notGreen`, `removeShape`, `discardNew` and
   * `cancelInteraction` used to post the rejection from inside a
   * `patch(s => ...)` updater, which StrictMode runs twice — doubling the
   * store's training signal.
   */
  it('posts a rejection once even when React runs the state updater twice (StrictMode)', async () => {
    /*
     * main.tsx renders under <StrictMode>, which runs state updater functions
     * twice in development to flush out side effects. A decision posted from
     * inside an updater is exactly such a side effect.
     */
    const proposals = [proposal('p-green', 'green', AT.green), proposal('p-green-next', 'green', AT.nextGreen)];
    const hook = renderHook(() => useMapper(), { reactStrictMode: true });
    act(() => hook.result.current.actions.openCourse(SESSION, { status: 'absent' }));
    act(() => hook.result.current.actions.openHole(0));
    for (const point of PEBBLE_LINE) act(() => hook.result.current.actions.onMapClick(point));
    act(() => hook.result.current.actions.confirmLine());
    await act(async () => {
      detection.pending[detection.pending.length - 1]({ status: 'ok', jobId: 'j', proposals, imagery: null, missingTeeSets: [] });
    });
    acceptUntil(hook as Hook, 'green');

    act(() => hook.result.current.actions.notGreen());

    expect(postedDecisions().filter((d) => d.outcome === 'rejected')).toHaveLength(1);
  });
});

describe('saving the hole', () => {
  /** A hole walked all the way through, with something of every kind in it. */
  async function walkedThrough() {
    const proposals = [
      proposal('p-tee-back', 'tee', AT.backTee),
      proposal('p-tee-stray', 'tee', AT.strayTee),
      proposal('p-green', 'green', AT.green),
      proposal('p-b1', 'bunker', AT.bunker1),
      proposal('p-b2', 'bunker', AT.bunker2),
      proposal('p-water', 'water', AT.water),
    ];
    const hook = await openedWith(proposals);
    /* Always the latest actions: each closes over the state it was rendered with. */
    const a = () => hook.result.current.actions;

    act(() => a().accept()); // blue: the back box
    act(() => a().accept()); // red: no box guessed, so "no red tee"
    act(() => a().accept()); // green
    act(() => a().accept()); // no fairway
    /* Sand: drop one, reshape another, add one. */
    act(() => a().startPick('remove'));
    act(() => a().onMapClick(AT.bunker2));
    act(() => a().startEdit(['p-b1']));
    const ring = shapeById(hook, 'p-b1')!.ring;
    act(() => a().moveShape('p-b1', ring.map(([lng, lat]) => [lng + 0.00001, lat] as LngLat)));
    act(() => a().finishEdit());
    act(() => a().startPlace('bunker'));
    act(() => a().onMapClick(AT.openGround));
    act(() => a().confirmNew());
    act(() => a().accept());
    /* Hazards: the water, and trees the contributor drew. */
    act(() => a().startPlace('hazard'));
    act(() => a().onMapClick(AT.nextGreen));
    act(() => a().confirmNew());
    act(() => a().setHazardType('drawn-2', 'trees'));
    act(() => a().accept());
    expect(hook.result.current.derived.allDone).toBe(true);
    expect(hook.result.current.derived.canSave).toBe(true);
    return hook;
  }

  it('builds the record from confirmed shapes only, each with its tee sets, type and tags', async () => {
    const hook = await walkedThrough();
    const hole = holeToSave(hook.result.current.state);
    if (!hole) throw new Error('expected a hole to save');

    expect(hole).toMatchObject({
      courseId: 'pebble',
      holeNumber: 1,
      par: 4,
      playingLine: { type: 'LineString', coordinates: PEBBLE_LINE },
      lineSource: 'drawn',
      osmHoleId: null,
    });
    /* Not the stray tee nobody chose, not the bunker the contributor removed. */
    expect(hole.features.map((f) => [f.kind, f.origin, f.edited])).toEqual([
      ['tee', 'proposed', false],
      ['green', 'proposed', false],
      ['bunker', 'proposed', true],
      ['water', 'proposed', false],
      ['bunker', 'drawn', false],
      ['trees', 'drawn', false],
    ]);
    const [tee, green, bunker, water, drawnBunker, trees] = hole.features;
    expect(tee.teeSets).toEqual([{ key: 'blue', name: 'Blue', yards: 380 }]);
    expect(green.teeSets).toEqual([]);
    expect(tee.osmTags).toEqual({ golf: 'tee' });
    expect(bunker.osmTags).toEqual({ golf: 'bunker', natural: 'sand' });
    expect(water).toMatchObject({ label: 'Water', osmTags: { golf: 'water_hazard', natural: 'water' } });
    expect(trees).toMatchObject({ label: 'Trees', osmTags: { natural: 'wood' } });
    /* `proposal` is there exactly when the shape was proposed. */
    expect(green.proposal).toEqual({
      confidence: 0.82,
      provenance: {
        acquired: '2023-07-04',
        gsdMeters: 0.6,
        source: 'USDA NAIP via Microsoft Planetary Computer',
        modelId: 'facebook/sam2-hiera-large',
        itemId: 'ca_m_3812_2023',
      },
    });
    expect(drawnBunker.proposal).toBeNull();
    expect(trees.proposal).toBeNull();
    /* A reshaped proposal saves its reshaped outline, closed. */
    const ring = bunker.geometry.type === 'Polygon' ? bunker.geometry.coordinates[0] : [];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(openRing(ring)).toEqual(shapeById(hook, 'p-b1')!.ring);
  });

  it('saves a proposal the service sent without provenance as the contributor’s own shape', async () => {
    const bare = { ...proposal('p-green', 'green', AT.green), modelId: null };
    const hook = await openedWith([bare]);
    acceptUntil(hook, 'fairway');

    const [green] = holeToSave(hook.result.current.state)!.features;
    expect(green).toMatchObject({ kind: 'green', origin: 'drawn', proposal: null });
  });

  it('posts the record snake_case to the store, and on ok marks the hole saved and shows it complete', async () => {
    const hook = await walkedThrough();

    act(() => hook.result.current.actions.saveHole());
    expect(hook.result.current.state.save).toEqual({ status: 'saving' });
    expect(hook.result.current.derived.canSave).toBe(false);
    await settle();

    const saves = fetchCalls().filter(([url]) => String(url).includes('/v1/holes'));
    expect(saves).toHaveLength(1);
    expect(String(saves[0][0])).toMatch(/\/v1\/holes$/);
    const body = JSON.parse(saves[0][1].body);
    expect(Object.keys(body).sort()).toEqual(
      ['course_id', 'features', 'hole_number', 'line_source', 'osm_hole_id', 'par', 'playing_line'].sort(),
    );
    expect(body).toMatchObject({ course_id: 'pebble', hole_number: 1, par: 4, line_source: 'drawn', osm_hole_id: null });
    expect(Object.keys(body.features[0]).sort()).toEqual(
      ['edited', 'geometry', 'kind', 'label', 'origin', 'osm_action', 'osm_id', 'osm_tags', 'proposal', 'tee_sets'].sort(),
    );
    expect(body.features[0].tee_sets).toEqual([{ key: 'blue', name: 'Blue', yards: 380 }]);
    expect(body.features[0].proposal.provenance).toMatchObject({ gsd_meters: 0.6, model_id: 'facebook/sam2-hiera-large' });
    expect(body.features.find((f: { origin: string }) => f.origin === 'drawn').proposal).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/user|session|device|contributor/i);

    const { state, derived } = hook.result.current;
    expect(state.screen).toBe('complete');
    expect(state.holeStatus[0]).toBe('saved');
    expect(state.save).toEqual({ status: 'saved', at: '2026-09-19T10:00:00Z' });
    expect(state.savedHoles[1]).toMatchObject({ courseId: 'pebble', holeNumber: 1, savedAt: '2026-09-19T10:00:00Z' });
    expect(state.savedHoles[1].features).toHaveLength(6);
    expect(derived.savedCount).toBe(1);
  });

  it('states a failed save, changes nothing else, and saves on a retry', async () => {
    const hook = await walkedThrough();
    const before = hook.result.current.state;
    holeAnswer = () => ({ status: 502, body: { status: 'upstream', message: 'The store is not configured.' } });

    act(() => hook.result.current.actions.saveHole());
    await settle();

    const failed = hook.result.current.state;
    expect(failed.save).toEqual({ status: 'failed', message: 'The store is not configured.' });
    expect(failed.screen).toBe('review');
    expect(failed.holeStatus[0]).toBe(before.holeStatus[0]);
    expect(failed.savedHoles).toEqual({});
    expect(failed.shapes).toBe(before.shapes);
    expect(failed.step).toBe(before.step);
    expect(hook.result.current.derived.canSave).toBe(true);

    holeAnswer = echoSavedHole;
    act(() => hook.result.current.actions.saveHole());
    await settle();

    expect(hook.result.current.state.screen).toBe('complete');
    expect(hook.result.current.state.holeStatus[0]).toBe('saved');
  });

  it('saves an untouched OpenStreetMap line as OSM’s, pointing at the way it came from', async () => {
    const { result } = openedOnHole(0, osmHolding());
    act(() => result.current.actions.confirmLine());
    act(() => result.current.actions.cancelProposals());
    act(() => result.current.actions.confirmLocate());

    expect(holeToSave(result.current.state)).toMatchObject({ lineSource: 'osm', osmHoleId: 'way/671717506', features: [] });
  });
});

describe('a course with holes already saved', () => {
  const savedLine = lineOf(540);
  const savedHoleTwo: SavedHole = {
    courseId: 'pebble',
    holeNumber: 2,
    par: 5,
    playingLine: { type: 'LineString', coordinates: savedLine },
    lineSource: 'drawn',
    osmHoleId: null,
    features: [
      {
        kind: 'green',
        geometry: squareAround(savedLine[1]),
        origin: 'drawn',
        edited: false,
        osmId: null,
        osmAction: 'create',
        teeSets: [],
        label: null,
        osmTags: { golf: 'green' },
        proposal: null,
      },
      {
        kind: 'bunker',
        geometry: squareAround([savedLine[1][0] + 0.0005, savedLine[1][1]]),
        origin: 'drawn',
        edited: false,
        osmId: null,
        osmAction: 'create',
        teeSets: [],
        label: null,
        osmTags: { golf: 'bunker', natural: 'sand' },
        proposal: null,
      },
    ],
    savedAt: '2026-09-01T09:00:00Z',
  };

  it('marks the saved holes saved on the board, and skips them for the next hole', () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(), { holes: [savedHoleTwo] }));

    expect(hook.result.current.state.holeStatus).toEqual(['complete', 'saved', 'unmapped']);
    expect(hook.result.current.state.savedHoles[2]).toBe(savedHoleTwo);

    act(() => hook.result.current.actions.openHole(0));
    act(() => hook.result.current.actions.nextHole());
    expect(hook.result.current.state.holeIndex).toBe(2);
  });

  it('opens a saved hole on the line saved for it, asking about it again, with the saved shapes as context', () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(), { holes: [savedHoleTwo] }));

    act(() => hook.result.current.actions.openHole(1));

    const { state, derived } = hook.result.current;
    expect(state.mode).toBe('locate');
    expect(state.locate.points).toEqual(savedLine);
    expect(state.locate.finished).toBe(false);
    expect(state.locate.source).toBe('drawn');
    expect(state.previous).toBe(savedHoleTwo.features);
    expect(state.lastAction).toBe('You saved this hole before — its line and 2 shapes are on the map.');
    const saved = derived.features.filter((f) => f.properties.status === 'saved');
    expect(saved.map((f) => [f.properties.kind, f.properties.label])).toEqual([
      ['green', 'saved green'],
      ['bunker', 'saved bunker'],
    ]);
  });

  /*
   * `edited` means "an OpenStreetMap line the contributor has dragged", so a
   * line the contributor drew reopens with it unset, however it was saved.
   */
  it('reopens a saved drawn line exactly as a drawn line: not “edited”', () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(), { holes: [savedHoleTwo] }));
    act(() => hook.result.current.actions.openHole(1));

    expect(hook.result.current.state.locate).toEqual({ points: savedLine, finished: false, source: 'drawn', edited: false });
  });

  it('prefers the saved line over OpenStreetMap’s, and keeps where it came from', () => {
    const moved: LngLat[] = [PEBBLE_TEE, [PEBBLE_TURN[0], PEBBLE_TURN[1] + 0.0001], PEBBLE_GREEN];
    const savedHoleOne: SavedHole = {
      ...savedHoleTwo,
      holeNumber: 1,
      par: 4,
      playingLine: { type: 'LineString', coordinates: moved },
      lineSource: 'osm_edited',
      osmHoleId: 'way/671717506',
      features: [],
    };
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding([osmGreen()]), { holes: [savedHoleOne] }));
    expect(hook.result.current.state.holeStatus[0]).toBe('saved');

    act(() => hook.result.current.actions.openHole(0));

    const { state } = hook.result.current;
    expect(state.locate).toEqual({ points: moved, finished: false, source: 'osm', edited: true });
    expect(state.osmHoleId).toBe('way/671717506');
    /* What OpenStreetMap outlines is still context. */
    expect(state.existing.map((f) => f.id)).toEqual(['way/820001']);
    /* Saved again untouched, it is still OSM's line as edited. */
    expect(holeToSave(state)?.lineSource).toBe('osm_edited');
  });

  it('opens a saved OSM line as OSM’s own when it was saved untouched', () => {
    const hook = renderHook(() => useMapper());
    const savedOsm: SavedHole = { ...savedHoleTwo, holeNumber: 1, lineSource: 'osm', osmHoleId: 'way/671717506' };
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding(), { holes: [savedOsm] }));
    act(() => hook.result.current.actions.openHole(0));

    expect(hook.result.current.state.locate).toMatchObject({ source: 'osm', edited: false });
    expect(hook.result.current.derived.lineFromOsm).toBe(true);
  });
});

describe('the course boundary', () => {
  const edge: Polygon = squareAround([-121.945, 36.565], 0.004);

  it('saves a moved edge to the course and says so; an unmoved one sends nothing', async () => {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, osmHolding()));
    expect(hook.result.current.state.screen).toBe('boundary');

    act(() => hook.result.current.actions.saveBoundary());
    expect(fetchCalls()).toHaveLength(0);

    act(() => hook.result.current.actions.moveBoundary(edge));
    act(() => hook.result.current.actions.saveBoundary());
    expect(hook.result.current.state.boundary.save).toEqual({ status: 'saving' });
    await settle();

    const [url, init] = fetchCalls()[0];
    expect(String(url)).toMatch(/\/v1\/courses\/pebble\/boundary$/);
    expect(JSON.parse(init.body)).toEqual({ osm_id: 'relation/3741806', geometry: edge, edited: true });
    expect(hook.result.current.state.boundary).toEqual({
      edited: edge,
      save: { status: 'saved', at: '2026-09-19T10:00:00Z' },
    });

    act(() => hook.result.current.actions.resetBoundary());
    expect(hook.result.current.state.boundary).toEqual({ edited: null, save: { status: 'idle' } });
  });

  it('opens a course on the edge saved for it before', () => {
    const hook = renderHook(() => useMapper());
    act(() =>
      hook.result.current.actions.openCourse(SESSION, osmHolding(), {
        boundary: { courseId: 'pebble', osmId: 'relation/3741806', geometry: edge, edited: true, savedAt: '2026-09-01T09:00:00Z' },
      }),
    );

    expect(hook.result.current.state.boundary).toEqual({
      edited: edge,
      save: { status: 'saved', at: '2026-09-01T09:00:00Z' },
    });
  });
});

describe('labels on real geometry', () => {
  /** A wide, flat polygon and a tall, thin one — different centroids by construction. */
  const WIDE: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-121.95, 36.57],
        [-121.94, 36.57],
        [-121.94, 36.5705],
        [-121.95, 36.5705],
        [-121.95, 36.57],
      ],
    ],
  };
  const TALL: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-121.9, 36.5],
        [-121.8995, 36.5],
        [-121.8995, 36.52],
        [-121.9, 36.52],
        [-121.9, 36.5],
      ],
    ],
  };

  it('anchors each label at its own shape’s centroid', () => {
    const [water, bunker] = shapesFromProposals([
      { ...proposal('p-water', 'water', AT.water), geometry: WIDE },
      { ...proposal('p-bunker', 'bunker', AT.bunker1), geometry: TALL },
    ]);
    const derived = computeDerived(
      stateWith({
        mode: 'ready',
        step: STEPS.length,
        locate: { points: PEBBLE_LINE, finished: true, source: 'drawn', edited: false },
        shapes: [
          { ...water, confirmed: true },
          { ...bunker, confirmed: true },
        ],
      }),
    );

    const byKey = new Map(derived.labels.map((label) => [label.key, label]));
    expect(byKey.get('p-water')?.position).toEqual(labelPoint(WIDE));
    expect(byKey.get('p-bunker')?.position).toEqual(labelPoint(TALL));
    expect(byKey.get('p-water')?.text).toBe('water');
    expect(byKey.get('p-bunker')?.text).toBe('bunker');
    expect(byKey.get('p-water')?.position).not.toEqual(byKey.get('p-bunker')?.position);
    /* The ring is held open for the editor and closed again for drawing. */
    expect(outlinePolygon(water.ring)).toEqual(WIDE);
  });

  it('anchors the tee and green labels on the points the contributor placed', () => {
    const derived = drawn(PEBBLE_LINE);
    const byKey = new Map(derived.labels.map((label) => [label.key, label]));

    expect(byKey.get('locate-tee')?.position).toEqual(PEBBLE_TEE);
    expect(byKey.get('locate-green')?.position).toEqual(PEBBLE_GREEN);
  });

  it('draws every proposal as a suggestion on arrival and captions only the ones being asked about (R8)', async () => {
    const hook = await openedWith([
      proposal('p-tee', 'tee', AT.backTee),
      proposal('p-green', 'green', AT.green),
      proposal('p-b1', 'bunker', AT.bunker1),
    ]);

    const shapes = hook.result.current.derived.features.filter((f) => f.properties.shapeId);
    expect(shapes).toHaveLength(3);
    for (const feature of shapes) expect(feature.properties.status).toBe('proposed');
    /* The tee box is the one asked about; the green and sand wait their turn, uncaptioned. */
    const captioned = hook.result.current.derived.labels.filter((l) => l.key.startsWith('p-'));
    expect(captioned.map((l) => [l.key, l.text, l.active])).toEqual([['p-tee', 'blue tee', true]]);
  });
});

/**
 * A detection answer is only ever about the hole the contributor is still on.
 *
 * The success handler resets the shapes, the tee boxes and the step — which is
 * right when the answer is the one being waited for, and is the deletion of
 * somebody's work when it is not. Every path out of the wait has to drop the
 * request behind it.
 */
describe('a detection answer that lands after the contributor moved on', () => {
  /** On hole 1, with a confirmed line and a request left hanging. */
  function waitingOnDetection() {
    const hook = openedOnHole(0);
    const { result } = hook;
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));
    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));
    /* Confirming the line is the request — no second ask. */
    act(() => result.current.actions.confirmLine());

    expect(result.current.state.detect.status).toBe('working');
    expect(detection.pending).toHaveLength(1);
    return hook;
  }

  /** The answer nobody is waiting for any more, delivered late — with shapes in it. */
  async function landsLate() {
    await act(async () => {
      detection.pending[0]({
        status: 'ok',
        jobId: 'job-late',
        proposals: [proposal('p-late-green', 'green', AT.green), proposal('p-late-tee', 'tee', AT.backTee)],
        imagery: null,
        missingTeeSets: [],
      });
    });
  }

  it('cannot delete the hole a contributor mapped by hand after carrying on without detection (R12)', async () => {
    const hook = waitingOnDetection();
    const { result } = hook;

    /* Not worth waiting for: keep the line and map the hole by hand instead. */
    act(() => result.current.actions.confirmLocate());
    expect(result.current.state.mode).toBe('ready');
    /* Nothing is being waited for, so nothing says it is. */
    expect(result.current.state.detect.status).toBe('idle');

    act(() => result.current.actions.accept()); // no blue tee
    act(() => result.current.actions.accept()); // no red tee
    act(() => result.current.actions.runAction('find-green'));
    act(() => result.current.actions.onMapClick(AT.green));
    act(() => result.current.actions.confirmNew());
    const mapped = result.current.state;
    expect(mapped.step).toBe(stepIndex('fairway'));

    await landsLate();

    expect(result.current.state.shapes).toBe(mapped.shapes);
    expect(result.current.state.shapes.map((s) => [s.id, s.confirmed])).toEqual([['drawn-1', true]]);
    expect(result.current.state.teeBoxes).toEqual({ blue: null, red: null });
    expect(result.current.state.step).toBe(stepIndex('fairway'));
    /* And the late answer is not adopted at all, not even as an idle result. */
    expect(result.current.state.detect.status).toBe('idle');
  });

  it('ignores an answer to a request the contributor cancelled', async () => {
    const { result } = waitingOnDetection();

    act(() => result.current.actions.cancelProposals());
    expect(result.current.state.detect.status).toBe('idle');
    expect(result.current.state.lastAction).toMatch(/Stopped looking/);

    await landsLate();

    expect(result.current.state.shapes).toEqual([]);
    expect(result.current.state.mode).toBe('locate');
    expect(result.current.state.detect.status).toBe('idle');
  });

  it('cannot fill another hole with the shapes of the one the contributor left', async () => {
    const { result } = waitingOnDetection();

    act(() => result.current.actions.openHole(1));
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));

    await landsLate();

    expect(result.current.state.holeIndex).toBe(1);
    expect(result.current.state.mode).toBe('locate');
    expect(result.current.state.locate.points).toEqual([PEBBLE_TEE]);
    expect(result.current.state.shapes).toEqual([]);
    expect(result.current.state.detect.status).toBe('idle');
  });

  it('cannot reopen a hole that has already been saved', async () => {
    const { result } = waitingOnDetection();

    act(() => result.current.actions.patch({ mode: 'ready', step: STEPS.length }));
    act(() => result.current.actions.saveHole());
    await settle();
    expect(result.current.state.screen).toBe('complete');
    expect(result.current.state.detect.status).toBe('idle');

    await landsLate();

    expect(result.current.state.screen).toBe('complete');
    expect(result.current.state.holeStatus[0]).toBe('saved');
    expect(result.current.state.shapes).toEqual([]);
    expect(result.current.state.detect.status).toBe('idle');
  });
});

describe('framing the map', () => {
  it('frames the course while nothing is drawn, and the hole once something is', () => {
    const empty = computeDerived(stateWith({}));
    const withLine = drawn(PEBBLE_LINE);

    expect(empty.mapBounds).not.toBeNull();
    expect(withLine.mapBounds).not.toBeNull();
    expect(withLine.mapBounds).not.toEqual(empty.mapBounds);

    /* The hole frame contains the drawn line and is tighter than the course. */
    const [w, s, e, n] = withLine.mapBounds!;
    expect(w).toBeLessThan(PEBBLE_TEE[0]);
    expect(e).toBeGreaterThan(PEBBLE_GREEN[0]);
    expect(s).toBeLessThan(PEBBLE_TEE[1]);
    expect(n).toBeGreaterThan(PEBBLE_GREEN[1]);
    expect(e - w).toBeLessThan(empty.mapBounds![2] - empty.mapBounds![0]);
  });
});
