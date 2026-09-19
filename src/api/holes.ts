import type { LineString, MultiPolygon, Polygon } from 'geojson';
import { DETECT_API_BASE, interpretFailure, readEnvelope, type DetectFailureReason } from './detect';

/**
 * Saving a finished hole, and a corrected course boundary, to our own store.
 *
 * This is the record the OpenStreetMap upload will be built from, so it keeps
 * everything the upload needs and nothing it would have to re-derive: the
 * playing line, every confirmed shape as WGS84 GeoJSON, which tee sets play from
 * which box, what each hazard is, the tags we are sure of, and — for a shape the
 * model proposed — the model's confidence and the imagery it read.
 *
 * Like the decision store, nothing here identifies the contributor. The payload
 * is the course, the hole and the geometry.
 *
 * Nothing throws for an expected condition; every outcome is a `StoreResult`.
 */

/** What a saved shape is, in the vocabulary the store takes. Hazards are named by their type. */
export type SavedFeatureKind =
  | 'tee'
  | 'green'
  | 'fairway'
  | 'bunker'
  | 'water'
  | 'trees'
  | 'waste_area'
  | 'native_area'
  | 'other';

export interface SavedTeeSet {
  key: string;
  name: string;
  yards: number | null;
}

export interface SavedFeature {
  kind: SavedFeatureKind;
  geometry: Polygon | MultiPolygon;
  /** The model proposed it, the contributor drew it, or it was already in OpenStreetMap. */
  origin: 'proposed' | 'drawn' | 'osm';
  /** A proposed or OpenStreetMap shape the contributor moved vertices of. */
  edited: boolean;
  /** The OpenStreetMap element it came from, e.g. "way/500123". Present exactly when `origin` is `osm`. */
  osmId: string | null;
  /**
   * What the OpenStreetMap upload has to do with it: create a new way, keep or
   * modify the one it came from, or look again at one the contributor said is
   * not what this hole's step says it is. See `service/holes.py` `OsmAction`.
   */
  osmAction: OsmAction;
  /** The card's tee sets that play from this box. Tee boxes only. */
  teeSets: SavedTeeSet[];
  label: string | null;
  osmTags: Record<string, string>;
  /** Present exactly when `origin` is `proposed`. */
  proposal: {
    confidence: number;
    provenance: {
      acquired: string;
      gsdMeters: number;
      source: string;
      modelId: string;
      itemId: string;
    };
  } | null;
}

export type LineSourceWire = 'drawn' | 'osm' | 'osm_edited';

export type OsmAction = 'create' | 'keep' | 'modify' | 'dispute';

/** Whether a saved hole has reached OpenStreetMap. Every save starts `pending`. */
export type OsmSyncStatus = 'pending' | 'synced';

export interface SavedHole {
  courseId: string;
  holeNumber: number;
  par: number | null;
  playingLine: LineString;
  lineSource: LineSourceWire;
  osmHoleId: string | null;
  features: SavedFeature[];
  /** ISO-8601, set by the store. Absent on a hole not yet saved. */
  savedAt?: string;
  /** Set by the store: `pending` until the upload has sent the hole. */
  osmSyncStatus?: OsmSyncStatus;
  osmSyncedAt?: string | null;
}

export interface SavedBoundary {
  courseId: string;
  osmId: string | null;
  geometry: Polygon | MultiPolygon;
  edited: boolean;
  savedAt?: string;
}

export type StoreResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'failed'; reason: DetectFailureReason; message: string; statusCode?: number }
  | { status: 'aborted' };

/* --- Wire shapes ---------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function featureToWire(feature: SavedFeature) {
  return {
    kind: feature.kind,
    geometry: feature.geometry,
    origin: feature.origin,
    edited: feature.edited,
    tee_sets: feature.teeSets,
    label: feature.label,
    osm_tags: feature.osmTags,
    osm_id: feature.osmId,
    osm_action: feature.osmAction,
    proposal: feature.proposal && {
      confidence: feature.proposal.confidence,
      provenance: {
        acquired: feature.proposal.provenance.acquired,
        gsd_meters: feature.proposal.provenance.gsdMeters,
        source: feature.proposal.provenance.source,
        model_id: feature.proposal.provenance.modelId,
        item_id: feature.proposal.provenance.itemId,
      },
    },
  };
}

export function holeToWire(hole: SavedHole) {
  return {
    course_id: hole.courseId,
    hole_number: hole.holeNumber,
    par: hole.par,
    playing_line: hole.playingLine,
    line_source: hole.lineSource,
    osm_hole_id: hole.osmHoleId,
    features: hole.features.map(featureToWire),
  };
}

function featureFromWire(value: unknown): SavedFeature | null {
  const raw = asRecord(value);
  const geometry = asRecord(raw.geometry);
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
  if (typeof raw.kind !== 'string') return null;
  const proposal = raw.proposal ? asRecord(raw.proposal) : null;
  const provenance = proposal ? asRecord(proposal.provenance) : null;
  return {
    kind: raw.kind as SavedFeatureKind,
    geometry: raw.geometry as Polygon | MultiPolygon,
    origin: raw.origin === 'proposed' || raw.origin === 'osm' ? raw.origin : 'drawn',
    edited: raw.edited === true,
    osmId: typeof raw.osm_id === 'string' ? raw.osm_id : null,
    osmAction:
      raw.osm_action === 'keep' || raw.osm_action === 'modify' || raw.osm_action === 'dispute'
        ? raw.osm_action
        : 'create',
    teeSets: Array.isArray(raw.tee_sets)
      ? raw.tee_sets.map((entry) => {
          const tee = asRecord(entry);
          return {
            key: String(tee.key ?? ''),
            name: String(tee.name ?? ''),
            yards: typeof tee.yards === 'number' ? tee.yards : null,
          };
        })
      : [],
    label: typeof raw.label === 'string' ? raw.label : null,
    osmTags: asRecord(raw.osm_tags) as Record<string, string>,
    proposal:
      proposal && provenance
        ? {
            confidence: Number(proposal.confidence ?? 0),
            provenance: {
              acquired: String(provenance.acquired ?? ''),
              gsdMeters: Number(provenance.gsd_meters ?? 0),
              source: String(provenance.source ?? ''),
              modelId: String(provenance.model_id ?? ''),
              itemId: String(provenance.item_id ?? ''),
            },
          }
        : null,
  };
}

export function holeFromWire(value: unknown): SavedHole | null {
  const raw = asRecord(value);
  const line = asRecord(raw.playing_line);
  if (typeof raw.course_id !== 'string' || typeof raw.hole_number !== 'number') return null;
  if (line.type !== 'LineString' || !Array.isArray(line.coordinates)) return null;
  const source = raw.line_source;
  return {
    courseId: raw.course_id,
    holeNumber: raw.hole_number,
    par: typeof raw.par === 'number' ? raw.par : null,
    playingLine: raw.playing_line as LineString,
    lineSource: source === 'osm' || source === 'osm_edited' ? source : 'drawn',
    osmHoleId: typeof raw.osm_hole_id === 'string' ? raw.osm_hole_id : null,
    features: (Array.isArray(raw.features) ? raw.features : [])
      .map(featureFromWire)
      .filter((feature): feature is SavedFeature => feature !== null),
    savedAt: typeof raw.saved_at === 'string' ? raw.saved_at : undefined,
    osmSyncStatus: raw.osm_sync_status === 'synced' ? 'synced' : 'pending',
    osmSyncedAt: typeof raw.osm_synced_at === 'string' ? raw.osm_synced_at : null,
  };
}

function boundaryFromWire(value: unknown): SavedBoundary | null {
  const raw = asRecord(value);
  const geometry = asRecord(raw.geometry);
  if (typeof raw.course_id !== 'string') return null;
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
  return {
    courseId: raw.course_id,
    osmId: typeof raw.osm_id === 'string' ? raw.osm_id : null,
    geometry: raw.geometry as Polygon | MultiPolygon,
    edited: raw.edited !== false,
    savedAt: typeof raw.saved_at === 'string' ? raw.saved_at : undefined,
  };
}

/* --- Requests ------------------------------------------------------------- */

/**
 * One request against the store, read the way the decision client reads one: a
 * 2xx whose body says `ok` is success, and everything else is a stated failure.
 * A 502 `{"status":"upstream"}` is the service running without a store, which
 * the contributor needs to hear as "not saved", never as success.
 */
async function storeRequest<T>(
  path: string,
  init: RequestInit,
  read: (body: Record<string, unknown>) => T | undefined,
  signal?: AbortSignal,
): Promise<StoreResult<T>> {
  if (signal?.aborted) return { status: 'aborted' };
  const envelope = await readEnvelope(
    `${DETECT_API_BASE}${path}`,
    { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } },
    signal,
  );
  if (!envelope.ok) {
    const result = envelope.result;
    if (result.status === 'aborted') return { status: 'aborted' };
    if (result.status === 'failed') return result;
    return { status: 'failed', reason: 'malformed', message: 'The store answered unreadably.' };
  }
  if (envelope.httpStatus < 200 || envelope.httpStatus >= 300 || envelope.body.status !== 'ok') {
    const failed = interpretFailure(envelope.body, envelope.httpStatus);
    if (failed.status === 'failed') return failed;
    return {
      status: 'failed',
      reason: 'upstream',
      message: 'message' in failed ? failed.message : 'The store did not accept it.',
    };
  }
  /* `undefined` is "unreadable"; `null` can be a real answer (no saved boundary). */
  const data = read(envelope.body);
  if (data === undefined) {
    return { status: 'failed', reason: 'malformed', message: 'The store answered in a shape we cannot read.' };
  }
  return { status: 'ok', data };
}

/** Save one finished hole. A re-save is a new version; the store keeps both. */
export function saveHole(hole: SavedHole, signal?: AbortSignal): Promise<StoreResult<SavedHole>> {
  return storeRequest(
    '/v1/holes',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(holeToWire(hole)),
    },
    (body) => holeFromWire(body.hole) ?? undefined,
    signal,
  );
}

/** The latest saved version of every hole on a course. */
export function listSavedHoles(courseId: string, signal?: AbortSignal): Promise<StoreResult<SavedHole[]>> {
  return storeRequest(
    `/v1/holes/${encodeURIComponent(courseId)}`,
    { method: 'GET' },
    (body) =>
      Array.isArray(body.holes)
        ? body.holes.map(holeFromWire).filter((hole): hole is SavedHole => hole !== null)
        : undefined,
    signal,
  );
}

/** Save a corrected course boundary. */
export function saveBoundary(
  boundary: SavedBoundary,
  signal?: AbortSignal,
): Promise<StoreResult<SavedBoundary>> {
  return storeRequest(
    `/v1/courses/${encodeURIComponent(boundary.courseId)}/boundary`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ osm_id: boundary.osmId, geometry: boundary.geometry, edited: boundary.edited }),
    },
    (body) => boundaryFromWire(body.boundary) ?? undefined,
    signal,
  );
}

/** The latest corrected boundary for a course, or null when nobody has corrected it. */
export function getSavedBoundary(
  courseId: string,
  signal?: AbortSignal,
): Promise<StoreResult<SavedBoundary | null>> {
  return storeRequest(
    `/v1/courses/${encodeURIComponent(courseId)}/boundary`,
    { method: 'GET' },
    (body) => (body.boundary === null ? null : boundaryFromWire(body.boundary) ?? undefined),
    signal,
  );
}
