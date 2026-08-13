import type { MultiPolygon, Polygon } from 'geojson';
import type { LngLat } from '../geo/coords';

/**
 * The hole-feature detection service: submit a drawn playing line, poll the job
 * it returns, and read back proposed features over NAIP imagery.
 *
 * Spawn-and-poll rather than one blocking call, because that is what the service
 * offers: a cold GPU container spends tens of seconds on boot, torch import and
 * checkpoint load, and a synchronous request over that would surface as a
 * transport error rather than the typed timeout R12 needs. So this module owns a
 * bounded polling loop instead — and the loop's delay is injected, so a caller
 * (or a test) can drive it without waiting on a real clock.
 *
 * Nothing here throws for an expected condition. Every outcome the service can
 * produce, and every way the network can fail, resolves to a `DetectResult`.
 *
 * No React here — the module stays a pure unit.
 */

/**
 * Where the detection service answers.
 *
 * A module constant, the same convention `API_BASE` follows in `opengolf.ts`.
 * This URL ships in the browser bundle and is not a secret: production sits
 * behind an authenticating identity proxy, which owns access control, so the
 * service itself carries no auth logic and knowing its address grants nothing.
 */
export const DETECT_API_BASE = 'https://opengolf--golf-hole-detection-fastapi-app.modal.run';

/** How long to leave between polls. Long enough not to hammer a cold container. */
export const POLL_INTERVAL_MS = 2_000;

/** What to assume the budget is when the service does not state one. */
export const DEFAULT_BUDGET_SECONDS = 60;

/**
 * Polls allowed past the stated budget, so the service's own typed timeout wins
 * the race with ours. The service knows why it ran out; we only know that it did.
 */
const POLL_GRACE = 3;

/** A ceiling no budget can talk us past — the loop must be bounded by construction. */
const MAX_POLLS = 120;

/** The five things detection classifies. Anything else is not a proposal we can render. */
export type ProposalKind = 'green' | 'tee' | 'bunker' | 'water' | 'fairway';

const PROPOSAL_KINDS = new Set<string>(['green', 'tee', 'bunker', 'water', 'fairway']);

/** One scorecard tee set, in the vocabulary the service takes and returns. */
export interface TeeSetRef {
  name: string;
  yards: number;
  key: string;
}

/** What the caller asks about: the drawn line, plus whatever the card knows. */
export interface DetectRequest {
  /** WGS84 `[lng, lat]`, ordered tee → green — the direction classification depends on. */
  line: LngLat[];
  par?: number;
  teeSets?: TeeSetRef[];
}

/**
 * One proposed feature.
 *
 * Flat rather than a GeoJSON `Feature` with a properties bag: the review sequence
 * reads `kind`, `confidence` and `teeSet` on every render, and the geometry is
 * handed to `courseFeature` when it is time to draw. `id` is assigned here — the
 * service does not name its proposals, and the review sequence needs a key.
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  geometry: Polygon | MultiPolygon;
  /** 0–1, the model's own confidence. */
  confidence: number;
  areaSquareMeters: number | null;
  vertexCount: number | null;
  /** Why the classifier said what it said, in plain words. */
  notes: string[];
  /** The scorecard tee set a tee mask was matched to, when it was matched to one. */
  teeSet: TeeSetRef | null;
  /** NAIP acquisition date, `YYYY-MM-DD`. */
  acquired: string | null;
  gsdMeters: number | null;
  source: string | null;
  modelId: string | null;
  itemId: string | null;
}

/** The corridor raster inference actually read, for provenance and overlay. */
export interface DetectionImagery {
  source: string;
  itemId: string;
  acquired: string;
  gsdMeters: number;
  assetHref: string;
  /** `[west, south, east, north]` in WGS84 — the order `BaseMap` takes. */
  boundsWgs84: [number, number, number, number];
  crs: string;
  width: number;
  height: number;
}

/** Why a detection request failed, so callers state a cause without reading raw errors. */
export type DetectFailureReason = 'network' | 'http' | 'malformed' | 'upstream';

/**
 * Every outcome of one detection request.
 *
 * Deliberately its own union rather than `ApiResult<T>`. The two disagree about
 * what an empty answer means: `ApiResult.empty` is "the request yielded no usable
 * records", while `no_coverage` is a message the service wrote about why, which
 * the screen states verbatim. And `timeout` is not a failure the contributor
 * should read as a broken service — it is the case R12 is about, and folding it
 * into `failed` would lose exactly the distinction the requirement asks for.
 * Widening `ApiResult` instead would push both variants onto every OpenGolfAPI
 * caller, none of which can ever see them.
 *
 * `aborted` keeps the meaning it has in `opengolf.ts`: a cancellation the caller
 * asked for, never surfaced as an error.
 */
export type DetectResult =
  | {
      status: 'ok';
      jobId: string;
      proposals: Proposal[];
      imagery: DetectionImagery | null;
      /** Card tee sets detection found no mask for — a "draw it yourself?" prompt. */
      missingTeeSets: TeeSetRef[];
    }
  | { status: 'no_coverage'; message: string }
  | { status: 'invalid'; message: string; field: string | null }
  | { status: 'timeout'; message: string }
  | { status: 'failed'; reason: DetectFailureReason; message: string; statusCode?: number }
  | { status: 'aborted' };

/** Everything the polling loop needs from the outside, so nothing here reads a real clock. */
export interface DetectOptions {
  signal?: AbortSignal;
  /**
   * The pause between polls. Injected: a test that had to wait out real seconds
   * to prove the loop stops would be slow where it needs to be exact.
   */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/* --- Reading the wire ----------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** The default pause, which gives up early when the caller cancels mid-wait. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function failure(
  reason: DetectFailureReason,
  message: string,
  statusCode?: number,
): DetectResult {
  return statusCode === undefined
    ? { status: 'failed', reason, message }
    : { status: 'failed', reason, message, statusCode };
}

/**
 * One request, read as the service's envelope.
 *
 * A non-2xx is not short-circuited the way `opengolf.ts` does it: the typed
 * timeout arrives as a 504, the validation error as a 422 and the upstream
 * failure as a 502, each with a body that says which it is. So the body is read
 * first and the HTTP status is only the fallback for a body that says nothing.
 */
async function readEnvelope(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<
  { ok: true; httpStatus: number; body: Record<string, unknown> } | { ok: false; result: DetectResult }
> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, result: { status: 'aborted' } };
    const message = error instanceof Error ? error.message : 'Network request failed';
    return { ok: false, result: failure('network', message) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, result: { status: 'aborted' } };
    return {
      ok: false,
      result: response.ok
        ? failure('malformed', 'The detection service answered with something that was not JSON')
        : failure('http', `Detection failed with status ${response.status}`, response.status),
    };
  }

  return { ok: true, httpStatus: response.status, body: asRecord(body) };
}

/**
 * Every non-success envelope, narrowed on its own `status` field.
 *
 * `no_coverage` arrives as a 200 and stays a success with an empty answer;
 * everything else here is either a stated failure or an unreadable one.
 */
function interpretFailure(body: Record<string, unknown>, httpStatus: number): DetectResult {
  const message = optionalString(body.message);
  switch (body.status) {
    case 'no_coverage':
      return {
        status: 'no_coverage',
        message: message ?? 'Detection produced no proposals for this hole.',
      };
    case 'timeout':
      return {
        status: 'timeout',
        message:
          message ?? 'Detection did not finish within the time budget. The hole is still yours to map by hand.',
      };
    case 'invalid':
      return {
        status: 'invalid',
        message: message ?? 'The detection service rejected this request.',
        field: optionalString(body.field),
      };
    case 'upstream':
      return failure(
        'upstream',
        message ?? 'Something the detection service depends on did not answer.',
        httpStatus,
      );
    default:
      return httpStatus >= 200 && httpStatus < 300
        ? failure('malformed', 'The detection service answered in a shape this client cannot read.')
        : failure('http', `Detection failed with status ${httpStatus}`, httpStatus);
  }
}

function toTeeSet(raw: unknown): TeeSetRef | null {
  const record = asRecord(raw);
  const name = optionalString(record.name);
  const key = optionalString(record.key);
  const yards = optionalNumber(record.yards);
  if (!name || !key || yards === null) return null;
  return { name, yards, key };
}

function toGeometry(raw: unknown): Polygon | MultiPolygon | null {
  const record = asRecord(raw);
  if (record.type !== 'Polygon' && record.type !== 'MultiPolygon') return null;
  if (!Array.isArray(record.coordinates) || record.coordinates.length === 0) return null;
  return record as unknown as Polygon | MultiPolygon;
}

/**
 * One GeoJSON Feature as a proposal, or null when it is not one this client can
 * render. A feature with no geometry, or with a kind outside the five detection
 * classes, is dropped rather than guessed at — the alternative is a proposal the
 * review sequence has no step for.
 */
function toProposal(raw: unknown, jobId: string, index: number): Proposal | null {
  const record = asRecord(raw);
  const geometry = toGeometry(record.geometry);
  if (!geometry) return null;

  const properties = asRecord(record.properties);
  const kind = optionalString(properties.kind);
  if (!kind || !PROPOSAL_KINDS.has(kind)) return null;

  return {
    id: `${jobId}-${index}`,
    kind: kind as ProposalKind,
    geometry,
    /* An unstated confidence reads as zero, never as certainty. */
    confidence: optionalNumber(properties.confidence) ?? 0,
    areaSquareMeters: optionalNumber(properties.area_sq_meters),
    vertexCount: optionalNumber(properties.vertex_count),
    notes: Array.isArray(properties.notes)
      ? properties.notes.filter((note): note is string => typeof note === 'string')
      : [],
    teeSet: toTeeSet(properties.tee_set),
    acquired: optionalString(properties.acquired),
    gsdMeters: optionalNumber(properties.gsd_meters),
    source: optionalString(properties.source),
    modelId: optionalString(properties.model_id),
    itemId: optionalString(properties.item_id),
  };
}

/** The corridor raster, or null when the answer did not describe one in full. */
function toImagery(raw: unknown): DetectionImagery | null {
  const record = asRecord(raw);
  const source = optionalString(record.source);
  const itemId = optionalString(record.item_id);
  const acquired = optionalString(record.acquired);
  const assetHref = optionalString(record.asset_href);
  const crs = optionalString(record.crs);
  const gsdMeters = optionalNumber(record.gsd_meters);
  const width = optionalNumber(record.width);
  const height = optionalNumber(record.height);
  const bounds = Array.isArray(record.bounds_wgs84) ? record.bounds_wgs84.map(optionalNumber) : [];
  if (bounds.length !== 4 || bounds.some((value) => value === null)) return null;
  if (!source || !itemId || !acquired || !assetHref || !crs) return null;
  if (gsdMeters === null || width === null || height === null) return null;

  return {
    source,
    itemId,
    acquired,
    gsdMeters,
    assetHref,
    boundsWgs84: bounds as [number, number, number, number],
    crs,
    width,
    height,
  };
}

function toDetection(body: Record<string, unknown>, jobId: string): DetectResult {
  const collection = asRecord(body.features);
  const raw = Array.isArray(collection.features) ? collection.features : [];
  const proposals = raw
    .map((feature, index) => toProposal(feature, jobId, index))
    .filter((proposal): proposal is Proposal => proposal !== null);
  const missing = Array.isArray(body.missing_tee_sets) ? body.missing_tee_sets : [];

  return {
    status: 'ok',
    jobId,
    proposals,
    imagery: toImagery(body.imagery),
    missingTeeSets: missing.map(toTeeSet).filter((tee): tee is TeeSetRef => tee !== null),
  };
}

/* --- Submitting and polling ----------------------------------------------- */

interface Job {
  jobId: string;
  pollUrl: string;
  budgetSeconds: number;
}

/**
 * Enqueue the detection. The service validates the line synchronously and answers
 * 202 with a reference, so a line that is too long fails here rather than after a
 * poll round trip.
 *
 * Only the fields the caller actually has are sent: the service rejects unknown
 * fields, and an explicit `par: null` is an unknown-shaped value, not an absent one.
 */
async function submit(
  request: DetectRequest,
  signal?: AbortSignal,
): Promise<{ ok: true; job: Job } | { ok: false; result: DetectResult }> {
  const payload: Record<string, unknown> = {
    line: request.line.map((point) => [point[0], point[1]]),
  };
  if (request.par !== undefined) payload.par = request.par;
  if (request.teeSets !== undefined && request.teeSets.length > 0) {
    payload.tee_sets = request.teeSets.map((tee) => ({
      name: tee.name,
      yards: tee.yards,
      key: tee.key,
    }));
  }

  const envelope = await readEnvelope(
    `${DETECT_API_BASE}/v1/detect`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    },
    signal,
  );
  if (!envelope.ok) return envelope;

  const jobId = optionalString(envelope.body.job_id);
  const pollUrl = optionalString(envelope.body.poll_url);
  if (!jobId || !pollUrl) return { ok: false, result: interpretFailure(envelope.body, envelope.httpStatus) };

  return {
    ok: true,
    job: {
      jobId,
      pollUrl,
      budgetSeconds: optionalNumber(envelope.body.budget_seconds) ?? DEFAULT_BUDGET_SECONDS,
    },
  };
}

/**
 * How many polls one job is worth: enough to cover the budget the service stated,
 * plus a few so its own typed timeout is what the contributor reads. Bounded by
 * `MAX_POLLS` regardless, so no answer from the service can turn this into a spin.
 */
function pollBudget(budgetSeconds: number): number {
  const covered = Math.ceil((budgetSeconds * 1000) / POLL_INTERVAL_MS);
  return Math.min(MAX_POLLS, Math.max(1, covered) + POLL_GRACE);
}

/**
 * Ask for proposals for one drawn playing line.
 *
 * Submits, then polls until the job answers, the budget runs out, or the caller
 * cancels. A cancellation stops the loop — there is no further request after the
 * signal aborts — and resolves to `aborted` rather than to a failure, because the
 * contributor asked for it.
 */
export async function requestProposals(
  request: DetectRequest,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const { signal, wait = sleep } = options;
  if (signal?.aborted) return { status: 'aborted' };

  const submitted = await submit(request, signal);
  if (!submitted.ok) return submitted.result;
  const { jobId, pollUrl, budgetSeconds } = submitted.job;

  const url = new URL(pollUrl, DETECT_API_BASE).toString();
  const polls = pollBudget(budgetSeconds);

  for (let attempt = 0; attempt < polls; attempt += 1) {
    if (signal?.aborted) return { status: 'aborted' };

    const envelope = await readEnvelope(url, { headers: { accept: 'application/json' } }, signal);
    if (!envelope.ok) return envelope.result;

    if (envelope.body.status === 'ok') return toDetection(envelope.body, jobId);
    if (envelope.body.status !== 'pending') {
      return interpretFailure(envelope.body, envelope.httpStatus);
    }

    await wait(POLL_INTERVAL_MS, signal);
  }

  if (signal?.aborted) return { status: 'aborted' };
  return {
    status: 'timeout',
    message:
      'Detection is still running after its time budget. The hole is still yours to map by hand.',
  };
}
