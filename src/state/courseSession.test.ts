import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { BoardScreen } from '../screens/BoardScreen';
import { SEARCH_DEBOUNCE_MS } from '../screens/SearchScreen';
import type { CourseDetail } from '../api/types';
import {
  buildCourseSession,
  defaultTeeAssign,
  holeYardage,
  scorecardFor,
} from './courseSession';
import { INITIAL, computeDerived } from './useMapper';

/**
 * The session is the only place the app learns a course's card, so these tests
 * drive it from record shapes the API actually returns: gendered `tee_key`s, a
 * stray `web` yardage column, and records with no `holes_data` at all.
 */

/** Yardages as the API sends them — bare colors, plus the `web` column no tee claims. */
function holeRow(
  number: number,
  par: number,
  handicap_index: number,
  yardages: Record<string, number>,
) {
  return { number, par, handicap_index, yardages };
}

const PEBBLE_HOLES = [
  holeRow(1, 4, 6, { red: 310, web: 378, blue: 378, gold: 349, white: 337 }),
  holeRow(2, 5, 10, { red: 420, web: 502, blue: 502, gold: 480, white: 457 }),
  holeRow(3, 4, 2, { red: 325, web: 390, blue: 390, gold: 363, white: 349 }),
];

function detailFixture(overrides: Partial<CourseDetail> = {}): CourseDetail {
  return {
    id: 'course-1',
    course_name: 'Pebble Beach Golf Links',
    city: 'Pebble Beach',
    state: 'California',
    latitude: 36.5685,
    longitude: -121.949,
    par: 72,
    yardage: 6802,
    holes: 18,
    tees: [
      { tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', gender: 'Male', yardage: 6802 },
      { tee_key: 'blue-female', tee_name: 'Blue', tee_color: 'blue', gender: 'Female', yardage: 6802 },
      { tee_key: 'gold-male', tee_name: 'Gold', tee_color: 'gold', gender: 'Male', yardage: 6116 },
      { tee_key: 'gold-female', tee_name: 'Gold', tee_color: 'gold', gender: 'Female', yardage: 6116 },
      { tee_key: 'white-male', tee_name: 'White', tee_color: 'white', gender: 'Male', yardage: 5720 },
      { tee_key: 'red-female', tee_name: 'Red', tee_color: 'red', gender: 'Female', yardage: 5197 },
      /* No hole carries a "black" column, so this set has nothing to show per hole. */
      { tee_key: 'black-male', tee_name: 'Black', tee_color: 'black', gender: 'Male', yardage: 7040 },
    ],
    holes_data: PEBBLE_HOLES,
    ...overrides,
  };
}

/** A different course, for the two-courses-two-scorecards check. */
function otherDetail(): CourseDetail {
  return {
    id: 'course-2',
    course_name: 'Bethpage Black',
    latitude: 40.744,
    longitude: -73.457,
    par: 71,
    yardage: 7468,
    holes: 18,
    tees: [{ tee_key: 'black-male', tee_name: 'Black', tee_color: 'black', yardage: 7468 }],
    holes_data: [
      holeRow(1, 4, 5, { black: 430 }),
      holeRow(2, 4, 9, { black: 389 }),
      holeRow(3, 3, 15, { black: 205 }),
    ],
  };
}

describe('buildCourseSession', () => {
  it('drives par and handicap index per hole from the loaded record', () => {
    const session = buildCourseSession(detailFixture());

    expect(session.name).toBe('Pebble Beach Golf Links');
    expect(session.holes.map((h) => h.par)).toEqual([4, 5, 4]);
    expect(session.holes.map((h) => h.handicapIndex)).toEqual([6, 10, 2]);
    expect(session.cardAvailable).toBe(true);
  });

  it('sorts holes by number even when the record arrives out of order', () => {
    const session = buildCourseSession(
      detailFixture({ holes_data: [PEBBLE_HOLES[2], PEBBLE_HOLES[0], PEBBLE_HOLES[1]] }),
    );

    expect(session.holes.map((h) => h.number)).toEqual([1, 2, 3]);
    expect(session.holes.map((h) => h.par)).toEqual([4, 5, 4]);
  });

  it('keeps one tee row per color rather than one per gendered key', () => {
    const session = buildCourseSession(detailFixture());

    expect(session.tees.map((t) => t.color)).toEqual(['blue', 'gold', 'white', 'red']);
    expect(session.tees.map((t) => t.name)).toEqual(['Blue', 'Gold', 'White', 'Red']);
  });

  it('drops tee colors with no yardage entry, and yardage columns with no tee', () => {
    const session = buildCourseSession(detailFixture());
    const colors = session.tees.map((t) => t.color);

    expect(colors).not.toContain('black');
    expect(colors).not.toContain('web');
  });

  it('opens a course with no holes_data without throwing and marks the card unavailable', () => {
    const session = buildCourseSession(detailFixture({ holes_data: [], holes: 18 }));

    expect(session.cardAvailable).toBe(false);
    expect(session.holes).toHaveLength(18);
    expect(session.holes[0].par).toBeNull();
    expect(holeYardage(session, 0)).toBeNull();
    expect(scorecardFor(session, 0)).toEqual([]);
  });

  it('reports the hole count a nine-hole record carries', () => {
    const session = buildCourseSession(
      detailFixture({
        holes: 9,
        holes_data: Array.from({ length: 9 }, (_, i) =>
          holeRow(i + 1, 4, i + 1, { blue: 300 + i, gold: 280 + i, white: 260 + i, red: 240 + i }),
        ),
      }),
    );

    expect(session.holes).toHaveLength(9);
    expect(session.meta).toContain('9 holes');
  });
});

describe('scorecardFor', () => {
  it('reads each tee from the hole’s own yardages map, not a scaled ratio', () => {
    const session = buildCourseSession(detailFixture());
    const hole2 = scorecardFor(session, 1);

    /* The old scaling hack derived Gold from hole 1's 349/378 ratio: 463, not 480. */
    expect(hole2.map((row) => [row.name, row.yd])).toEqual([
      ['Blue', 502],
      ['Gold', 480],
      ['White', 457],
      ['Red', 420],
    ]);
  });

  it('takes the hole yardage from the longest tee the record carries', () => {
    const session = buildCourseSession(detailFixture());

    expect(holeYardage(session, 0)).toBe(378);
    expect(holeYardage(session, 2)).toBe(390);
  });

  it('gives two different courses two different scorecards', () => {
    const pebble = buildCourseSession(detailFixture());
    const bethpage = buildCourseSession(otherDetail());

    expect(scorecardFor(pebble, 0)).not.toEqual(scorecardFor(bethpage, 0));
    expect(holeYardage(bethpage, 0)).toBe(430);
    expect(bethpage.holes[2].par).toBe(3);
  });
});

describe('defaultTeeAssign', () => {
  it('names the four review tee slots from the course’s own tee sets', () => {
    const session = buildCourseSession(detailFixture());

    expect(defaultTeeAssign(session)).toEqual({
      tee1: 'Blue',
      tee2: 'Gold',
      tee3: 'White',
      tee4: 'Red',
    });
  });

  it('repeats the last set when a course carries fewer than four tees', () => {
    const session = buildCourseSession(otherDetail());

    expect(defaultTeeAssign(session)).toEqual({
      tee1: 'Black',
      tee2: 'Black',
      tee3: 'Black',
      tee4: 'Black',
    });
  });
});

describe('computeDerived with a loaded course', () => {
  it('reads the card from the session rather than a fixture constant', () => {
    const session = buildCourseSession(detailFixture());
    const derived = computeDerived({ ...INITIAL, course: session, holeIndex: 1 });

    expect(derived.cardYds).toBe(502);
    expect(derived.holePar).toBe(5);
    expect(derived.holeHandicapIndex).toBe(10);
    expect(derived.scorecard.map((row) => row.yd)).toEqual([502, 480, 457, 420]);
  });

  it('reports no card when the record carried no holes_data', () => {
    const session = buildCourseSession(detailFixture({ holes_data: [] }));
    const derived = computeDerived({ ...INITIAL, course: session, holeIndex: 0 });

    expect(derived.cardYds).toBeNull();
    expect(derived.holePar).toBeNull();
    expect(derived.scorecard).toEqual([]);
  });
});

describe('BoardScreen with a loaded course', () => {
  it('renders one tile per hole a nine-hole course carries, not eighteen', () => {
    const session = buildCourseSession(
      detailFixture({
        course_name: 'Nine Hole Muni',
        holes: 9,
        holes_data: Array.from({ length: 9 }, (_, i) =>
          holeRow(i + 1, 4, i + 1, { blue: 300 + i, gold: 280 + i, white: 260 + i, red: 240 + i }),
        ),
      }),
    );

    render(
      createElement(BoardScreen, {
        course: session,
        holeStatus: session.holes.map(() => 'unmapped' as const),
        doneCount: 0,
        onOpenHole: () => {},
        onBack: () => {},
      }),
    );

    expect(screen.getAllByRole('button', { name: /par 4/ })).toHaveLength(9);
    expect(screen.getByText(/of 9 holes on the map/)).toBeDefined();
    expect(screen.getByText('Nine Hole Muni')).toBeDefined();
  });

  it('states that the card is unavailable when the record carried no holes_data', () => {
    const session = buildCourseSession(detailFixture({ holes_data: [], holes: 18 }));

    render(
      createElement(BoardScreen, {
        course: session,
        holeStatus: session.holes.map(() => 'unmapped' as const),
        doneCount: 0,
        onOpenHole: () => {},
        onBack: () => {},
      }),
    );

    expect(screen.getByText(/scorecard.*not in this course/i)).toBeDefined();
  });
});

/* --- The course-open transition, driven through the real API client. --- */

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function settle(ms = SEARCH_DEBOUNCE_MS + 20) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Search resolves; whether detail resolves is what each test varies. */
function routeFetch(detail: () => Promise<Response>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/courses/search')) {
      return jsonResponse({
        courses: [
          {
            id: 'course-1',
            name: 'Pebble Beach Golf Links',
            latitude: 36.5685,
            longitude: -121.949,
          },
        ],
      });
    }
    return detail();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('opening a course from search', () => {
  it('leaves the contributor on search with a stated failure when detail fetch fails', async () => {
    fetchMock = routeFetch(async () => {
      throw new Error('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(App));
    fireEvent.change(screen.getByPlaceholderText(/course name/i), {
      target: { value: 'pebble' },
    });
    await settle();

    fireEvent.click(screen.getByText('Pebble Beach Golf Links'));
    await settle(0);

    expect(screen.getByRole('status').textContent).toMatch(/Failed to fetch/);
    /* Still on search: the input is there and no board header replaced it. */
    expect(screen.getByPlaceholderText(/course name/i)).toBeDefined();
    expect(screen.queryByText(/holes on the map/)).toBeNull();
  });

  it('states that it is opening the course while the detail fetch runs', async () => {
    fetchMock = routeFetch(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(App));
    fireEvent.change(screen.getByPlaceholderText(/course name/i), {
      target: { value: 'pebble' },
    });
    await settle();

    fireEvent.click(screen.getByText('Pebble Beach Golf Links'));
    await settle(0);

    expect(screen.getByRole('status').textContent).toMatch(/opening/i);
    expect(screen.queryByText(/holes on the map/)).toBeNull();
  });

  it('opens the board on the loaded course once detail resolves', async () => {
    fetchMock = routeFetch(async () => jsonResponse(detailFixture()));
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(App));
    fireEvent.change(screen.getByPlaceholderText(/course name/i), {
      target: { value: 'pebble' },
    });
    await settle();

    fireEvent.click(screen.getByText('Pebble Beach Golf Links'));
    await settle(0);

    expect(screen.getByText('Pebble Beach Golf Links')).toBeDefined();
    expect(screen.getByText(/of 3 holes on the map/)).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
