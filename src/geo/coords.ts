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
