/**
 * What OpenStreetMap already holds for a course: its boundary, the holes mapped
 * inside it, and the landmarks that sit within the line.
 *
 * Read-only. Nothing here writes to OpenStreetMap, and nothing here invents
 * geometry — a course with no OSM boundary comes back absent rather than with a
 * shape drawn for it (KTD13).
 *
 * Overpass is unreliable by default (KTD11). Three consecutive probe calls on
 * 2026-08-12 returned a 504, an empty reply, then a 200, so every lookup carries
 * a hard timeout, exactly one retry, and an `unknown` outcome that is distinct
 * from `absent`. Successful lookups are cached per course for the browser
 * session, so re-opening a course does not re-roll the dice.
 *
 * Matching is deliberately conservative (KTD12). The Pebble Beach bbox returns
 * seven golf courses, so a course is adopted only on a confident name match or a
 * centroid inside a tight distance ceiling. Below both, the course is treated as
 * absent rather than wearing a neighbour's boundary.
 *
 * No React here — the module stays a pure unit.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { labelPoint, polygon, polygonAcres, yardsBetween, type LngLat } from '../geo/coords';

/** The public instance. Sends `access-control-allow-origin: *` and needs no key. */
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** How long one attempt may run before it is abandoned. */
export const OVERPASS_TIMEOUT_MS = 8_000;

/** The pause before the single retry. */
export const OVERPASS_RETRY_BACKOFF_MS = 700;

/** Half-width of the box searched around a course's coordinate. */
export const BBOX_RADIUS_METRES = 2_500;

/**
 * How alike two course names must read before the match counts as confident.
 * "Pebble Beach Golf Course" against "Pebble Beach Golf Links" scores 1; every
 * neighbour in the same bbox scores 0.
 */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * How far a course's coordinate may sit from an OSM course's centroid before the
 * proximity fallback stops trusting it. OpenGolfAPI coordinates may be a
 * clubhouse point or a geocoded address, so the ceiling is loose enough for that
 * and tight enough to exclude the next course along.
 */
export const CENTROID_CEILING_METRES = 600;

const METRES_PER_YARD = 0.9144;
const METRES_PER_DEGREE_LATITUDE = 111_320;

/** A geographic extent in the order Overpass writes it. */
export interface OverpassBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** One thing OSM holds inside the adopted line, worth naming for orientation. */
export interface OsmLandmark {
  /** OSM element identity, e.g. "way/700001". */
  id: string;
  name: string;
  /** What it is, in plain words: "Clubhouse", "Driving range". */
  kind: string;
  position: LngLat;
}

/** The course OpenStreetMap already holds, as the screens read it. */
export interface OsmCourse {
  /** OSM element identity, e.g. "relation/3741806". */
  osmId: string;
  /** The `name` tag, when the element carries one. */
  name: string | null;
  boundary: Polygon | MultiPolygon;
  acres: number;
  /** Map framing extent, in `[west, south, east, north]` — the order `BaseMap` takes. */
  bbox: [number, number, number, number];
  /** `golf=hole` refs found inside the boundary, ascending. */
  mappedHoleRefs: number[];
  landmarks: OsmLandmark[];
  /** Which of the two rules adopted this course, so the screen can say. */
  matchedBy: 'name' | 'proximity';
}

/**
 * The outcome of one lookup.
 *
 * `absent` and `unknown` are deliberately different answers (R16): absent is
 * "OpenStreetMap holds nothing for this course", unknown is "we could not find
 * out". Rendering the second as the first would tell a contributor that a
 * fully-mapped course has no holes.
 */
export type OsmLookup =
  | { status: 'pending' }
  | { status: 'found'; course: OsmCourse }
  | { status: 'absent' }
  | { status: 'unknown'; message: string };

/** What a lookup needs to know about the course being opened. */
export interface OsmCourseQuery {
  /** The OpenGolfAPI course id, which is also the cache key. */
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/* --- The query ------------------------------------------------------------ */

/** The box searched around a course coordinate, roughly `BBOX_RADIUS_METRES` each way. */
export function overpassBbox(latitude: number, longitude: number): OverpassBbox {
  const latitudeSpan = BBOX_RADIUS_METRES / METRES_PER_DEGREE_LATITUDE;
  /* Degrees of longitude shorten towards the poles; clamped so a course near one
   * does not ask for a box the width of a continent. */
  const shrink = Math.max(Math.cos((latitude * Math.PI) / 180), 0.05);
  const longitudeSpan = latitudeSpan / shrink;
  return {
    south: latitude - latitudeSpan,
    west: longitude - longitudeSpan,
    north: latitude + latitudeSpan,
    east: longitude + longitudeSpan,
  };
}

/**
 * The Overpass QL for one course box.
 *
 * `nwr` rather than `way`: Pebble Beach and Poppy Hills are both mapped as
 * relations, so a way-only query misses them entirely. `out geom` returns member
 * geometry on relations, which is what makes the multipolygon assemblable.
 */
export function overpassQuery(box: OverpassBbox): string {
  const bbox = `(${box.south},${box.west},${box.north},${box.east})`;
  return [
    `[out:json][timeout:${Math.round(OVERPASS_TIMEOUT_MS / 1000)}];`,
    '(',
    `  nwr["leisure"="golf_course"]${bbox};`,
    `  nwr["golf"="hole"]${bbox};`,
    `  nwr["golf"~"^(clubhouse|driving_range|practice|academy)$"]${bbox};`,
    `  nwr["building"="clubhouse"]${bbox};`,
    `  nwr["leisure"="miniature_golf"]${bbox};`,
    `  nwr["shop"="golf"]${bbox};`,
    ');',
    'out geom;',
  ].join('\n');
}

/* --- The response --------------------------------------------------------- */

interface OverpassPoint {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type?: string;
  role?: string;
  geometry?: OverpassPoint[];
  lat?: number;
  lon?: number;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: OverpassPoint[];
  members?: OverpassMember[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toPositions(points: OverpassPoint[] | undefined): LngLat[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point) => typeof point?.lat === 'number' && typeof point?.lon === 'number')
    .map((point): LngLat => [point.lon, point.lat]);
}

const EPSILON = 1e-9;

function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
}

function isClosed(ring: readonly LngLat[]): boolean {
  return ring.length > 2 && samePoint(ring[0], ring[ring.length - 1]);
}

/**
 * Join unordered way geometries into closed rings.
 *
 * A multipolygon relation stores its outline as however many ways the mappers
 * split it into, in no particular order and in either direction, so the ends have
 * to be walked and matched. A run that never closes is dropped rather than forced
 * shut — a fabricated edge is worse than no boundary.
 */
function stitchRings(segments: LngLat[][]): LngLat[][] {
  const pool = segments.filter((segment) => segment.length >= 2).map((segment) => segment.slice());
  const rings: LngLat[][] = [];

  while (pool.length > 0) {
    let run = pool.shift() as LngLat[];
    let joined = true;
    while (!isClosed(run) && joined) {
      joined = false;
      for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[i];
        const end = run[run.length - 1];
        if (samePoint(end, candidate[0])) {
          run = run.concat(candidate.slice(1));
        } else if (samePoint(end, candidate[candidate.length - 1])) {
          run = run.concat(candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        pool.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (isClosed(run) && run.length >= 4) rings.push(run);
  }

  return rings;
}

function ringContains(ring: readonly Position[], point: LngLat): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > point[1] !== yj > point[1];
    if (straddles && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when a coordinate falls inside the polygon, and outside any of its holes. */
export function boundaryContains(boundary: Polygon | MultiPolygon, point: LngLat): boolean {
  const parts = boundary.type === 'Polygon' ? [boundary.coordinates] : boundary.coordinates;
  return parts.some(([outer, ...inners]) => {
    if (!outer || !ringContains(outer, point)) return false;
    return !inners.some((inner) => ringContains(inner, point));
  });
}

/** A ring's rough area in square degrees — only ever used to rank rings against each other. */
function ringSpan(ring: readonly LngLat[]): number {
  let doubled = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    doubled += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(doubled / 2);
}

/**
 * The polygon an element outlines, or null when it outlines nothing usable.
 *
 * Ways carry their own ring. Relations carry member ways: `outer` roles (and the
 * blank role older data uses) form the rings, `inner` roles are punched out of
 * whichever outer ring holds them.
 */
export function elementBoundary(element: OverpassElement): Polygon | MultiPolygon | null {
  if (element.type === 'way') {
    const ring = toPositions(element.geometry);
    if (ring.length < 3) return null;
    try {
      return polygon(ring);
    } catch {
      return null;
    }
  }

  if (element.type !== 'relation' || !Array.isArray(element.members)) return null;

  const outerSegments: LngLat[][] = [];
  const innerSegments: LngLat[][] = [];
  for (const member of element.members) {
    if (member.type !== 'way') continue;
    const segment = toPositions(member.geometry);
    if (segment.length < 2) continue;
    if (member.role === 'inner') innerSegments.push(segment);
    else if (member.role === 'outer' || !member.role) outerSegments.push(segment);
  }

  const outers = stitchRings(outerSegments).sort((a, b) => ringSpan(b) - ringSpan(a));
  if (outers.length === 0) return null;
  const inners = stitchRings(innerSegments);

  const shells: Position[][][] = outers.map((outer) => [outer as Position[]]);
  for (const inner of inners) {
    const host = outers.findIndex((outer) => ringContains(outer as Position[], inner[0]));
    shells[host < 0 ? 0 : host].push(inner as Position[]);
  }

  return shells.length === 1
    ? { type: 'Polygon', coordinates: shells[0] }
    : { type: 'MultiPolygon', coordinates: shells };
}

/** Every coordinate an element occupies: a node's point, or a way's vertices. */
function elementPositions(element: OverpassElement): LngLat[] {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return [[element.lon, element.lat]];
  }
  const points = toPositions(element.geometry);
  if (points.length > 0) return points;
  const boundary = elementBoundary(element);
  return boundary ? [labelPoint(boundary)] : [];
}

/**
 * Whether an element belongs to the adopted course.
 *
 * Any vertex inside is enough, deliberately. A `golf=hole` way is a playing line,
 * not a blob, and real boundaries are drawn tight: measured against live OSM data
 * on 2026-08-12, Pebble Beach's 14th and 18th both run partly outside relation
 * 3741806, so a centre-point test dropped two of its eighteen holes.
 */
function withinBoundary(element: OverpassElement, boundary: Polygon | MultiPolygon): boolean {
  return elementPositions(element).some((position) => boundaryContains(boundary, position));
}

function boundaryBbox(boundary: Polygon | MultiPolygon): [number, number, number, number] {
  const parts = boundary.type === 'Polygon' ? [boundary.coordinates] : boundary.coordinates;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const rings of parts) {
    for (const [lng, lat] of rings[0] ?? []) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

function boundaryAcres(boundary: Polygon | MultiPolygon): number {
  if (boundary.type === 'Polygon') return polygonAcres(boundary);
  return boundary.coordinates.reduce(
    (total, coordinates) => total + polygonAcres({ type: 'Polygon', coordinates }),
    0,
  );
}

function metresBetween(from: LngLat, to: LngLat): number {
  return yardsBetween(from, to) * METRES_PER_YARD;
}

/* --- Matching ------------------------------------------------------------- */

/**
 * Words that appear on half the golf courses in any country and so carry no
 * evidence about which one this is. "Pebble Beach Golf Links" and "Pebble Beach
 * Golf Course" differ only in these.
 */
const GENERIC_NAME_WORDS = new Set([
  'golf',
  'course',
  'courses',
  'club',
  'links',
  'country',
  'resort',
  'the',
  'at',
  'and',
  'of',
  'cc',
  'gc',
  'gcc',
]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * How alike two course names read, from 0 to 1.
 *
 * Generic golf words are dropped first, so the comparison is between the words
 * that actually identify the place. A name made entirely of generic words keeps
 * them rather than scoring against nothing.
 */
export function courseNameSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return 0;

  const leftSignificant = left.filter((token) => !GENERIC_NAME_WORDS.has(token));
  const rightSignificant = right.filter((token) => !GENERIC_NAME_WORDS.has(token));
  const usable = leftSignificant.length > 0 && rightSignificant.length > 0;

  return dice(
    new Set(usable ? leftSignificant : left),
    new Set(usable ? rightSignificant : right),
  );
}

interface Candidate {
  osmId: string;
  name: string | null;
  boundary: Polygon | MultiPolygon;
  centroid: LngLat;
}

/**
 * Pick the one course the contributor opened, or none.
 *
 * Name first, proximity second, and nothing third — a bbox holding only
 * neighbours yields no match at all, per KTD12.
 */
function selectCandidate(
  candidates: Candidate[],
  query: OsmCourseQuery,
): { candidate: Candidate; matchedBy: 'name' | 'proximity' } | null {
  if (candidates.length === 0) return null;

  let best: Candidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = candidate.name ? courseNameSimilarity(candidate.name, query.name) : 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best && bestScore >= NAME_MATCH_THRESHOLD) return { candidate: best, matchedBy: 'name' };

  const point: LngLat = [query.longitude, query.latitude];
  let nearest: Candidate | null = null;
  let nearestMetres = Infinity;
  for (const candidate of candidates) {
    const metres = metresBetween(point, candidate.centroid);
    if (metres < nearestMetres) {
      nearest = candidate;
      nearestMetres = metres;
    }
  }
  if (nearest && nearestMetres <= CENTROID_CEILING_METRES) {
    return { candidate: nearest, matchedBy: 'proximity' };
  }

  return null;
}

/* --- Landmarks ------------------------------------------------------------ */

/** Plain words for the handful of tags worth naming on the boundary screen. */
function landmarkKind(tags: Record<string, string>): string | null {
  if (tags.golf === 'clubhouse') return 'Clubhouse';
  if (tags.golf === 'driving_range') return 'Driving range';
  if (tags.golf === 'practice' || tags.golf === 'academy') return 'Practice area';
  if (tags.building === 'clubhouse') return 'Clubhouse';
  if (tags.leisure === 'miniature_golf') return 'Putting course';
  if (tags.shop === 'golf') return 'Golf shop';
  return null;
}

/* --- Reading the answer --------------------------------------------------- */

function elementId(element: OverpassElement): string {
  return `${element.type ?? 'element'}/${element.id ?? 0}`;
}

/** Turn one Overpass answer into a lookup outcome. Null means the body was unreadable. */
function interpret(body: unknown, query: OsmCourseQuery): OsmLookup | null {
  const raw = asRecord(body).elements;
  if (!Array.isArray(raw)) return null;
  const elements = raw as OverpassElement[];

  const candidates: Candidate[] = [];
  for (const element of elements) {
    if (element.tags?.leisure !== 'golf_course') continue;
    const boundary = elementBoundary(element);
    if (!boundary) continue;
    candidates.push({
      osmId: elementId(element),
      name: element.tags.name ?? null,
      boundary,
      centroid: labelPoint(boundary),
    });
  }

  const selected = selectCandidate(candidates, query);
  if (!selected) return { status: 'absent' };
  const { boundary } = selected.candidate;

  const refs = new Set<number>();
  for (const element of elements) {
    if (element.tags?.golf !== 'hole') continue;
    const ref = Number.parseInt(element.tags.ref ?? '', 10);
    if (!Number.isFinite(ref)) continue;
    /* A neighbour's holes sit in the same bbox; only what the adopted line
     * touches is this course's. */
    if (withinBoundary(element, boundary)) refs.add(ref);
  }

  const landmarks: OsmLandmark[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const kind = landmarkKind(tags);
    if (!kind) continue;
    if (!withinBoundary(element, boundary)) continue;
    const positions = elementPositions(element);
    const position = positions[0];
    if (!position) continue;
    const name = tags.name?.trim() || kind;
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    landmarks.push({ id: elementId(element), name, kind, position });
  }

  return {
    status: 'found',
    course: {
      osmId: selected.candidate.osmId,
      name: selected.candidate.name,
      boundary,
      acres: boundaryAcres(boundary),
      bbox: boundaryBbox(boundary),
      mappedHoleRefs: [...refs].sort((a, b) => a - b),
      landmarks,
      matchedBy: selected.matchedBy,
    },
  };
}

/* --- Talking to an endpoint that often does not answer --------------------- */

type Attempt =
  | { ok: true; body: unknown }
  | { ok: false; aborted: true }
  | { ok: false; aborted?: false; message: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One shot at Overpass, with its own hard timeout.
 *
 * The timeout aborts through a controller of our own, so a caller cancelling the
 * whole lookup and the clock running out stay distinguishable — one is a
 * cancellation nobody should be told about, the other is a failure worth
 * retrying.
 */
async function attempt(query: string, signal?: AbortSignal): Promise<Attempt> {
  if (signal?.aborted) return { ok: false, aborted: true };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OVERPASS_TIMEOUT_MS);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort);

  try {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (!response.ok) return { ok: false, message: `it answered ${response.status}` };
    /* An empty reply is one of Overpass's regular failure modes; `json()` throws
     * on it, which lands here as a retryable failure rather than a crash. */
    return { ok: true, body: await response.json() };
  } catch (error) {
    if (signal?.aborted) return { ok: false, aborted: true };
    if (timedOut) {
      return { ok: false, message: `it did not answer within ${OVERPASS_TIMEOUT_MS / 1000}s` };
    }
    const message = error instanceof Error ? error.message : 'the request failed';
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

/** The attempt, then one retry after a backoff, and no more (KTD11). */
async function requestOverpass(query: string, signal?: AbortSignal): Promise<Attempt> {
  const first = await attempt(query, signal);
  if (first.ok || first.aborted) return first;

  await delay(OVERPASS_RETRY_BACKOFF_MS);
  if (signal?.aborted) return { ok: false, aborted: true };
  return attempt(query, signal);
}

/* --- The cache ------------------------------------------------------------ */

/**
 * Answers that resolved, per course, for as long as the tab is open. Failures are
 * never cached: the next open should get a fresh roll of the dice.
 */
const cache = new Map<string, OsmLookup>();

/** Forget every cached answer. Tests use it; nothing in the app does. */
export function clearOsmCache(): void {
  cache.clear();
}

/**
 * What OpenStreetMap holds for one course.
 *
 * Never throws and never blocks a course from opening: every failure resolves to
 * `unknown`, which the board renders as "we do not know" rather than as zero
 * holes mapped (R12, R16).
 */
export async function lookupOsmCourse(
  query: OsmCourseQuery,
  signal?: AbortSignal,
): Promise<OsmLookup> {
  const cached = cache.get(query.id);
  if (cached) return cached;

  const result = await requestOverpass(
    overpassQuery(overpassBbox(query.latitude, query.longitude)),
    signal,
  );

  if (!result.ok) {
    return {
      status: 'unknown',
      message: result.aborted ? 'the lookup was cancelled' : result.message,
    };
  }

  const lookup = interpret(result.body, query);
  if (!lookup) return { status: 'unknown', message: 'its answer could not be read' };

  cache.set(query.id, lookup);
  return lookup;
}
