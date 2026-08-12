import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OsmLookup } from '../api/overpass';
import {
  REVIEW_DIAGONAL,
  REVIEW_VIEWBOX,
  SHAPES,
  STEPS,
  TEE_IDS,
  YARDAGE_TOLERANCE,
  type HoleStatus,
  type Step,
  type TeeId,
} from '../data/course';
import { corridorPath, distance, ell, rr, type Point } from '../data/geometry';
import {
  defaultTeeAssign,
  holeStatusesFrom,
  holeYardage,
  scorecardFor,
  type CourseSession,
} from './courseSession';

export type Screen = 'search' | 'boundary' | 'board' | 'review' | 'complete';
export type ReviewMode = 'ready' | 'locate' | 'attention';

export interface ExtraShape {
  id: string;
  d: string;
  label: string;
}

export interface MapperState {
  screen: Screen;
  /** The course the contributor opened. Null until a detail record loads. */
  course: CourseSession | null;
  query: string;
  mode: ReviewMode;
  holeIndex: number;
  locate: { tee: Point | null; green: Point | null };
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

export const INITIAL: MapperState = {
  screen: 'search',
  course: null,
  query: '',
  mode: 'ready',
  holeIndex: 0,
  locate: { tee: null, green: null },
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
  /* Null, never 0, when the record carries no yardage: the screens say "—" for it. */
  const cardYds = course ? holeYardage(course, hi) : null;
  const q = currentStep(s);
  const allDone = s.step >= STEPS.length;
  const isLocate = s.mode === 'locate';
  const blocked = isBlocked(s) && !isLocate;

  const { tee, green } = s.locate;
  const locateDone = !!(tee && green);
  const locateYds =
    locateDone && cardYds !== null
      ? Math.round(distance(tee!, green!) * (cardYds / REVIEW_DIAGONAL))
      : 0;
  const locateOff = cardYds === null ? Infinity : Math.abs(locateYds - cardYds);
  const corridor = locateDone ? corridorPath(tee!, green!) : null;

  const activeIds = s.addMode
    ? []
    : blocked
      ? ['greenAlt', 'green']
      : allDone
        ? []
        : q.targets.filter((t) => !s.removed.includes(t));

  const allIds = Object.keys(SHAPES).filter((k) => (k === 'greenAlt' ? blocked : true));
  const confirmedIds = s.confirmed.filter((c) => allIds.includes(c));
  const pendingIds = allIds.filter(
    (k) => !confirmedIds.includes(k) && !activeIds.includes(k) && !s.removed.includes(k),
  );

  const measured =
    s.mode === 'attention' ? (s.attentionResolved ? 374 : 250) : locateYds || cardYds;

  const bunkersRemoved = s.removed.filter((r) => r.startsWith('bunker')).length;

  return {
    hi,
    cardYds,
    holePar: hole?.par ?? null,
    holeHandicapIndex: hole?.handicapIndex ?? null,
    q,
    allDone,
    isLocate,
    blocked,
    locateDone,
    locateYds,
    locateOff,
    locateWithinTolerance: locateOff <= YARDAGE_TOLERANCE,
    corridor,
    activeIds,
    confirmedIds,
    pendingIds,
    measured,
    doneCount: s.holeStatus.filter((x) => x === 'complete').length,
    /* Straight off this hole's own `yardages` map — no ratio, no hole-1 baseline. */
    scorecard: course ? scorecardFor(course, hi) : [],
    summary: [
      '1 green',
      `${2 - bunkersRemoved + s.extra.length} bunkers`,
      `4 tee boxes — ${TEE_IDS.map((id) => s.teeAssign[id].toLowerCase()).join(', ')}`,
      'fairway, tee to green',
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
        locate: screen === 'review' ? { tee: null, green: null } : s.locate,
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
        step: 0,
        confirmed: [],
        removed: [],
        extra: [],
        addMode: null,
        locate: { tee: null, green: null },
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

  const mapPoint = (e: React.MouseEvent<SVGSVGElement>): Point => {
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM?.();
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * REVIEW_VIEWBOX.w,
      y: ((e.clientY - r.top) / r.height) * REVIEW_VIEWBOX.h,
    };
  };

  const onMapClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const p = mapPoint(e);
      if (state.mode === 'locate') {
        patch((s) => {
          if (!s.locate.tee) return { locate: { tee: p, green: null }, lastAction: 'Tee marked.' };
          if (!s.locate.green) {
            return {
              locate: { tee: s.locate.tee, green: p },
              lastAction: 'Green marked — that is the line.',
            };
          }
          return {};
        });
        return;
      }
      if (!state.addMode) return;

      const noun = state.addMode;
      const d =
        noun === 'water'
          ? ell(p.x, p.y, 46, 30)
          : noun === 'tee box'
            ? rr(p.x - 30, p.y - 14, 60, 28, 6)
            : ell(p.x, p.y, 30, 19);

      patch((s) => ({
        extra: s.extra.concat([{ id: 'extra' + s.extra.length, d, label: noun }]),
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
        locate: { tee: null, green: null },
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

  /* A / N / M drive the three review answers without reaching for the mouse. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.screen !== 'review' || state.addMode) return;
      const k = e.key.toLowerCase();
      if (k === 'a') accept();
      else if (k === 'n') reject();
      else if (k === 'm') missing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.screen, state.addMode, accept, reject, missing]);

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
      cancelAdd: () => patch({ addMode: null }),
      resetLocate: () => patch({ locate: { tee: null, green: null }, lastAction: '' }),
      confirmLocate: () =>
        patch({
          mode: 'ready',
          step: 0,
          confirmed: [],
          removed: [],
          extra: [],
          lastAction:
            'Inside your line we found a green, 2 bunkers and the fairway. Check them below.',
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
