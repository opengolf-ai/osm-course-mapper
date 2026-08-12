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
import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { labelPoint, lineYards, yardsBetween, type LngLat } from '../geo/coords';
import type { CourseDetail } from '../api/types';
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
