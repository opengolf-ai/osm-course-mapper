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
import type { Feature, Geometry, LineString, MultiPolygon, Polygon } from 'geojson';

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

/**
 * How far along a playing line a point sits from the green end, in yards.
 *
 * The point is dropped onto the nearest segment and the rest of the line is
 * measured from there — the same way the card counts a dogleg. This is what
 * tells a tee box 412 yards out from one 380 yards out: straight-line distance
 * to the green would read a dogleg's back tee short by the size of the bend.
 *
 * Same local equirectangular projection as `yardsToLine`, for the same reason.
 */
export function yardsAlongToEnd(point: LngLat, line: readonly LngLat[] | LineString): number {
  const coordinates: readonly number[][] = 'type' in line ? line.coordinates : line;
  if (coordinates.length === 0) return Infinity;
  if (coordinates.length === 1) return yardsBetween(point, coordinates[0] as LngLat);

  const perLat = METRES_PER_DEGREE_LATITUDE;
  const perLng = METRES_PER_DEGREE_LATITUDE * Math.cos((point[1] * Math.PI) / 180);
  const x = (position: readonly number[]) => position[0] * perLng;
  const y = (position: readonly number[]) => position[1] * perLat;

  const px = x(point);
  const py = y(point);
  let bestSegment = 1;
  let bestT = 0;
  let bestDistance = Infinity;
  for (let i = 1; i < coordinates.length; i += 1) {
    const ax = x(coordinates[i - 1]);
    const ay = y(coordinates[i - 1]);
    const dx = x(coordinates[i]) - ax;
    const dy = y(coordinates[i]) - ay;
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span));
    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = i;
      bestT = t;
    }
  }

  const from = coordinates[bestSegment - 1];
  const to = coordinates[bestSegment];
  const onLine: LngLat = [from[0] + (to[0] - from[0]) * bestT, from[1] + (to[1] - from[1]) * bestT];
  return lineYards([onLine, ...(coordinates.slice(bestSegment) as LngLat[])]);
}

/** Even–odd ray cast. Enough for the small, simple rings a hole's features are. */
export function pointInRing(point: LngLat, ring: readonly LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A ring without its closing duplicate — the form a vertex editor works in.
 *
 * GeoJSON closes every ring by repeating the first position. Handing that to
 * something that draws a drag handle per vertex puts two handles on one corner,
 * and dragging one tears the ring open.
 */
export function openRing(ring: readonly (readonly number[])[]): LngLat[] {
  const points = ring.map((position) => [position[0], position[1]] as LngLat);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

/**
 * The one editable outline of a polygon: the outer ring of its largest part,
 * with any holes in it carried alongside untouched.
 *
 * Detection only ever emits single polygons, but a MultiPolygon is valid on the
 * wire and must not crash the review. Its largest part is the feature; the
 * slivers beside it are noise the contributor can redraw if they are not.
 */
export function editableOutline(geometry: Polygon | MultiPolygon): { ring: LngLat[]; inner: LngLat[][] } {
  const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = parts[0] ?? [];
  let bestArea = -1;
  for (const part of parts) {
    if (!part[0] || part[0].length < 4) continue;
    const area = turfArea({ type: 'Polygon', coordinates: part });
    if (area > bestArea) {
      best = part;
      bestArea = area;
    }
  }
  return { ring: openRing(best[0] ?? []), inner: best.slice(1).map(openRing) };
}

/** An outline back into GeoJSON, every ring closed. */
export function outlinePolygon(ring: readonly LngLat[], inner: readonly LngLat[][] = []): Polygon {
  const close = (points: readonly LngLat[]) => polygon(points).coordinates[0];
  return { type: 'Polygon', coordinates: [close(ring), ...inner.filter((r) => r.length >= 3).map(close)] };
}

/**
 * A rough ellipse around a click, in real coordinates: the shape a contributor
 * gets when they say "there is one here" and then pull into place.
 *
 * Few vertices on purpose — ten or twelve handles is something a person can
 * drag into the shape of a bunker; the forty a smooth circle needs is not.
 * `bearing` turns the long axis, in degrees clockwise from north, so a tee box
 * or a fairway piece can be dropped already lying along the hole.
 */
export function ellipseAround(
  center: LngLat,
  alongYards: number,
  acrossYards: number,
  steps = 12,
  bearing = 0,
): LngLat[] {
  const metresPerLng = METRES_PER_DEGREE_LATITUDE * Math.max(Math.cos((center[1] * Math.PI) / 180), 0.01);
  const theta = (bearing * Math.PI) / 180;
  const ring: LngLat[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    /* Local metres, long axis pointing north before the turn. */
    const across = Math.cos(angle) * acrossYards * METRES_PER_YARD;
    const along = Math.sin(angle) * alongYards * METRES_PER_YARD;
    const east = across * Math.cos(theta) + along * Math.sin(theta);
    const north = -across * Math.sin(theta) + along * Math.cos(theta);
    ring.push([center[0] + east / metresPerLng, center[1] + north / METRES_PER_DEGREE_LATITUDE]);
  }
  return ring;
}

/** Compass bearing from one coordinate to another, degrees clockwise from north. */
export function bearingBetween(from: LngLat, to: LngLat): number {
  const east = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
  const north = to[1] - from[1];
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/** Acres enclosed by a boundary of one part or many. */
export function areaAcres(area: Polygon | MultiPolygon): number {
  return turfArea(area) / SQUARE_METRES_PER_ACRE;
}
