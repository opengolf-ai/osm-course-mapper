import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Geometry, LineString, Polygon } from 'geojson';
import type { OsmLookup } from '../api/overpass';
import { STEPS, TEE_IDS, type HoleStatus, type Step, type TeeId } from '../data/course';
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
  confirmed: string[];
  removed: string[];
  extra: ExtraShape[];
  addMode: string | null;
  lastAction: string;
  attentionResolved: boolean;
  /** What OpenStreetMap answered for the open course. Drives routing and the board. */
  osm: OsmLookup;
  teeAssign: Record<TeeId, string>;
  holeStatus: HoleStatus[];
}

const EMPTY_LINE: LocateState = { points: [], finished: false };

export const INITIAL: MapperState = {
  screen: 'search',
  course: null,
  query: '',
  mode: 'ready',
  holeIndex: 0,
  locate: EMPTY_LINE,
  teeSet: null,
  step: 0,
  confirmed: [],
  removed: [],
  extra: [],
  addMode: null,
  lastAction: '',
  attentionResolved: false,
  osm: { status: 'pending' },
  /* Named for real when a course loads — `defaultTeeAssign` reads the course's own sets. */
  teeAssign: { tee1: '', tee2: '', tee3: '', tee4: '' },
  /* No course, no holes. Statuses arrive with the course, from OpenStreetMap. */
  holeStatus: [],
};

/** The noun the "we missed one" branch is about, per review step. */
function missingNoun(stepId: string): string {
  if (stepId === 'bunkers') return 'bunker';
  if (stepId === 'tees') return 'tee box';
  if (stepId === 'extras') return 'water';
  if (stepId === 'green') return 'green';
  return 'fairway edge';
}

/** What an added feature is, and roughly how big one is, in yards of radius. */
const ADDED_FEATURE: Record<string, { kind: FeatureKind; radiusYards: number }> = {
  water: { kind: 'water', radiusYards: 40 },
  'tee box': { kind: 'tee', radiusYards: 14 },
  green: { kind: 'green', radiusYards: 22 },
  bunker: { kind: 'bunker', radiusYards: 12 },
  'fairway edge': { kind: 'fairway', radiusYards: 28 },
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

const currentStep = (s: MapperState): Step => STEPS[Math.min(s.step, STEPS.length - 1)];
const isBlocked = (s: MapperState) => s.mode === 'attention' && !s.attentionResolved;

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
  const holeRef = hole ? String(hole.number) : String(hi + 1);
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
  for (const added of s.extra) {
    features.push({
      ...added.feature,
      properties: { ...added.feature.properties, status: 'confirmed', label: added.label },
    });
  }

  /* Captions sit at the centroid of the thing they name, not at a fixed offset. */
  const labels: FeatureLabel[] = s.extra.map((added) => ({
    key: added.id,
    text: added.label,
    position: labelPoint(added.feature.geometry),
  }));
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
    features,
    labels,
    mapBounds,
    doneCount: s.holeStatus.filter((x) => x === 'complete').length,
    /* Straight off this hole's own `yardages` map — no ratio, no hole-1 baseline. */
    scorecard: course ? scorecardFor(course, hi) : [],
    /* Only what the contributor actually drew — nothing is claimed on their behalf. */
    summary: [
      locateDone
        ? `playing line, ${locateYds} yd over ${points.length} points`
        : 'no playing line drawn yet',
      ...[...addedByLabel].map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`),
      `tee boxes named — ${TEE_IDS.map((id) => s.teeAssign[id].toLowerCase()).join(', ')}`,
    ],
  };
}

export function useMapper() {
  const [state, setState] = useState<MapperState>(INITIAL);
  const advanceTimer = useRef<number | null>(null);

  const patch = useCallback((next: Partial<MapperState> | ((s: MapperState) => Partial<MapperState>)) => {
    setState((s) => ({ ...s, ...(typeof next === 'function' ? next(s) : next) }));
  }, []);

  const go = useCallback(
    (screen: Screen, mode?: ReviewMode) => {
      patch((s) => ({
        screen,
        mode: mode ?? s.mode,
        step: screen === 'review' ? 0 : s.step,
        confirmed: screen === 'review' ? [] : s.confirmed,
        removed: screen === 'review' ? [] : s.removed,
        extra: screen === 'review' ? [] : s.extra,
        addMode: null,
        locate: screen === 'review' ? EMPTY_LINE : s.locate,
        lastAction: '',
        attentionResolved:
          screen === 'review' && mode === 'attention' ? false : s.attentionResolved,
      }));
    },
    [patch],
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
        confirmed: [],
        removed: [],
        extra: [],
        addMode: null,
        locate: EMPTY_LINE,
        lastAction: '',
        attentionResolved: false,
      });
    },
    [patch],
  );

  const advance = useCallback(
    (note?: string) => {
      patch((s) => {
        const st = STEPS[s.step];
        const add = st ? st.targets.filter((t) => !s.removed.includes(t)) : [];
        return {
          confirmed: s.confirmed.concat(add),
          step: s.step + 1,
          lastAction: note ?? st?.done ?? '',
        };
      });
    },
    [patch],
  );

  const accept = useCallback(() => {
    setState((s) => {
      if (isBlocked(s)) return s;
      const st = STEPS[s.step];
      const add = st ? st.targets.filter((t) => !s.removed.includes(t)) : [];
      return {
        ...s,
        confirmed: s.confirmed.concat(add),
        step: s.step + 1,
        lastAction: st?.done ?? '',
      };
    });
  }, []);

  const reject = useCallback(() => {
    setState((s) => {
      if (isBlocked(s)) return s;
      const st = currentStep(s);
      const drop = st.targets[st.targets.length - 1];
      const removed = drop ? s.removed.concat([drop]) : s.removed;
      const stepDef = STEPS[s.step];
      const add = stepDef ? stepDef.targets.filter((t) => !removed.includes(t)) : [];
      return {
        ...s,
        removed,
        confirmed: s.confirmed.concat(add),
        step: s.step + 1,
        lastAction: 'Dropped it — false alarms happen as often as misses.',
      };
    });
  }, []);

  const missing = useCallback(() => {
    setState((s) => (isBlocked(s) ? s : { ...s, addMode: missingNoun(currentStep(s).id) }));
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
        confirmed: [],
        removed: [],
        extra: [],
        addMode: null,
        locate: EMPTY_LINE,
        lastAction: '',
        attentionResolved: status === 'attention' ? false : s.attentionResolved,
      }));
    },
    [state.holeStatus],
  );

  const nextHole = useCallback(() => {
    const from = state.holeIndex;
    const next = state.holeStatus.findIndex((st, i) => i > from && st !== 'complete');
    openHole(next < 0 ? from : next);
  }, [state.holeIndex, state.holeStatus, openHole]);

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
      advance,
      onMapClick,
      upload,
      openHole,
      nextHole,
      setQuery: (query: string) => patch({ query }),
      setTee: (id: TeeId, value: string) =>
        patch((s) => ({ teeAssign: { ...s.teeAssign, [id]: value } })),
      /** Which tee set the drawn line is checked against (R15). */
      setTeeSet: (color: string) => patch({ teeSet: color }),
      cancelAdd: () => patch({ addMode: null }),
      resetLocate: () => patch({ locate: EMPTY_LINE, lastAction: '' }),
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
          confirmed: [],
          removed: [],
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
