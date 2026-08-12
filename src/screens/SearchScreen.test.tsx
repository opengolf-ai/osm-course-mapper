import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS, SearchScreen } from './SearchScreen';

/**
 * The screen owns a debounce and an abort, so every test drives fake timers and a
 * stubbed `fetch` — the real client runs underneath, which keeps the US filter and
 * the result-shape tolerance in the loop rather than mocked away.
 */

/** The parent owns the query in the app, so the harness owns it here. */
function Harness({ onOpen = () => {} }: { onOpen?: (courseId: string) => void }) {
  const [query, setQuery] = useState('');
  return <SearchScreen query={query} onQuery={setQuery} onOpen={onOpen} />;
}

function usRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'course-1',
    name: 'Pebble Beach Golf Links',
    latitude: 36.5685,
    longitude: -121.949,
    city: 'Pebble Beach',
    state: 'California',
    ...overrides,
  };
}

function searchBody(courses: unknown[]) {
  return { courses, total: courses.length, _license: 'ODbL-1.0' };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/course name/i), { target: { value } });
}

/** Advance past the debounce and drain the client's awaits before asserting. */
async function settle(ms = SEARCH_DEBOUNCE_MS + 20) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => jsonResponse(searchBody([usRecord()])));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SearchScreen states', () => {
  it('renders the idle state with no rows before anything is typed', () => {
    render(<Harness />);

    expect(screen.getByText(/type a course name/i)).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the loading state while the request is in flight', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    render(<Harness />);

    typeQuery('pebble');
    await settle();

    expect(screen.getByText(/searching/i)).toBeDefined();
    expect(screen.queryByText(/no united states courses/i)).toBeNull();
  });

  it('renders the no-matches state for an empty result set, distinct from loading', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(searchBody([])));
    render(<Harness />);

    typeQuery('qqqqzzz');
    await settle();

    expect(screen.getByText(/no united states courses/i)).toBeDefined();
    expect(screen.queryByText(/^searching/i)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders the failure state and no list when the request fails', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('Failed to fetch');
    });
    render(<Harness />);

    typeQuery('pebble');
    await settle();

    expect(screen.getByText(/could not reach/i)).toBeDefined();
    expect(screen.queryByText(/no united states courses/i)).toBeNull();
    expect(screen.queryByText(/^searching/i)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('SearchScreen requests', () => {
  it('issues one request after the debounce interval rather than one per keystroke', async () => {
    render(<Harness />);

    typeQuery('p');
    typeQuery('pe');
    typeQuery('peb');
    expect(fetchMock).not.toHaveBeenCalled();

    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('q=peb');
  });

  it('aborts the in-flight request when the next keystroke arrives', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    render(<Harness />);

    typeQuery('peb');
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    typeQuery('pebb');

    expect(signals[0].aborted).toBe(true);
  });
});

describe('SearchScreen results', () => {
  it('distinguishes two results that share a name and have no city or state', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        searchBody([
          usRecord({ id: 'a', city: null, state: null }),
          usRecord({
            id: 'b',
            city: null,
            state: null,
            latitude: 36.5701,
            longitude: -121.9404,
          }),
        ]),
      ),
    );
    render(<Harness />);

    typeQuery('pebble');
    await settle();

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('36.569, -121.949')).toBeDefined();
    expect(screen.getByText('36.570, -121.940')).toBeDefined();
    for (const row of rows) {
      expect(row.textContent).not.toContain('null');
      expect(row.textContent).not.toContain('undefined');
    }
  });

  it('renders city and state when the record carries them', async () => {
    render(<Harness />);

    typeQuery('pebble');
    await settle();

    expect(screen.getByText('Pebble Beach · California')).toBeDefined();
  });

  it('invokes the open handler with the selected course id', async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    typeQuery('pebble');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Pebble Beach Golf Links/ }));

    expect(onOpen).toHaveBeenCalledWith('course-1');
  });
});
