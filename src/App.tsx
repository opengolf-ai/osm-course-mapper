import { useCallback, useEffect, useRef, useState } from 'react';
import { getCourse } from './api/opengolf';
import { getSavedBoundary, listSavedHoles, type SavedBoundary, type SavedHole } from './api/holes';
import { lookupOsmCourse } from './api/overpass';
import { TopNav, type NavItem } from './components/TopNav';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { SearchScreen } from './screens/SearchScreen';
import { buildCourseSession } from './state/courseSession';
import { parsePath, routeFor, routeToPath, type Route } from './state/url';
import { summariseSavedHole, useMapper } from './state/useMapper';

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
          /* Release the address. The link stays in the bar so a refresh retries
             it, but the app must be free to write one again when the
             contributor navigates somewhere else. */
          pendingRoute.current = null;
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
        /*
         * What the contributor already saved here is read alongside OpenStreetMap,
         * and is best-effort: a store that is down or not configured leaves the
         * course opening exactly as it would have with nothing saved.
         */
        const saved = loadSaved(session.id, controller.signal);
        const osm = await lookupOsmCourse(
          {
            id: session.id,
            name: session.name,
            latitude: session.latitude,
            longitude: session.longitude,
            /* The card goes with the query so the lookup can tell which of a
             * club's nines this eighteen plays — a composite's front nine is
             * identified by its pars, not by anything the hole tags say. */
            holes: session.holes.map((hole) => ({ number: hole.number, par: hole.par })),
          },
          controller.signal,
        );
        const { holes, boundary } = await saved;
        if (controller.signal.aborted) return;

        setLoad({ kind: 'idle' });
        actions.openCourse(session, osm, { holes, boundary });
      })();
    },
    [actions],
  );

  useEffect(() => () => inFlight.current?.abort(), []);

  /*
   * ---------- The address bar ----------
   *
   * Every screen has a URL, so the browser's own back and forward buttons work
   * and a link survives a refresh. Three effects, in the order they have to run:
   * read the address once on mount, write it whenever the app moves, and read it
   * again whenever the contributor uses the back button.
   *
   * `synced` is what keeps those from fighting. It holds the path this component
   * last agreed with, so applying an address never bounces back out as a new
   * history entry.
   */
  const synced = useRef<string | null>(null);
  /*
   * The address an applied route came from. Opening a hole can land somewhere
   * more specific than the link said — `/hole/1` on an unmapped hole becomes
   * `/hole/1/locate` — and that correction has to replace the entry it came
   * from. Pushed instead, the contributor's first back press would land on the
   * address that immediately corrects itself again, and the button would look
   * broken.
   */
  const correctingFrom = useRef<string | null>(null);
  /* A deep link names a course that is not loaded yet. Hold the rest of the
     address until the fetch lands, then finish the navigation. */
  const pendingRoute = useRef<Route | null>(null);

  const holeNumberAt = useCallback(
    (index: number) => course?.holes[index]?.number ?? index + 1,
    [course],
  );

  const indexOfHole = useCallback(
    (holeNumber: number) => {
      if (!course) return 0;
      const found = course.holes.findIndex((h) => h.number === holeNumber);
      /* A number the record does not carry still addresses a position, so a
         hand-typed /hole/3 opens something rather than dead-ending. */
      if (found >= 0) return found;
      return Math.min(Math.max(holeNumber - 1, 0), Math.max(course.holes.length - 1, 0));
    },
    [course],
  );

  const currentRoute = routeFor({
    screen: state.screen,
    mode: state.mode,
    courseId: course?.id ?? null,
    holeNumber: course ? holeNumberAt(state.holeIndex) : null,
  });

  /** Move the app to an address. Never touches history — the caller owns that. */
  const applyRoute = useCallback(
    (route: Route) => {
      if (route.screen === 'search') {
        actions.go('search');
        return;
      }
      /* Every other screen reads the course. If it is not the one loaded, the
         fetch has to finish first; park the address and let openCourse land. */
      if (!course || course.id !== route.courseId) {
        pendingRoute.current = route;
        openCourse(route.courseId);
        return;
      }
      switch (route.screen) {
        case 'boundary':
          /* Only a course OpenStreetMap holds a line for has a boundary screen
             to show. A link to one that does not lands on the board rather than
             on a screen with nothing in it. */
          actions.go(state.osm.status === 'found' ? 'boundary' : 'board');
          return;
        case 'board':
          actions.go('board');
          return;
        case 'review': {
          /*
           * Always open the hole, even when its index already matches. Hole 1
           * resolves to index 0, which is also where `holeIndex` starts, so a
           * guard on "did the index change" skips the one hole a pasted link is
           * most likely to name — leaving the screen in its default mode with
           * no line drawn and nothing asking for one.
           */
          actions.openHole(indexOfHole(route.holeNumber));
          /*
           * `ready` is the absence of a mode in the address, not a mode to
           * impose. Opening the hole already picked one from what
           * OpenStreetMap holds — a hole with no line wants `locate` — and
           * forcing `ready` over that is what left the screen with nothing to
           * do. Only a mode the address names explicitly overrides it.
           */
          if (route.mode !== 'ready') actions.go('review', route.mode);
          return;
        }
        case 'complete':
          actions.patch({ holeIndex: indexOfHole(route.holeNumber), screen: 'complete' });
          return;
      }
    },
    [course, openCourse, actions, indexOfHole, state.osm.status],
  );

  /* Read the address once, on mount. Until this runs, nothing is written — a
     deep link must not be overwritten by the initial state's own URL. */
  useEffect(() => {
    const route = parsePath(window.location.pathname);
    synced.current = window.location.pathname;
    correctingFrom.current = window.location.pathname;
    if (route.screen !== 'search') applyRoute(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only, by design
  }, []);

  /* A deep link's remaining address, applied once its course has landed. */
  useEffect(() => {
    const pending = pendingRoute.current;
    if (!pending || pending.screen === 'search' || !course || course.id !== pending.courseId) return;
    pendingRoute.current = null;
    applyRoute(pending);
  }, [course, applyRoute]);

  /* Write the address whenever the app moves somewhere new. */
  useEffect(() => {
    if (synced.current === null) return; /* mount read has not happened yet */
    /*
     * A deep link is still resolving. The address already names where we are
     * going; the app just cannot get there until the course lands. Writing the
     * loading screen's own route over it would throw the destination away —
     * the address bar would snap to `/` and a refresh would lose the hole too.
     */
    if (pendingRoute.current !== null) return;

    const path = routeToPath(currentRoute);
    if (path === synced.current) return;
    /* Only the first write after applying an address is a correction of it. */
    const correcting = correctingFrom.current !== null && correctingFrom.current === synced.current;
    correctingFrom.current = null;
    synced.current = path;
    if (correcting) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  }, [currentRoute]);

  /* Back and forward: read the address and move to it, without writing one. */
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      const route = parsePath(path);
      synced.current = path;
      correctingFrom.current = path;
      applyRoute(route);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute]);

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
          geometry={state.boundary.edited ?? adopted.boundary}
          edited={state.boundary.edited !== null}
          save={state.boundary.save}
          courseName={course.name}
          onChange={actions.moveBoundary}
          onReset={actions.resetBoundary}
          onSave={actions.saveBoundary}
          onContinue={() => {
            /* An edge dragged but never saved is saved on the way past, not dropped. */
            if (state.boundary.edited && state.boundary.save.status === 'idle') actions.saveBoundary();
            actions.go('board');
          }}
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
          holeNum={derived.holeNumber}
          saved={summariseSavedHole(state.savedHoles[derived.holeNumber])}
          doneCount={derived.doneCount + derived.savedCount}
          holeCount={course.holes.length}
          onNextHole={actions.nextHole}
          onBack={() => actions.go('board')}
        />
      )}

      {load.kind !== 'idle' && <CourseLoadNotice load={load} />}
    </div>
  );
}

/** How long opening a course waits on our own store before carrying on without it. */
const SAVED_READ_TIMEOUT_MS = 4_000;

/**
 * The holes and boundary saved for a course, or nothing. Never fails: the store
 * is where a contributor's own earlier work lives, and its absence must not
 * stop a course opening.
 */
async function loadSaved(
  courseId: string,
  outer: AbortSignal,
): Promise<{ holes: SavedHole[]; boundary: SavedBoundary | null }> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  outer.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, SAVED_READ_TIMEOUT_MS);
  try {
    const [holes, boundary] = await Promise.all([
      listSavedHoles(courseId, controller.signal),
      getSavedBoundary(courseId, controller.signal),
    ]);
    return {
      holes: holes.status === 'ok' ? holes.data : [],
      boundary: boundary.status === 'ok' ? boundary.data : null,
    };
  } catch {
    return { holes: [], boundary: null };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', stop);
  }
}

/**
 * The course-open transition, stated over whatever screen the contributor is on.
 *
 * Loading and checking cover the screen: nothing underneath is the course they
 * picked yet, and a click on the search results behind it would start a second
 * load. A failure is a toast instead — search stays usable, because picking
 * another course is the way forward.
 */
function CourseLoadNotice({ load }: { load: Exclude<CourseLoad, { kind: 'idle' }> }) {
  if (load.kind === 'failed') {
    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 28,
          transform: 'translateX(-50%)',
          zIndex: 70,
          maxWidth: 560,
          background: 'var(--status-danger-bg, #f6e4e1)',
          color: 'var(--clay-500, #8a3324)',
          border: '1px solid var(--status-danger-fg, #b4462f)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-md)',
          padding: '12px 18px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.6,
          textWrap: 'pretty',
        }}
      >
        Could not open that course — {load.message}. Pick a course to try again.
      </div>
    );
  }

  const checking = load.kind === 'checking';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(6,43,38,.62)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        animation: 'ogRise 190ms var(--ease-out)',
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: '100%',
          background: 'var(--green-900)',
          border: '1px solid rgba(255,255,255,.14)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: '28px 26px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
          textAlign: 'center',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            border: '3px solid rgba(255,255,255,.14)',
            borderTopColor: 'var(--mint-400)',
            animation: 'ogSpin 0.9s linear infinite',
          }}
        />
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, color: '#fff', marginBottom: 6 }}>
            {checking ? 'Checking OpenStreetMap' : 'Opening the course'}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--green-200)', textWrap: 'pretty' }}>
            {checking
              ? 'Looking up the boundary, holes and outlines OpenStreetMap already holds, and anything you saved here before …'
              : 'Loading its scorecard …'}
          </div>
        </div>
        {/* Two stages, so a slow OpenStreetMap answer reads as progress rather than a hang. */}
        <div style={{ display: 'flex', gap: 6 }} aria-hidden="true">
          {[true, checking].map((done, i) => (
            <span
              key={i}
              style={{
                width: 28,
                height: 4,
                borderRadius: 2,
                background: done ? 'var(--mint-400)' : 'rgba(255,255,255,.14)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
