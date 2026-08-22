/**
 * @vitest-environment jsdom
 *
 * Every screen has an address, and the browser's own back button is the reason.
 * These tests drive the real App with stubbed network so the assertions are
 * about `window.location` and history, not about a router in isolation.
 *
 * MapLibre needs a WebGL context jsdom has not got, so it is replaced.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { SEARCH_DEBOUNCE_MS } from './screens/SearchScreen';
import { clearOsmCache } from './api/overpass';

vi.mock('maplibre-gl', () => {
  class FakeMap {
    on() { return this; }
    once(_t: string, handler: () => void) { handler(); return this; }
    off() { return this; }
    remove() {}
    fitBounds() {}
    isStyleLoaded() { return true; }
    addSource() {}
    addLayer() {}
    removeLayer() {}
    removeSource() {}
    getSource() { return undefined; }
    getLayer() { return undefined; }
    setLayoutProperty() {}
    getCanvas() { return { style: {} }; }
    project() { return { x: 0, y: 0 }; }
    unproject() { return { lng: 0, lat: 0 }; }
  }
  return { default: { Map: FakeMap }, Map: FakeMap };
});

const COURSE_ID = 'course-1';
const COURSE_NAME = 'Pebble Beach Golf Links';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Three holes is enough to tell hole 1 from hole 2 in an address. */
function detailFixture() {
  return {
    id: COURSE_ID,
    course_name: COURSE_NAME,
    lat: 36.5685,
    lng: -121.949,
    tees: [{ tee_key: 'blue-male', tee_name: 'Blue', par: 72, yardage: 6800 }],
    holes_data: [1, 2, 3].map((number) => ({
      number,
      par: 4,
      handicap_index: number,
      yardages: { blue: 380 + number },
    })),
  };
}

function stubNetwork() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/courses/search')) {
        return jsonResponse({
          courses: [{ id: COURSE_ID, name: COURSE_NAME, latitude: 36.5685, longitude: -121.949 }],
        });
      }
      /* No boundary and no holes: the course opens straight onto the board. */
      if (url.includes('overpass')) return jsonResponse({ elements: [] });
      return jsonResponse(detailFixture());
    }),
  );
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/*
 * jsdom traverses history on a queued task, not synchronously, so `back()` needs
 * a real wait before the address has moved -- a single tick is not enough. Wait
 * for the popstate the app listens for, then let React apply it.
 */
async function goBack() {
  await act(async () => {
    const landed = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
    });
    window.history.back();
    await landed;
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function openTheCourse() {
  render(<App />);
  fireEvent.change(screen.getByPlaceholderText(/course name/i), { target: { value: 'pebble' } });
  await act(async () => { await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 20)); });
  fireEvent.click(screen.getByText(COURSE_NAME));
  await settle();
}

const path = () => window.location.pathname;

beforeEach(() => {
  clearOsmCache();
  stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the address follows the screen', () => {
  it('starts at the root and names the course once one is open', async () => {
    expect(path()).toBe('/');
    await openTheCourse();
    expect(path()).toBe(`/c/${COURSE_ID}`);
  });

  it('names the hole by its number, not its index', async () => {
    await openTheCourse();
    fireEvent.click(screen.getByText('2'));
    await settle();
    /*
     * The second hole is index 1 and number 2 -- the address carries the number.
     * `/locate` is on the end because OpenStreetMap holds nothing for this hole,
     * so it opens on the draw-the-line step. The address says which step, which
     * is the point: back out of drawing and you land on the board, not nowhere.
     */
    expect(path()).toBe(`/c/${COURSE_ID}/hole/2/locate`);
  });

  it('leaves the address alone when nothing moved', async () => {
    await openTheCourse();
    const before = window.history.length;
    await settle();
    expect(window.history.length).toBe(before);
  });
});

describe('the back button', () => {
  it('returns to the board from a hole', async () => {
    await openTheCourse();
    expect(path()).toBe(`/c/${COURSE_ID}`);

    fireEvent.click(screen.getByText('2'));
    await settle();
    expect(path()).toBe(`/c/${COURSE_ID}/hole/2/locate`);

    await goBack();

    expect(path()).toBe(`/c/${COURSE_ID}`);
    /* Back is a real navigation, not just a URL change: the board is showing. */
    expect(document.body.textContent).toContain(COURSE_NAME);
  });

  it('walks back through several holes in order', async () => {
    await openTheCourse();
    fireEvent.click(screen.getByText('1'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'holes' }));
    await settle();
    fireEvent.click(screen.getByText('3'));
    await settle();
    expect(path()).toBe(`/c/${COURSE_ID}/hole/3/locate`);

    await goBack();
    expect(path()).toBe(`/c/${COURSE_ID}`);

    await goBack();
    expect(path()).toBe(`/c/${COURSE_ID}/hole/1/locate`);
  });
});

describe('a pasted link', () => {
  it('opens the course and the hole it names', async () => {
    window.history.replaceState(null, '', `/c/${COURSE_ID}/hole/3`);
    render(<App />);
    /* Two awaited stages: the course record, then the OpenStreetMap lookup. */
    await settle();
    await settle();

    /* The fixture's course has no OpenStreetMap data, so every hole opens on
       the draw-the-line step and the address corrects itself to say so. */
    expect(path()).toBe(`/c/${COURSE_ID}/hole/3/locate`);
    expect(document.body.textContent).toContain('Hole 3');
  });

  it('asks for a line when the hole it names has none', async () => {
    /*
     * Hole 1 is the case that breaks quietly: it resolves to index 0, which is
     * also where holeIndex starts, so a guard that only opens the hole when the
     * index changes never opens it at all -- leaving the review screen in its
     * default mode with no line and nothing asking for one.
     */
    window.history.replaceState(null, '', `/c/${COURSE_ID}/hole/1`);
    render(<App />);
    await settle();
    await settle();

    expect(document.body.textContent).toContain('Show us where this hole plays.');
    /* And the address says so, so backing out of drawing goes somewhere real. */
    expect(path()).toBe(`/c/${COURSE_ID}/hole/1/locate`);
  });

  it('correcting the address does not trap the back button', async () => {
    window.history.replaceState(null, '', `/c/${COURSE_ID}/hole/1`);
    render(<App />);
    await settle();
    await settle();
    expect(path()).toBe(`/c/${COURSE_ID}/hole/1/locate`);

    /* The correction replaced the entry it came from rather than stacking on
       it, so one press leaves the hole instead of bouncing back to it. */
    await goBack();
    expect(path()).not.toBe(`/c/${COURSE_ID}/hole/1/locate`);
  });

  it('keeps the address while the course it names is still loading', async () => {
    /*
     * The bug this pins: while the course loads there is no course, so the app's
     * own route is the search screen -- and writing that over the address
     * replaced the link with `/` before it ever resolved. The destination was
     * gone from the bar, and a refresh could not get it back.
     */
    let releaseDetail: (() => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('overpass')) return jsonResponse({ elements: [] });
        /* Hold the course record open so the loading window is observable. */
        await new Promise<void>((resolve) => { releaseDetail = resolve; });
        return jsonResponse(detailFixture());
      }),
    );

    window.history.replaceState(null, '', `/c/${COURSE_ID}/hole/2`);
    render(<App />);
    await settle();

    /* Still loading, and the address still names where we are going. */
    expect(path()).toBe(`/c/${COURSE_ID}/hole/2`);

    await act(async () => { releaseDetail?.(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();

    expect(path()).toBe(`/c/${COURSE_ID}/hole/2/locate`);
    expect(document.body.textContent).toContain('Show us where this hole plays.');
  });

  it('releases the address when the course it names cannot be opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('overpass')) return jsonResponse({ elements: [] });
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }),
    );

    window.history.replaceState(null, '', `/c/${COURSE_ID}/hole/2`);
    render(<App />);
    await settle();
    await settle();

    /* The link stays put so a refresh retries it, and the failure is stated. */
    expect(path()).toBe(`/c/${COURSE_ID}/hole/2`);
    expect(document.body.textContent).toContain('Could not open that course');
  });

  it('falls back to search when the address is unreadable', async () => {
    window.history.replaceState(null, '', '/c/course-1/hole/nonsense');
    render(<App />);
    await settle();

    expect(screen.getByPlaceholderText(/course name/i)).toBeDefined();
  });
});
