import type {
  ApiResult,
  CourseDetail,
  CourseHole,
  CourseSummary,
  CourseTee,
} from './types';

/**
 * Every OpenGolfAPI call the app makes. Requests go browser-direct — the service
 * serves `access-control-allow-origin: *` and needs no key, so there is no proxy
 * and no backend.
 *
 * Two endpoints, two record shapes: search answers `/v1/courses/search`, detail
 * answers `/api/v1/courses/{id}`. `/v1/courses/{id}` exists but returns only a
 * bare `scorecard` with no tees and no per-hole yardages, so it is never used.
 *
 * No React here — the module stays a pure unit.
 */
export const API_BASE = 'https://api.opengolfapi.org';

/**
 * OpenGolfAPI serves worldwide records and ranks loosely, so most of any page is
 * non-US — 19 of 20 for a query like "golf". Ask for a wide page so the US filter
 * has something to keep. `per_page` is ignored by the API; `limit` is honored.
 */
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * US bounding boxes, per R13. The product's scorecard, imagery, and elevation
 * inputs are all US-bound, so results outside these boxes are dropped before the
 * caller sees them.
 */
const US_BOXES: ReadonlyArray<{ minLat: number; maxLat: number; minLon: number; maxLon: number }> = [
  { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }, // contiguous states
  { minLat: 51, maxLat: 72, minLon: -180, maxLon: -129 }, // Alaska
  { minLat: 18, maxLat: 23, minLon: -161, maxLon: -154 }, // Hawaii
];

/** True when a coordinate pair falls inside one of the US boxes. */
export function isInUnitedStates(latitude: number, longitude: number): boolean {
  return US_BOXES.some(
    (box) =>
      latitude >= box.minLat &&
      latitude <= box.maxLat &&
      longitude >= box.minLon &&
      longitude <= box.maxLon,
  );
}

/** A string the API may return as null, "", or a non-string. Absent beats the string "null". */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A number the API may return as null, or as a numeric string. */
function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toSummary(raw: unknown): CourseSummary | null {
  const record = asRecord(raw);
  const id = optionalString(record.id);
  const name = optionalString(record.name) ?? optionalString(record.course_name);
  const latitude = optionalNumber(record.latitude);
  const longitude = optionalNumber(record.longitude);
  if (!id || !name || latitude === undefined || longitude === undefined) return null;

  const summary: CourseSummary = { id, name, latitude, longitude };
  const city = optionalString(record.city);
  const state = optionalString(record.state);
  const type = optionalString(record.type);
  const par = optionalNumber(record.par);
  const phone = optionalString(record.phone);
  const website = optionalString(record.website);
  if (city !== undefined) summary.city = city;
  if (state !== undefined) summary.state = state;
  if (type !== undefined) summary.type = type;
  if (par !== undefined) summary.par = par;
  if (phone !== undefined) summary.phone = phone;
  if (website !== undefined) summary.website = website;
  return summary;
}

function toTee(raw: unknown): CourseTee | null {
  const record = asRecord(raw);
  const teeKey = optionalString(record.tee_key);
  if (!teeKey) return null;

  const tee: CourseTee = { tee_key: teeKey };
  const teeName = optionalString(record.tee_name);
  const teeColor = optionalString(record.tee_color);
  const gender = optionalString(record.gender);
  const courseRating = optionalNumber(record.course_rating);
  const slope = optionalNumber(record.slope);
  const par = optionalNumber(record.par);
  const yardage = optionalNumber(record.yardage);
  if (teeName !== undefined) tee.tee_name = teeName;
  if (teeColor !== undefined) tee.tee_color = teeColor;
  if (gender !== undefined) tee.gender = gender;
  if (courseRating !== undefined) tee.course_rating = courseRating;
  if (slope !== undefined) tee.slope = slope;
  if (par !== undefined) tee.par = par;
  if (yardage !== undefined) tee.yardage = yardage;
  return tee;
}

function toHole(raw: unknown): CourseHole | null {
  const record = asRecord(raw);
  const number = optionalNumber(record.number);
  if (number === undefined) return null;

  const yardages: Record<string, number> = {};
  for (const [color, value] of Object.entries(asRecord(record.yardages))) {
    const yards = optionalNumber(value);
    if (yards !== undefined) yardages[color] = yards;
  }

  const hole: CourseHole = { number, yardages };
  const par = optionalNumber(record.par);
  const handicapIndex = optionalNumber(record.handicap_index);
  if (par !== undefined) hole.par = par;
  if (handicapIndex !== undefined) hole.handicap_index = handicapIndex;
  return hole;
}

/**
 * Detail records name their coordinates `lat`/`lng`. Rebuild the record rather
 * than spreading it, so `lat`/`lng` never reach a consumer that would then have
 * two field pairs to choose between.
 */
function toDetail(raw: unknown): CourseDetail | null {
  const record = asRecord(raw);
  const id = optionalString(record.id);
  const courseName = optionalString(record.course_name) ?? optionalString(record.name);
  const latitude = optionalNumber(record.lat) ?? optionalNumber(record.latitude);
  const longitude = optionalNumber(record.lng) ?? optionalNumber(record.longitude);
  if (!id || !courseName || latitude === undefined || longitude === undefined) return null;

  const detail: CourseDetail = {
    id,
    course_name: courseName,
    latitude,
    longitude,
    tees: (Array.isArray(record.tees) ? record.tees : []).map(toTee).filter(isPresent),
    holes_data: (Array.isArray(record.holes_data) ? record.holes_data : [])
      .map(toHole)
      .filter(isPresent),
  };
  const clubName = optionalString(record.club_name);
  const city = optionalString(record.city);
  const state = optionalString(record.state);
  const par = optionalNumber(record.par);
  const holes = optionalNumber(record.holes);
  const yardage = optionalNumber(record.yardage);
  if (clubName !== undefined) detail.club_name = clubName;
  if (city !== undefined) detail.city = city;
  if (state !== undefined) detail.state = state;
  if (par !== undefined) detail.par = par;
  if (holes !== undefined) detail.holes = holes;
  if (yardage !== undefined) detail.yardage = yardage;
  return detail;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/** The union's failure branch, so every caller reads one shape. */
function failure(
  reason: 'network' | 'http' | 'malformed',
  message: string,
  statusCode?: number,
): ApiResult<never> {
  return statusCode === undefined
    ? { status: 'failed', reason, message }
    : { status: 'failed', reason, message, statusCode };
}

/**
 * Fetch and parse JSON, folding every failure mode into the result union: a
 * rejected fetch is `network`, a non-2xx is `http`, an unreadable body is
 * `malformed`, and a cancellation is `aborted`.
 */
async function fetchJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ ok: true; body: unknown } | { ok: false; result: ApiResult<never> }> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, result: { status: 'aborted' } };
    const message = error instanceof Error ? error.message : 'Network request failed';
    return { ok: false, result: failure('network', message) };
  }

  if (!response.ok) {
    return {
      ok: false,
      result: failure('http', `Request failed with status ${response.status}`, response.status),
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, result: { status: 'aborted' } };
    return { ok: false, result: failure('malformed', 'Response was not valid JSON') };
  }
}

/**
 * Search courses by name, filtered to the US per R13.
 *
 * Resolves to `empty` when the query is blank, when the API returns no records,
 * or when every record it returned falls outside the US — a populated non-US page
 * is not a result the caller can use.
 */
export async function searchCourses(
  query: string,
  signal?: AbortSignal,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<ApiResult<CourseSummary[]>> {
  const trimmed = query.trim();
  if (trimmed === '') return { status: 'empty' };

  const url = new URL('/v1/courses/search', API_BASE);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(limit));

  const fetched = await fetchJson(url.toString(), signal);
  if (!fetched.ok) return fetched.result;

  const body = asRecord(fetched.body);
  const attribution = optionalString(body._attribution);
  const raw = Array.isArray(body.courses) ? body.courses : [];
  const courses = raw
    .map(toSummary)
    .filter(isPresent)
    .filter((course) => isInUnitedStates(course.latitude, course.longitude));

  if (courses.length === 0) {
    return attribution === undefined ? { status: 'empty' } : { status: 'empty', attribution };
  }
  return attribution === undefined
    ? { status: 'ok', data: courses }
    : { status: 'ok', data: courses, attribution };
}

/**
 * Load one course's detail record. Uses `/api/v1`, the only path that carries
 * `tees` and `holes_data`; `/v1/courses/{id}` answers with a bare par-only
 * scorecard and would leave the board without yardages or handicap indexes.
 */
export async function getCourse(
  id: string,
  signal?: AbortSignal,
): Promise<ApiResult<CourseDetail>> {
  const url = new URL(`/api/v1/courses/${encodeURIComponent(id)}`, API_BASE);

  const fetched = await fetchJson(url.toString(), signal);
  if (!fetched.ok) return fetched.result;

  const detail = toDetail(fetched.body);
  if (!detail) return failure('malformed', 'Course record was missing required fields');

  const attribution = optionalString(asRecord(fetched.body)._attribution);
  return attribution === undefined
    ? { status: 'ok', data: detail }
    : { status: 'ok', data: detail, attribution };
}
