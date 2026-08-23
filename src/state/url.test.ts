import { describe, expect, it } from 'vitest';
import { HOME, parsePath, routeFor, routeToPath, type Route } from './url';

/**
 * The address bar is the one piece of app state a contributor can edit by hand,
 * so these tests care about two things: that every route survives a round trip
 * through a path, and that a path we did not mint resolves to something safe
 * rather than throwing.
 */

const COURSE = 'opengolf-1234';

const ROUTES: Route[] = [
  { screen: 'search' },
  { screen: 'board', courseId: COURSE },
  { screen: 'boundary', courseId: COURSE },
  { screen: 'review', courseId: COURSE, holeNumber: 7, mode: 'ready' },
  { screen: 'review', courseId: COURSE, holeNumber: 1, mode: 'locate' },
  { screen: 'review', courseId: COURSE, holeNumber: 18, mode: 'attention' },
  { screen: 'complete', courseId: COURSE, holeNumber: 12 },
];

describe('routes round-trip through a path', () => {
  it.each(ROUTES)('$screen', (route) => {
    expect(parsePath(routeToPath(route))).toEqual(route);
  });

  it('mints the paths a person would expect to read', () => {
    expect(routeToPath({ screen: 'search' })).toBe('/');
    expect(routeToPath({ screen: 'board', courseId: COURSE })).toBe('/c/opengolf-1234');
    expect(routeToPath({ screen: 'boundary', courseId: COURSE })).toBe('/c/opengolf-1234/boundary');
    expect(routeToPath({ screen: 'review', courseId: COURSE, holeNumber: 7, mode: 'ready' })).toBe(
      '/c/opengolf-1234/hole/7',
    );
    expect(routeToPath({ screen: 'review', courseId: COURSE, holeNumber: 7, mode: 'locate' })).toBe(
      '/c/opengolf-1234/hole/7/locate',
    );
    expect(routeToPath({ screen: 'complete', courseId: COURSE, holeNumber: 7 })).toBe(
      '/c/opengolf-1234/hole/7/done',
    );
  });

  it('survives a course id that needs escaping', () => {
    const awkward = 'pebble beach/links?v=2';
    const path = routeToPath({ screen: 'board', courseId: awkward });
    expect(path).not.toContain(' ');
    /* The id must not be able to invent extra path segments. */
    expect(path.split('/').filter(Boolean)).toHaveLength(2);
    expect(parsePath(path)).toEqual({ screen: 'board', courseId: awkward });
  });
});

describe('an address we did not mint resolves to search, never a throw', () => {
  it.each([
    ['', 'empty'],
    ['/', 'root'],
    ['/nonsense', 'unknown first segment'],
    ['/c', 'course prefix with no id'],
    ['/c/', 'course prefix with an empty id'],
    ['/c/abc/hole', 'hole with no number'],
    ['/c/abc/hole/0', 'hole zero'],
    ['/c/abc/hole/-3', 'negative hole'],
    ['/c/abc/hole/4.5', 'fractional hole'],
    ['/c/abc/hole/seven', 'hole that is not a number'],
    ['/c/abc/hole/7/sideways', 'unknown mode segment'],
    ['/c/abc/hole/7/locate/extra', 'trailing junk'],
    ['/c/abc/elsewhere', 'unknown course sub-screen'],
    ['/c/%E0%A4%A/hole/1', 'malformed percent-escape'],
  ])('%s (%s)', (path) => {
    expect(parsePath(path)).toEqual(HOME);
  });

  it('tolerates a trailing slash and a doubled separator', () => {
    expect(parsePath('/c/abc/')).toEqual({ screen: 'board', courseId: 'abc' });
    expect(parsePath('//c//abc//hole//7')).toEqual({
      screen: 'review',
      courseId: 'abc',
      holeNumber: 7,
      mode: 'ready',
    });
  });
});

describe('routeFor maps app state onto an address', () => {
  it('is the search screen until a course is loaded', () => {
    /* Every other screen reads the course, so no course means no address for one. */
    for (const screen of ['search', 'boundary', 'board', 'review', 'complete'] as const) {
      expect(routeFor({ screen, mode: 'ready', courseId: null, holeNumber: 7 })).toEqual(HOME);
    }
  });

  it('carries the review mode', () => {
    expect(
      routeFor({ screen: 'review', mode: 'locate', courseId: COURSE, holeNumber: 3 }),
    ).toEqual({ screen: 'review', courseId: COURSE, holeNumber: 3, mode: 'locate' });
  });

  it('falls back to the board when a hole screen has no hole resolved', () => {
    expect(routeFor({ screen: 'review', mode: 'ready', courseId: COURSE, holeNumber: null })).toEqual({
      screen: 'board',
      courseId: COURSE,
    });
    expect(routeFor({ screen: 'complete', mode: 'ready', courseId: COURSE, holeNumber: null })).toEqual({
      screen: 'board',
      courseId: COURSE,
    });
  });

  it('keeps the course when the contributor goes back to search', () => {
    /* Search with a course still loaded is a real state -- the nav offers it. */
    expect(routeFor({ screen: 'search', mode: 'ready', courseId: COURSE, holeNumber: 7 })).toEqual(HOME);
  });
});
