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
import type { LineString, MultiPolygon, Polygon, Position } from 'geojson';
import {
  labelPoint,
  polygon,
  polygonAcres,
  yardsBetween,
  yardsToLine,
  type FeatureKind,
  type LngLat,
} from '../geo/coords';

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

/**
 * How far a tagged golf feature may sit from a playing line before it stops
 * counting as part of that hole.
 *
 * Features are attached to the nearest hole line, which needs a ceiling or a
 * practice green on the far side of the clubhouse joins whichever hole happens
 * to be least distant. A hundred yards clears the widest fairway and the deepest
 * greenside bunker while stopping short of the next hole over on all but the
 * tightest routings — and OSM's own `ref` tag, when a mapper set one, is
 * believed ahead of any distance.
 */
export const HOLE_FEATURE_CEILING_YARDS = 100;

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

/**
 * One thing OSM already outlines on a hole: its green, a bunker, the fairway,
 * a tee box, a pond, a cart path.
 *
 * Geometry, not a description (KTD6): what comes back here is drawn on the map
 * as an outline, so it has to be the shape OSM holds and not a summary of it.
 * Multipolygons are split into their parts on the way in — a fairway mapped as a
 * relation with two lobes becomes two outlines, which is what the fill layer's
 * `Polygon` filter can draw.
 */
export interface OsmHoleFeature {
  /** OSM element identity, e.g. "way/500123". */
  id: string;
  /** The kind the app draws it as, mapped from the `golf` tag. */
  kind: FeatureKind;
  /** The `golf` tag value itself, so a caption can say what OSM actually calls it. */
  tag: string;
  /** The `name` tag, when the element carries one. */
  name: string | null;
  geometry: Polygon | LineString;
}

/**
 * One hole OpenStreetMap already holds: the playing line, and what is outlined
 * along it.
 *
 * `line` is the `golf=hole` way as OSM stores it. By convention it runs tee
 * first, green last, which is why the review screen can label its ends without
 * asking anyone.
 */
export interface OsmHole {
  /** OSM element identity, e.g. "way/800001". */
  osmId: string;
  /**
   * The hole's number **on the card the contributor opened**, which is not
   * always the number in its `ref` tag. A composite eighteen plays two of a
   * club's nines, so card hole 12 can be OSM's `Valley #3`.
   */
  ref: number;
  /** The nine this hole belongs to, when OSM names one: "Lakes", "Mountain". */
  nine: string | null;
  /** What the tag actually said — "Lakes #3", "7" — so a screen can quote it. */
  osmRef: string;
  /** The `par` tag, when the way carries one. Never guessed from length. */
  par: number | null;
  line: LineString;
  /** Everything tagged `golf=*` that belongs to this hole, nearest-line first. */
  features: OsmHoleFeature[];
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
  /** `golf=hole` refs found inside the boundary, ascending. The refs of `holes`. */
  mappedHoleRefs: number[];
  /** The playing lines inside the boundary and what OSM outlines along them, by ref. */
  holes: OsmHole[];
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
  /**
   * The card, hole by hole, when the record carried one.
   *
   * Only the par sequence is used, and only for one thing: working out which of
   * a club's nines a composite eighteen actually plays. Hidden Valley Country
   * Club in Sandy is three nines paired three ways, and its card is the only
   * thing that says whether "hole 1" is the Lakes 1st or the Mountain 1st.
   */
  holes?: ReadonlyArray<{ number: number; par: number | null }>;
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
 *
 * `nwr["golf"]` rather than a list of the golf values we care about. It is one
 * selector instead of four, and it is what makes a hole that is already mapped
 * openable: the greens, bunkers, fairways and tees come back in the same answer
 * as the playing lines they belong to, so opening a mapped hole draws what OSM
 * holds rather than an empty frame over the right acre of grass.
 */
export function overpassQuery(box: OverpassBbox): string {
  const bbox = `(${box.south},${box.west},${box.north},${box.east})`;
  return [
    `[out:json][timeout:${Math.round(OVERPASS_TIMEOUT_MS / 1000)}];`,
    '(',
    `  nwr["leisure"="golf_course"]${bbox};`,
    `  nwr["golf"]${bbox};`,
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

/* --- Which hole is which ---------------------------------------------------*/

/**
 * A hole's tag, split into the nine it belongs to and its number.
 *
 * `ref=7` is the easy case. The one this exists for is a club with more than one
 * nine, where the tag carries both: Hidden Valley Country Club in Sandy tags its
 * three nines `ref=1`…`9` with `name=Mountain #1`, `ref=Lakes #1`, and
 * `ref=Valley #1`. Reading those with `parseInt` yields `NaN` for two nines out
 * of three, which silently drops eighteen of the club's twenty-seven holes and
 * leaves the third nine answering to every card number.
 *
 * The number is the digits at the end; anything before them, less separators, is
 * the nine's name.
 */
export function parseHoleRef(tag: string | undefined | null): { nine: string | null; number: number } | null {
  if (!tag) return null;
  const match = /^(.*?)(\d+)\s*$/.exec(tag.trim());
  if (!match) return null;
  const number = Number.parseInt(match[2], 10);
  if (!Number.isFinite(number) || number < 1) return null;
  const nine = match[1].replace(/[#\s\-–—:.]+$/u, '').trim();
  return { nine: nine.length > 0 ? nine : null, number };
}

/** How many holes a nine holds. Blocks of a composite card are counted in these. */
const HOLES_PER_NINE = 9;

/** One of a club's nines, as OSM holds it. */
interface Nine {
  /** The name on the tags, or null for a nine whose holes carry bare numbers. */
  label: string | null;
  holes: RawHole[];
}

/** A `golf=hole` way, read but not yet matched to a hole on the card. */
interface RawHole {
  osmId: string;
  osmRef: string;
  nine: string | null;
  number: number;
  par: number | null;
  line: LineString;
}

/** The nine's pars in hole order, or null when OSM does not carry all of them. */
function ninePars(nine: Nine): number[] | null {
  const pars = nine.holes.map((hole) => hole.par);
  return pars.every((par): par is number => par !== null) ? pars : null;
}

/**
 * Which nine each block of the card plays, by matching pars hole for hole.
 *
 * The strongest evidence there is, and it comes from the holes themselves rather
 * than from anybody's naming: Hidden Valley's Lakes nine plays 5-3-4-4-4-4-3-4-5
 * and its card's front nine reads the same, while the Mountain nine
 * (5-4-4-3-4-4-4-5-3) matches neither half. A block that matches two nines
 * equally well — a club with two identical nines — is no evidence at all and
 * resolves to null, leaving the naming below to answer.
 */
function ninesByPar(nines: Nine[], card: ReadonlyArray<{ number: number; par: number | null }>, blocks: number): (Nine | null)[] {
  const byNumber = [...card].sort((a, b) => a.number - b.number);
  return Array.from({ length: blocks }, (_, block) => {
    const wanted = byNumber
      .slice(block * HOLES_PER_NINE, (block + 1) * HOLES_PER_NINE)
      .map((hole) => hole.par);
    if (wanted.length < HOLES_PER_NINE || wanted.some((par) => par === null)) return null;
    const matched = nines.filter((nine) => {
      const pars = ninePars(nine);
      return pars !== null && pars.length === wanted.length && pars.every((par, i) => par === wanted[i]);
    });
    return matched.length === 1 ? matched[0] : null;
  });
}

/**
 * Which nine each block of the card plays, by reading the course's own name.
 *
 * OpenGolfAPI files a composite as "Hidden Valley Country Club Lakes Valley",
 * which names the nines in the order they are played. The club's own name is cut
 * off the front first, and that is not fussiness: "Valley" appears in "Hidden
 * Valley" as well, so searching the whole string finds the Valley nine before
 * the Lakes nine and pairs the card backwards.
 */
function ninesByName(nines: Nine[], courseName: string, osmName: string | null, blocks: number): (Nine | null)[] {
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((token) => token.length > 0);

  const card = tokens(courseName);
  const club = osmName ? tokens(osmName) : [];
  /* Only a leading club name is cut: a name that does not start with it is not
   * one this can safely trim. */
  const startsWithClub = club.length > 0 && club.every((token, i) => card[i] === token);
  const remainder = startsWithClub ? card.slice(club.length) : card;

  const placed: Array<{ at: number; nine: Nine }> = [];
  for (const nine of nines) {
    if (!nine.label) continue;
    const label = tokens(nine.label);
    if (label.length === 0) continue;
    /* The last occurrence, so a label that also appears in the club name is
     * read where it is being used as a nine. */
    let at = -1;
    for (let i = 0; i + label.length <= remainder.length; i += 1) {
      if (label.every((token, k) => remainder[i + k] === token)) at = i;
    }
    if (at >= 0) placed.push({ at, nine });
  }
  placed.sort((a, b) => a.at - b.at);
  return Array.from({ length: blocks }, (_, block) => placed[block]?.nine ?? null);
}

/**
 * Give every OSM hole the number it carries on the card the contributor opened.
 *
 * One nine, or a course whose holes are numbered straight through, needs none of
 * this — the tag number is the card number. A club with several nines does: the
 * card is a pairing of two of them, and which two is not something the hole tags
 * say. Pars answer it first, the course name second, and nothing answers it
 * third — an unresolved block contributes no holes at all, because drawing the
 * Mountain 1st over a contributor reviewing the Lakes 1st is worse in every way
 * than drawing nothing.
 */
function numberAgainstCard(raw: RawHole[], query: OsmCourseQuery, osmName: string | null): OsmHole[] {
  const byLabel = new Map<string | null, Nine>();
  for (const hole of raw) {
    const existing = byLabel.get(hole.nine);
    if (existing) existing.holes.push(hole);
    else byLabel.set(hole.nine, { label: hole.nine, holes: [hole] });
  }
  const nines = [...byLabel.values()];
  for (const nine of nines) nine.holes.sort((a, b) => a.number - b.number);

  const build = (hole: RawHole, cardNumber: number): OsmHole => ({
    osmId: hole.osmId,
    ref: cardNumber,
    nine: hole.nine,
    osmRef: hole.osmRef,
    par: hole.par,
    line: hole.line,
    features: [],
  });

  /* The ordinary course: one set of numbers, used as they are. */
  if (nines.length <= 1) return raw.map((hole) => build(hole, hole.number));

  const card = query.holes ?? [];
  const blocks = Math.max(1, Math.ceil((card.length || HOLES_PER_NINE * 2) / HOLES_PER_NINE));
  const byPar = ninesByPar(nines, card, blocks);
  const byName = ninesByName(nines, query.name, osmName, blocks);

  const holes: OsmHole[] = [];
  const used = new Set<Nine>();
  for (let block = 0; block < blocks; block += 1) {
    const nine = byPar[block] ?? byName[block] ?? null;
    /* A nine cannot be played twice in one round; a resolution that says so is
     * a resolution that is wrong. */
    if (!nine || used.has(nine)) continue;
    used.add(nine);
    for (const hole of nine.holes) {
      holes.push(build(hole, block * HOLES_PER_NINE + hole.number));
    }
  }
  return holes;
}

/* --- What OSM outlines on a hole ------------------------------------------ */

/**
 * The `golf` tag values this app can draw, and what it draws them as.
 *
 * Only the outlines a contributor is asked about elsewhere in the app appear
 * here. `golf=hole` is deliberately absent — it is the playing line, handled as
 * the hole itself — and so are clubhouses and driving ranges, which are course
 * furniture rather than anything on a hole and are already read as landmarks.
 */
const GOLF_TAG_KIND: Record<string, FeatureKind> = {
  green: 'green',
  bunker: 'bunker',
  fairway: 'fairway',
  tee: 'tee',
  rough: 'rough',
  water_hazard: 'water',
  lateral_water_hazard: 'water',
  path: 'path',
  cartpath: 'path',
};

/** Every polygon an element outlines, multipolygons split into their parts. */
function elementPolygons(element: OverpassElement): Polygon[] {
  const boundary = elementBoundary(element);
  if (!boundary) return [];
  if (boundary.type === 'Polygon') return [boundary];
  return boundary.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
}

/**
 * The shapes one `golf=*` element contributes.
 *
 * A path is a line and everything else is an area, which is not a stylistic
 * choice — a cart path mapped as an open way has no interior to fill, and
 * forcing one closed would draw a shape OSM does not hold (KTD13).
 */
function golfGeometries(element: OverpassElement, kind: FeatureKind): (Polygon | LineString)[] {
  if (kind === 'path') {
    const points = toPositions(element.geometry);
    if (points.length >= 2 && !isClosed(points)) {
      return [{ type: 'LineString', coordinates: points.map((point) => [...point]) }];
    }
  }
  return elementPolygons(element);
}

/**
 * How far a green or a tee may sit from the end of a playing line it belongs to.
 *
 * Looser than the ceiling for everything else because the measurement is to a
 * single point rather than to a whole line: a `golf=hole` way commonly stops at
 * the front of the green or at the middle of one tee box, so the centroid of the
 * thing it stops at is legitimately tens of yards further on.
 */
export const HOLE_END_CEILING_YARDS = 120;

/**
 * How far a feature is from the hole it might belong to.
 *
 * A green is measured to where the line *ends* and a tee to where it *starts*,
 * not to the nearest point on the line — which sounds like a refinement and is
 * really a correctness fix. Holes run alongside each other, so on the ground at
 * Hidden Valley a green can be 60 yards from its own hole's line and 63 from the
 * neighbouring one, and nearest-line put it on the wrong hole. Measured to the
 * ends, which is what a green and a tee actually are, the same 27 holes each
 * come out with their own green.
 */
function yardsToHole(kind: FeatureKind, centre: LngLat, line: LineString): number {
  const coordinates = line.coordinates as LngLat[];
  if (kind === 'green') return yardsBetween(centre, coordinates[coordinates.length - 1]);
  if (kind === 'tee') return yardsBetween(centre, coordinates[0]);
  return yardsToLine(centre, line);
}

/** The ceiling that applies to one kind of feature. */
function ceilingFor(kind: FeatureKind): number {
  return kind === 'green' || kind === 'tee' ? HOLE_END_CEILING_YARDS : HOLE_FEATURE_CEILING_YARDS;
}

/**
 * Attach each outlined feature to the hole it belongs to.
 *
 * OSM's own `ref` is believed first: a mapper who wrote `ref=7` on a green has
 * said which hole it is, and no distance measurement outranks that — though on a
 * club with several nines it is read the same way a hole's own ref is, since
 * `ref=Lakes #7` names a nine as well as a number. Everything else goes to the
 * nearest hole and only inside the ceiling for its kind: a practice green by the
 * clubhouse is nearest to *something*, and putting it on that hole would draw a
 * shape the contributor is being asked to trust on a hole it has nothing to do
 * with.
 */
function attachFeatures(
  holes: OsmHole[],
  candidates: {
    feature: OsmHoleFeature;
    ref: { nine: string | null; number: number } | null;
    centre: LngLat;
  }[],
): void {
  if (holes.length === 0) return;
  /* Keyed on the nine and the number the tag actually carries, which is what a
   * feature's ref is written in — not on the card number the hole ended up with. */
  const byTag = new Map<string, OsmHole>(
    holes.map((hole) => [`${hole.nine ?? ''}#${parseHoleRef(hole.osmRef)?.number ?? hole.ref}`, hole]),
  );

  for (const candidate of candidates) {
    const tagged = candidate.ref
      ? (byTag.get(`${candidate.ref.nine ?? ''}#${candidate.ref.number}`) ??
        /* A bare `ref=7` on a course with one nine still names hole 7. */
        (candidate.ref.nine === null && byTag.size === holes.length
          ? holes.find((hole) => parseHoleRef(hole.osmRef)?.number === candidate.ref?.number && hole.nine === null)
          : undefined))
      : undefined;
    if (tagged) {
      tagged.features.push(candidate.feature);
      continue;
    }
    let nearest: OsmHole | null = null;
    let nearestYards = Infinity;
    for (const hole of holes) {
      const yards = yardsToHole(candidate.feature.kind, candidate.centre, hole.line);
      if (yards < nearestYards) {
        nearest = hole;
        nearestYards = yards;
      }
    }
    if (nearest && nearestYards <= ceilingFor(candidate.feature.kind)) {
      nearest.features.push(candidate.feature);
    }
  }
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

  /*
   * The playing lines, with their geometry.
   *
   * A hole is read as the nine it belongs to plus its number within that nine,
   * because on a club with more than one nine those are two different facts and
   * the tag carries both. The nine's name comes off `ref` where the mapper put
   * it there ("Lakes #4") and off `name` where they put it there instead
   * ("Mountain #1", `ref=1`) — Hidden Valley in Sandy does both, on the same
   * course, and reading only `ref` leaves its Mountain nine answering to every
   * card number while eighteen other holes go missing.
   */
  const drawnHoles = new Map<string, RawHole>();
  for (const element of elements) {
    if (element.tags?.golf !== 'hole') continue;
    const tagged = parseHoleRef(element.tags.ref);
    const named = parseHoleRef(element.tags.name);
    const number = tagged?.number ?? named?.number ?? null;
    if (number === null) continue;
    /* A neighbour's holes sit in the same bbox; only what the adopted line
     * touches is this course's. */
    if (!withinBoundary(element, boundary)) continue;
    const points = toPositions(element.geometry);
    if (points.length < 2) continue;
    /* The name only names the nine when it agrees about which hole it is. */
    const nine = tagged?.nine ?? (named?.number === number ? named.nine : null) ?? null;
    const par = Number.parseInt(element.tags.par ?? '', 10);
    const hole: RawHole = {
      osmId: elementId(element),
      /* Whichever tag names the nine is the one worth quoting back: the
       * Mountain holes are `ref=1` with `name=Mountain #1`, and "1" on its own
       * is exactly the ambiguity the contributor is trying to resolve. */
      osmRef: (tagged?.nine
        ? element.tags.ref
        : named?.nine && named.number === number
          ? element.tags.name
          : (element.tags.ref ?? element.tags.name)
      )?.trim() ?? String(number),
      nine,
      number,
      par: Number.isFinite(par) ? par : null,
      line: { type: 'LineString', coordinates: points.map((point) => [...point]) },
    };
    /*
     * Two ways for one hole happens; the fuller line is the one worth showing.
     * Keyed on the nine as well as the number, so the Lakes 1st and the Mountain
     * 1st are never mistaken for two drawings of the same hole.
     */
    const key = `${nine ?? ''}#${number}`;
    const held = drawnHoles.get(key);
    if (!held || held.line.coordinates.length < hole.line.coordinates.length) {
      drawnHoles.set(key, hole);
    }
  }
  const holes = numberAgainstCard([...drawnHoles.values()], query, selected.candidate.name).sort(
    (a, b) => a.ref - b.ref,
  );

  /* What OSM outlines along those lines, attached to whichever hole owns it. */
  const outlined: {
    feature: OsmHoleFeature;
    ref: { nine: string | null; number: number } | null;
    centre: LngLat;
  }[] = [];
  for (const element of elements) {
    const tag = element.tags?.golf;
    if (!tag) continue;
    const kind = GOLF_TAG_KIND[tag];
    if (!kind) continue;
    if (!withinBoundary(element, boundary)) continue;
    const id = elementId(element);
    const parts = golfGeometries(element, kind);
    parts.forEach((geometry, index) => {
      outlined.push({
        feature: {
          /* A split multipolygon is several drawn shapes off one element, so the
           * part index keeps their ids distinct. */
          id: parts.length > 1 ? `${id}#${index}` : id,
          kind,
          tag,
          name: element.tags?.name?.trim() || null,
          geometry,
        },
        ref: parseHoleRef(element.tags?.ref) ?? null,
        centre: labelPoint(geometry),
      });
    });
  }
  attachFeatures(holes, outlined);

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
      mappedHoleRefs: holes.map((hole) => hole.ref),
      holes,
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
