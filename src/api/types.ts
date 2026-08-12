/**
 * Types for OpenGolfAPI. The service answers two endpoints with two different
 * record shapes — `/v1/courses/search` and `/api/v1/courses/{id}` — so search
 * and detail are modelled separately rather than as one resource.
 *
 * `city`, `state`, and `par` are optional everywhere: the API returns null for
 * all three on most records, and callers must render without them.
 */

/** One row from `/v1/courses/search`. Coordinates are always present. */
export interface CourseSummary {
  id: string;
  /** The display name. Falls back to `course_name` when `name` is absent. */
  name: string;
  latitude: number;
  longitude: number;
  city?: string;
  state?: string;
  /** Access classification, e.g. "Resort/Public". */
  type?: string;
  par?: number;
  phone?: string;
  website?: string;
}

/** One tee set from a detail record. `tee_key` carries a gender suffix, e.g. "blue-male". */
export interface CourseTee {
  tee_key: string;
  tee_name?: string;
  tee_color?: string;
  gender?: string;
  course_rating?: number;
  slope?: number;
  par?: number;
  yardage?: number;
}

/**
 * One hole from a detail record. `yardages` is keyed by tee color, and
 * `handicap_index` is the hole's stroke index — neither is carried by the
 * `/v1/courses/{id}` shape, which is why detail must use `/api/v1`.
 */
export interface CourseHole {
  number: number;
  par?: number;
  handicap_index?: number;
  yardages: Record<string, number>;
}

/**
 * A record from `/api/v1/courses/{id}`. The API names its coordinates `lat`/`lng`
 * here; they are normalized to `latitude`/`longitude` so every consumer reads one
 * field pair regardless of which endpoint produced the record.
 */
export interface CourseDetail {
  id: string;
  course_name: string;
  club_name?: string;
  city?: string;
  state?: string;
  latitude: number;
  longitude: number;
  par?: number;
  holes?: number;
  yardage?: number;
  tees: CourseTee[];
  holes_data: CourseHole[];
}

/** Why a request failed, so callers state the cause without inspecting raw errors. */
export type ApiFailureReason = 'network' | 'http' | 'malformed';

/**
 * Every call resolves to one of these — nothing throws. `empty` is a successful
 * request that yielded no usable records; `aborted` is a cancellation the caller
 * asked for and should not surface as an error.
 */
export type ApiResult<T> =
  | { status: 'ok'; data: T; attribution?: string }
  | { status: 'empty'; attribution?: string }
  | {
      status: 'failed';
      reason: ApiFailureReason;
      message: string;
      statusCode?: number;
      /** Never present on a failure; declared so `result.attribution` reads off the union. */
      attribution?: undefined;
    }
  | { status: 'aborted'; attribution?: undefined };
