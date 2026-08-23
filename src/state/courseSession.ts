import type { OsmLookup } from '../api/overpass';
import type { CourseDetail } from '../api/types';
import { TEE_IDS, type HoleStatus, type TeeId } from '../data/course';

/**
 * The loaded course, in the shape the screens read.
 *
 * OpenGolfAPI's detail record answers two different vocabularies for the same
 * tee set: `tees[].tee_key` is gendered ("blue-male", "gold-female"), while
 * `holes_data[].yardages` is keyed by bare color ("blue", "gold") plus a stray
 * "web" column no tee claims. The session joins the two once, here, so no screen
 * has to know either vocabulary.
 *
 * Pure — no React, no fetching. `src/App.tsx` owns the request and hands the
 * record in.
 */

/** One tee set, already joined to the color its per-hole yardages live under. */
export interface SessionTee {
  /** The `yardages` key this set reads, e.g. "blue". */
  color: string;
  /** Display name, e.g. "Blue". */
  name: string;
  swatch: string;
  /** Total yardage for the set, when the record carries one. */
  yd: number | null;
}

/** One hole's card. Every number is nullable — most records are partial. */
export interface SessionHole {
  number: number;
  par: number | null;
  handicapIndex: number | null;
  /** Yardage by tee color, exactly as the record carried it. */
  yardages: Record<string, number>;
}

export interface CourseSession {
  id: string;
  name: string;
  /** The one-line card summary under the course name, e.g. "par 72 · 6,802 yd · 18 holes". */
  meta: string;
  holes: SessionHole[];
  tees: SessionTee[];
  /** False when the record carried no `holes_data`: pars and yardages are unknown. */
  cardAvailable: boolean;
  latitude: number;
  longitude: number;
}

/** One row of a hole's card, ready to render. */
export interface ScorecardRow {
  name: string;
  yd: number;
  swatch: string;
}

/** Courses with no `holes_data` still need tiles; 18 is the only sane guess. */
const ASSUMED_HOLE_COUNT = 18;

/**
 * Gender suffixes seen on `tee_key`. Only these are stripped — a key like
 * "white-tee" keeps its whole string, since "white-tee" is the color.
 */
const GENDER_SUFFIXES = new Set([
  'male',
  'female',
  'men',
  'mens',
  'women',
  'womens',
  'ladies',
  'senior',
  'seniors',
  'junior',
  'juniors',
  'm',
  'f',
]);

/** Swatches for the tee colors the API actually names. Anything else reads slate. */
const SWATCHES: Record<string, string> = {
  black: '#1b201c',
  blue: '#2b7fa8',
  bronze: '#a2703c',
  brown: '#7a5a3a',
  championship: '#1b201c',
  copper: '#a2703c',
  gold: '#c98a15',
  gray: '#8d9698',
  green: '#237a5c',
  grey: '#8d9698',
  maroon: '#7a2c33',
  navy: '#274b7a',
  orange: '#d2762a',
  pink: '#cf7f9c',
  purple: '#7a5aa8',
  red: '#b4462f',
  silver: '#b9c0c4',
  tan: '#c8b189',
  teal: '#2b9a94',
  white: '#e8ebdf',
  yellow: '#d8c02f',
};

const DEFAULT_SWATCH = '#8d9698';

/** "blue-male" → "blue". A key with no gender suffix comes back whole. */
export function teeColorKey(teeKey: string): string {
  const lower = teeKey.trim().toLowerCase();
  const cut = lower.lastIndexOf('-');
  if (cut > 0 && GENDER_SUFFIXES.has(lower.slice(cut + 1))) return lower.slice(0, cut);
  return lower;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function buildHoles(detail: CourseDetail): SessionHole[] {
  if (detail.holes_data.length > 0) {
    return [...detail.holes_data]
      .sort((a, b) => a.number - b.number)
      .map((hole) => ({
        number: hole.number,
        par: hole.par ?? null,
        handicapIndex: hole.handicap_index ?? null,
        yardages: hole.yardages,
      }));
  }

  const count =
    detail.holes !== undefined && detail.holes > 0 ? Math.round(detail.holes) : ASSUMED_HOLE_COUNT;
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    par: null,
    handicapIndex: null,
    yardages: {},
  }));
}

/**
 * One row per color, longest first.
 *
 * A color the card never lists a yardage for is dropped rather than rendered
 * blank: the tee row exists to carry a number, and Pebble Beach ships tee rows
 * whose color appears in no hole's `yardages`.
 */
function buildTees(detail: CourseDetail, holes: SessionHole[]): SessionTee[] {
  const columns = new Set<string>();
  for (const hole of holes) for (const color of Object.keys(hole.yardages)) columns.add(color);

  const byColor = new Map<string, SessionTee>();
  for (const tee of detail.tees) {
    const fromKey = teeColorKey(tee.tee_key);
    const fromColor = tee.tee_color?.trim().toLowerCase();
    const color = columns.has(fromKey) ? fromKey : fromColor && columns.has(fromColor) ? fromColor : null;
    if (!color) continue;

    const existing = byColor.get(color);
    if (existing) {
      /* Gendered rows repeat the color; keep the longest yardage of the set. */
      if (tee.yardage !== undefined && (existing.yd === null || tee.yardage > existing.yd)) {
        existing.yd = tee.yardage;
      }
      continue;
    }

    byColor.set(color, {
      color,
      name: tee.tee_name?.trim() || titleCase(color),
      swatch: SWATCHES[color] ?? DEFAULT_SWATCH,
      yd: tee.yardage ?? null,
    });
  }

  const totalFor = (color: string) =>
    holes.reduce((sum, hole) => sum + (hole.yardages[color] ?? 0), 0);

  return [...byColor.values()].sort((a, b) => (b.yd ?? totalFor(b.color)) - (a.yd ?? totalFor(a.color)));
}

function buildMeta(detail: CourseDetail, holes: SessionHole[], cardAvailable: boolean): string {
  const parts: string[] = [];

  const summedPar =
    cardAvailable && holes.every((hole) => hole.par !== null)
      ? holes.reduce((sum, hole) => sum + (hole.par ?? 0), 0)
      : undefined;
  const par = detail.par ?? summedPar;
  if (par !== undefined && par > 0) parts.push(`par ${par}`);

  if (detail.yardage !== undefined && detail.yardage > 0) {
    parts.push(`${detail.yardage.toLocaleString('en-US')} yd`);
  }

  parts.push(`${holes.length} hole${holes.length === 1 ? '' : 's'}`);

  const place = [detail.city, detail.state].filter((part): part is string => !!part).join(', ');
  if (place) parts.push(place);

  return parts.join(' · ');
}

/** Turn one detail record into the session every screen reads. */
export function buildCourseSession(detail: CourseDetail): CourseSession {
  const holes = buildHoles(detail);
  const cardAvailable = detail.holes_data.length > 0;
  return {
    id: detail.id,
    name: detail.course_name,
    meta: buildMeta(detail, holes, cardAvailable),
    holes,
    tees: buildTees(detail, holes),
    cardAvailable,
    latitude: detail.latitude,
    longitude: detail.longitude,
  };
}

/** The hole's card yardage from the longest tee that lists one. */
export function holeYardage(session: CourseSession, holeIndex: number): number | null {
  const hole = session.holes[holeIndex];
  if (!hole) return null;
  for (const tee of session.tees) {
    const yd = hole.yardages[tee.color];
    if (yd !== undefined) return yd;
  }
  const listed = Object.values(hole.yardages);
  return listed.length > 0 ? Math.max(...listed) : null;
}

/** One row per tee that lists a yardage for this hole, longest first. */
export function scorecardFor(session: CourseSession, holeIndex: number): ScorecardRow[] {
  const hole = session.holes[holeIndex];
  if (!hole) return [];
  return session.tees
    .filter((tee) => hole.yardages[tee.color] !== undefined)
    .map((tee) => ({ name: tee.name, yd: hole.yardages[tee.color], swatch: tee.swatch }));
}

/**
 * Names for the review screen's four tee slots, back to front. Courses carrying
 * fewer than four sets repeat the shortest rather than leaving a slot blank.
 */
export function defaultTeeAssign(session: CourseSession): Record<TeeId, string> {
  const last = session.tees.length - 1;
  const nameAt = (i: number) => (last < 0 ? 'Tee' : session.tees[Math.min(i, last)].name);
  const assign = {} as Record<TeeId, string>;
  TEE_IDS.forEach((id, i) => {
    assign[id] = i === TEE_IDS.length - 1 ? nameAt(last) : nameAt(i);
  });
  return assign;
}

/**
 * Hole statuses sized to the loaded course and driven by what OpenStreetMap
 * already holds (R10).
 *
 * The three outcomes stay three different answers. A found boundary marks the
 * refs Overpass returned as complete and the rest as `unmapped`; an absent course
 * is `unmapped` throughout; a failed or still-running lookup is `unknown`
 * throughout, which is not the same claim as zero (R16).
 */
export function holeStatusesFrom(session: CourseSession, lookup: OsmLookup): HoleStatus[] {
  if (lookup.status === 'found') {
    const mapped = new Set(lookup.course.mappedHoleRefs);
    return session.holes.map((hole) => (mapped.has(hole.number) ? 'complete' : 'unmapped'));
  }
  const status: HoleStatus = lookup.status === 'absent' ? 'unmapped' : 'unknown';
  return session.holes.map(() => status);
}
