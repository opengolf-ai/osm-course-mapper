import { useCallback, useEffect, useRef, useState } from 'react';
import { getCourse } from './api/opengolf';
import { lookupOsmCourse } from './api/overpass';
import { TopNav, type NavItem } from './components/TopNav';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { SearchScreen } from './screens/SearchScreen';
import { buildCourseSession } from './state/courseSession';
import { useMapper } from './state/useMapper';

/**
 * What opening a course is doing right now. Loading, checking, and failed are
 * surfaces of their own per R5 — a detail fetch that fails leaves the contributor
 * on search with the cause stated, never on an empty board.
 *
 * `checking` is the OpenStreetMap stage. It can only fail into `unknown`, never
 * into a stop: a course whose OSM lookup dies still opens (R12).
 */
type CourseLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'checking' }
  | { kind: 'failed'; message: string };

export default function App() {
  const mapper = useMapper();
  const { state, derived, actions } = mapper;
  const course = state.course;

  const [load, setLoad] = useState<CourseLoad>({ kind: 'idle' });
  const inFlight = useRef<AbortController | null>(null);

  /* One course at a time: a second pick drops whatever the first left in flight. */
  const openCourse = useCallback(
    (courseId: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoad({ kind: 'loading' });

      void (async () => {
        const result = await getCourse(courseId, controller.signal);
        if (controller.signal.aborted || result.status === 'aborted') return;
        if (result.status !== 'ok') {
          setLoad({
            kind: 'failed',
            message: result.status === 'failed' ? result.message : 'the record held no course data',
          });
          return;
        }

        const session = buildCourseSession(result.data);

        /*
         * The course opens on what OpenStreetMap already holds, so the answer is
         * waited for rather than applied later — being moved off the board onto
         * a boundary screen mid-read would be worse than the wait. The lookup
         * carries its own timeout and single retry, and every failure resolves
         * to `unknown`, so this can stall but never hang.
         */
        setLoad({ kind: 'checking' });
        const osm = await lookupOsmCourse(
          {
            id: session.id,
            name: session.name,
            latitude: session.latitude,
            longitude: session.longitude,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;

        setLoad({ kind: 'idle' });
        actions.openCourse(session, osm);
      })();
    },
    [actions],
  );

  useEffect(() => () => inFlight.current?.abort(), []);

  /*
   * Every screen and review mode stays reachable directly, so no state is
   * stranded — but only once a course is loaded, since every one of them reads it.
   */
  const lastHole = course ? course.holes.length - 1 : 0;
  /* Only a course OSM actually holds a line for has a boundary screen to reach. */
  const adopted = state.osm.status === 'found' ? state.osm.course : null;
  const navItems: NavItem[] = [
    { label: 'find', active: state.screen === 'search', go: () => actions.go('search') },
    ...(course
      ? [
          ...(adopted
            ? [
                {
                  label: 'boundary',
                  active: state.screen === 'boundary',
                  go: () => actions.go('boundary'),
                },
              ]
            : []),
          { label: 'holes', active: state.screen === 'board', go: () => actions.go('board') },
          {
            label: 'review',
            active: state.screen === 'review' && state.mode === 'ready',
            go: () => {
              actions.patch({ holeIndex: 0 });
              actions.go('review', 'ready');
            },
          },
          {
            label: 'new hole',
            active: state.screen === 'review' && state.mode === 'locate',
            go: () => {
              actions.patch({ holeIndex: Math.min(9, lastHole) });
              actions.go('review', 'locate');
            },
          },
          {
            label: 'needs attention',
            active: state.screen === 'review' && state.mode === 'attention',
            go: () => {
              actions.patch({ holeIndex: 0 });
              actions.go('review', 'attention');
            },
          },
          {
            label: 'done',
            active: state.screen === 'complete',
            go: () => actions.patch({ screen: 'complete' }),
          },
        ]
      : []),
  ];

  /* With no course loaded there is nothing for the other screens to draw. */
  const showSearch = !course || state.screen === 'search';
  const showBoard = !!course && (state.screen === 'board' || state.screen === 'complete');

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--green-950)',
        color: 'var(--green-100)',
        fontFamily: 'var(--font-sans)',
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <TopNav items={navItems} />

      {showSearch && (
        <SearchScreen query={state.query} onQuery={actions.setQuery} onOpen={openCourse} />
      )}

      {course && adopted && state.screen === 'boundary' && (
        <BoundaryScreen
          course={adopted}
          courseName={course.name}
          onContinue={() => actions.go('board')}
          onBack={() => actions.go('search')}
        />
      )}

      {showBoard && course && (
        <BoardScreen
          course={course}
          holeStatus={state.holeStatus}
          doneCount={derived.doneCount}
          osm={state.osm}
          onOpenHole={actions.openHole}
          onBack={() => actions.go('search')}
        />
      )}

      {course && state.screen === 'review' && <ReviewScreen mapper={mapper} />}

      {course && state.screen === 'complete' && (
        <CompleteModal
          courseName={course.name}
          holeNum={course.holes[derived.hi]?.number ?? derived.hi + 1}
          doneCount={derived.doneCount}
          holeCount={course.holes.length}
          onNextHole={actions.nextHole}
          onBack={() => actions.go('board')}
        />
      )}

      {load.kind !== 'idle' && <CourseLoadNotice load={load} />}
    </div>
  );
}

/** The course-open transition, stated over whatever screen the contributor is on. */
function CourseLoadNotice({ load }: { load: Exclude<CourseLoad, { kind: 'idle' }> }) {
  const failed = load.kind === 'failed';
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        zIndex: 70,
        maxWidth: 560,
        background: failed ? 'var(--status-danger-bg, #f6e4e1)' : 'var(--green-800)',
        color: failed ? 'var(--clay-500, #8a3324)' : 'var(--green-100)',
        border: `1px solid ${failed ? 'var(--status-danger-fg, #b4462f)' : 'rgba(255,255,255,.18)'}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        padding: '12px 18px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        textWrap: 'pretty',
      }}
    >
      {failed
        ? `Could not open that course — ${load.message}. Pick a course to try again.`
        : load.kind === 'checking'
          ? 'Checking what OpenStreetMap already holds for this course …'
          : 'Opening that course — loading its scorecard …'}
    </div>
  );
}
