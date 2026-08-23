/**
 * Geographic geometry for proposed course features, in WGS84.
 *
 * Everything here speaks GeoJSON, which means coordinates are ordered
 * `[longitude, latitude]` — the reverse of how a map UI usually says it. The
 * `LngLat` alias exists to make that order visible at every call site.
 *
 * Pure functions only, no React. Turf is imported one package at a time; the
 * `@turf/turf` barrel re-exports about a hundred packages and does not
 * tree-shake.
 */
import turfArea from '@turf/area';
import turfCentroid from '@turf/centroid';
import turfDistance from '@turf/distance';
import turfLength from '@turf/length';
import type { Feature, Geometry, LineString, Polygon } from 'geojson';

/** A WGS84 coordinate in GeoJSON order: `[longitude, latitude]`. */
export type LngLat = [number, number];

/** Definition of the international acre, used to report polygon areas. */
export const SQUARE_METRES_PER_ACRE = 4046.8564224;

/** Definition of the international yard, for the flat-earth measurement below. */
const METRES_PER_YARD = 0.9144;

/** One degree of latitude, near enough anywhere on the ellipsoid for a golf hole. */
const METRES_PER_DEGREE_LATITUDE = 111_320;

/**
 * What a drawn feature represents. `hole` is the playing line itself — the
 * geometry OpenStreetMap holds for `golf=hole` — and the rest are the areas a
 * contributor traces around it.
 */
export type FeatureKind =
  | 'hole'
  | 'tee'
  | 'green'
  | 'fairway'
  | 'rough'
  | 'bunker'
  | 'water'
  | 'path';

/** Properties every proposed feature carries. `ref` is the hole number where one applies. */
export interface CourseFeatureProperties {
  kind: FeatureKind;
  ref?: string;
  [key: string]: unknown;
}

/** A proposed feature: WGS84 geometry plus the kind of thing it is. */
export type CourseFeature<G extends Geometry = Geometry> = Feature<G, CourseFeatureProperties>;

/**
 * The ordered points a contributor drew for one hole: tee, any number of turn
 * points, then green. Fewer than two points is a line still being drawn, not a
 * hole — `playingLine` refuses it, and `lineYards` measures it as zero.
 */
export function playingLine(points: readonly LngLat[]): LineString {
  if (points.length < 2) {
    throw new Error('A playing line needs at least two points: a tee and a green.');
  }
  return { type: 'LineString', coordinates: points.map((point) => [...point]) };
}

/**
 * A polygon from a single outer ring. GeoJSON requires the ring to close, so a
 * ring that does not repeat its first point gets one appended.
 */
export function polygon(ring: readonly LngLat[]): Polygon {
  if (ring.length < 3) {
    throw new Error('A polygon needs at least three points.');
  }
  const coordinates: LngLat[] = ring.map((point) => [...point] as LngLat);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coordinates.push([...first]);
  }
  return { type: 'Polygon', coordinates: [coordinates] };
}

/** Tags geometry with its feature kind so it can be reviewed and later uploaded. */
export function courseFeature<G extends Geometry>(
  kind: FeatureKind,
  geometry: G,
  properties: Omit<CourseFeatureProperties, 'kind'> = {},
): CourseFeature<G> {
  return { type: 'Feature', properties: { ...properties, kind }, geometry };
}

/**
 * Length of a drawn line in yards, measured along every segment.
 *
 * A scorecard yardage follows the playing path, so measuring tee-to-green
 * directly reads short on any dogleg; this is the like-for-like comparison.
 */
export function lineYards(points: readonly LngLat[] | LineString): number {
  const coordinates: readonly number[][] = 'type' in points ? points.coordinates : points;
  if (coordinates.length < 2) return 0;
  const feature: Feature<LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coordinates.map((point) => [...point]) },
  };
  return turfLength(feature, { units: 'yards' });
}

/** Great-circle distance between two coordinates, in yards. */
export function yardsBetween(from: LngLat, to: LngLat): number {
  return turfDistance(from as number[], to as number[], { units: 'yards' });
}

/** Area of a polygon in acres. Turf reports square metres; acres follow from the definition. */
export function polygonAcres(area: Polygon): number {
  return turfArea(area) / SQUARE_METRES_PER_ACRE;
}

/** Where to anchor a label for a feature: the centroid of its geometry. */
export function labelPoint(geometry: Geometry): LngLat {
  const [lng, lat] = turfCentroid(geometry).geometry.coordinates;
  return [lng, lat];
}

/**
 * How far a coordinate sits from a polyline, in yards, measured to the nearest
 * point on the nearest segment.
 *
 * Distance to the nearest *vertex* is not the same measurement and is wrong for
 * exactly the case this exists for: a `golf=hole` way is often two or three
 * points across four hundred yards, so a bunker halfway down the fairway is
 * metres from the line and hundreds of yards from either end of it.
 *
 * The segment maths is done on a local equirectangular projection — longitude
 * shortened by the cosine of the latitude — because a point-to-segment
 * projection has no closed form on a sphere, and over the few hundred yards a
 * hole spans the flat-earth error is well under a yard.
 */
export function yardsToLine(point: LngLat, line: readonly LngLat[] | LineString): number {
  const coordinates: readonly number[][] = 'type' in line ? line.coordinates : line;
  if (coordinates.length === 0) return Infinity;
  if (coordinates.length === 1) return yardsBetween(point, coordinates[0] as LngLat);

  /* Metres per degree, at this point's latitude. */
  const perLat = METRES_PER_DEGREE_LATITUDE;
  const perLng = METRES_PER_DEGREE_LATITUDE * Math.cos((point[1] * Math.PI) / 180);
  const x = (position: readonly number[]) => position[0] * perLng;
  const y = (position: readonly number[]) => position[1] * perLat;

  const px = x(point);
  const py = y(point);
  let best = Infinity;
  for (let i = 1; i < coordinates.length; i += 1) {
    const ax = x(coordinates[i - 1]);
    const ay = y(coordinates[i - 1]);
    const bx = x(coordinates[i]);
    const by = y(coordinates[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    /* A zero-length segment — duplicated vertices happen — is just its endpoint. */
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(px - cx, py - cy));
  }
  return best / METRES_PER_YARD;
}
