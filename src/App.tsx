import { useCallback, useEffect, useRef, useState } from 'react';
import { getCourse } from './api/opengolf';
import { TopNav, type NavItem } from './components/TopNav';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { SearchScreen } from './screens/SearchScreen';
import { buildCourseSession } from './state/courseSession';
import { useMapper } from './state/useMapper';

/**
 * What opening a course is doing right now. Loading and failed are surfaces of
 * their own per R5 — a detail fetch that fails leaves the contributor on search
 * with the cause stated, never on an empty board.
 */
type CourseLoad = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; message: string };

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

      void getCourse(courseId, controller.signal).then((result) => {
        if (controller.signal.aborted || result.status === 'aborted') return;
        if (result.status === 'ok') {
          setLoad({ kind: 'idle' });
          actions.openCourse(buildCourseSession(result.data));
          return;
        }
        setLoad({
          kind: 'failed',
          message:
            result.status === 'failed' ? result.message : 'the record held no course data',
        });
      });
    },
    [actions],
  );

  useEffect(() => () => inFlight.current?.abort(), []);

  /*
   * Every screen and review mode stays reachable directly, so no state is
   * stranded — but only once a course is loaded, since every one of them reads it.
   */
  const lastHole = course ? course.holes.length - 1 : 0;
  const navItems: NavItem[] = [
    { label: 'find', active: state.screen === 'search', go: () => actions.go('search') },
    ...(course
      ? [
          { label: 'boundary', active: state.screen === 'boundary', go: () => actions.go('boundary') },
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
        <SearchScreen
          query={state.query}
          onQuery={actions.setQuery}
          /* Every course opens the board today; U7 routes on whether OSM holds a boundary for this id. */
          onOpen={openCourse}
        />
      )}

      {course && state.screen === 'boundary' && (
        <BoundaryScreen
          courseName={course.name}
          flagged={state.flagged}
          onFlag={actions.flagBoundary}
          onConfirm={() => actions.go('board')}
          onBack={() => actions.go('search')}
        />
      )}

      {showBoard && course && (
        <BoardScreen
          course={course}
          holeStatus={state.holeStatus}
          doneCount={derived.doneCount}
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
        : 'Opening that course — loading its scorecard …'}
    </div>
  );
}
