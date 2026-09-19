import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';
import {
  bearingBetween,
  courseFeature,
  editableOutline,
  ellipseAround,
  labelPoint,
  lineYards,
  openRing,
  outlinePolygon,
  playingLine,
  pointInRing,
  polygon,
  polygonAcres,
  yardsAlongToEnd,
  yardsBetween,
  yardsToLine,
  type LngLat,
} from './coords';

/**
 * Pebble Beach Golf Links hole 1 as OpenStreetMap holds it (way 671717506,
 * `golf=hole`, `par=4`, `ref=1`): tee, one turn point, green. The card plays it
 * at 380 yards from the Championship tees.
 */
const PEBBLE_HOLE_1: LngLat[] = [
  [-121.9495343, 36.5693904],
  [-121.9477382, 36.5705598],
  [-121.9461359, 36.5706059],
];

describe('lineYards', () => {
  it('measures a dogleg longer than the straight line between its endpoints', () => {
    const [tee, , green] = PEBBLE_HOLE_1;
    const alongThePath = lineYards(PEBBLE_HOLE_1);
    const chord = lineYards([tee, green]);

    expect(alongThePath).toBeGreaterThan(chord);
    // The chord reads roughly 19 yards short on this hole.
    expect(alongThePath - chord).toBeGreaterThan(10);
  });

  it('equals the distance between the endpoints of a straight two-point line', () => {
    const a: LngLat = [-121.9495343, 36.5693904];
    const b: LngLat = [-121.9461359, 36.5706059];

    expect(lineYards([a, b])).toBeCloseTo(yardsBetween(a, b), 6);
  });

  it('returns zero rather than NaN for a line with a single point', () => {
    expect(lineYards([[-121.9495343, 36.5693904]])).toBe(0);
  });

  it('returns zero for a line with no points', () => {
    expect(lineYards([])).toBe(0);
  });

  it('is unchanged when the points are reversed', () => {
    const forward = lineYards(PEBBLE_HOLE_1);
    const backward = lineYards([...PEBBLE_HOLE_1].reverse());

    expect(backward).toBeCloseTo(forward, 6);
  });

  it("measures a known Pebble Beach hole within tolerance of its card", () => {
    // 380 yards on the card; OSM's drawn line measures ~382.
    expect(lineYards(PEBBLE_HOLE_1)).toBeGreaterThan(365);
    expect(lineYards(PEBBLE_HOLE_1)).toBeLessThan(395);
  });
});

describe('yardsBetween', () => {
  it('returns the expected yardage between two known coordinates', () => {
    // 0.01 degrees of latitude is 1111.95 m on turf's sphere, i.e. 1216.04 yards.
    expect(yardsBetween([0, 0], [0, 0.01])).toBeCloseTo(1216.04, 1);
  });

  it('is zero for a coordinate against itself', () => {
    expect(yardsBetween([-121.9495343, 36.5693904], [-121.9495343, 36.5693904])).toBe(0);
  });
});

describe('polygon and polygonAcres', () => {
  /** A 0.01 x 0.01 degree square at the equator: 1111.95 m a side, 305.53 acres. */
  const square: LngLat[] = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
  ];

  it('converts a known-area square to acres', () => {
    expect(polygonAcres(polygon(square))).toBeCloseTo(305.53, 1);
  });

  it('closes an open ring', () => {
    const ring = polygon(square).coordinates[0];

    expect(ring).toHaveLength(square.length + 1);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it('leaves an already-closed ring alone', () => {
    const closed: LngLat[] = [...square, [0, 0]];

    expect(polygon(closed).coordinates[0]).toHaveLength(closed.length);
  });
});

describe('playingLine', () => {
  it('keeps the drawn points in order as a LineString', () => {
    const line = playingLine(PEBBLE_HOLE_1);

    expect(line.type).toBe('LineString');
    expect(line.coordinates).toEqual(PEBBLE_HOLE_1);
  });

  it('rejects a line that has no green yet', () => {
    expect(() => playingLine([[-121.9495343, 36.5693904]])).toThrow(/two/i);
  });
});

describe('labelPoint', () => {
  it('places a label at the centre of a square', () => {
    const [lng, lat] = labelPoint(
      polygon([
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
      ]),
    );

    expect(lng).toBeCloseTo(0.005, 6);
    expect(lat).toBeCloseTo(0.005, 6);
  });

  it('returns [longitude, latitude] order for a line', () => {
    const [lng, lat] = labelPoint(playingLine(PEBBLE_HOLE_1));

    expect(lng).toBeLessThan(-121);
    expect(lat).toBeGreaterThan(36);
  });
});

describe('courseFeature', () => {
  it('carries the feature kind alongside WGS84 geometry', () => {
    const feature = courseFeature('hole', playingLine(PEBBLE_HOLE_1), { ref: '1' });

    expect(feature.type).toBe('Feature');
    expect(feature.properties.kind).toBe('hole');
    expect(feature.properties.ref).toBe('1');
    expect(feature.geometry.coordinates).toEqual(PEBBLE_HOLE_1);
  });
});

describe('yardsToLine', () => {
  /* A due-north line at Pebble Beach's latitude, a tenth of a degree tall. */
  const NORTH_LINE: LngLat[] = [
    [-121.95, 36.565],
    [-121.95, 36.568],
  ];

  it('measures to the nearest point on a segment, not to the nearest vertex', () => {
    /* Level with the middle of the line — hundreds of yards from either end of
     * it, and a few dozen from the line itself. This is the whole reason the
     * function exists: a bunker halfway down a two-point fairway. */
    const beside: LngLat = [-121.9495, 36.5665];

    const toLine = yardsToLine(beside, NORTH_LINE);
    const toNearestVertex = Math.min(
      yardsBetween(beside, NORTH_LINE[0]),
      yardsBetween(beside, NORTH_LINE[1]),
    );

    expect(toLine).toBeLessThan(60);
    expect(toNearestVertex).toBeGreaterThan(150);
  });

  it('reads zero on the line itself', () => {
    expect(yardsToLine([-121.95, 36.5665], NORTH_LINE)).toBeCloseTo(0, 5);
  });

  it('measures past the ends rather than projecting beyond them', () => {
    /* Directly north of the top of the line: the answer is the distance to that
     * end, not to an infinite line through it. */
    const beyond: LngLat = [-121.95, 36.569];

    expect(yardsToLine(beyond, NORTH_LINE)).toBeCloseTo(yardsBetween(beyond, NORTH_LINE[1]), 0);
  });

  it('takes a LineString as readily as a list of points', () => {
    const point: LngLat = [-121.9495, 36.5665];

    expect(yardsToLine(point, playingLine(NORTH_LINE))).toBeCloseTo(
      yardsToLine(point, NORTH_LINE),
      6,
    );
  });

  it('is infinite against a line with no points at all', () => {
    expect(yardsToLine([-121.95, 36.5665], [])).toBe(Infinity);
  });
});

describe('yardsAlongToEnd', () => {
  const [tee, turn, green] = PEBBLE_HOLE_1;

  it('reads the whole hole, along the dogleg, from the tee', () => {
    /* A local flat projection against turf's sphere: within a yard over 380. */
    expect(yardsAlongToEnd(tee, PEBBLE_HOLE_1)).toBeCloseTo(lineYards(PEBBLE_HOLE_1), 0);
    /* And not the chord: a straight line to the green reads the back tee ~19 yards short. */
    expect(yardsAlongToEnd(tee, PEBBLE_HOLE_1) - yardsBetween(tee, green)).toBeGreaterThan(10);
  });

  it('reads only the second leg from the corner, and nothing from the green', () => {
    expect(yardsAlongToEnd(turn, PEBBLE_HOLE_1)).toBeCloseTo(lineYards([turn, green]), 0);
    expect(yardsAlongToEnd(green, PEBBLE_HOLE_1)).toBeCloseTo(0, 6);
  });

  it('drops a point beside the line onto it before measuring', () => {
    /* Halfway down the first leg, then pushed ~20 yards off it to the south-east:
     * a tee box beside the line is as far out as the spot on the line beside it. */
    const mid: LngLat = [(tee[0] + turn[0]) / 2, (tee[1] + turn[1]) / 2];
    const beside: LngLat = [mid[0] + 0.00012, mid[1] - 0.00012];

    expect(yardsToLine(beside, PEBBLE_HOLE_1)).toBeGreaterThan(10);
    expect(yardsAlongToEnd(beside, PEBBLE_HOLE_1)).toBeCloseTo(yardsAlongToEnd(mid, PEBBLE_HOLE_1), -1);
    expect(Math.abs(yardsAlongToEnd(mid, PEBBLE_HOLE_1) - (lineYards([mid, turn]) + lineYards([turn, green])))).toBeLessThan(1);
  });

  it('measures a point behind the tee from the tee, not beyond it', () => {
    /* Further back than the first point: the projection clamps to the line's start. */
    const behind: LngLat = [tee[0] - (turn[0] - tee[0]) * 0.1, tee[1] - (turn[1] - tee[1]) * 0.1];

    expect(yardsAlongToEnd(behind, PEBBLE_HOLE_1)).toBeCloseTo(yardsAlongToEnd(tee, PEBBLE_HOLE_1), 6);
  });

  it('takes a LineString as readily as a list of points', () => {
    expect(yardsAlongToEnd(tee, playingLine(PEBBLE_HOLE_1))).toBeCloseTo(yardsAlongToEnd(tee, PEBBLE_HOLE_1), 6);
  });

  it('is infinite against no line, and the straight distance against a single point', () => {
    expect(yardsAlongToEnd(tee, [])).toBe(Infinity);
    expect(yardsAlongToEnd(tee, [green])).toBeCloseTo(yardsBetween(tee, green), 6);
  });
});

describe('pointInRing', () => {
  const square: LngLat[] = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
  ];
  /* An L: the square with its north-east quarter cut out. */
  const ell: LngLat[] = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.005],
    [0.005, 0.005],
    [0.005, 0.01],
    [0, 0.01],
  ];

  it('finds a point inside and not one outside', () => {
    expect(pointInRing([0.005, 0.005], square)).toBe(true);
    expect(pointInRing([0.02, 0.005], square)).toBe(false);
    expect(pointInRing([0.005, -0.001], square)).toBe(false);
  });

  it('answers the same for an open ring and a closed one', () => {
    const closed = polygon(square).coordinates[0] as LngLat[];
    for (const point of [[0.005, 0.005], [0.02, 0.005]] as LngLat[]) {
      expect(pointInRing(point, closed)).toBe(pointInRing(point, square));
    }
  });

  it('knows the notch of a concave outline is outside it', () => {
    expect(pointInRing([0.0075, 0.0075], ell)).toBe(false);
    expect(pointInRing([0.0025, 0.0075], ell)).toBe(true);
    expect(pointInRing([0.0075, 0.0025], ell)).toBe(true);
  });

  it('holds nothing inside a degenerate ring', () => {
    expect(pointInRing([0, 0], [])).toBe(false);
  });
});

describe('openRing', () => {
  it('drops the closing duplicate GeoJSON adds, so a corner gets one handle', () => {
    const closed = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(openRing(closed)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('leaves an open ring as it is, and keeps only longitude and latitude', () => {
    expect(
      openRing([
        [0, 0, 12],
        [1, 0, 12],
        [1, 1, 12],
      ]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('does not mutate what it was given', () => {
    const closed = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    openRing(closed);
    expect(closed).toHaveLength(4);
  });
});

describe('editableOutline', () => {
  const square = (lng: number, lat: number, size: number): number[][] => [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];

  it('opens the outer ring of a polygon and carries its holes alongside, opened too', () => {
    const geometry: Polygon = { type: 'Polygon', coordinates: [square(0, 0, 0.01), square(0.004, 0.004, 0.002)] };

    const { ring, inner } = editableOutline(geometry);

    expect(ring).toEqual(openRing(geometry.coordinates[0]));
    expect(ring).toHaveLength(4);
    expect(inner).toEqual([openRing(geometry.coordinates[1])]);
    /* And closed again, it is the polygon it came from. */
    expect(outlinePolygon(ring, inner)).toEqual(geometry);
  });

  it('picks the largest part of a MultiPolygon, wherever it sits in the list', () => {
    const sliver = square(0.02, 0.02, 0.0005);
    const main = square(0, 0, 0.01);
    const geometry: MultiPolygon = { type: 'MultiPolygon', coordinates: [[sliver], [main], [square(0.03, 0.03, 0.001)]] };

    expect(editableOutline(geometry)).toEqual({ ring: openRing(main), inner: [] });
  });

  it('skips a part too short to be a polygon rather than crashing on it', () => {
    const main = square(0, 0, 0.01);
    const geometry: MultiPolygon = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 1]]], [main]] };

    expect(editableOutline(geometry).ring).toEqual(openRing(main));
  });
});

describe('ellipseAround', () => {
  const centre: LngLat = [-121.947, 36.5705];

  it('gives as many handles as asked for, twelve by default, and an open ring', () => {
    expect(ellipseAround(centre, 10, 6)).toHaveLength(12);
    expect(ellipseAround(centre, 10, 6, 8)).toHaveLength(8);
    const ring = ellipseAround(centre, 10, 6);
    expect(ring[0]).not.toEqual(ring[ring.length - 1]);
  });

  it('is roughly the size it was asked for, long axis north before any turn', () => {
    const ring = ellipseAround(centre, 20, 8, 12);
    /* Vertex 0 and 6 lie across the ellipse; 3 and 9 along it. */
    expect(yardsBetween(ring[0], ring[6])).toBeCloseTo(16, 0);
    expect(yardsBetween(ring[3], ring[9])).toBeCloseTo(40, 0);
    expect(ring[3][0]).toBeCloseTo(centre[0], 9);
    expect(ring[3][1]).toBeGreaterThan(centre[1]);
    /* Centred on the click, and holding it. */
    const [lng, lat] = labelPoint(outlinePolygon(ring));
    expect(lng).toBeCloseTo(centre[0], 6);
    expect(lat).toBeCloseTo(centre[1], 6);
    expect(pointInRing(centre, ring)).toBe(true);
  });

  it('lays the long axis along a bearing, so a dropped shape lies along the hole', () => {
    const ring = ellipseAround(centre, 20, 8, 12, 90);

    /* Turned to face east: the long axis now runs east–west. */
    expect(yardsBetween(ring[3], ring[9])).toBeCloseTo(40, 0);
    expect(ring[3][1]).toBeCloseTo(centre[1], 9);
    expect(ring[3][0]).toBeGreaterThan(centre[0]);
  });
});

describe('bearingBetween', () => {
  it('reads compass bearings clockwise from north', () => {
    const from: LngLat = [-121.95, 36.57];
    expect(bearingBetween(from, [-121.95, 36.58])).toBeCloseTo(0, 6);
    expect(bearingBetween(from, [-121.94, 36.57])).toBeCloseTo(90, 6);
    expect(bearingBetween(from, [-121.95, 36.56])).toBeCloseTo(180, 6);
    expect(bearingBetween(from, [-121.96, 36.57])).toBeCloseTo(270, 6);
  });
});
