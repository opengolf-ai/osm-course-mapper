import { describe, expect, it } from 'vitest';
import {
  courseFeature,
  labelPoint,
  lineYards,
  playingLine,
  polygon,
  polygonAcres,
  yardsBetween,
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
