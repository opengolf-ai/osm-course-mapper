import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Geometry, LineString, Polygon } from 'geojson';
import {
  decisionFor,
  recordDecisions,
  requestProposals as askTheDetectionService,
  type DecisionOutcome,
  type DetectRequest,
  type DetectionImagery,
  type Proposal,
  type TeeSetRef,
} from '../api/detect';
import type { OsmLookup } from '../api/overpass';
import {
  STEPS,
  TEE_IDS,
  stepAccept,
  stepNote,
  stepTitle,
  type HoleStatus,
  type Step,
  type TeeId,
} from '../data/course';
import {
  courseFeature,
  labelPoint,
  lineYards,
  playingLine,
  polygon,
  type CourseFeature,
  type FeatureKind,
  type LngLat,
} from '../geo/coords';
import {
  defaultTeeAssign,
  holeStatusesFrom,
  holeYardage,
  scorecardFor,
  type CourseSession,
} from './courseSession';

export type Screen = 'search' | 'boundary' | 'board' | 'review' | 'complete';
export type ReviewMode = 'ready' | 'locate' | 'attention';

/**
 * How far a measured playing line may sit from the card before it reads as a
 * mismatch, as a fraction of the card yardage (KTD8).
 *
 * This replaced a flat 25 yards, which was tuned back when the measurement was
 * derived from the card and so could never disagree with it. A real measurement
 * can, and 25 yards is punishing on a 543-yard par 5 while it is loose enough on
 * a 106-yard par 3 to accept a line drawn to the wrong green.
 */
export const YARDAGE_TOLERANCE_FRACTION = 0.1;

/** The two verdicts a finished line gets. Exported so screens and tests agree on the words. */
export const LOCATE_CLOSE_ENOUGH = 'close enough';
export const LOCATE_CHECK_YOUR_WORK = 'check your work';

/** A geographic extent in WGS84: `[west, south, east, north]`, the order `BaseMap` takes. */
export type MapBounds = [number, number, number, number];

/**
 * A feature the contributor added themselves — the "we missed one" branch.
 *
 * Geometry, not a path string (KTD6): what is stored here has to be able to
 * become an OpenStreetMap way, and a `d` attribute in a viewBox cannot.
 */
export interface ExtraShape {
  id: string;
  label: string;
  feature: CourseFeature<Polygon>;
}

/** Where a caption is anchored on the imagery: a real coordinate, projected at draw time. */
export interface FeatureLabel {
  key: string;
  text: string;
  position: LngLat;
}

/**
 * The ordered points of the playing line, and whether the contributor has said
 * they are done. Fewer than two points is a line still being drawn, so it can
 * never be finished (R8).
 */
export interface LocateState {
  points: LngLat[];
  finished: boolean;
}

/**
 * Where a detection request for the open hole stands (R1, R12).
 *
 * Five states, not four: `no_coverage` is detection saying "there is nothing to
 * propose here" and `failed` is detection not answering at all. Rendering the
 * first as the second would tell a contributor the tool is broken when it simply
 * had nothing to say — and neither one stops them mapping the hole by hand.
 */
export type DetectionState =
  | { status: 'idle' }
  | { status: 'working' }
  | {
      status: 'ready';
      jobId: string;
      proposals: Proposal[];
      /** The corridor raster inference read, for provenance and the U8 overlay. */
      imagery: DetectionImagery | null;
      /** Card tee sets detection found no mask for. */
      missingTeeSets: TeeSetRef[];
    }
  | { status: 'no_coverage'; message: string }
  | { status: 'failed'; message: string };

export interface MapperState {
  screen: Screen;
  /** The course the contributor opened. Null until a detail record loads. */
  course: CourseSession | null;
  query: string;
  mode: ReviewMode;
  holeIndex: number;
  locate: LocateState;
  /** The `yardages` key of the tee set being measured against (R15). Null falls back to the longest. */
  teeSet: string | null;
  step: number;
  /**
   * Which proposal within the current step is being asked about (R7).
   *
   * The step alone cannot say: a step reviews a variable-length list of proposals
   * of one kind, and the contributor answers about exactly one of them at a time.
   * Reset whenever the step changes, and whenever a hole is opened.
   */
  proposalIndex: number;
  /** Proposal ids the contributor confirmed. One entry per explicit human act. */
  confirmed: string[];
  /** Proposal ids the contributor rejected — the map side of `rejections`. */
  removed: string[];
  /**
   * Proposal ids the contributor said a ball can find (R14).
   *
   * Separate from `confirmed` because they answer different questions: confirmed
   * is "yes, that is water", a hazard is "yes, and it is in play". Water can be
   * confirmed without ever becoming a hazard, and nothing but an explicit yes
   * puts an id in here.
   */
  hazards: string[];
  /**
   * Every proposal the contributor rejected on this course, keyed by hole number
   * (R10).
   *
   * Course-level rather than per-hole state because every other slot that could
   * hold this — `detect`, `removed`, `extra` — is cleared on navigation, so a
   * per-hole home would keep only the hole last visited. This is an in-session
   * cache in front of the server-side store (KTD10), not the system of record:
   * `recordDecisions` posts each rejection as it is made, and this is what the
   * screen can show without a round trip.
   */
  rejections: Record<number, Proposal[]>;
  extra: ExtraShape[];
  addMode: string | null;
  lastAction: string;
  attentionResolved: boolean;
  /** What OpenStreetMap answered for the open course. Drives routing and the board. */
  osm: OsmLookup;
  /** Where the detection request for the open hole stands. Per hole, never carried across. */
  detect: DetectionState;
  teeAssign: Record<TeeId, string>;
  holeStatus: HoleStatus[];
}

const EMPTY_LINE: LocateState = { points: [], finished: false };

/** Nothing asked for yet. Every route into a hole starts here. */
const NO_DETECTION: DetectionState = { status: 'idle' };

/**
 * Bounds the service enforces on a request, applied before sending rather than
 * after being refused: it rejects unknown fields and out-of-range values with a
 * 422, and a contributor should not read a validation error about a par the
 * course record supplied and they never touched.
 */
const PAR_RANGE = { min: 3, max: 7 } as const;
const TEE_YARDS_RANGE = { min: 30, max: 1312.3 } as const;
const MAX_TEE_SETS = 8;

export const INITIAL: MapperState = {
  screen: 'search',
  course: null,
  query: '',
  mode: 'ready',
  holeIndex: 0,
  locate: EMPTY_LINE,
  teeSet: null,
  step: 0,
  proposalIndex: 0,
  confirmed: [],
  removed: [],
  hazards: [],
  rejections: {},
  extra: [],
  addMode: null,
  lastAction: '',
  attentionResolved: false,
  osm: { status: 'pending' },
  detect: NO_DETECTION,
  /* Named for real when a course loads — `defaultTeeAssign` reads the course's own sets. */
  teeAssign: { tee1: '', tee2: '', tee3: '', tee4: '' },
  /* No course, no holes. Statuses arrive with the course, from OpenStreetMap. */
  holeStatus: [],
};

/** What an added feature is, and roughly how big one is, in yards of radius. */
const ADDED_FEATURE: Record<string, { kind: FeatureKind; radiusYards: number }> = {
  water: { kind: 'water', radiusYards: 40 },
  'tee box': { kind: 'tee', radiusYards: 14 },
  green: { kind: 'green', radiusYards: 22 },
  bunker: { kind: 'bunker', radiusYards: 12 },
  'fairway edge': { kind: 'fairway', radiusYards: 28 },
  /*
   * The Other Hazards step takes anything we do not classify — a waste area, a
   * ditch, a stand of trees. `rough` is the nearest kind this client models, and
   * the contributor's own word rides along in `label`, so nothing they said is
   * lost even though the kind is approximate.
   */
  hazard: { kind: 'rough', radiusYards: 30 },
};

const METRES_PER_YARD = 0.9144;
const METRES_PER_DEGREE_LATITUDE = 111_320;

/**
 * A rough circle around a click, in real coordinates.
 *
 * The contributor is saying "there is one here", not tracing its edge, so the
 * shape is a placeholder of about the right size rather than a claim about the
 * feature's outline. Vertex editing is the deferred escape hatch for that.
 */
export function bufferedAround(center: LngLat, radiusYards: number, steps = 24): Polygon {
  const metres = radiusYards * METRES_PER_YARD;
  const dLat = metres / METRES_PER_DEGREE_LATITUDE;
  /* Longitude degrees shrink towards the poles; the clamp keeps the maths finite. */
  const dLng = dLat / Math.max(Math.cos((center[1] * Math.PI) / 180), 0.01);
  const ring: LngLat[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ring.push([center[0] + Math.cos(angle) * dLng, center[1] + Math.sin(angle) * dLat]);
  }
  return polygon(ring);
}

/** Every coordinate in a geometry, flattened, for framing. */
function coordinatesOf(geometry: Geometry): LngLat[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates as LngLat];
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates as LngLat[];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.flat() as LngLat[];
    case 'MultiPolygon':
      return geometry.coordinates.flat(2) as LngLat[];
    default:
      return [];
  }
}

/** The extent of a set of points, opened out so the geometry is not flush to the edge. */
function boundsOf(points: readonly LngLat[], padFraction = 0.35): MapBounds | null {
  if (points.length === 0) return null;
  let west = points[0][0];
  let east = points[0][0];
  let south = points[0][1];
  let north = points[0][1];
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  /* A single point, or a line with no spread on one axis, still needs an extent. */
  const padLng = Math.max((east - west) * padFraction, 0.0008);
  const padLat = Math.max((north - south) * padFraction, 0.0008);
  return [west - padLng, south - padLat, east + padLng, north + padLat];
}

/** The whole course: OSM's own extent when it holds one, otherwise a box around its coordinate. */
function courseBounds(s: MapperState): MapBounds | null {
  if (s.osm.status === 'found') return s.osm.course.bbox;
  const course = s.course;
  if (!course) return null;
  const dLat = 0.009;
  const dLng = dLat / Math.max(Math.cos((course.latitude * Math.PI) / 180), 0.01);
  return [
    course.longitude - dLng,
    course.latitude - dLat,
    course.longitude + dLng,
    course.latitude + dLat,
  ];
}

/**
 * What the detection service is asked about this hole: the line as drawn, plus
 * whatever the card knows about it.
 *
 * Tee sets are built from `course.tees` joined to the hole's own `yardages`
 * rather than from `scorecardFor`, whose rows drop the colour key — and the key
 * is what the service echoes back on a matched tee proposal, so the review
 * sequence can open the tee step prefilled.
 */
export function detectRequestFor(s: MapperState): DetectRequest {
  const hole = s.course?.holes[s.holeIndex] ?? null;
  const request: DetectRequest = {
    line: s.locate.points.map((point): LngLat => [point[0], point[1]]),
  };

  const par = hole?.par ?? null;
  if (par !== null && par >= PAR_RANGE.min && par <= PAR_RANGE.max) request.par = par;

  const teeSets: TeeSetRef[] = (s.course?.tees ?? [])
    .map((tee) => ({ name: tee.name, key: tee.color, yards: hole?.yardages[tee.color] }))
    .filter(
      (tee): tee is TeeSetRef =>
        typeof tee.yards === 'number' &&
        tee.yards >= TEE_YARDS_RANGE.min &&
        tee.yards <= TEE_YARDS_RANGE.max,
    )
    .slice(0, MAX_TEE_SETS);
  if (teeSets.length > 0) request.teeSets = teeSets;

  return request;
}

const currentStep = (s: MapperState): Step => STEPS[Math.min(s.step, STEPS.length - 1)];
const isBlocked = (s: MapperState) => s.mode === 'attention' && !s.attentionResolved;

/** Everything detection proposed for the open hole, or nothing at all. */
export function proposalsOf(s: MapperState): Proposal[] {
  return s.detect.status === 'ready' ? s.detect.proposals : [];
}

/** The hole number the open hole carries on the card — the key rejections are filed under. */
export function openHoleNumber(s: MapperState): number {
  return s.course?.holes[s.holeIndex]?.number ?? s.holeIndex + 1;
}

/**
 * The proposals one step reviews, in the order they came back.
 *
 * Derived at runtime from the detection answer rather than declared on the step,
 * because the step cannot know how many bunkers a hole has. A step with no
 * detection class behind it, and a step detection said nothing about, both come
 * back empty — and both are still shown (see `Step.empty`).
 *
 * Rejected proposals stay in the list: the list is what the contributor walks,
 * and a decided proposal keeps its position so the count they were told about
 * ("bunker 2 of 3") does not renumber underneath them.
 */
export function proposalsForStep(s: MapperState, step: Step): Proposal[] {
  if (!step.kind) return [];
  return proposalsOf(s).filter((proposal) => proposal.kind === step.kind);
}

/**
 * Everything the review screen draws, derived from state alone.
 * Pure and exported so screens can be rendered without driving the hook.
 */
export function computeDerived(s: MapperState) {
  const hi = s.holeIndex;
  const course = s.course;
  const hole = course?.holes[hi] ?? null;
  /*
   * The yardage of the tee set the contributor started from (R15), not whichever
   * set happens to be longest. Null, never 0, when the record carries no yardage
   * at all: the screens say "—" for it.
   */
  const fromSelectedTee = hole && s.teeSet ? hole.yardages[s.teeSet] : undefined;
  const cardYds = fromSelectedTee ?? (course ? holeYardage(course, hi) : null);
  const q = currentStep(s);
  const allDone = s.step >= STEPS.length;
  const isLocate = s.mode === 'locate';

  const points = s.locate.points;
  const locateLine: LineString | null = points.length >= 2 ? playingLine(points) : null;
  /* Measured along every segment (KTD7) — a dogleg's card follows the path, not the chord. */
  const measuredYards = lineYards(points);
  const locateYds = Math.round(measuredYards);
  const locateDone = s.locate.finished && points.length >= 2;
  const canFinish = points.length >= 2 && !s.locate.finished;

  const locateTolerance = cardYds === null ? null : cardYds * YARDAGE_TOLERANCE_FRACTION;
  const locateOff = cardYds === null ? Infinity : Math.abs(measuredYards - cardYds);
  const locateWithinTolerance = locateTolerance !== null && locateOff <= locateTolerance;
  const locateVerdict =
    !locateDone || cardYds === null
      ? null
      : locateWithinTolerance
        ? LOCATE_CLOSE_ENOUGH
        : LOCATE_CHECK_YOUR_WORK;

  /*
   * One collection for the map, every feature carrying the status its styling is
   * matched on. Three arrays became one property (KTD6) — a `match` expression on
   * `status` is what the layer paint reads.
   */
  const holeNumber = openHoleNumber(s);
  const holeRef = String(holeNumber);
  const features: CourseFeature[] = [];
  if (locateLine) {
    features.push(
      courseFeature('hole', locateLine, {
        ref: holeRef,
        status: locateDone ? 'confirmed' : 'active',
        label: 'playing line',
      }),
    );
  }
  points.forEach((position, i) => {
    features.push(
      courseFeature(
        'hole',
        { type: 'Point', coordinates: [...position] },
        {
          ref: holeRef,
          status: locateDone ? 'confirmed' : 'active',
          label: i === 0 ? 'tee' : i === points.length - 1 && locateDone ? 'green' : 'turn',
        },
      ),
    );
  });
  /*
   * Proposals (R8). Every one of them draws as `proposed` until the contributor
   * has said otherwise about that one feature — never `confirmed`, and never
   * silently, which is what the suggestion layer in `ReviewScreen` is styled for.
   * A rejected proposal leaves the map entirely; it survives in `rejections`.
   */
  const proposals = proposalsOf(s);
  const confirmedIds = new Set(s.confirmed);
  const rejectedIds = new Set(s.removed);
  const hazardIds = new Set(s.hazards);
  const step = currentStep(s);
  const stepProposals = proposalsForStep(s, step);
  const activeProposal = stepProposals[s.proposalIndex] ?? null;

  for (const proposal of proposals) {
    if (rejectedIds.has(proposal.id)) continue;
    const isConfirmed = confirmedIds.has(proposal.id);
    features.push(
      courseFeature(proposal.kind, proposal.geometry, {
        ref: holeRef,
        status: isConfirmed ? 'confirmed' : 'proposed',
        /* The one being asked about, so the suggestion layer can pick it out. */
        focus: !isConfirmed && activeProposal?.id === proposal.id,
        label: proposal.kind,
        proposalId: proposal.id,
        /* U8 reads these off the feature as well as off the proposal. */
        confidence: proposal.confidence,
        acquired: proposal.acquired,
        /* R14: false until an explicit in-play yes, never merely by being water. */
        ...(proposal.kind === 'water' ? { hazard: hazardIds.has(proposal.id) } : {}),
      }),
    );
  }

  for (const added of s.extra) {
    features.push({
      ...added.feature,
      properties: { ...added.feature.properties, status: 'confirmed', label: added.label },
    });
  }

  /* Captions sit at the centroid of the thing they name, not at a fixed offset. */
  const labels: FeatureLabel[] = proposals
    .filter((proposal) => !rejectedIds.has(proposal.id))
    .map((proposal) => ({
      key: proposal.id,
      text: confirmedIds.has(proposal.id) ? proposal.kind : `${proposal.kind}?`,
      position: labelPoint(proposal.geometry),
    }))
    .concat(
      s.extra.map((added) => ({
        key: added.id,
        text: added.label,
        position: labelPoint(added.feature.geometry),
      })),
    );
  if (points.length > 0) {
    labels.unshift({ key: 'locate-tee', text: 'your tee', position: points[0] });
  }
  if (points.length >= 2) {
    labels.push({
      key: 'locate-green',
      text: locateDone ? 'your green' : 'last point',
      position: points[points.length - 1],
    });
  }

  /* Frame the hole when there is geometry for one; otherwise the whole course. */
  const drawn = features.flatMap((feature) => coordinatesOf(feature.geometry));
  const mapBounds = boundsOf(drawn) ?? courseBounds(s);

  const addedByLabel = new Map<string, number>();
  for (const added of s.extra) {
    addedByLabel.set(added.label, (addedByLabel.get(added.label) ?? 0) + 1);
  }

  return {
    hi,
    cardYds,
    holePar: hole?.par ?? null,
    holeHandicapIndex: hole?.handicapIndex ?? null,
    q,
    allDone,
    isLocate,
    locatePoints: points,
    locateLine,
    locateDone,
    canFinish,
    locateYds,
    locateOff,
    locateTolerance,
    locateWithinTolerance,
    locateVerdict,
    /* R1: there is nothing to detect against until the line is finished. */
    canRequestProposals: locateDone && s.detect.status !== 'working',
    detecting: s.detect.status === 'working',
    /* What the service proposed for this hole. The review sequence drives from here. */
    proposals,
    /* The corridor raster inference read — provenance, and the U8 overlay. */
    detectionImagery: s.detect.status === 'ready' ? s.detect.imagery : null,
    missingTeeSets: s.detect.status === 'ready' ? s.detect.missingTeeSets : [],
    /* The current step's own list, and the single feature being asked about (R7). */
    stepProposals,
    stepProposalCount: stepProposals.length,
    activeProposal,
    /** 1-based, for copy. Zero when the step has nothing to review. */
    activePosition: activeProposal ? s.proposalIndex + 1 : 0,
    /* Copy templated off the real count — never "we found 2 bunkers" on a hole with three. */
    stepTitle: stepTitle(step, s.proposalIndex + 1, stepProposals.length),
    stepNote: stepNote(step, stepProposals.length),
    stepAccept: stepAccept(step, stepProposals.length),
    /* R14: the water step offers the in-play answer, and only it does. */
    stepNeedsInPlay: step.needsInPlay === true && activeProposal !== null,
    activeIsHazard: activeProposal !== null && hazardIds.has(activeProposal.id),
    /* What was rejected on this hole, still readable after leaving and coming back (R10). */
    rejectedHere: s.rejections[holeNumber] ?? [],
    features,
    labels,
    mapBounds,
    doneCount: s.holeStatus.filter((x) => x === 'complete').length,
    /* Straight off this hole's own `yardages` map — no ratio, no hole-1 baseline. */
    scorecard: course ? scorecardFor(course, hi) : [],
    /* Only what the contributor actually decided — nothing is claimed on their behalf. */
    summary: [
      locateDone
        ? `playing line, ${locateYds} yd over ${points.length} points`
        : 'no playing line drawn yet',
      ...(s.confirmed.length > 0
        ? [`${s.confirmed.length} proposal${s.confirmed.length === 1 ? '' : 's'} you confirmed`]
        : []),
      ...(s.removed.length > 0
        ? [`${s.removed.length} you turned down, recorded either way`]
        : []),
      ...[...addedByLabel].map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`),
      `tee boxes named — ${TEE_IDS.map((id) => s.teeAssign[id].toLowerCase()).join(', ')}`,
    ],
  };
}

export function useMapper() {
  const [state, setState] = useState<MapperState>(INITIAL);
  const advanceTimer = useRef<number | null>(null);
  /**
   * The detection request in flight, if there is one. Held in a ref rather than
   * in state because aborting it is not a render — and because a result that
   * arrives after the contributor has moved on must be able to recognise that it
   * is no longer the request anyone is waiting for.
   */
  const detectRun = useRef<AbortController | null>(null);

  /** Drop whatever detection is in flight. Leaving a hole is one of the reasons to. */
  const dropDetection = useCallback(() => {
    detectRun.current?.abort();
    detectRun.current = null;
  }, []);

  const patch = useCallback((next: Partial<MapperState> | ((s: MapperState) => Partial<MapperState>)) => {
    setState((s) => ({ ...s, ...(typeof next === 'function' ? next(s) : next) }));
  }, []);

  const go = useCallback(
    (screen: Screen, mode?: ReviewMode) => {
      dropDetection();
      patch((s) => ({
        screen,
        mode: mode ?? s.mode,
        step: screen === 'review' ? 0 : s.step,
        proposalIndex: screen === 'review' ? 0 : s.proposalIndex,
        confirmed: screen === 'review' ? [] : s.confirmed,
        removed: screen === 'review' ? [] : s.removed,
        hazards: screen === 'review' ? [] : s.hazards,
        /* Not `rejections`: it is course-level on purpose, and clearing it here
         * would leave only the last hole's rejections in front of the store. */
        extra: screen === 'review' ? [] : s.extra,
        addMode: null,
        locate: screen === 'review' ? EMPTY_LINE : s.locate,
        /* Proposals belong to the line they were asked about, and that line is gone. */
        detect: screen === 'review' ? NO_DETECTION : s.detect,
        lastAction: '',
        attentionResolved:
          screen === 'review' && mode === 'attention' ? false : s.attentionResolved,
      }));
    },
    [patch, dropDetection],
  );

  /**
   * Adopt a loaded course and whatever OpenStreetMap holds for it. Everything
   * sized to the previous course — the hole statuses, the hole index, the tee
   * names — is rebuilt here, so opening a nine-hole course after an eighteen
   * never leaves nine stale tiles behind.
   *
   * An adopted boundary opens on the boundary screen for orientation (R11);
   * anything else — absent, or a lookup that failed — opens straight on the
   * board, which states what happened (R12).
   */
  const openCourse = useCallback(
    (session: CourseSession, osm: OsmLookup) => {
      dropDetection();
      patch({
        course: session,
        screen: osm.status === 'found' ? 'boundary' : 'board',
        mode: 'ready',
        holeIndex: 0,
        osm,
        holeStatus: holeStatusesFrom(session, osm),
        teeAssign: defaultTeeAssign(session),
        /* Measuring starts from the longest set the course lists; the rail moves it. */
        teeSet: session.tees[0]?.color ?? null,
        step: 0,
        proposalIndex: 0,
        confirmed: [],
        removed: [],
        hazards: [],
        /* A different course: its rejections are not this one's. */
        rejections: {},
        extra: [],
        addMode: null,
        locate: EMPTY_LINE,
        detect: NO_DETECTION,
        lastAction: '',
        attentionResolved: false,
      });
    },
    [patch, dropDetection],
  );

  /**
   * Persist one decision (R15, KTD10).
   *
   * Fire-and-forget, and per decision rather than per hole: a contributor who
   * walks away mid-hole has still told us something true about every proposal
   * they answered, and a rejection they made is exactly the record R10 is about.
   * A store that is unreachable cannot undo a review that already happened in
   * front of them, so nothing here surfaces or retries — `rejections` is the
   * in-session copy that keeps the screen honest either way.
   */
  const sendDecision = useCallback(
    (holeNumber: number, proposal: Proposal, outcome: DecisionOutcome, inPlay?: boolean) => {
      const courseId = state.course?.id;
      if (!courseId) return;
      void recordDecisions(courseId, holeNumber, [decisionFor(proposal, outcome, inPlay)]).catch(
        () => {},
      );
    },
    [state.course],
  );

  /**
   * Where the sequence goes once one proposal has been decided: to the next
   * proposal in this step, or — only when this was the last of them — to the next
   * step. Deciding a feature must never carry the ones behind it with it (R7).
   */
  const afterDecision = useCallback(
    (s: MapperState, step: Step, count: number, note: string): Partial<MapperState> => {
      const next = s.proposalIndex + 1;
      if (next < count) return { proposalIndex: next, lastAction: note };
      return { step: s.step + 1, proposalIndex: 0, lastAction: note || step.done };
    },
    [],
  );

  /**
   * Move past this step without deciding anything.
   *
   * It confirms nothing — it used to concatenate the step's whole target list,
   * which is the batch confirmation KTD1 rules out. And it stays put while a
   * proposal is still on screen awaiting an answer: adding a feature we missed is
   * not an answer about the one we did propose.
   */
  const advance = useCallback(
    (note?: string) => {
      patch((s) => {
        const step = STEPS[s.step];
        if (!step) return { lastAction: note ?? '' };
        const stepProposals = proposalsForStep(s, step);
        if (stepProposals[s.proposalIndex]) return { lastAction: note ?? '' };
        return { step: s.step + 1, proposalIndex: 0, lastAction: note ?? step.done };
      });
    },
    [patch],
  );

  /**
   * One explicit confirmation, about one proposal (R7, KTD1).
   *
   * On a step with nothing proposed this is the contributor saying so — it
   * confirms no geometry, because there is none, and moves the sequence on.
   */
  const accept = useCallback(() => {
    if (isBlocked(state)) return;
    const step = STEPS[state.step];
    if (!step) return;
    const stepProposals = proposalsForStep(state, step);
    const active = stepProposals[state.proposalIndex] ?? null;

    if (active) {
      sendDecision(openHoleNumber(state), active, 'confirmed', step.needsInPlay ? true : undefined);
      const remaining = stepProposals.length - (state.proposalIndex + 1);
      patch((s) => ({
        confirmed: s.confirmed.concat([active.id]),
        /* R14: on the in-play step the confirming answer *is* the in-play yes —
         * the title asks "can a ball find that water?" and the button answers it,
         * so this is an explicit human answer, not an inference from a confirm.
         * `answerInPlay(false)` is the other half of the same question. */
        hazards: step.needsInPlay ? s.hazards.concat([active.id]) : s.hazards,
        ...afterDecision(
          s,
          step,
          stepProposals.length,
          remaining > 0 ? `Confirmed. ${remaining} more to check on this hole.` : step.done,
        ),
      }));
      return;
    }

    patch((s) => ({ step: s.step + 1, proposalIndex: 0, lastAction: step.done }));
  }, [state, patch, sendDecision, afterDecision]);

  /**
   * One rejection, about one proposal (R10).
   *
   * The proposal leaves the map and is written down — with the kind the model
   * classified it as and the geometry it drew — both in `rejections` and at the
   * store. A false alarm nobody recorded is a false alarm the model repeats.
   */
  const reject = useCallback(() => {
    if (isBlocked(state)) return;
    const step = STEPS[state.step];
    if (!step) return;
    const stepProposals = proposalsForStep(state, step);
    const active = stepProposals[state.proposalIndex] ?? null;

    if (active) {
      const holeNumber = openHoleNumber(state);
      sendDecision(holeNumber, active, 'rejected');
      patch((s) => ({
        removed: s.removed.concat([active.id]),
        rejections: {
          ...s.rejections,
          [holeNumber]: (s.rejections[holeNumber] ?? []).concat([active]),
        },
        ...afterDecision(
          s,
          step,
          stepProposals.length,
          'Dropped it, and noted why — a false alarm is worth as much as a miss.',
        ),
      }));
      return;
    }

    patch((s) => ({ step: s.step + 1, proposalIndex: 0, lastAction: 'Skipped.' }));
  }, [state, patch, sendDecision, afterDecision]);

  /**
   * The in-play answer for a proposed water body (R14).
   *
   * Both answers confirm the water — it is there either way, and the imagery said
   * so. Only `true` makes it a hazard. Spectral classification proposes water; it
   * never decides whether the water counts, and neither does anything else here:
   * the only two routes into `hazards` are this call and the in-play confirming
   * button in `accept`, which asks the same question in the same words.
   */
  const answerInPlay = useCallback(
    (inPlay: boolean) => {
      if (isBlocked(state)) return;
      const step = STEPS[state.step];
      if (!step) return;
      const stepProposals = proposalsForStep(state, step);
      const active = stepProposals[state.proposalIndex] ?? null;
      if (!active) return;

      sendDecision(openHoleNumber(state), active, 'confirmed', inPlay);
      patch((s) => ({
        confirmed: s.confirmed.concat([active.id]),
        hazards: inPlay ? s.hazards.concat([active.id]) : s.hazards,
        ...afterDecision(
          s,
          step,
          stepProposals.length,
          inPlay ? 'Marked in play.' : 'Kept as water, not as a hazard.',
        ),
      }));
    },
    [state, patch, sendDecision, afterDecision],
  );

  const missing = useCallback(() => {
    setState((s) => (isBlocked(s) ? s : { ...s, addMode: currentStep(s).missNoun }));
  }, []);

  /**
   * A click on the imagery, already a WGS84 coordinate — `BaseMap` unprojects it,
   * so nothing here converts from screen space (R7).
   */
  const onMapClick = useCallback(
    (position: LngLat) => {
      if (state.mode === 'locate') {
        patch((s) => {
          if (s.locate.finished) return {};
          const points = s.locate.points.concat([position]);
          return {
            locate: { points, finished: false },
            lastAction:
              points.length === 1
                ? 'Tee marked. Add a point wherever the hole bends.'
                : `Point ${points.length} added.`,
          };
        });
        return;
      }
      if (!state.addMode) return;

      const noun = state.addMode;
      const spec = ADDED_FEATURE[noun] ?? ADDED_FEATURE['fairway edge'];

      patch((s) => ({
        extra: s.extra.concat([
          {
            id: 'extra' + s.extra.length,
            label: noun,
            feature: courseFeature(spec.kind, bufferedAround(position, spec.radiusYards), {
              status: 'confirmed',
              label: noun,
            }),
          },
        ]),
        addMode: null,
        lastAction: 'Added the ' + noun + ' you spotted.',
      }));
      advanceTimer.current = window.setTimeout(() => advance('Thanks — that one was on us.'), 260);
    },
    [state.mode, state.addMode, patch, advance],
  );

  const upload = useCallback(() => {
    patch((s) => {
      const holeStatus = s.holeStatus.slice();
      holeStatus[s.holeIndex] = 'complete';
      return { holeStatus, screen: 'complete' };
    });
  }, [patch]);

  const openHole = useCallback(
    (i: number) => {
      const status = state.holeStatus[i];
      dropDetection();
      setState((s) => ({
        ...s,
        holeIndex: i,
        screen: 'review',
        /* Nothing known about the hole — whether because OSM holds nothing or
         * because it never answered — means starting from the playing line. */
        mode:
          status === 'attention'
            ? 'attention'
            : status === 'unmapped' || status === 'unknown'
              ? 'locate'
              : 'ready',
        step: 0,
        proposalIndex: 0,
        confirmed: [],
        removed: [],
        hazards: [],
        /* `rejections` deliberately survives: it is keyed by hole number and is
         * what the contributor sees when they come back to this one (R10). */
        extra: [],
        addMode: null,
        locate: EMPTY_LINE,
        detect: NO_DETECTION,
        lastAction: '',
        attentionResolved: status === 'attention' ? false : s.attentionResolved,
      }));
    },
    [state.holeStatus, dropDetection],
  );

  const nextHole = useCallback(() => {
    const from = state.holeIndex;
    const next = state.holeStatus.findIndex((st, i) => i > from && st !== 'complete');
    openHole(next < 0 ? from : next);
  }, [state.holeIndex, state.holeStatus, openHole]);

  /**
   * Ask the detection service what it can see on this hole (R1).
   *
   * Only ever from a finished line: the request is bounded by the corridor the
   * line describes, and there is no corridor until the contributor has said where
   * the hole plays. Nothing here can leave the hole unmappable — every outcome
   * the service can produce lands in `detect` as a state the screen states, and
   * the hand-drawing path stays exactly where it was (R12).
   */
  const requestProposals = useCallback(() => {
    if (!state.locate.finished || state.locate.points.length < 2) return;

    dropDetection();
    const controller = new AbortController();
    detectRun.current = controller;
    patch({ detect: { status: 'working' }, lastAction: '' });

    void askTheDetectionService(detectRequestFor(state), { signal: controller.signal }).then(
      (result) => {
        /* Superseded by a later request, or by leaving the hole: not ours to apply. */
        if (detectRun.current !== controller) return;
        detectRun.current = null;

        /* A cancellation is what the contributor asked for; `cancelProposals` has
         * already put the hole back the way they want it. */
        if (result.status === 'aborted') return;

        if (result.status === 'ok') {
          patch({
            detect: {
              status: 'ready',
              jobId: result.jobId,
              proposals: result.proposals,
              imagery: result.imagery,
              missingTeeSets: result.missingTeeSets,
            },
            /* Into the review sequence, the same transition `confirmLocate` makes. */
            mode: 'ready',
            step: 0,
            proposalIndex: 0,
            confirmed: [],
            removed: [],
            hazards: [],
            extra: [],
            /* "To check with you", never "found": nothing here is settled until
             * the contributor has answered about each one (R7). */
            lastAction: `We found ${result.proposals.length} thing${
              result.proposals.length === 1 ? '' : 's'
            } to check with you, one at a time.`,
          });
          return;
        }

        if (result.status === 'no_coverage') {
          patch({ detect: { status: 'no_coverage', message: result.message }, lastAction: '' });
          return;
        }

        patch({ detect: { status: 'failed', message: result.message }, lastAction: '' });
      },
    );
  }, [state, patch, dropDetection]);

  /**
   * Stop waiting. The first request of a session is the one most likely to be
   * slow — a cold container — and a contributor who would rather map the hole
   * than wait it out needs a way out that is not the timeout (R12).
   */
  const cancelProposals = useCallback(() => {
    dropDetection();
    patch((s) =>
      s.detect.status === 'working'
        ? { detect: NO_DETECTION, lastAction: 'Stopped looking. The hole is yours to map by hand.' }
        : {},
    );
  }, [patch, dropDetection]);

  /*
   * A / N / M drive the three review answers without reaching for the mouse — but
   * only when the map is not waiting for a click. In click-to-place the
   * contributor's attention is on the imagery, and a stray key that advanced the
   * review behind them would be the worst kind of surprise.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.screen !== 'review' || state.addMode || state.mode === 'locate') return;
      const k = e.key.toLowerCase();
      if (k === 'a') accept();
      else if (k === 'n') reject();
      else if (k === 'm') missing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.screen, state.addMode, state.mode, accept, reject, missing]);

  useEffect(() => {
    return () => {
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
      detectRun.current?.abort();
    };
  }, []);

  const derived = useMemo(() => computeDerived(state), [state]);

  return {
    state,
    derived,
    actions: {
      patch,
      go,
      openCourse,
      accept,
      reject,
      /** R14: the in-play answer, the only thing that makes water a hazard. */
      answerInPlay,
      missing,
      advance,
      onMapClick,
      upload,
      openHole,
      nextHole,
      requestProposals,
      cancelProposals,
      setQuery: (query: string) => patch({ query }),
      setTee: (id: TeeId, value: string) =>
        patch((s) => ({ teeAssign: { ...s.teeAssign, [id]: value } })),
      /** Which tee set the drawn line is checked against (R15). */
      setTeeSet: (color: string) => patch({ teeSet: color }),
      cancelAdd: () => patch({ addMode: null }),
      /** Start the line again — and with it whatever was proposed about the old one. */
      resetLocate: () => {
        dropDetection();
        patch({ locate: EMPTY_LINE, detect: NO_DETECTION, lastAction: '' });
      },
      /** Take back the last point placed. Anything finished goes back to being drawn. */
      undoLastPoint: () =>
        patch((s) => {
          if (s.locate.points.length === 0) return {};
          const points = s.locate.points.slice(0, -1);
          return {
            locate: { points, finished: false },
            lastAction: points.length === 0 ? '' : 'Took the last point back.',
          };
        }),
      /** Close the line. Refused below two points — that is not yet a hole (R8). */
      finishLine: () =>
        patch((s) =>
          s.locate.points.length < 2
            ? {}
            : {
                locate: { points: s.locate.points, finished: true },
                lastAction: 'That is the line — here is how it measures.',
              },
        ),
      confirmLocate: () =>
        patch({
          mode: 'ready',
          step: 0,
          proposalIndex: 0,
          confirmed: [],
          removed: [],
          hazards: [],
          extra: [],
          lastAction: 'Playing line saved. Check anything else you can see on the hole.',
        }),
      resolveAttention: (lastAction: string) => patch({ attentionResolved: true, lastAction }),
      nudge: () =>
        patch({
          lastAction: 'Drag handles are on — pull an edge, or press Esc to leave it to us.',
        }),
    },
  };
}

export type Mapper = ReturnType<typeof useMapper>;
