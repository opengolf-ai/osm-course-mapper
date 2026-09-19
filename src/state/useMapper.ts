import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Geometry, LineString, MultiPolygon, Polygon } from 'geojson';
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
import {
  saveBoundary as postBoundary,
  saveHole as postHole,
  type OsmAction,
  type SavedBoundary,
  type SavedFeature,
  type SavedHole,
} from '../api/holes';
import type { OsmHole, OsmHoleFeature, OsmLookup } from '../api/overpass';
import {
  SHAPE_NOUN,
  STEPS,
  countOf,
  hazardLabel,
  plural,
  osmTagsFor,
  type HazardType,
  type HoleStatus,
  type ShapeKind,
  type Step,
} from '../data/course';
import {
  bearingBetween,
  courseFeature,
  editableOutline,
  ellipseAround,
  labelPoint,
  lineYards,
  outlinePolygon,
  playingLine,
  pointInRing,
  yardsAlongToEnd,
  yardsBetween,
  type CourseFeature,
  type FeatureKind,
  type LngLat,
} from '../geo/coords';
import type { EditablePath } from '../map/useShapeEditor';
import {
  holeStatusesFrom,
  holeYardage,
  scorecardFor,
  teeSetsFor,
  type CourseSession,
  type HoleTeeSet,
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

/** The two verdicts a line gets. Exported so screens and tests agree on the words. */
export const LOCATE_CLOSE_ENOUGH = 'close enough';
export const LOCATE_CHECK_YOUR_WORK = 'check your line';

/** A geographic extent in WGS84: `[west, south, east, north]`, the order `BaseMap` takes. */
export type MapBounds = [number, number, number, number];

/** Where a caption is anchored on the imagery: a real coordinate, projected at draw time. */
export interface FeatureLabel {
  key: string;
  text: string;
  position: LngLat;
  /** The caption for what is being asked about right now, drawn in the active colour. */
  active?: boolean;
}

/**
 * Where the playing line on screen came from.
 *
 * A line lifted off OpenStreetMap is not something the contributor drew, and
 * drawing it in the colour reserved for what they confirmed would credit them
 * with a shape they have never looked at (R8). Dragging one of its points makes
 * it theirs — `edited` — and from then on it draws as their work.
 */
export type LineSource = 'drawn' | 'osm';

/**
 * The ordered points of the playing line, and whether the contributor has said
 * "yes, that is the hole". Fewer than two points is a line still being drawn,
 * so it can never be confirmed (R8).
 */
export interface LocateState {
  points: LngLat[];
  /** Confirmed: the line is locked and detection has been asked about it. */
  finished: boolean;
  source: LineSource;
  /** An OpenStreetMap line the contributor has dragged. */
  edited: boolean;
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

/**
 * One shape on the hole under review: a proposal the model made, or something
 * the contributor drew.
 *
 * Geometry, not a path string (KTD6): what is here becomes an OpenStreetMap way,
 * so it is WGS84 coordinates. The outline is held open — no closing duplicate —
 * because that is the form the vertex editor works in, and closed again when it
 * is drawn or saved.
 *
 * Nothing about a proposal is settled until the contributor says so (R7, R8):
 * `confirmed` is only ever set by an answer, and a rejected proposal is kept
 * with `removed` rather than dropped, so it can be recorded as a rejection.
 */
export interface HoleShape {
  id: string;
  kind: ShapeKind;
  ring: LngLat[];
  /** Holes in the outline, kept as they came. Not editable. */
  inner: LngLat[][];
  /** The outline as it first appeared — what "put it back" restores. */
  original: LngLat[];
  /** The model proposed it, the contributor drew it, or it is already in OpenStreetMap. */
  origin: 'proposed' | 'drawn' | 'osm';
  /** The proposal behind it, for the decision record and provenance. */
  proposal: Proposal | null;
  /** The OpenStreetMap element behind an `osm` shape, e.g. "way/500123". */
  osmId?: string | null;
  /** The `golf=*` value OSM gives it, kept so the saved tags say what OSM says. */
  osmTag?: string | null;
  /** Saved on an earlier visit to this hole: the contributor's own work, brought back to review. */
  fromSaved?: boolean;
  /** The confidence and provenance a saved proposal was stored with — the `Proposal` itself is gone. */
  savedProposal?: SavedFeature['proposal'];
  /**
   * The card tee set detection matched to this box, when that match was made on
   * a proposal this shape absorbed. See `reviewShapes`.
   */
  teeSetKey?: string | null;
  edited: boolean;
  confirmed: boolean;
  removed: boolean;
  /** What a hazard is. Only the hazard step sets it, and only the contributor. */
  hazardType: HazardType | null;
}

/**
 * What the map is waiting for, beyond the question in the rail.
 *
 * One at a time, and every one of them has a way back out (Esc, or "never
 * mind"). While any of them is open the question's own answers are held — an
 * accept pressed with a half-dragged outline would confirm a shape nobody has
 * finished drawing.
 */
export type Interaction =
  | { kind: 'none' }
  /** "Edges look off": drag handles on these outlines. */
  | { kind: 'edit'; shapeIds: string[] }
  /** "There is another one": the next click drops a rough outline there. */
  | { kind: 'place'; shape: ShapeKind; forTee: string | null; replacing: boolean }
  /** Click one of the shapes on the map: the box a tee plays from, or the one that is not sand. */
  | { kind: 'pick'; purpose: 'tee' | 'remove' }
  /** A shape just dropped or picked, being pulled into place before it is kept. */
  | { kind: 'new'; shapeId: string };

const NO_INTERACTION: Interaction = { kind: 'none' };

export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: string | null }
  | { status: 'failed'; message: string };

const NOT_SAVING: SaveState = { status: 'idle' };

/** A corrected course edge, held until it is saved and after. */
export interface BoundaryState {
  /** The contributor's edge, or null while it is still OpenStreetMap's. */
  edited: Polygon | MultiPolygon | null;
  save: SaveState;
}

export interface MapperState {
  screen: Screen;
  /** The course the contributor opened. Null until a detail record loads. */
  course: CourseSession | null;
  query: string;
  mode: ReviewMode;
  holeIndex: number;
  locate: LocateState;
  /** The `yardages` key of the tee set the line is measured against (R15). Null falls back to the longest. */
  teeSet: string | null;
  /** Position in `STEPS`. Past the end is "every check done". */
  step: number;
  /** Which of the card's tee sets the tee step is asking about. */
  teeIndex: number;
  /**
   * Which box each of the card's tee sets plays from, by tee key.
   *
   * A shape id, `null` for "this set has no tee on this hole" (only ever the
   * contributor's answer), or absent for "no box yet". Several sets may share a
   * box — a combo tee is one patch of grass with two colours of marker on it.
   */
  teeBoxes: Record<string, string | null>;
  shapes: HoleShape[];
  interaction: Interaction;
  /** Proposal ids already sent to the decision store, so none is sent twice. */
  decided: string[];
  /**
   * Every proposal the contributor rejected on this course, keyed by hole number
   * (R10). Course-level because everything per-hole is cleared on navigation.
   */
  rejections: Record<number, Proposal[]>;
  /** What OpenStreetMap already outlines on the open hole (R10). Read-only context. */
  existing: OsmHoleFeature[];
  /** What OpenStreetMap calls the open hole, when that is not its number on the card. */
  osmHoleRef: string | null;
  /** The `golf=hole` way the line came from, kept so the saved hole can point at it. */
  osmHoleId: string | null;
  /** What the contributor saved for the open hole last time, drawn as context. */
  previous: SavedFeature[];
  lastAction: string;
  attentionResolved: boolean;
  /** What OpenStreetMap answered for the open course. Drives routing and the board. */
  osm: OsmLookup;
  /** Where the detection request for the open hole stands. Per hole, never carried across. */
  detect: DetectionState;
  holeStatus: HoleStatus[];
  /** Holes saved to our store on this course, latest version each, by hole number. */
  savedHoles: Record<number, SavedHole>;
  /** Saving the open hole. */
  save: SaveState;
  boundary: BoundaryState;
  /** Counter for the ids of drawn shapes. Never reused within a hole. */
  shapeSeq: number;
}

const EMPTY_LINE: LocateState = { points: [], finished: false, source: 'drawn', edited: false };

/** The hole OpenStreetMap holds for this number, or null when it holds none. */
export function osmHoleFor(osm: OsmLookup, holeNumber: number): OsmHole | null {
  if (osm.status !== 'found') return null;
  return osm.course.holes.find((hole) => hole.ref === holeNumber) ?? null;
}

/**
 * The line and the outlines OSM already holds for a hole, as the state that
 * opens on it.
 *
 * A hole with nothing in OpenStreetMap opens on an empty line and no outlines,
 * so this can only ever put on screen something that genuinely exists in the map.
 */
export function seedFromOsm(hole: OsmHole | null): {
  locate: LocateState;
  existing: OsmHoleFeature[];
  osmHoleRef: string | null;
  osmHoleId: string | null;
} {
  if (!hole || hole.line.coordinates.length < 2) {
    return { locate: EMPTY_LINE, existing: [], osmHoleRef: null, osmHoleId: null };
  }
  return {
    /* Not finished: the flow asks "does the hole run this way?" about OSM's line
     * exactly as it does about a drawn one, and dragging a point is the answer
     * "not quite". */
    locate: {
      points: hole.line.coordinates.map(([lng, lat]) => [lng, lat] as LngLat),
      finished: false,
      source: 'osm',
      edited: false,
    },
    existing: hole.features,
    /* Only worth saying when it is not just the card number back again. */
    osmHoleRef: hole.nine ? hole.osmRef : null,
    osmHoleId: hole.osmId,
  };
}

/** Nothing asked for yet. Every route into a hole starts here. */
const NO_DETECTION: DetectionState = { status: 'idle' };

/**
 * Bounds the service enforces on a request, applied before sending rather than
 * after being refused.
 */
const PAR_RANGE = { min: 3, max: 7 } as const;
const TEE_YARDS_RANGE = { min: 30, max: 1312.3 } as const;
const MAX_TEE_SETS = 8;

/** Everything a hole resets to when it is opened, or its line is confirmed again. */
const FRESH_REVIEW = {
  step: 0,
  teeIndex: 0,
  teeBoxes: {} as Record<string, string | null>,
  shapes: [] as HoleShape[],
  interaction: NO_INTERACTION,
  decided: [] as string[],
  save: NOT_SAVING,
};

export const INITIAL: MapperState = {
  screen: 'search',
  course: null,
  query: '',
  mode: 'ready',
  holeIndex: 0,
  locate: EMPTY_LINE,
  teeSet: null,
  ...FRESH_REVIEW,
  rejections: {},
  existing: [],
  osmHoleRef: null,
  osmHoleId: null,
  previous: [],
  lastAction: '',
  attentionResolved: false,
  osm: { status: 'pending' },
  detect: NO_DETECTION,
  /* No course, no holes. Statuses arrive with the course, from OpenStreetMap. */
  holeStatus: [],
  savedHoles: {},
  boundary: { edited: null, save: NOT_SAVING },
  shapeSeq: 0,
};

/**
 * How big a shape the contributor drops is before they pull it into place, in
 * yards: half its length along the hole, half its width across, and how many
 * handles it gets. Roughly the right size, so the drag is a correction rather
 * than a drawing from scratch.
 */
const DROPPED_SHAPE: Record<ShapeKind, { along: number; across: number; vertices: number }> = {
  tee: { along: 12, across: 7, vertices: 8 },
  green: { along: 16, across: 13, vertices: 12 },
  fairway: { along: 45, across: 17, vertices: 12 },
  bunker: { along: 9, across: 6, vertices: 10 },
  hazard: { along: 25, across: 16, vertices: 12 },
};

/**
 * A tee box a card set plausibly plays from, when detection did not match one:
 * within this many yards of the card, measured along the line.
 */
const TEE_MATCH_TOLERANCE_YARDS = 30;

/** How near the start of the line a box must be to be taken for the back tee. */
const BACK_TEE_REACH_YARDS = 45;

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

/**
 * The extent of a set of points, opened out so the geometry is not flush to the
 * edge. A sixth of the span: `BaseMap` pads 56px on top of this, and the job is
 * to put the contributor on the hole, not on the ones either side of it.
 */
function boundsOf(points: readonly LngLat[], padFraction = 0.16): MapBounds | null {
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
  return [course.longitude - dLng, course.latitude - dLat, course.longitude + dLng, course.latitude + dLat];
}

/**
 * What the detection service is asked about this hole: the line as drawn, plus
 * whatever the card knows about it. The tee key is what the service echoes back
 * on a matched tee proposal, which is what lets the tee step open prefilled.
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
        typeof tee.yards === 'number' && tee.yards >= TEE_YARDS_RANGE.min && tee.yards <= TEE_YARDS_RANGE.max,
    )
    .slice(0, MAX_TEE_SETS);
  if (teeSets.length > 0) request.teeSets = teeSets;

  return request;
}

const isBlocked = (s: MapperState) => s.mode === 'attention' && !s.attentionResolved;

/** The hole number the open hole carries on the card — the key rejections are filed under. */
export function openHoleNumber(s: MapperState): number {
  return s.course?.holes[s.holeIndex]?.number ?? s.holeIndex + 1;
}

/** Everything detection proposed for the open hole, or nothing at all. */
export function proposalsOf(s: MapperState): Proposal[] {
  return s.detect.status === 'ready' ? s.detect.proposals : [];
}

/** The card's tee sets for the open hole, longest first. */
export function teeSetsOf(s: MapperState): HoleTeeSet[] {
  return s.course ? teeSetsFor(s.course, s.holeIndex) : [];
}

/**
 * Proposals as shapes to review.
 *
 * Water becomes a hazard of type water: detection can see a pond, and whether
 * it belongs to the hole is the question the hazard step asks. Everything else
 * keeps its kind.
 */
export function shapesFromProposals(proposals: readonly Proposal[]): HoleShape[] {
  return proposals.map((proposal) => {
    const { ring, inner } = editableOutline(proposal.geometry);
    const isWater = proposal.kind === 'water';
    return {
      id: proposal.id,
      /* Every proposal kind but water is a shape kind of the same name. */
      kind: isWater ? 'hazard' : (proposal.kind as Exclude<ShapeKind, 'hazard'>),
      ring,
      inner,
      original: ring,
      origin: 'proposed',
      proposal,
      edited: false,
      confirmed: false,
      removed: false,
      hazardType: isWater ? 'water' : null,
    };
  });
}

/** The review's shape kind for what OpenStreetMap holds, or null for what the review does not ask about. */
function shapeKindForOsm(kind: FeatureKind): ShapeKind | null {
  switch (kind) {
    case 'tee':
    case 'green':
    case 'fairway':
    case 'bunker':
      return kind;
    case 'water':
      return 'hazard';
    default:
      /* The playing line, cart paths and rough are context, not steps. */
      return null;
  }
}

/**
 * What OpenStreetMap already outlines on this hole, as shapes the review asks
 * about, picks and edits exactly like anything detection proposed.
 *
 * Only closed outlines of a kind the review has a step for: a tee mapped as a
 * point or an open way is not a box anyone can pick, and closing it here would
 * draw a shape OSM does not hold. The OSM tag rides along so a
 * `lateral_water_hazard` is saved as one, not flattened to our default.
 */
export function osmShapes(existing: readonly OsmHoleFeature[]): HoleShape[] {
  return existing.flatMap((feature) => {
    const kind = shapeKindForOsm(feature.kind);
    if (!kind || feature.geometry.type !== 'Polygon') return [];
    const { ring, inner } = editableOutline(feature.geometry);
    if (ring.length < 3) return [];
    return [
      {
        id: `osm:${feature.id}`,
        kind,
        ring,
        inner,
        original: ring,
        origin: 'osm' as const,
        proposal: null,
        osmId: feature.id,
        osmTag: feature.tag,
        teeSetKey: null,
        edited: false,
        confirmed: false,
        removed: false,
        hazardType: kind === 'hazard' ? ('water' as const) : null,
      },
    ];
  });
}

/**
 * Everything the review walks: what OpenStreetMap already outlines on the hole,
 * then what detection proposed.
 *
 * A proposal whose centre lies inside an OSM outline of the same kind is that
 * outline, seen again. Offering both would ask the contributor to choose between
 * two drawings of one green, and saving the proposal would put a second green on
 * the map on top of the first. So the OSM shape stays and the proposal is folded
 * into it — keeping the tee set detection matched a tee to, the one thing it
 * knew that the map did not. A folded proposal is never shown, so nobody answers
 * it and no decision is recorded for it.
 */
export function reviewShapes(
  proposals: readonly Proposal[],
  existing: readonly OsmHoleFeature[],
  saved: readonly SavedFeature[] = [],
): HoleShape[] {
  /* What the contributor saved last time comes first and wins: an OSM outline
   * they already confirmed, edited or disputed is theirs now, not OSM's raw copy. */
  const fromSaved = savedShapes(saved);
  const claimed = new Set(fromSaved.map((shape) => shape.osmId).filter((id): id is string => !!id));
  const fromOsm = osmShapes(existing).filter((shape) => !claimed.has(shape.osmId as string));
  const base = [...fromSaved, ...fromOsm];
  const proposed = shapesFromProposals(proposals).filter((shape) => {
    const centre = labelPoint(outlinePolygon(shape.ring));
    const under = base.find((known) => !known.removed && known.kind === shape.kind && pointInRing(centre, known.ring));
    if (!under) return true;
    if (!under.teeSetKey && shape.proposal?.teeSet) under.teeSetKey = shape.proposal.teeSet.key;
    return false;
  });
  return [...base, ...proposed];
}

/** The review's shape kind and hazard type for a saved feature's kind. */
function shapeKindForSaved(kind: SavedFeature['kind']): { kind: ShapeKind; hazardType: HazardType | null } {
  switch (kind) {
    case 'tee':
    case 'green':
    case 'fairway':
    case 'bunker':
      return { kind, hazardType: null };
    default:
      return { kind: 'hazard', hazardType: kind };
  }
}

/**
 * A hole saved on an earlier visit, as shapes to review again.
 *
 * Everything the save knew comes back: where each shape came from (so a green
 * picked off OpenStreetMap is still that OSM element, and one the model
 * proposed still carries its provenance), whether it was edited, and — for a
 * disputed OSM outline — that it was disputed, so it stays off the map and in
 * the record. Nothing is pre-confirmed: every step still asks.
 */
export function savedShapes(features: readonly SavedFeature[]): HoleShape[] {
  return features.flatMap((feature, i) => {
    const { ring, inner } = editableOutline(feature.geometry);
    if (ring.length < 3) return [];
    const { kind, hazardType } = shapeKindForSaved(feature.kind);
    return [
      {
        id: `saved:${i}`,
        kind,
        ring,
        inner,
        original: ring,
        origin: feature.origin,
        proposal: null,
        savedProposal: feature.proposal,
        osmId: feature.osmId,
        osmTag: feature.origin === 'osm' ? (feature.osmTags.golf ?? null) : null,
        teeSetKey: null,
        fromSaved: true,
        edited: feature.edited,
        confirmed: false,
        removed: feature.osmAction === 'dispute',
        hazardType,
      },
    ];
  });
}

/** Which box each card tee set was saved as playing from, by the saved shape's id. */
export function savedTeeBoxes(shapes: readonly HoleShape[], saved: readonly SavedFeature[]): Record<string, string> {
  const boxes: Record<string, string> = {};
  saved.forEach((feature, i) => {
    const id = `saved:${i}`;
    if (feature.kind !== 'tee' || !shapes.some((shape) => shape.id === id)) return;
    for (const tee of feature.teeSets) boxes[tee.key] = id;
  });
  return boxes;
}

/**
 * Which box each of the card's tee sets probably plays from.
 *
 * Three rules, in order, and a set none of them places is left with no box
 * rather than given one at random:
 *
 * 1. The box detection itself matched to that set.
 * 2. The box whose distance to the green, measured along the line, is within
 *    `TEE_MATCH_TOLERANCE_YARDS` of what the card says the set plays.
 * 3. For the longest set only: the box at the start of the line, because the
 *    contributor was asked to start the line on the furthest-back tee.
 */
export function guessTeeBoxes(
  teeSets: readonly HoleTeeSet[],
  shapes: readonly HoleShape[],
  line: readonly LngLat[],
): Record<string, string> {
  const boxes = shapes.filter((shape) => shape.kind === 'tee' && !shape.removed);
  const guesses: Record<string, string> = {};
  if (boxes.length === 0) return guesses;

  const measured =
    line.length >= 2
      ? new Map(boxes.map((box) => [box.id, yardsAlongToEnd(labelPoint(outlinePolygon(box.ring)), line)]))
      : new Map<string, number>();

  teeSets.forEach((tee, position) => {
    const matched = boxes.find((box) => (box.teeSetKey ?? box.proposal?.teeSet?.key) === tee.key);
    if (matched) {
      guesses[tee.key] = matched.id;
      return;
    }
    let best: { id: string; off: number } | null = null;
    for (const box of boxes) {
      const along = measured.get(box.id);
      if (along === undefined) continue;
      const off = Math.abs(along - tee.yards);
      if (off <= TEE_MATCH_TOLERANCE_YARDS && (!best || off < best.off)) best = { id: box.id, off };
    }
    if (best) {
      guesses[tee.key] = best.id;
      return;
    }
    if (position === 0 && line.length > 0) {
      const start = line[0];
      const containing = boxes.find((box) => pointInRing(start, box.ring));
      const nearest = boxes
        .map((box) => ({ id: box.id, yards: yardsBetween(start, labelPoint(outlinePolygon(box.ring))) }))
        .sort((a, b) => a.yards - b.yards)[0];
      const back = containing?.id ?? (nearest && nearest.yards <= BACK_TEE_REACH_YARDS ? nearest.id : null);
      if (back) guesses[tee.key] = back;
    }
  });
  return guesses;
}

/** Shapes of one kind still in play on the hole. */
export function liveShapes(s: MapperState, kind: ShapeKind): HoleShape[] {
  return s.shapes.filter((shape) => shape.kind === kind && !shape.removed);
}

/**
 * The green being asked about: one already confirmed, or the proposal nearest
 * the end of the line — detection reads a corridor, and the green of the next
 * hole over is often inside it.
 */
export function greenCandidate(s: MapperState): HoleShape | null {
  const greens = liveShapes(s, 'green');
  const confirmed = greens.find((shape) => shape.confirmed);
  if (confirmed) return confirmed;
  /* The green the contributor saved last time, before anything newly proposed. */
  const saved = greens.find((shape) => shape.fromSaved);
  if (saved) return saved;
  const end = s.locate.points[s.locate.points.length - 1];
  if (!end) return greens[0] ?? null;
  return (
    greens
      .map((shape) => ({ shape, yards: yardsBetween(end, labelPoint(outlinePolygon(shape.ring))) }))
      .sort((a, b) => a.yards - b.yards)[0]?.shape ?? null
  );
}

/**
 * Whether the tee step walks the card's tee sets, one at a time. A card with no
 * yardages for this hole has no sets to walk, and the step falls back to asking
 * about the boxes themselves, the way the sand step does.
 */
function teesByCard(s: MapperState): boolean {
  return teeSetsOf(s).length > 0;
}

/** The step on screen, or null past the end. */
function stepAt(s: MapperState): Step | null {
  return STEPS[s.step] ?? null;
}

/**
 * The shapes the question on screen is about — drawn in the active colour, and
 * the ones "edges look off" hands to the editor.
 */
export function activeShapeIds(s: MapperState): string[] {
  const { interaction } = s;
  if (interaction.kind === 'edit') return interaction.shapeIds;
  if (interaction.kind === 'new') return [interaction.shapeId];
  if (s.mode === 'locate') return [];
  const step = stepAt(s);
  if (!step) return [];
  if (step.id === 'tees' && teesByCard(s)) {
    const tee = teeSetsOf(s)[s.teeIndex];
    const box = tee ? s.teeBoxes[tee.key] : null;
    return box ? [box] : [];
  }
  if (step.id === 'green') {
    const green = greenCandidate(s);
    return green ? [green.id] : [];
  }
  return liveShapes(s, step.kind).map((shape) => shape.id);
}

/**
 * Whether a shape is still worth drawing.
 *
 * A proposal whose step has come and gone without anyone confirming it — a tee
 * box no set on the card plays from, the green of the hole next door — was
 * passed over. Leaving it on the imagery for the rest of the review would keep
 * asking a question that has already been answered.
 */
function stillShown(s: MapperState, shape: HoleShape): boolean {
  if (shape.removed) return false;
  if (shape.confirmed) return true;
  const index = STEPS.findIndex((step) => step.kind === shape.kind);
  return index >= s.step;
}

/** The tee sets that play from a box, back to front. */
function teeSetsFrom(s: MapperState, shapeId: string): HoleTeeSet[] {
  return teeSetsOf(s).filter((tee) => s.teeBoxes[tee.key] === shapeId);
}

/** What a shape is called on the map. */
function captionFor(s: MapperState, shape: HoleShape): string {
  const settled = shape.confirmed || shape.origin !== 'proposed' || shape.fromSaved === true;
  switch (shape.kind) {
    case 'tee': {
      const sets = teeSetsFrom(s, shape.id);
      return sets.length > 0
        ? `${sets.map((tee) => tee.name.toLowerCase()).join(' + ')} tee`
        : settled
          ? 'tee box'
          : 'tee box?';
    }
    case 'hazard':
      return shape.hazardType ? hazardLabel(shape.hazardType).toLowerCase() : 'hazard?';
    default:
      return settled ? SHAPE_NOUN[shape.kind] : `${SHAPE_NOUN[shape.kind]}?`;
  }
}

/** The drawing kind a shape is styled as. Hazards draw by what they are. */
function featureKindOf(shape: HoleShape): FeatureKind {
  if (shape.kind === 'hazard') return shape.hazardType === 'water' ? 'water' : 'rough';
  return shape.kind;
}

/** The action buttons under a question, by what they do. */
export type QuestionAction =
  | 'pick-tee'
  | 'no-tee'
  | 'edit'
  | 'not-green'
  | 'find-green'
  | 'add'
  | 'remove-one'
  | 'draw-hazard';

export interface Question {
  kicker: string;
  title: string;
  note: string;
  accept: string;
  /** Held when accepting would say something untrue — an untyped hazard. */
  acceptDisabled: boolean;
  actions: { id: QuestionAction; label: string }[];
}

/**
 * The question on screen, and every answer it offers, derived from the shapes
 * actually on the hole.
 *
 * Copy is templated off the real count — "we found 3 bunkers" on a hole with
 * three, never a fixed sentence written for a demo hole with two.
 */
export function questionFor(s: MapperState): Question | null {
  const step = stepAt(s);
  if (!step || s.mode === 'locate') return null;
  const edit = { id: 'edit' as const, label: 'Edges look off' };

  if (step.id === 'tees' && teesByCard(s)) {
    const sets = teeSetsOf(s);
    const tee = sets[Math.min(s.teeIndex, sets.length - 1)];
    const name = tee.name.toLowerCase();
    const box = s.teeBoxes[tee.key];
    return {
      kicker: `Tee ${Math.min(s.teeIndex, sets.length - 1) + 1} of ${sets.length} · ${tee.name}`,
      title: box ? `Is that where the ${name} tee plays from?` : `Where does the ${name} tee play from?`,
      note: box
        ? s.shapes.find((shape) => shape.id === box)?.fromSaved
          ? `That is the box you saved for the ${name} tee last time. Click a different box if it has moved.`
          : s.shapes.find((shape) => shape.id === box)?.origin === 'osm'
            ? 'That box is already in OpenStreetMap. Click a different box if it is the wrong one.'
            : step.note
        : liveShapes(s, 'tee').some((shape) => shape.origin === 'osm')
          ? 'Click one of the boxes OpenStreetMap already holds — outlined in blue — or click open ground to draw one.'
          : 'Click the box on the map. Click open ground instead and you can draw one.',
      accept: box ? `Yes, that is the ${name} tee` : `No ${name} tee on this hole`,
      acceptDisabled: false,
      actions: box
        ? [
            { id: 'pick-tee', label: 'Pick a different box' },
            edit,
            { id: 'no-tee', label: `No ${name} tee here` },
          ]
        : [{ id: 'pick-tee', label: 'Pick the box' }],
    };
  }

  if (step.id === 'green') {
    const green = greenCandidate(s);
    return green
      ? {
          kicker: step.kicker,
          title: 'Is that the green?',
          note: green.fromSaved
            ? 'That is the green you saved for this hole last time.'
            : green.origin === 'osm'
              ? 'That green is already in OpenStreetMap. If its edges are off, fix them; if it is another hole’s green, say so.'
              : step.note,
          accept: 'Yes, that is the green',
          acceptDisabled: false,
          actions: [{ id: 'not-green', label: 'That is not the green' }, edit],
        }
      : {
          kicker: step.kicker,
          title: 'Where is the green?',
          note: 'Click “Find the green”, then click the green you putt on. We drop an outline there for you to pull into shape.',
          accept: 'Skip the green for now',
          acceptDisabled: false,
          actions: [{ id: 'find-green', label: 'Find the green' }],
        };
  }

  if (step.id === 'hazards') {
    const hazards = liveShapes(s, 'hazard');
    const untyped = hazards.some((shape) => shape.hazardType === null);
    return {
      kicker: step.kicker,
      title: hazards.length === 0 ? 'Any other hazards out there?' : `${countOf(hazards.length, 'hazard')} on this hole. Anything else?`,
      note: untyped ? 'Say what each one is before moving on.' : step.note,
      accept: hazards.length === 0 ? 'Nothing else out there' : 'That is all of them',
      acceptDisabled: untyped,
      actions: [{ id: 'draw-hazard', label: 'Draw a hazard' }],
    };
  }

  /* Fairway, sand, and tee boxes on a card with no yardages: a set of shapes. */
  const shapes = liveShapes(s, step.kind);
  const n = shapes.length;
  const noun = SHAPE_NOUN[step.kind];
  /* How many of them OpenStreetMap already holds — "we found" is not true of those. */
  const inOsm = shapes.filter((shape) => shape.origin === 'osm').length;
  const osmNote =
    inOsm === 0 ? '' : inOsm === n ? ' All of these are already in OpenStreetMap.' : ` ${inOsm} of these ${inOsm === 1 ? 'is' : 'are'} already in OpenStreetMap.`;
  if (step.id === 'fairway') {
    return {
      kicker: step.kicker,
      title:
        n === 0 ? 'No fairway on this hole. Right?' : n === 1 ? 'Is this outline of the fairway right?' : `Do all ${n} pieces of fairway look right?`,
      note: n === 0 ? 'On a par 3 that is expected. Anywhere else, add it.' : step.note + osmNote,
      accept: n === 0 ? 'No fairway on this hole' : n === 1 ? 'Yes, that is the fairway' : `Yes, all ${n} pieces`,
      acceptDisabled: false,
      actions: [
        { id: 'add', label: 'Another piece of fairway' },
        ...(n > 0 ? [{ id: 'remove-one' as const, label: 'One of these is not fairway' }, edit] : []),
      ],
    };
  }
  return {
    kicker: step.kicker,
    title:
      n === 0
        ? `No ${plural(noun)} on this hole. Right?`
        : inOsm === n
          ? `OpenStreetMap has ${countOf(n, noun)} on this hole. Did it miss any?`
          : `We found ${countOf(n, noun)} on this hole. Did we miss any?`,
    note: (step.id === 'tees' ? 'Every box anyone tees off from on this hole.' : step.note) + (inOsm === n ? '' : osmNote),
    accept:
      n === 0 ? `No ${plural(noun)} on this hole` : n === 1 ? 'That is the only one' : `That is all ${n} of them`,
    acceptDisabled: false,
    actions: [
      ...(n > 0
        ? [{ id: 'remove-one' as const, label: step.id === 'bunkers' ? 'One of these is not sand' : `One of these is not a ${noun}` }]
        : []),
      { id: 'add', label: step.id === 'bunkers' ? 'There is another bunker' : `There is another ${noun}` },
      ...(n > 0 ? [{ ...edit, label: 'Edges are off — let me fix them' }] : []),
    ],
  };
}

/** A shape as the saved record holds it. */
function savedFeatureOf(s: MapperState, shape: HoleShape): SavedFeature | null {
  const proposal = shape.proposal;
  const provenance =
    proposal && proposal.acquired && proposal.gsdMeters !== null && proposal.source && proposal.modelId && proposal.itemId
      ? {
          acquired: proposal.acquired,
          gsdMeters: proposal.gsdMeters,
          source: proposal.source,
          modelId: proposal.modelId,
          itemId: proposal.itemId,
        }
      : /* A shape saved as a proposal last time kept its provenance in the record. */
        (shape.savedProposal?.provenance ?? null);
  /* A proposal the service sent without provenance cannot be stored as proposed
   * — the store requires it — so it is saved as what the contributor made of it. */
  const origin = shape.origin === 'osm' ? 'osm' : shape.origin === 'proposed' && provenance ? 'proposed' : 'drawn';
  const osmAction: OsmAction =
    origin !== 'osm' ? 'create' : shape.removed ? 'dispute' : shape.edited ? 'modify' : 'keep';
  const tags = osmTagsFor(shape.kind, shape.hazardType);
  const kind = shape.kind === 'hazard' ? shape.hazardType : shape.kind;
  if (!kind) return null;
  const teeSets = shape.kind === 'tee' ? teeSetsFrom(s, shape.id) : [];
  return {
    kind,
    geometry: outlinePolygon(shape.ring, shape.inner),
    origin,
    edited: shape.edited,
    osmId: origin === 'osm' ? (shape.osmId ?? null) : null,
    osmAction,
    teeSets: teeSets.map((tee) => ({ key: tee.key, name: tee.name, yards: tee.yards })),
    label: shape.kind === 'hazard' ? hazardLabel(shape.hazardType) : null,
    /* What OSM already calls it wins over our default: a lateral water hazard stays one. */
    osmTags: shape.osmTag && tags.golf ? { ...tags, golf: shape.osmTag } : tags,
    proposal:
      origin === 'proposed' && provenance
        ? { confidence: proposal?.confidence ?? shape.savedProposal?.confidence ?? 0, provenance }
        : null,
  };
}

/**
 * The finished hole, in the shape the store keeps: the line and every shape the
 * contributor confirmed. Nothing unconfirmed goes in — a proposal nobody said
 * yes to is not part of the hole.
 */
export function holeToSave(s: MapperState): SavedHole | null {
  const course = s.course;
  if (!course || s.locate.points.length < 2) return null;
  const hole = course.holes[s.holeIndex];
  return {
    courseId: course.id,
    holeNumber: openHoleNumber(s),
    par: hole?.par ?? null,
    playingLine: playingLine(s.locate.points),
    lineSource: s.locate.source === 'osm' ? (s.locate.edited ? 'osm_edited' : 'osm') : 'drawn',
    osmHoleId: s.osmHoleId,
    /*
     * The confirmed shapes, plus every OSM outline the contributor said is not
     * what its step asked about. That one is not part of the hole, but it is in
     * OpenStreetMap, and the upload has to hear that somebody disputed it.
     */
    features: s.shapes
      .filter((shape) => (shape.confirmed && !shape.removed) || (shape.origin === 'osm' && shape.removed))
      .map((shape) => savedFeatureOf(s, shape))
      .filter((feature): feature is SavedFeature => feature !== null),
  };
}

/**
 * Everything the review screen draws, derived from state alone.
 * Pure and exported so screens can be rendered without driving the hook.
 */
export function computeDerived(s: MapperState) {
  const hi = s.holeIndex;
  const course = s.course;
  const hole = course?.holes[hi] ?? null;
  /* The yardage of the tee set the contributor measures against (R15). Null, never
   * 0, when the record carries no yardage at all: the screens say "—" for it. */
  const fromSelectedTee = hole && s.teeSet ? hole.yardages[s.teeSet] : undefined;
  const cardYds = fromSelectedTee ?? (course ? holeYardage(course, hi) : null);
  const step = stepAt(s);
  const allDone = s.step >= STEPS.length;
  const isLocate = s.mode === 'locate';

  const points = s.locate.points;
  const locateLine: LineString | null = points.length >= 2 ? playingLine(points) : null;
  /* Measured along every segment (KTD7) — a dogleg's card follows the path. */
  const measuredYards = lineYards(points);
  const locateYds = Math.round(measuredYards);
  const locateDone = s.locate.finished && points.length >= 2;
  const canConfirmLine = points.length >= 2 && !s.locate.finished;

  const locateTolerance = cardYds === null ? null : cardYds * YARDAGE_TOLERANCE_FRACTION;
  const locateOff = cardYds === null ? Infinity : Math.abs(measuredYards - cardYds);
  const locateWithinTolerance = locateTolerance !== null && locateOff <= locateTolerance;
  const locateVerdict =
    points.length < 2 || cardYds === null ? null : locateWithinTolerance ? LOCATE_CLOSE_ENOUGH : LOCATE_CHECK_YOUR_WORK;

  const holeNumber = openHoleNumber(s);
  const holeRef = String(holeNumber);
  /* OpenStreetMap's line, untouched, is `existing` — nobody here has ruled on it (R8). */
  const lineFromOsm = s.locate.source === 'osm' && !s.locate.edited;
  const lineStatus = locateDone ? 'confirmed' : lineFromOsm ? 'existing' : 'active';
  const features: CourseFeature[] = [];

  const active = new Set(activeShapeIds(s));
  const shown = s.shapes.filter((shape) => stillShown(s, shape) && !(isLocate && !locateDone));
  /* An OSM outline the review has taken up is drawn once, as the shape being
   * reviewed. Once its step passes unpicked it goes back to being context. */
  const taken = new Set([
    ...s.shapes
      .filter((shape) => shape.osmId && (shape.removed || shown.includes(shape)))
      .map((shape) => shape.osmId as string),
    /*
     * And everything the contributor's save says about an OSM element. Their
     * saved version is the one to show — an edited green drawn beside OSM's
     * original is two greens — and one they disputed is not shown at all. This
     * holds from the moment the hole opens, before the review has any shapes.
     */
    ...s.previous.map((feature) => feature.osmId).filter((id): id is string => !!id),
  ]);
  const context = s.existing.filter((feature) => !taken.has(feature.id));

  /* What OpenStreetMap outlines on this hole, under everything else (R10). */
  for (const feature of context) {
    features.push(
      courseFeature(feature.kind, feature.geometry, {
        ref: holeRef,
        status: 'existing',
        label: feature.name ?? feature.tag.replace(/_/g, ' '),
        osmId: feature.id,
      }),
    );
  }
  /* What the contributor saved for this hole last time, as context. */
  /* Once the review has taken the saved shapes up, they are drawn as shapes, not twice. */
  const savedAsContext = s.shapes.some((shape) => shape.fromSaved)
    ? []
    : /* A disputed OSM outline is in the record for the upload, not on the map. */
      s.previous.filter((feature) => feature.osmAction !== 'dispute');
  for (const [i, feature] of savedAsContext.entries()) {
    features.push(
      courseFeature(feature.kind === 'water' ? 'water' : feature.kind === 'tee' || feature.kind === 'green' || feature.kind === 'fairway' || feature.kind === 'bunker' ? feature.kind : 'rough', feature.geometry, {
        ref: holeRef,
        status: 'saved',
        label: `saved ${feature.kind.replace(/_/g, ' ')}`,
        savedIndex: i,
      }),
    );
  }

  if (locateLine) {
    features.push(courseFeature('hole', locateLine, { ref: holeRef, status: lineStatus, label: 'playing line' }));
  }
  /* The line's points once it is locked. While it is being drawn the editor's
   * handles are the points, and a second circle under each would only blur them. */
  if (locateDone || !isLocate) {
    [points[0], points[points.length - 1]].forEach((position, i) => {
      if (!position || points.length < 2) return;
      features.push(
        courseFeature('hole', { type: 'Point', coordinates: [...position] }, {
          ref: holeRef,
          status: lineStatus,
          label: i === 0 ? 'tee' : 'green',
        }),
      );
    });
  }

  /*
   * The shapes (R8). A proposal draws as a suggestion until the contributor has
   * answered about it — amber and dashed, heavier while it is the one being
   * asked about — and never in the confirmed colour before then. Something the
   * contributor drew is theirs from the start and draws in the active colour.
   */
  for (const shape of shown) {
    const isActive = active.has(shape.id);
    /* An OSM box keeps OSM's colour until it is picked or confirmed: it is in
     * the map already, and nobody here has said anything about it yet. */
    const status = shape.confirmed
      ? 'confirmed'
      : shape.fromSaved
        ? 'saved'
        : shape.origin === 'proposed'
          ? 'proposed'
          : shape.origin === 'osm'
            ? 'existing'
            : 'active';
    features.push(
      courseFeature(featureKindOf(shape), outlinePolygon(shape.ring, shape.inner), {
        ref: holeRef,
        status: isActive && (shape.origin !== 'proposed' || shape.fromSaved) ? 'active' : status,
        focus: isActive,
        label: captionFor(s, shape),
        shapeId: shape.id,
        ...(shape.proposal ? { proposalId: shape.proposal.id, confidence: shape.proposal.confidence } : {}),
      }),
    );
  }

  /* Captions: the shapes being asked about and the ones already settled. A
   * proposal for a later step stays uncaptioned — it has not been asked yet. */
  const labels: FeatureLabel[] = [];
  for (const feature of context) {
    labels.push({ key: feature.id, text: feature.name ?? feature.tag.replace(/_/g, ' '), position: labelPoint(feature.geometry) });
  }
  for (const shape of shown) {
    if (!active.has(shape.id) && !shape.confirmed) continue;
    labels.push({
      key: shape.id,
      text: captionFor(s, shape),
      position: labelPoint(outlinePolygon(shape.ring)),
      active: active.has(shape.id),
    });
  }
  if (points.length > 0) {
    labels.unshift({ key: 'locate-tee', text: lineFromOsm ? 'tee' : 'tee — 1', position: points[0] });
  }
  if (points.length >= 2) {
    labels.push({ key: 'locate-green', text: lineFromOsm ? 'green' : 'green', position: points[points.length - 1] });
  }

  /* Frame the hole when there is geometry for one; otherwise the whole course. */
  const drawn = features.flatMap((feature) => coordinatesOf(feature.geometry));
  const mapBounds = boundsOf(drawn) ?? courseBounds(s);

  /*
   * What the vertex editor puts handles on: the line while it is being drawn or
   * checked, and the outlines the contributor is reshaping.
   */
  const editablePaths: EditablePath[] = [];
  if (isLocate && !locateDone && s.detect.status !== 'working') {
    if (points.length > 0) editablePaths.push({ id: 'line', coords: points, closed: false });
  } else if (s.interaction.kind === 'edit' || s.interaction.kind === 'new') {
    for (const id of activeShapeIds(s)) {
      const shape = s.shapes.find((candidate) => candidate.id === id);
      if (shape && !shape.removed) editablePaths.push({ id: shape.id, coords: shape.ring, closed: true });
    }
  }

  const teeSets = teeSetsOf(s);
  const hazards = liveShapes(s, 'hazard');
  const confirmed = s.shapes.filter((shape) => shape.confirmed && !shape.removed);
  const confirmedOf = (kind: ShapeKind) => confirmed.filter((shape) => shape.kind === kind);
  const teeBoxesConfirmed = confirmedOf('tee');
  const placedSets = teeSets.filter((tee) => {
    const box = s.teeBoxes[tee.key];
    return box && teeBoxesConfirmed.some((shape) => shape.id === box);
  });

  return {
    hi,
    holeNumber,
    cardYds,
    holePar: hole?.par ?? null,
    holeHandicapIndex: hole?.handicapIndex ?? null,
    step,
    allDone,
    isLocate,
    locatePoints: points,
    locateLine,
    locateDone,
    canConfirmLine,
    locateYds,
    locateOff,
    locateTolerance,
    locateWithinTolerance,
    locateVerdict,
    /* Where the line came from, so the rail never calls OpenStreetMap's work "your line" (R8). */
    lineFromOsm,
    lineSource: s.locate.source,
    existing: s.existing,
    osmHoleRef: s.osmHoleRef,
    canRequestProposals: locateDone && s.detect.status !== 'working',
    detecting: s.detect.status === 'working',
    proposals: proposalsOf(s),
    detectionImagery: s.detect.status === 'ready' ? s.detect.imagery : null,
    missingTeeSets: s.detect.status === 'ready' ? s.detect.missingTeeSets : [],
    question: questionFor(s),
    teeSets,
    currentTee: teeSets[s.teeIndex] ?? null,
    hazards,
    activeShapeIds: [...active],
    /* The first proposal among the shapes being asked about, for the provenance panel. */
    activeProposal: s.shapes.find((shape) => active.has(shape.id) && shape.proposal && !shape.confirmed)?.proposal ?? null,
    editablePaths,
    rejectedHere: s.rejections[holeNumber] ?? [],
    features,
    labels,
    mapBounds,
    doneCount: s.holeStatus.filter((x) => x === 'complete').length,
    savedCount: s.holeStatus.filter((x) => x === 'saved').length,
    scorecard: course ? scorecardFor(course, hi) : [],
    /* Only what the contributor actually decided — nothing is claimed on their behalf. */
    summary: [
      locateLine ? `playing line, ${locateYds} yd over ${points.length} points` : 'no playing line',
      teeSets.length > 0
        ? `${countOf(teeBoxesConfirmed.length, 'tee box', 'no tee boxes')}${
            placedSets.length > 0 ? ` — ${placedSets.map((tee) => tee.name.toLowerCase()).join(', ')}` : ''
          }`
        : countOf(teeBoxesConfirmed.length, 'tee box', 'no tee boxes'),
      confirmedOf('green').length > 0 ? 'the green' : 'no green',
      countOf(confirmedOf('fairway').length, 'piece', 'no fairway').replace(/pieces?$/, (word) => `${word} of fairway`),
      countOf(confirmedOf('bunker').length, 'bunker'),
      ...(confirmedOf('hazard').length > 0
        ? [confirmedOf('hazard').map((shape) => hazardLabel(shape.hazardType).toLowerCase()).join(', ')]
        : []),
    ],
    canSave: allDone && locateLine !== null && s.save.status !== 'saving',
  };
}

/**
 * Where "review the next hole" goes: the next hole along that the contributor
 * has not saved here, wrapping round to the first hole if the rest of the round
 * is done, and simply the next hole when every one is saved.
 *
 * A hole OpenStreetMap already holds (`complete`) is not skipped. It used to
 * be, and on a course OSM has fully mapped — Pebble Beach has all eighteen —
 * there was nothing left to go to, so the button reopened the hole just
 * finished. Those holes are exactly what this flow is for checking.
 */
export function nextHoleIndex(statuses: readonly HoleStatus[], from: number): number {
  const count = statuses.length;
  if (count === 0) return from;
  for (let step = 1; step < count; step += 1) {
    const i = (from + step) % count;
    if (statuses[i] !== 'saved') return i;
  }
  return (from + 1) % count;
}

export function useMapper() {
  const [state, setState] = useState<MapperState>(INITIAL);
  /**
   * The detection request in flight, if there is one. Held in a ref rather than
   * in state because aborting it is not a render — and because a result that
   * arrives after the contributor has moved on must be able to recognise that it
   * is no longer the request anyone is waiting for.
   */
  const detectRun = useRef<AbortController | null>(null);
  /** The hole save in flight, dropped the same way when the contributor leaves. */
  const saveRun = useRef<AbortController | null>(null);

  const dropDetection = useCallback(() => {
    detectRun.current?.abort();
    detectRun.current = null;
  }, []);

  const dropSave = useCallback(() => {
    saveRun.current?.abort();
    saveRun.current = null;
  }, []);

  const patch = useCallback((next: Partial<MapperState> | ((s: MapperState) => Partial<MapperState>)) => {
    setState((s) => ({ ...s, ...(typeof next === 'function' ? next(s) : next) }));
  }, []);

  const go = useCallback(
    (screen: Screen, mode?: ReviewMode) => {
      dropDetection();
      dropSave();
      patch((s) => ({
        screen,
        mode: mode ?? s.mode,
        ...(screen === 'review'
          ? {
              ...FRESH_REVIEW,
              /* Not `rejections`: it is course-level on purpose. */
              existing: [],
              osmHoleRef: null,
              osmHoleId: null,
              previous: [],
              locate: EMPTY_LINE,
              /* Proposals belong to the line they were asked about, and that line is gone. */
              detect: NO_DETECTION,
            }
          : { interaction: NO_INTERACTION }),
        lastAction: '',
        attentionResolved: screen === 'review' && mode === 'attention' ? false : s.attentionResolved,
      }));
    },
    [patch, dropDetection, dropSave],
  );

  /**
   * Adopt a loaded course, whatever OpenStreetMap holds for it, and whatever the
   * contributor already saved for it here. Everything sized to the previous
   * course is rebuilt, so a nine-hole course after an eighteen never leaves nine
   * stale tiles behind.
   *
   * An adopted boundary opens on the boundary screen (R11); anything else opens
   * straight on the board, which states what happened (R12).
   */
  const openCourse = useCallback(
    (
      session: CourseSession,
      osm: OsmLookup,
      saved: { holes?: SavedHole[]; boundary?: SavedBoundary | null } = {},
    ) => {
      dropDetection();
      dropSave();
      const savedHoles: Record<number, SavedHole> = {};
      for (const hole of saved.holes ?? []) savedHoles[hole.holeNumber] = hole;
      const holeStatus = holeStatusesFrom(session, osm).map((status, i) =>
        savedHoles[session.holes[i]?.number ?? i + 1] ? 'saved' : status,
      );
      patch({
        course: session,
        screen: osm.status === 'found' ? 'boundary' : 'board',
        mode: 'ready',
        holeIndex: 0,
        osm,
        holeStatus,
        savedHoles,
        boundary: {
          edited: saved.boundary?.geometry ?? null,
          save: saved.boundary ? { status: 'saved', at: saved.boundary.savedAt ?? null } : NOT_SAVING,
        },
        /* Measuring starts from the longest set the course lists; the rail moves it. */
        teeSet: session.tees[0]?.color ?? null,
        ...FRESH_REVIEW,
        /* A different course: its rejections are not this one's. */
        rejections: {},
        existing: [],
        osmHoleRef: null,
        osmHoleId: null,
        previous: [],
        locate: EMPTY_LINE,
        detect: NO_DETECTION,
        lastAction: '',
        attentionResolved: false,
      });
    },
    [patch, dropDetection, dropSave],
  );

  /**
   * Persist decisions about proposals (R15, KTD10) — fire-and-forget, and at the
   * moment each is made, so a contributor who walks away mid-hole has still told
   * us something true about every proposal they answered. Returns the ids now
   * decided, so the caller can record them and never send one twice.
   */
  const sendDecisions = useCallback(
    (s: MapperState, entries: { shape: HoleShape; outcome: DecisionOutcome; inPlay?: boolean }[]): string[] => {
      const already = new Set(s.decided);
      const fresh = entries.filter(({ shape }) => shape.proposal && !already.has(shape.proposal.id));
      const courseId = s.course?.id;
      if (courseId && fresh.length > 0) {
        void recordDecisions(
          courseId,
          openHoleNumber(s),
          fresh.map(({ shape, outcome, inPlay }) => decisionFor(shape.proposal as Proposal, outcome, inPlay)),
        ).catch(() => {});
      }
      return fresh.map(({ shape }) => (shape.proposal as Proposal).id);
    },
    [],
  );

  /** Take a shape off the hole. A proposal is kept as a rejection (R10); a drawn one simply goes. */
  const withoutShape = useCallback(
    (s: MapperState, id: string): Partial<MapperState> => {
      const shape = s.shapes.find((candidate) => candidate.id === id);
      if (!shape) return {};
      const teeBoxes = { ...s.teeBoxes };
      for (const [key, box] of Object.entries(teeBoxes)) if (box === id) delete teeBoxes[key];
      if (shape.origin === 'drawn') {
        return { shapes: s.shapes.filter((candidate) => candidate.id !== id), teeBoxes };
      }
      const holeNumber = openHoleNumber(s);
      const decided = sendDecisions(s, [{ shape, outcome: 'rejected' }]);
      return {
        shapes: s.shapes.map((candidate) => (candidate.id === id ? { ...candidate, removed: true, confirmed: false } : candidate)),
        teeBoxes,
        decided: s.decided.concat(decided),
        rejections:
          shape.proposal && decided.length > 0
            ? { ...s.rejections, [holeNumber]: (s.rejections[holeNumber] ?? []).concat([shape.proposal]) }
            : s.rejections,
      };
    },
    [sendDecisions],
  );

  /** Mark shapes confirmed, and tell the store about the proposals among them. */
  const confirming = useCallback(
    (s: MapperState, ids: readonly string[]): Partial<MapperState> => {
      const set = new Set(ids);
      const shapes = s.shapes.filter((shape) => set.has(shape.id) && !shape.removed);
      const decided = sendDecisions(
        s,
        shapes.map((shape) => ({
          shape,
          outcome: 'confirmed' as const,
          /* R14: water kept on the hazard step is a contributor saying it is in play. */
          ...(shape.proposal?.kind === 'water' ? { inPlay: true } : {}),
        })),
      );
      return {
        shapes: s.shapes.map((shape) => (set.has(shape.id) && !shape.removed ? { ...shape, confirmed: true } : shape)),
        decided: s.decided.concat(decided),
      };
    },
    [sendDecisions],
  );

  /** The next step, with its own opening line. */
  const nextStep = (s: MapperState, note?: string): Partial<MapperState> => {
    const step = stepAt(s);
    return {
      step: s.step + 1,
      teeIndex: 0,
      interaction: NO_INTERACTION,
      lastAction: note ?? step?.done ?? '',
    };
  };

  /**
   * The confirming answer to the question on screen.
   *
   * About the shapes the question names and nothing else: one tee set's box, the
   * one green, or the set of bunkers the contributor is looking at, all of them
   * highlighted. It is held while the map is mid-edit — see `Interaction`.
   */
  const accept = useCallback(() => {
    const s = state;
    if (isBlocked(s) || s.interaction.kind !== 'none' || s.mode === 'locate') return;
    const step = stepAt(s);
    if (!step) return;

    if (step.id === 'tees' && teesByCard(s)) {
      const sets = teeSetsOf(s);
      const tee = sets[s.teeIndex];
      if (!tee) return;
      const box = s.teeBoxes[tee.key];
      const answered: Partial<MapperState> = box
        ? { ...confirming(s, [box]), lastAction: `The ${tee.name.toLowerCase()} tee plays from that box.` }
        : { teeBoxes: { ...s.teeBoxes, [tee.key]: null }, lastAction: `No ${tee.name.toLowerCase()} tee on this hole.` };
      const last = s.teeIndex + 1 >= sets.length;
      /* The answer's own words, even on the last set — "tees matched" would be
       * untrue after "no red tee on this hole". */
      patch(last ? { ...answered, ...nextStep(s, answered.lastAction) } : { ...answered, teeIndex: s.teeIndex + 1 });
      return;
    }

    if (step.id === 'green') {
      const green = greenCandidate(s);
      patch({ ...(green ? confirming(s, [green.id]) : {}), ...nextStep(s, green ? step.done : 'Green left for later.') });
      return;
    }

    if (step.id === 'hazards' && liveShapes(s, 'hazard').some((shape) => shape.hazardType === null)) {
      patch({ lastAction: 'Say what each hazard is first — water, trees, a waste area.' });
      return;
    }

    const ids = liveShapes(s, step.kind).map((shape) => shape.id);
    patch({ ...confirming(s, ids), ...nextStep(s) });
  }, [state, patch, confirming]);

  /** Wait for the next map click to drop a new outline of this kind. */
  const startPlace = useCallback(
    (shape: ShapeKind, options: { forTee?: string | null; replacing?: boolean } = {}) => {
      patch((s) =>
        isBlocked(s)
          ? {}
          : {
              interaction: { kind: 'place', shape, forTee: options.forTee ?? null, replacing: options.replacing ?? false },
              lastAction: '',
            },
      );
    },
    [patch],
  );

  const startPick = useCallback(
    (purpose: 'tee' | 'remove') => {
      patch((s) => (isBlocked(s) ? {} : { interaction: { kind: 'pick', purpose }, lastAction: '' }));
    },
    [patch],
  );

  /** "Edges look off": handles on the shapes being asked about, or on the ones named. */
  const startEdit = useCallback(
    (ids?: string[]) => {
      patch((s) => {
        if (isBlocked(s)) return {};
        const shapeIds = ids ?? activeShapeIds(s);
        return shapeIds.length > 0 ? { interaction: { kind: 'edit', shapeIds }, lastAction: '' } : {};
      });
    },
    [patch],
  );

  const finishEdit = useCallback(() => {
    patch((s) => (s.interaction.kind === 'edit' ? { interaction: NO_INTERACTION, lastAction: 'Edges saved.' } : {}));
  }, [patch]);

  /** Put the outlines being edited back how they first appeared. */
  const resetEdit = useCallback(() => {
    patch((s) => {
      if (s.interaction.kind !== 'edit') return {};
      const ids = new Set(s.interaction.shapeIds);
      return {
        shapes: s.shapes.map((shape) => (ids.has(shape.id) ? { ...shape, ring: shape.original, edited: false } : shape)),
      };
    });
  }, [patch]);

  /*
   * The actions below that can take a proposal off the hole read `state` from
   * the render rather than working inside a `patch(s => …)` updater. Taking a
   * proposal off posts its rejection, and React runs updaters twice under
   * StrictMode — a side effect inside one records the same rejection twice.
   */
  const cancelInteraction = useCallback(() => {
    const s = state;
    if (s.interaction.kind === 'none') return;
    /* A shape still being pulled into place when the contributor backs out was
     * never kept. A picked proposal goes back to waiting; a drawn one goes. */
    if (s.interaction.kind === 'new') {
      const id = s.interaction.shapeId;
      const shape = s.shapes.find((candidate) => candidate.id === id);
      if (shape?.origin === 'drawn') {
        patch({ ...withoutShape(s, shape.id), interaction: NO_INTERACTION });
        return;
      }
    }
    patch({ interaction: NO_INTERACTION });
  }, [state, patch, withoutShape]);

  /** Keep the shape just dropped or picked. On the green step that is the answer. */
  const confirmNew = useCallback(() => {
    const s = state;
    if (s.interaction.kind !== 'new') return;
    const id = s.interaction.shapeId;
    const shape = s.shapes.find((candidate) => candidate.id === id);
    if (!shape) return;
    const step = stepAt(s);
    if (step?.id === 'green' && shape.kind === 'green') {
      patch({ ...confirming(s, [id]), ...nextStep(s, 'That is the green.') });
      return;
    }
    const sets = teeSetsFrom(s, id);
    patch({
      interaction: NO_INTERACTION,
      lastAction:
        shape.kind === 'tee' && sets.length > 0
          ? `Drew a box for the ${sets.map((tee) => tee.name.toLowerCase()).join(' + ')} tee.`
          : `Added the ${SHAPE_NOUN[shape.kind]} you spotted — that one was on us.`,
    });
  }, [state, patch, confirming]);

  /** Throw away the shape just dropped or picked. */
  const discardNew = useCallback(() => {
    const s = state;
    if (s.interaction.kind !== 'new') return;
    patch({ ...withoutShape(s, s.interaction.shapeId), interaction: NO_INTERACTION, lastAction: 'Removed it.' });
  }, [state, patch, withoutShape]);

  /** "That is not the green": drop it, and wait for a click on the real one. */
  const notGreen = useCallback(() => {
    const s = state;
    if (isBlocked(s)) return;
    const green = greenCandidate(s);
    patch({
      ...(green ? withoutShape(s, green.id) : {}),
      interaction: { kind: 'place', shape: 'green', forTee: null, replacing: true },
      lastAction: '',
    });
  }, [state, patch, withoutShape]);

  /** "No blue tee here", said while a box is highlighted for it. */
  const noTee = useCallback(() => {
    const s = state;
    const sets = teeSetsOf(s);
    const tee = sets[s.teeIndex];
    if (!tee || stepAt(s)?.id !== 'tees' || s.interaction.kind !== 'none') return;
    const answered = { teeBoxes: { ...s.teeBoxes, [tee.key]: null }, lastAction: `No ${tee.name.toLowerCase()} tee on this hole.` };
    patch(
      s.teeIndex + 1 >= sets.length
        ? { ...answered, ...nextStep(s, answered.lastAction) }
        : { ...answered, teeIndex: s.teeIndex + 1 },
    );
  }, [state, patch]);

  /** The N key: the "no" each step offers first. */
  const reject = useCallback(() => {
    const s = state;
    if (isBlocked(s) || s.interaction.kind !== 'none' || s.mode === 'locate') return;
    const step = stepAt(s);
    if (!step) return;
    if (step.id === 'tees' && teesByCard(s)) startPick('tee');
    else if (step.id === 'green') notGreen();
    else if (step.id !== 'hazards' && liveShapes(s, step.kind).length > 0) startPick('remove');
  }, [state, startPick, notGreen]);

  /** The M key: "you missed one". */
  const missing = useCallback(() => {
    const s = state;
    if (isBlocked(s) || s.interaction.kind !== 'none' || s.mode === 'locate') return;
    const step = stepAt(s);
    if (!step) return;
    if (step.id === 'tees' && teesByCard(s)) startPick('tee');
    else startPlace(step.kind, { replacing: false });
  }, [state, startPick, startPlace]);

  /** One of the buttons under the question, by its id. */
  const runAction = useCallback(
    (id: QuestionAction) => {
      switch (id) {
        case 'pick-tee':
          return startPick('tee');
        case 'no-tee':
          return noTee();
        case 'edit':
          return startEdit();
        case 'not-green':
          return notGreen();
        case 'find-green':
          return startPlace('green', { replacing: true });
        case 'add': {
          const step = stepAt(state);
          return step ? startPlace(step.kind) : undefined;
        }
        case 'remove-one':
          return startPick('remove');
        case 'draw-hazard':
          return startPlace('hazard');
      }
    },
    [state, startPick, noTee, startEdit, notGreen, startPlace],
  );

  /** A new rough outline at a click, lying along the hole. */
  const dropShape = (s: MapperState, kind: ShapeKind, at: LngLat): HoleShape => {
    const size = DROPPED_SHAPE[kind];
    const line = s.locate.points;
    const bearing = line.length >= 2 ? bearingBetween(line[0], line[line.length - 1]) : 0;
    const ring = ellipseAround(at, size.along, size.across, size.vertices, bearing);
    return {
      id: `drawn-${s.shapeSeq + 1}`,
      kind,
      ring,
      inner: [],
      original: ring,
      origin: 'drawn',
      proposal: null,
      edited: false,
      confirmed: false,
      removed: false,
      hazardType: null,
    };
  };

  /**
   * A click on the imagery, already a WGS84 coordinate — `BaseMap` unprojects it,
   * so nothing here converts from screen space (R7).
   */
  const onMapClick = useCallback(
    (position: LngLat) => {
      const s = state;
      if (s.mode === 'locate') {
        /* Clicks add to a line the contributor is drawing. OpenStreetMap's line
         * is reshaped by its handles, not extended past its green. */
        if (s.locate.finished || s.locate.source === 'osm' || s.detect.status === 'working') return;
        const points = s.locate.points.concat([position]);
        patch({
          locate: { ...s.locate, points },
          lastAction:
            points.length === 1 ? 'Tee marked. Click where the hole bends, then the green.' : `Point ${points.length} added.`,
        });
        return;
      }

      const interaction = s.interaction;
      if (interaction.kind === 'pick') {
        if (interaction.purpose === 'tee') {
          const tee = teeSetsOf(s)[s.teeIndex];
          if (!tee) return;
          const hit = liveShapes(s, 'tee').find((shape) => pointInRing(position, shape.ring));
          if (hit) {
            patch({
              teeBoxes: { ...s.teeBoxes, [tee.key]: hit.id },
              interaction: NO_INTERACTION,
              lastAction: `Highlighted that box for the ${tee.name.toLowerCase()} tee.`,
            });
            return;
          }
          /* Open ground: a new box for this tee, right there. */
          const shape = dropShape(s, 'tee', position);
          patch({
            shapes: s.shapes.concat([shape]),
            shapeSeq: s.shapeSeq + 1,
            teeBoxes: { ...s.teeBoxes, [tee.key]: shape.id },
            interaction: { kind: 'new', shapeId: shape.id },
            lastAction: '',
          });
          return;
        }
        const step = stepAt(s);
        if (!step) return;
        const hit = liveShapes(s, step.kind).find((shape) => pointInRing(position, shape.ring));
        if (!hit) return;
        patch({
          ...withoutShape(s, hit.id),
          interaction: NO_INTERACTION,
          lastAction: 'Dropped that one — the rest stay as they are.',
        });
        return;
      }

      if (interaction.kind === 'place') {
        /* Looking for the real green, a click on another proposed green takes that one. */
        if (interaction.shape === 'green') {
          const other = liveShapes(s, 'green').find((shape) => !shape.confirmed && pointInRing(position, shape.ring));
          if (other) {
            patch({ interaction: { kind: 'new', shapeId: other.id }, lastAction: '' });
            return;
          }
        }
        const shape = dropShape(s, interaction.shape, position);
        patch({
          shapes: s.shapes.concat([shape]),
          shapeSeq: s.shapeSeq + 1,
          ...(interaction.forTee ? { teeBoxes: { ...s.teeBoxes, [interaction.forTee]: shape.id } } : {}),
          interaction: { kind: 'new', shapeId: shape.id },
          lastAction: '',
        });
      }
    },
    [state, patch, withoutShape],
  );

  /** One outline, reshaped on the map. */
  const moveShape = useCallback(
    (id: string, ring: LngLat[]) => {
      patch((s) => ({
        shapes: s.shapes.map((shape) => (shape.id === id ? { ...shape, ring, edited: shape.origin !== 'drawn' } : shape)),
      }));
    },
    [patch],
  );

  /** The playing line, reshaped on the map. Touching OpenStreetMap's line makes it the contributor's. */
  const moveLine = useCallback(
    (points: LngLat[]) => {
      patch((s) =>
        s.locate.finished
          ? {}
          : { locate: { ...s.locate, points, edited: s.locate.source === 'osm' ? true : s.locate.edited } },
      );
    },
    [patch],
  );

  const setHazardType = useCallback(
    (id: string, hazardType: HazardType) => {
      patch((s) => ({
        shapes: s.shapes.map((shape) => (shape.id === id ? { ...shape, hazardType } : shape)),
        lastAction: '',
      }));
    },
    [patch],
  );

  const removeShape = useCallback(
    (id: string) => {
      patch({ ...withoutShape(state, id), interaction: NO_INTERACTION, lastAction: 'Removed it.' });
    },
    [state, patch, withoutShape],
  );

  /**
   * Ask the service what is on a confirmed line (R1).
   *
   * Takes the points rather than reading them off state, because the caller that
   * matters most — confirming the line — knows them before React has applied the
   * `finished` flag.
   */
  const runDetection = useCallback(
    (points: readonly LngLat[]) => {
      if (points.length < 2) return;

      dropDetection();
      const controller = new AbortController();
      detectRun.current = controller;
      patch({ detect: { status: 'working' }, lastAction: '' });

      const snapshot = { ...state, locate: { ...state.locate, points: [...points], finished: true } };
      const request = detectRequestFor(snapshot);
      void askTheDetectionService(request, { signal: controller.signal }).then((result) => {
        /* Superseded by a later request, or by leaving the hole: not ours to apply. */
        if (detectRun.current !== controller) return;
        detectRun.current = null;
        if (result.status === 'aborted') return;

        if (result.status === 'ok') {
          patch((s) => {
            const shapes = reviewShapes(result.proposals, s.existing, s.previous);
            return {
              detect: {
                status: 'ready',
                jobId: result.jobId,
                proposals: result.proposals,
                imagery: result.imagery,
                missingTeeSets: result.missingTeeSets,
              },
              mode: 'ready',
              ...FRESH_REVIEW,
              shapes,
              /* Guesses first; what the contributor saved last time overrides them. */
              teeBoxes: { ...guessTeeBoxes(teeSetsOf(s), shapes, s.locate.points), ...savedTeeBoxes(shapes, s.previous) },
              /* "To check with you", never "found": nothing is settled until the
               * contributor has answered (R7). */
              lastAction: `Along your line we found ${countOf(result.proposals.length, 'shape', 'nothing')} to check with you.`,
            };
          });
          return;
        }
        if (result.status === 'no_coverage') {
          patch({ detect: { status: 'no_coverage', message: result.message }, lastAction: '' });
          return;
        }
        patch({ detect: { status: 'failed', message: result.message }, lastAction: '' });
      });
    },
    [state, patch, dropDetection],
  );

  /** Ask again by hand — the retry after a failure or an empty answer. */
  const requestProposals = useCallback(() => {
    if (!state.locate.finished) return;
    runDetection(state.locate.points);
  }, [state.locate.finished, state.locate.points, runDetection]);

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

  /**
   * "Yes, that is the hole": lock the line and go looking for what is on it.
   *
   * Confirming the line *is* the request for features — asking the contributor
   * to press a second button before anything happens would make them state the
   * same intent twice. Started here rather than from an effect watching
   * `finished`, because cancelling returns detection to idle and an effect would
   * read that as "not started yet" and fire again, forever.
   */
  const confirmLine = useCallback(() => {
    const { points, finished } = state.locate;
    if (points.length < 2 || finished) return;
    patch((s) => ({
      locate: { ...s.locate, finished: true },
      lastAction: 'Line locked in — looking along it for the tees, the green, the fairway and the sand …',
    }));
    runDetection(points);
  }, [state.locate, patch, runDetection]);

  /**
   * Carry on by hand, without waiting for detection — after a failure, an empty
   * answer, or a cancel. The drop is the whole point of the call order: a late
   * answer would otherwise reset the hole the contributor has started mapping.
   */
  const confirmLocate = useCallback(() => {
    dropDetection();
    patch((s) => {
      /* No proposals, but the tee boxes OpenStreetMap already holds are still pickable. */
      const shapes = reviewShapes([], s.existing, s.previous);
      return {
        mode: 'ready',
        ...FRESH_REVIEW,
        shapes,
        teeBoxes: { ...guessTeeBoxes(teeSetsOf(s), shapes, s.locate.points), ...savedTeeBoxes(shapes, s.previous) },
        locate: { ...s.locate, finished: s.locate.points.length >= 2 },
        detect: NO_DETECTION,
        lastAction: s.previous.length > 0
          ? 'Line saved. Each step starts from what you saved for this hole last time.'
          : shapes.length > 0
            ? `Line saved. OpenStreetMap already outlines ${countOf(shapes.length, 'shape')} on this hole — each step starts from those.`
            : 'Line saved. Every step is yours to draw.',
      };
    });
  }, [patch, dropDetection]);

  /**
   * Save the hole to our store (step 7).
   *
   * Only confirmed shapes are sent. A failure is stated and leaves everything in
   * place to try again — the hole is not marked done until the store has it.
   */
  const saveHole = useCallback(() => {
    const hole = holeToSave(state);
    if (!hole || state.save.status === 'saving') return;
    dropSave();
    const controller = new AbortController();
    saveRun.current = controller;
    const holeIndex = state.holeIndex;
    patch({ save: { status: 'saving' } });
    void postHole(hole, controller.signal).then((result) => {
      if (saveRun.current !== controller) return;
      saveRun.current = null;
      if (result.status === 'aborted') return;
      if (result.status === 'failed') {
        patch({ save: { status: 'failed', message: result.message } });
        return;
      }
      dropDetection();
      patch((s) => {
        const holeStatus = s.holeStatus.slice();
        holeStatus[holeIndex] = 'saved';
        return {
          holeStatus,
          savedHoles: { ...s.savedHoles, [hole.holeNumber]: result.data },
          save: { status: 'saved', at: result.data.savedAt ?? null },
          screen: 'complete',
          detect: NO_DETECTION,
          interaction: NO_INTERACTION,
        };
      });
    });
  }, [state, patch, dropSave, dropDetection]);

  const openHole = useCallback(
    (i: number) => {
      const status = state.holeStatus[i];
      dropDetection();
      dropSave();
      setState((s) => {
        /*
         * A hole opens on the best line anyone has for it: the one the
         * contributor saved here, else the one OpenStreetMap holds (R10), else
         * none. Whichever it is, the rail asks "does the hole run this way?"
         * before anything is detected along it.
         */
        const number = s.course?.holes[i]?.number ?? i + 1;
        const seed = seedFromOsm(osmHoleFor(s.osm, number));
        const saved = s.savedHoles[number];
        const locate: LocateState = saved
          ? {
              points: saved.playingLine.coordinates.map(([lng, lat]) => [lng, lat] as LngLat),
              finished: false,
              source: saved.lineSource === 'drawn' ? 'drawn' : 'osm',
              /* Only an OpenStreetMap line can have been edited; see `LocateState`. */
              edited: saved.lineSource === 'osm_edited',
            }
          : seed.locate;
        return {
          ...s,
          holeIndex: i,
          screen: 'review',
          mode: status === 'attention' ? 'attention' : 'locate',
          ...FRESH_REVIEW,
          locate,
          existing: seed.existing,
          osmHoleRef: seed.osmHoleRef,
          osmHoleId: saved?.osmHoleId ?? seed.osmHoleId,
          previous: saved?.features ?? [],
          detect: NO_DETECTION,
          lastAction: saved
            ? `You saved this hole before — its line and ${countOf(saved.features.length, 'shape')} are on the map.`
            : seed.existing.length > 0
              ? `OpenStreetMap already holds this hole — its line and ${countOf(seed.existing.length, 'outlined feature')} are on the map.`
              : seed.locate.points.length > 0
                ? 'OpenStreetMap already holds this hole — its playing line is on the map.'
                : '',
          attentionResolved: status === 'attention' ? false : s.attentionResolved,
        };
      });
    },
    [state.holeStatus, dropDetection, dropSave],
  );

  const nextHole = useCallback(() => {
    openHole(nextHoleIndex(state.holeStatus, state.holeIndex));
  }, [state.holeIndex, state.holeStatus, openHole]);

  /* --- The course boundary (step 2) --------------------------------------- */

  const moveBoundary = useCallback(
    (geometry: Polygon | MultiPolygon) => {
      patch({ boundary: { edited: geometry, save: NOT_SAVING } });
    },
    [patch],
  );

  const resetBoundary = useCallback(() => {
    patch({ boundary: { edited: null, save: NOT_SAVING } });
  }, [patch]);

  /** Save the corrected edge. Nothing is sent for an edge nobody moved. */
  const saveBoundary = useCallback(() => {
    const s = state;
    const geometry = s.boundary.edited;
    if (!s.course || !geometry || s.boundary.save.status === 'saving') return;
    patch({ boundary: { edited: geometry, save: { status: 'saving' } } });
    void postBoundary({
      courseId: s.course.id,
      osmId: s.osm.status === 'found' ? s.osm.course.osmId : null,
      geometry,
      edited: true,
    }).then((result) => {
      if (result.status === 'aborted') return;
      patch((current) =>
        current.boundary.edited !== geometry
          ? {}
          : {
              boundary: {
                edited: geometry,
                save:
                  result.status === 'ok'
                    ? { status: 'saved', at: result.data.savedAt ?? null }
                    : { status: 'failed', message: result.message },
              },
            },
      );
    });
  }, [state, patch]);

  /*
   * A / N / M answer the question without the mouse; Esc backs out of whatever
   * the map is waiting for. Only while the question is on screen: in the line
   * flow the contributor's attention is on the imagery, and a stray key that
   * moved the review on behind them would be the worst kind of surprise.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* An OS auto-repeat is one act, not twenty (KTD1). */
      if (e.repeat) return;
      if (state.screen !== 'review') return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === 'Escape') {
        cancelInteraction();
        return;
      }
      if (state.interaction.kind !== 'none' || state.mode === 'locate') return;
      const k = e.key.toLowerCase();
      if (k === 'a') accept();
      else if (k === 'n') reject();
      else if (k === 'm') missing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.screen, state.interaction.kind, state.mode, accept, reject, missing, cancelInteraction]);

  useEffect(() => {
    return () => {
      detectRun.current?.abort();
      saveRun.current?.abort();
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
      missing,
      runAction,
      startPlace,
      startPick,
      startEdit,
      finishEdit,
      resetEdit,
      cancelInteraction,
      confirmNew,
      discardNew,
      notGreen,
      noTee,
      setHazardType,
      removeShape,
      moveShape,
      moveLine,
      onMapClick,
      saveHole,
      openHole,
      nextHole,
      requestProposals,
      cancelProposals,
      confirmLine,
      confirmLocate,
      moveBoundary,
      resetBoundary,
      saveBoundary,
      setQuery: (query: string) => patch({ query }),
      /** Which tee set the drawn line is checked against (R15). */
      setTeeSet: (color: string) => patch({ teeSet: color }),
      /** Start the line again — and with it whatever was proposed about the old one. */
      resetLocate: () => {
        dropDetection();
        patch({ locate: EMPTY_LINE, detect: NO_DETECTION, ...FRESH_REVIEW, lastAction: '' });
      },
      /** Take back the last point placed. */
      undoLastPoint: () =>
        patch((s) => {
          if (s.locate.points.length === 0 || s.locate.finished) return {};
          const points = s.locate.points.slice(0, -1);
          return {
            /* Once a point has been taken off OpenStreetMap's line it is the contributor's. */
            locate: { points, finished: false, source: 'drawn', edited: false },
            lastAction: points.length === 0 ? '' : 'Took the last point back.',
          };
        }),
      resolveAttention: (lastAction: string) => patch({ attentionResolved: true, lastAction }),
    },
  };
}

export type Mapper = ReturnType<typeof useMapper>;

/**
 * What a saved hole holds, one phrase per kind — "2 tee boxes", "the green",
 * "3 bunkers", "water" — for the confirmation that it was saved. Counted off the
 * record itself, so it can never describe a hole it was not.
 */
export function summariseSavedHole(hole: SavedHole | undefined): string[] {
  if (!hole) return [];
  const count = (kind: SavedFeature['kind']) => hole.features.filter((feature) => feature.kind === kind).length;
  const parts: string[] = [];
  if (count('tee') > 0) parts.push(countOf(count('tee'), 'tee box'));
  if (count('green') > 0) parts.push(count('green') === 1 ? '1 green' : countOf(count('green'), 'green'));
  if (count('fairway') > 0) parts.push(count('fairway') === 1 ? '1 fairway' : `${count('fairway')} pieces of fairway`);
  if (count('bunker') > 0) parts.push(countOf(count('bunker'), 'bunker'));
  const others = hole.features
    .filter((feature) => !['tee', 'green', 'fairway', 'bunker'].includes(feature.kind))
    .map((feature) => (feature.label ?? feature.kind.replace(/_/g, ' ')).toLowerCase());
  if (others.length > 0) parts.push(others.join(', '));
  return parts;
}
