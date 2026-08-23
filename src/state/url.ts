import type { ReviewMode, Screen } from './useMapper';

/**
 * The address bar as a first-class view of where the contributor is.
 *
 * Every screen gets a URL so the browser's own back and forward buttons work,
 * and so a link survives a refresh or a paste into someone else's chat. That
 * second property is the reason this maps to real paths rather than a query
 * string or a hash: a URL that dies when you reload it is not a URL, it is a
 * session variable with extra steps.
 *
 * Holes are addressed by their **number**, not their index. The number is what
 * the card shows and what a person means by "the 7th", and it stays stable if a
 * record's hole ordering ever changes; the index is an implementation detail of
 * the loaded session.
 *
 * This module is deliberately pure — no `window`, no history, no React. The app
 * is server-rendered by the smoke harness, so anything that touches `location`
 * has to stay in an effect. Keeping the mapping here also makes it testable
 * without a DOM.
 */

/** Where the contributor is, in a form that round-trips through a path. */
export type Route =
  | { screen: 'search' }
  | { screen: 'boundary'; courseId: string }
  | { screen: 'board'; courseId: string }
  | { screen: 'review'; courseId: string; holeNumber: number; mode: ReviewMode }
  | { screen: 'complete'; courseId: string; holeNumber: number };

/** The review modes that earn a path segment. `ready` is the bare hole URL. */
const MODE_SEGMENT: Record<Exclude<ReviewMode, 'ready'>, string> = {
  locate: 'locate',
  attention: 'attention',
};

const SEGMENT_MODE: Record<string, ReviewMode> = {
  locate: 'locate',
  attention: 'attention',
};

/** The search screen, and what an unreadable path falls back to. */
export const HOME: Route = { screen: 'search' };

/**
 * A course id is put in a path segment, so it has to survive one. The API's ids
 * are opaque strings we do not control, and a slash or a space in one would
 * silently reshape the path.
 */
function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** Build the path for a route. Always absolute, never with a trailing slash. */
export function routeToPath(route: Route): string {
  switch (route.screen) {
    case 'search':
      return '/';
    case 'boundary':
      return `/c/${encodeId(route.courseId)}/boundary`;
    case 'board':
      return `/c/${encodeId(route.courseId)}`;
    case 'review': {
      const base = `/c/${encodeId(route.courseId)}/hole/${route.holeNumber}`;
      return route.mode === 'ready' ? base : `${base}/${MODE_SEGMENT[route.mode]}`;
    }
    case 'complete':
      return `/c/${encodeId(route.courseId)}/hole/${route.holeNumber}/done`;
  }
}

/**
 * Read a path back into a route.
 *
 * Anything unreadable resolves to the search screen rather than throwing or
 * rendering an error page. A bad URL is a navigation problem, not a crash, and
 * search is the one screen that works with no course loaded.
 */
export function parsePath(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part.length > 0);

  if (parts[0] !== 'c' || parts.length < 2) return HOME;

  let courseId: string;
  try {
    courseId = decodeURIComponent(parts[1]);
  } catch {
    /* A malformed percent-escape throws; treat it as an unreadable address. */
    return HOME;
  }
  if (courseId === '') return HOME;

  /* /c/:id */
  if (parts.length === 2) return { screen: 'board', courseId };

  /* /c/:id/boundary */
  if (parts.length === 3 && parts[2] === 'boundary') return { screen: 'boundary', courseId };

  /* /c/:id/hole/:n[/mode|done] */
  if (parts[2] === 'hole' && parts.length >= 4) {
    const holeNumber = Number(parts[3]);
    /* Whole positive numbers only — `hole/0`, `hole/-1` and `hole/4.5` are not holes. */
    if (!Number.isInteger(holeNumber) || holeNumber < 1) return HOME;

    if (parts.length === 4) return { screen: 'review', courseId, holeNumber, mode: 'ready' };

    if (parts.length === 5) {
      if (parts[4] === 'done') return { screen: 'complete', courseId, holeNumber };
      const mode = SEGMENT_MODE[parts[4]];
      if (mode) return { screen: 'review', courseId, holeNumber, mode };
    }
  }

  return HOME;
}

/**
 * The route for the app's current state.
 *
 * Takes primitives rather than the state object so this module stays free of a
 * dependency on the shape of the whole hook. `courseId` is null before a course
 * loads, which is the one case that can only be the search screen — every other
 * screen reads the course.
 */
export function routeFor(input: {
  screen: Screen;
  mode: ReviewMode;
  courseId: string | null;
  holeNumber: number | null;
}): Route {
  const { screen, mode, courseId, holeNumber } = input;
  if (!courseId) return HOME;

  switch (screen) {
    case 'search':
      return HOME;
    case 'boundary':
      return { screen: 'boundary', courseId };
    case 'board':
      return { screen: 'board', courseId };
    case 'review':
      /* A review screen with no hole resolved is the board's job to fix, not
         an address worth minting. */
      return holeNumber === null
        ? { screen: 'board', courseId }
        : { screen: 'review', courseId, holeNumber, mode };
    case 'complete':
      return holeNumber === null
        ? { screen: 'board', courseId }
        : { screen: 'complete', courseId, holeNumber };
  }
}
