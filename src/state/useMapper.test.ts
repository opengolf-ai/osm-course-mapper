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
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import { labelPoint, lineYards, yardsBetween, type LngLat } from '../geo/coords';
import type { CourseDetail } from '../api/types';
import type { DetectResult, Proposal, ProposalKind } from '../api/detect';

/**
 * Detection is stubbed at the client boundary, with every request left hanging
 * until a test resolves it by hand. That is the only way to say *when* an answer
 * lands, and "after the contributor gave up on it" is the case that matters.
 *
 * `recordDecisions` stays real: what it posts is asserted below against a
 * stubbed `fetch`.
 */
const detection = vi.hoisted(() => {
  const pending: Array<(result: DetectResult) => void> = [];
  return {
    pending,
    request: vi.fn(
      () =>
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

import { STEPS } from '../data/course';
import { buildCourseSession } from './courseSession';
import {
  INITIAL,
  LOCATE_CHECK_YOUR_WORK,
  LOCATE_CLOSE_ENOUGH,
  YARDAGE_TOLERANCE_FRACTION,
  computeDerived,
  useMapper,
  type MapperState,
} from './useMapper';

/* Pebble Beach hole 1, OSM way 671717506: tee, the corner, the green. */
const PEBBLE_TEE: LngLat = [-121.9495343, 36.5693904];
const PEBBLE_TURN: LngLat = [-121.9477382, 36.5705598];
const PEBBLE_GREEN: LngLat = [-121.9461359, 36.5706059];

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
  return computeDerived(stateWith({ locate: { points, finished: true }, ...overrides }));
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

describe('the drawn playing line', () => {
  it('measures a dogleg along its path, longer than its chord and inside the card tolerance', () => {
    const derived = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN]);

    const chord = yardsBetween(PEBBLE_TEE, PEBBLE_GREEN);
    expect(Math.round(chord)).toBe(363);
    expect(derived.locateYds).toBe(382);
    expect(derived.locateYds).toBeGreaterThan(chord);

    expect(derived.cardYds).toBe(380);
    expect(derived.locateWithinTolerance).toBe(true);
    expect(derived.locateVerdict).toBe(LOCATE_CLOSE_ENOUGH);
  });

  it('stores the line as an ordered WGS84 LineString, the geometry OSM holds for golf=hole', () => {
    const derived = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN]);

    expect(derived.locateLine).toEqual({
      type: 'LineString',
      coordinates: [PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN],
    });
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
    const fromBlue = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN], { teeSet: 'blue' });
    const fromRed = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN], { teeSet: 'red' });

    expect(fromBlue.cardYds).toBe(380);
    expect(fromRed.cardYds).toBe(310);
    expect(fromBlue.locateTolerance).not.toBe(fromRed.locateTolerance);
    /* The same 382-yard line: fine off the blues, long off the reds. */
    expect(fromBlue.locateWithinTolerance).toBe(true);
    expect(fromRed.locateWithinTolerance).toBe(false);
  });
});

describe('drawing, undoing and finishing', () => {
  function openedOnHoleOne() {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, { status: 'absent' }));
    act(() => hook.result.current.actions.openHole(0));
    return hook;
  }

  it('starts on the line even for a hole OpenStreetMap already holds', () => {
    /*
     * `complete` means OSM has the hole, not that this app has its geometry —
     * the lookup carries which hole numbers exist, not their shape. Opening one
     * into the review sequence walked the contributor through empty questions
     * ("we did not find a green here") over a hole with nothing drawn on it and
     * no way to draw one.
     */
    const hook = renderHook(() => useMapper());
    act(() =>
      hook.result.current.actions.openCourse(SESSION, {
        status: 'found',
        course: {
          osmId: 'relation/3741806',
          name: 'Pebble Beach Golf Links',
          boundary: { type: 'Polygon', coordinates: [[[-121.95, 36.56], [-121.94, 36.56], [-121.94, 36.57], [-121.95, 36.56]]] },
          acres: 176,
          bbox: [-121.95, 36.56, -121.94, 36.57],
          /* Hole 1 is already on the map, so its status is `complete`. */
          mappedHoleRefs: [1],
          landmarks: [],
          matchedBy: 'name',
        },
      }),
    );
    expect(hook.result.current.state.holeStatus[0]).toBe('complete');

    act(() => hook.result.current.actions.openHole(0));

    expect(hook.result.current.state.mode).toBe('locate');
    /* And nothing is being reviewed, so no empty question is asked. */
    expect(hook.result.current.derived.proposals).toEqual([]);
  });

  it('places tee, turn points and green in the order they are clicked', () => {
    const { result } = openedOnHoleOne();
    expect(result.current.state.mode).toBe('locate');

    act(() => result.current.actions.onMapClick(PEBBLE_TEE));
    act(() => result.current.actions.onMapClick(PEBBLE_TURN));
    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));

    expect(result.current.state.locate.points).toEqual([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN]);
    expect(result.current.derived.locateYds).toBe(382);
  });

  it('undoes the last placed point and restores the measurement before it', () => {
    const { result } = openedOnHoleOne();
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

  it('refuses to finish a line of fewer than two points', () => {
    const { result } = openedOnHoleOne();
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));

    expect(result.current.derived.canFinish).toBe(false);
    act(() => result.current.actions.finishLine());
    expect(result.current.state.locate.finished).toBe(false);
    expect(result.current.derived.locateDone).toBe(false);

    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));
    expect(result.current.derived.canFinish).toBe(true);
    act(() => result.current.actions.finishLine());
    expect(result.current.derived.locateDone).toBe(true);
  });

  it('keeps the A / N / M shortcuts inert while the map is in click-to-place mode', () => {
    const { result } = openedOnHoleOne();
    const stepBefore = result.current.state.step;

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });

    expect(result.current.state.step).toBe(stepBefore);
    expect(result.current.state.removed).toEqual([]);
    expect(result.current.state.addMode).toBeNull();

    /* Out of click-to-place, the same key does what it always did. */
    act(() => result.current.actions.patch({ mode: 'ready' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.state.step).toBe(stepBefore + 1);
  });

  it('stores a "missed one" feature as GeoJSON rather than an SVG path string', () => {
    const { result } = openedOnHoleOne();
    act(() => result.current.actions.patch({ mode: 'ready', addMode: 'water' }));
    act(() => result.current.actions.onMapClick(PEBBLE_TURN));

    const added = result.current.state.extra[0];
    expect(added.label).toBe('water');
    expect(added.feature.type).toBe('Feature');
    expect(added.feature.geometry.type).toBe('Polygon');
    expect(added.feature.properties.kind).toBe('water');
    expect(Object.prototype.hasOwnProperty.call(added, 'd')).toBe(false);

    /* Real coordinates, near where the click landed — not viewBox units. */
    const ring = added.feature.geometry.coordinates[0];
    expect(ring.length).toBeGreaterThan(3);
    for (const [lng, lat] of ring) {
      expect(Math.abs(lng - PEBBLE_TURN[0])).toBeLessThan(0.01);
      expect(Math.abs(lat - PEBBLE_TURN[1])).toBeLessThan(0.01);
    }
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

  it('anchors each label at its own feature centroid', () => {
    const derived = computeDerived(
      stateWith({
        mode: 'ready',
        extra: [
          {
            id: 'extra0',
            label: 'water',
            feature: { type: 'Feature', properties: { kind: 'water' }, geometry: WIDE },
          },
          {
            id: 'extra1',
            label: 'bunker',
            feature: { type: 'Feature', properties: { kind: 'bunker' }, geometry: TALL },
          },
        ],
      }),
    );

    const byKey = new Map(derived.labels.map((label) => [label.key, label]));
    expect(byKey.get('extra0')?.position).toEqual(labelPoint(WIDE));
    expect(byKey.get('extra1')?.position).toEqual(labelPoint(TALL));
    expect(byKey.get('extra0')?.position).not.toEqual(byKey.get('extra1')?.position);
  });

  it('anchors the tee and green labels on the points the contributor placed', () => {
    const derived = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN]);
    const byKey = new Map(derived.labels.map((label) => [label.key, label]));

    expect(byKey.get('locate-tee')?.position).toEqual(PEBBLE_TEE);
    expect(byKey.get('locate-green')?.position).toEqual(PEBBLE_GREEN);
  });
});

/**
 * The per-feature confirmation sequence (R7, R8, R10, R14).
 *
 * Every assertion here is about one guarantee: a proposal becomes confirmed
 * geometry only through an explicit human act about that one feature. A test that
 * merely counted confirmations would pass on a batch, so each case pins down
 * *which* proposal moved and that the others did not.
 */
describe('reviewing proposals one at a time', () => {
  /** A small square near the hole. Distinct per proposal, so geometry is traceable. */
  function squareAt(lng: number, lat: number): Polygon {
    return {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + 0.0002, lat],
          [lng + 0.0002, lat + 0.0002],
          [lng, lat + 0.0002],
          [lng, lat],
        ],
      ],
    };
  }

  let nextOffset = 0;
  function proposal(id: string, kind: ProposalKind): Proposal {
    nextOffset += 1;
    return {
      id,
      kind,
      geometry: squareAt(-121.947 + nextOffset * 0.0005, 36.5705),
      confidence: 0.82,
      areaSquareMeters: 640,
      vertexCount: 5,
      notes: [],
      teeSet: null,
      acquired: '2023-07-04',
      gsdMeters: 0.6,
      source: 'USDA NAIP via Microsoft Planetary Computer',
      modelId: 'facebook/sam2-hiera-large',
      itemId: 'ca_m_3812_2023',
    };
  }

  const stepIndex = (id: string) => STEPS.findIndex((step) => step.id === id);

  /** The hook, on hole 1, with a finished line and a detection answer already in. */
  function openedWith(proposals: Proposal[], holeIndex = 0) {
    const hook = renderHook(() => useMapper());
    act(() => hook.result.current.actions.openCourse(SESSION, { status: 'absent' }));
    act(() => hook.result.current.actions.openHole(holeIndex));
    act(() =>
      hook.result.current.actions.patch({
        mode: 'ready',
        locate: { points: [PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN], finished: true },
        detect: {
          status: 'ready',
          jobId: 'job-1',
          proposals,
          imagery: null,
          missingTeeSets: [],
        },
      }),
    );
    return hook;
  }

  /** Walk to a named step without deciding anything on the way. */
  function goToStep(actions: { patch: (p: Partial<MapperState>) => void }, id: string) {
    act(() => actions.patch({ step: stepIndex(id), proposalIndex: 0 }));
  }

  beforeEach(() => {
    nextOffset = 0;
    /* No service in a unit test: decisions post into a stub and nothing waits. */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })),
    );
  });

  it('renders every proposal as a suggestion, and confirms none of them on arrival (R8)', () => {
    const { result } = openedWith([
      proposal('p-green', 'green'),
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
    ]);

    const drawnFeatures = result.current.derived.features.filter((f) => f.properties.kind !== 'hole');
    expect(drawnFeatures).toHaveLength(3);
    for (const feature of drawnFeatures) {
      expect(feature.properties.status).toBe('proposed');
    }
    expect(result.current.state.confirmed).toEqual([]);
    /* And nothing on the map claims to be confirmed geometry. */
    expect(drawnFeatures.some((f) => f.properties.status === 'confirmed')).toBe(false);
  });

  it('confirms only the active proposal and advances within the step, not past it (R7)', () => {
    const { result } = openedWith([
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
      proposal('p-bunker-3', 'bunker'),
    ]);
    goToStep(result.current.actions, 'bunkers');

    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-1');
    expect(result.current.derived.stepProposalCount).toBe(3);

    act(() => result.current.actions.accept());

    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
    expect(result.current.state.step).toBe(stepIndex('bunkers'));
    expect(result.current.state.proposalIndex).toBe(1);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-2');

    /* The other two are still suggestions on the map. */
    const byId = new Map(
      result.current.derived.features
        .filter((f) => typeof f.properties.proposalId === 'string')
        .map((f) => [f.properties.proposalId as string, f.properties.status]),
    );
    expect(byId.get('p-bunker-1')).toBe('confirmed');
    expect(byId.get('p-bunker-2')).toBe('proposed');
    expect(byId.get('p-bunker-3')).toBe('proposed');

    /* Only after the last one does the step move on. */
    act(() => result.current.actions.accept());
    act(() => result.current.actions.accept());
    expect(result.current.state.step).toBe(stepIndex('bunkers') + 1);
    expect(result.current.state.confirmed).toEqual(['p-bunker-1', 'p-bunker-2', 'p-bunker-3']);
  });

  it('records a rejection with its classified kind and geometry rather than discarding it (R10)', () => {
    const rejected = proposal('p-bunker-1', 'bunker');
    const { result } = openedWith([rejected, proposal('p-bunker-2', 'bunker')]);
    goToStep(result.current.actions, 'bunkers');

    act(() => result.current.actions.reject());

    const recorded = result.current.derived.rejectedHere;
    expect(recorded).toHaveLength(1);
    expect(recorded[0].kind).toBe('bunker');
    expect(recorded[0].geometry).toEqual(rejected.geometry);
    expect(recorded[0].confidence).toBe(0.82);
    expect(recorded[0].acquired).toBe('2023-07-04');

    /* Rejected is not confirmed, and it leaves the map. */
    expect(result.current.state.confirmed).toEqual([]);
    expect(
      result.current.derived.features.some((f) => f.properties.proposalId === 'p-bunker-1'),
    ).toBe(false);
    /* And the next proposal in the step is the one now being asked about. */
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-2');
  });

  it('marks proposed water a hazard only on an explicit in-play answer (R14)', () => {
    const { result } = openedWith([proposal('p-water-1', 'water'), proposal('p-water-2', 'water')]);
    goToStep(result.current.actions, 'water');

    const hazardOf = (id: string) =>
      result.current.derived.features.find((f) => f.properties.proposalId === id)?.properties
        .hazard;

    /* Proposed and unanswered: water on the imagery, not a hazard on the map. */
    expect(hazardOf('p-water-1')).toBe(false);

    act(() => result.current.actions.answerInPlay(false));
    expect(result.current.state.confirmed).toContain('p-water-1');
    expect(result.current.state.hazards).not.toContain('p-water-1');
    expect(hazardOf('p-water-1')).toBe(false);

    act(() => result.current.actions.answerInPlay(true));
    expect(result.current.state.confirmed).toContain('p-water-2');
    expect(result.current.state.hazards).toContain('p-water-2');
    expect(hazardOf('p-water-2')).toBe(true);
  });

  it('keeps a step with nothing proposed, with its add action live', () => {
    const { result } = openedWith([proposal('p-green', 'green')]);
    goToStep(result.current.actions, 'bunkers');

    expect(result.current.derived.stepProposalCount).toBe(0);
    expect(result.current.derived.activeProposal).toBeNull();
    /* The step is shown, and it says nothing came back rather than saying nothing. */
    expect(result.current.derived.stepTitle).toBe(STEPS[stepIndex('bunkers')].empty.title);
    expect(result.current.derived.stepAccept).toBe(STEPS[stepIndex('bunkers')].empty.accept);

    act(() => result.current.actions.missing());
    expect(result.current.state.addMode).toBe('bunker');
  });

  it('keeps a rejection after navigating to another hole and back (R10)', () => {
    const { result } = openedWith([proposal('p-bunker-1', 'bunker')]);
    goToStep(result.current.actions, 'bunkers');
    act(() => result.current.actions.reject());
    expect(result.current.derived.rejectedHere).toHaveLength(1);

    act(() => result.current.actions.openHole(1));
    expect(result.current.derived.rejectedHere).toHaveLength(0);

    act(() => result.current.actions.openHole(0));
    expect(result.current.derived.rejectedHere).toHaveLength(1);
    expect(result.current.derived.rejectedHere[0].id).toBe('p-bunker-1');
    /* Keyed by hole number, not by array position in the session. */
    expect(Object.keys(result.current.state.rejections)).toEqual(['1']);
  });

  it('drives the keyboard shortcuts off the active proposal, one key one feature', () => {
    const { result } = openedWith([
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
    ]);
    goToStep(result.current.actions, 'bunkers');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
    expect(result.current.state.step).toBe(stepIndex('bunkers'));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
    });
    expect(result.current.state.removed).toEqual(['p-bunker-2']);
    expect(result.current.derived.rejectedHere.map((p) => p.id)).toEqual(['p-bunker-2']);
    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
  });

  it('confirms nothing while the A key auto-repeats under a held finger', () => {
    const { result } = openedWith([
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
      proposal('p-bunker-3', 'bunker'),
    ]);
    goToStep(result.current.actions, 'bunkers');

    /* What the OS sends while `a` is held down. Without the repeat guard this
     * walks the whole step through to confirmed and posts every one of them. */
    act(() => {
      for (let repeat = 0; repeat < 6; repeat += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true }));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', repeat: true }));
    });

    expect(result.current.state.confirmed).toEqual([]);
    expect(result.current.state.removed).toEqual([]);
    expect(result.current.state.proposalIndex).toBe(0);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-1');
    /* Nothing reached the decision store either — a held key is not a decision. */
    expect(globalThis.fetch).not.toHaveBeenCalled();

    /* A deliberate press, on the same key, still answers about the one feature. */
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-2');
  });

  it('drops an answer bound to a proposal that is no longer the one being asked about', () => {
    const { result } = openedWith([
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
    ]);
    goToStep(result.current.actions, 'bunkers');

    act(() => result.current.actions.accept('p-bunker-1'));
    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-2');

    /* A second answer still carrying the first id — a queued or repeated event —
     * must not be spent on the feature that happens to be next. */
    act(() => result.current.actions.accept('p-bunker-1'));
    act(() => result.current.actions.reject('p-bunker-1'));
    act(() => result.current.actions.answerInPlay(true, 'p-bunker-1'));

    expect(result.current.state.confirmed).toEqual(['p-bunker-1']);
    expect(result.current.state.removed).toEqual([]);
    expect(result.current.state.hazards).toEqual([]);
    expect(result.current.state.proposalIndex).toBe(1);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-2');

    /* Bound to the feature actually on screen, the same call goes through. */
    act(() => result.current.actions.accept('p-bunker-2'));
    expect(result.current.state.confirmed).toEqual(['p-bunker-1', 'p-bunker-2']);
  });

  it('never carries an undecided proposal past on the back of an added feature (R7)', () => {
    const { result } = openedWith([
      proposal('p-bunker-1', 'bunker'),
      proposal('p-bunker-2', 'bunker'),
    ]);
    goToStep(result.current.actions, 'bunkers');

    /* Adding one we missed is not an answer about the one we proposed, so the
     * step stays where it is and confirms nothing. */
    act(() => result.current.actions.advance('Thanks — that one was on us.'));

    expect(result.current.state.step).toBe(stepIndex('bunkers'));
    expect(result.current.state.proposalIndex).toBe(0);
    expect(result.current.state.confirmed).toEqual([]);
    expect(result.current.derived.activeProposal?.id).toBe('p-bunker-1');
  });

  it('posts each decision to the store with its geometry and provenance, and no identifier (R15)', async () => {
    const { result } = openedWith([proposal('p-green', 'green')]);
    goToStep(result.current.actions, 'green');

    await act(async () => {
      result.current.actions.accept();
    });

    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(String(call[0])).toContain('/v1/decisions');
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.course_id).toBe('pebble');
    expect(body.hole_number).toBe(1);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].kind).toBe('green');
    expect(body.decisions[0].outcome).toBe('confirmed');
    expect(body.decisions[0].geometry.type).toBe('Polygon');
    expect(body.decisions[0].provenance.item_id).toBe('ca_m_3812_2023');
    /* The store holds no contributor, session or device identifier — and is sent none. */
    expect(JSON.stringify(body)).not.toMatch(/user|session|device|contributor/i);
  });
});

/**
 * A detection answer is only ever about the hole the contributor is still on.
 *
 * The success handler resets `confirmed`, `removed`, `hazards`, `extra`, `step`
 * and `proposalIndex` — which is right when the answer is the one being waited
 * for, and is the deletion of somebody's work when it is not. Every path out of
 * the wait has to drop the request behind it.
 */
describe('a detection answer that lands after the contributor moved on', () => {
  /** On hole 1, with a finished line and a request left hanging. */
  function waitingOnDetection() {
    const hook = renderHook(() => useMapper());
    const { result } = hook;
    act(() => result.current.actions.openCourse(SESSION, { status: 'absent' }));
    act(() => result.current.actions.openHole(0));
    act(() => result.current.actions.onMapClick(PEBBLE_TEE));
    act(() => result.current.actions.onMapClick(PEBBLE_GREEN));
    /* Finishing the line is the request — no second ask. */
    act(() => result.current.actions.finishLine());

    expect(result.current.state.detect.status).toBe('working');
    expect(detection.pending).toHaveLength(1);
    return hook;
  }

  /** The answer nobody is waiting for any more, delivered late. */
  async function landsLate() {
    await act(async () => {
      detection.pending[0]({
        status: 'ok',
        jobId: 'job-late',
        proposals: [],
        imagery: null,
        missingTeeSets: [],
      });
    });
  }

  beforeEach(() => {
    detection.pending.length = 0;
    detection.request.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })),
    );
  });

  it('cannot delete the hole a contributor mapped by hand after saving the line (R12)', async () => {
    const { result } = waitingOnDetection();

    /* Not worth waiting for: save the line and map the hole by hand instead. */
    act(() => result.current.actions.confirmLocate());
    expect(result.current.state.mode).toBe('ready');
    /* Nothing is being waited for, so nothing says it is. */
    expect(result.current.state.detect.status).toBe('idle');

    act(() => result.current.actions.patch({ addMode: 'water' }));
    act(() => result.current.actions.onMapClick(PEBBLE_TURN));
    act(() =>
      result.current.actions.patch({
        confirmed: ['by-hand-green'],
        removed: ['by-hand-bunker'],
        hazards: ['by-hand-green'],
        step: 2,
        proposalIndex: 0,
      }),
    );

    await landsLate();

    expect(result.current.state.confirmed).toEqual(['by-hand-green']);
    expect(result.current.state.removed).toEqual(['by-hand-bunker']);
    expect(result.current.state.hazards).toEqual(['by-hand-green']);
    expect(result.current.state.extra).toHaveLength(1);
    expect(result.current.state.step).toBe(2);
    /* And the late answer is not adopted at all, not even as an idle result. */
    expect(result.current.state.detect.status).toBe('idle');
  });

  it('cannot reopen a hole that has already been uploaded', async () => {
    const { result } = waitingOnDetection();

    act(() => result.current.actions.patch({ mode: 'ready', confirmed: ['by-hand-green'] }));
    act(() => result.current.actions.upload());
    expect(result.current.state.screen).toBe('complete');
    expect(result.current.state.detect.status).toBe('idle');

    await landsLate();

    expect(result.current.state.screen).toBe('complete');
    expect(result.current.state.holeStatus[0]).toBe('complete');
    expect(result.current.state.confirmed).toEqual(['by-hand-green']);
    expect(result.current.state.detect.status).toBe('idle');
  });
});

describe('framing the map', () => {
  it('frames the course while nothing is drawn, and the hole once something is', () => {
    const empty = computeDerived(stateWith({}));
    const withLine = drawn([PEBBLE_TEE, PEBBLE_TURN, PEBBLE_GREEN]);

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
