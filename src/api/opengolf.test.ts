import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, getCourse, searchCourses } from './opengolf';

/** A US-coordinate search record with everything populated. */
function usSearchRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc',
    name: 'Pebble Beach Golf Links',
    course_name: 'Pebble Beach Golf Links',
    latitude: 36.5685,
    longitude: -121.949,
    city: 'Pebble Beach',
    state: 'California',
    type: 'Resort/Public',
    par: 72,
    phone: '+1 831-622-8723',
    website: 'https://www.pebblebeach.com',
    ...overrides,
  };
}

const ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI — https://opengolfapi.org/attribution';

function searchBody(courses: unknown[]) {
  return {
    courses,
    total: courses.length,
    _license: 'ODbL-1.0',
    _attribution: ATTRIBUTION,
  };
}

/** A minimal `Response` stand-in — only what the client actually reads. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const detailBody = {
  id: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc',
  course_name: 'Pebble Beach Golf Links',
  club_name: 'Pebble Beach Resorts',
  city: 'Pebble Beach',
  state: 'California',
  lat: 36.5685,
  lng: -121.949,
  par: 72,
  holes: 18,
  yardage: 6802,
  tees: [
    {
      tee_key: 'blue-male',
      tee_name: 'Blue',
      tee_color: 'blue',
      gender: 'Male',
      course_rating: 74.9,
      slope: 144,
      par: 72,
      yardage: 6802,
    },
  ],
  holes_data: [
    {
      number: 1,
      par: 4,
      handicap_index: 6,
      yardages: { red: 310, web: 378, blue: 378, gold: 349, green: 328, white: 337 },
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchCourses', () => {
  it('calls the /v1 search endpoint with q and limit, and no per_page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchBody([usSearchRecord()])));

    await searchCourses('pebble');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${API_BASE}/v1/courses/search`);
    expect(url.searchParams.get('q')).toBe('pebble');
    expect(url.searchParams.get('limit')).toBeTruthy();
    expect(url.searchParams.has('per_page')).toBe(false);
  });

  it('maps a well-formed response into typed records, preserving name, city, and state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchBody([usSearchRecord()])));

    const result = await searchCourses('pebble');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc',
      name: 'Pebble Beach Golf Links',
      city: 'Pebble Beach',
      state: 'California',
      latitude: 36.5685,
      longitude: -121.949,
      par: 72,
    });
  });

  it('leaves null city, state, and par absent rather than the string "null"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(searchBody([usSearchRecord({ city: null, state: null, par: null })])),
    );

    const result = await searchCourses('pebble');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const record = result.data[0];
    expect(record.city).toBeUndefined();
    expect(record.state).toBeUndefined();
    expect(record.par).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('null');
  });

  it('returns the empty variant when every result is outside the US', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchBody([
          usSearchRecord({ id: 'dubai', name: 'Emirates Golf Club', latitude: 25.05, longitude: 55.16 }),
          usSearchRecord({ id: 'orkney', name: 'Orkney Golf Club', latitude: 58.98, longitude: -2.96 }),
          usSearchRecord({ id: 'ar', name: 'Golf Club Argentino', latitude: -34.6, longitude: -58.4 }),
        ]),
      ),
    );

    const result = await searchCourses('golf');

    expect(result.status).toBe('empty');
  });

  it('keeps courses inside the Alaska and Hawaii boxes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchBody([
          usSearchRecord({ id: 'ak', name: 'Anchorage Golf Course', latitude: 61.11, longitude: -149.79 }),
          usSearchRecord({ id: 'hi', name: 'Waialae Country Club', latitude: 21.27, longitude: -157.79 }),
          usSearchRecord({ id: 'dubai', name: 'Emirates Golf Club', latitude: 25.05, longitude: 55.16 }),
        ]),
      ),
    );

    const result = await searchCourses('golf');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.map((c) => c.id)).toEqual(['ak', 'hi']);
  });

  it('surfaces the ODbL attribution string on the result', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchBody([usSearchRecord()])));

    const result = await searchCourses('pebble');

    expect(result.attribution).toBe(ATTRIBUTION);
  });

  it('resolves a non-2xx response to the request-failed variant', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    const result = await searchCourses('pebble');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('http');
    expect(result.statusCode).toBe(503);
  });

  it('resolves a network rejection to the request-failed variant', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await searchCourses('pebble');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('network');
  });

  it('resolves an aborted request to the aborted variant without throwing', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const result = await searchCourses('pebble', controller.signal);

    expect(result.status).toBe('aborted');
  });

  it('passes the abort signal through to fetch', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(jsonResponse(searchBody([usSearchRecord()])));

    await searchCourses('pebble', controller.signal);

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('returns empty for a blank query without issuing a request', async () => {
    const result = await searchCourses('   ');

    expect(result.status).toBe('empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getCourse', () => {
  it('calls the /api/v1 detail endpoint, not the /v1 one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody));

    await getCourse('40977ee8-33ee-4195-b6a2-99a4ca83c2bc');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      `${API_BASE}/api/v1/courses/40977ee8-33ee-4195-b6a2-99a4ca83c2bc`,
    );
  });

  it('reads holes_data yardages and handicap_index, which the /v1 shape does not carry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody));

    const result = await getCourse('40977ee8-33ee-4195-b6a2-99a4ca83c2bc');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const hole = result.data.holes_data[0];
    expect(hole.handicap_index).toBe(6);
    expect(hole.yardages.blue).toBe(378);
    expect(result.data.tees[0].tee_key).toBe('blue-male');
  });

  it('normalizes lat/lng to latitude/longitude', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody));

    const result = await getCourse('40977ee8-33ee-4195-b6a2-99a4ca83c2bc');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.latitude).toBe(36.5685);
    expect(result.data.longitude).toBe(-121.949);
    expect('lat' in result.data).toBe(false);
    expect('lng' in result.data).toBe(false);
  });

  it('leaves null city, state, and par absent on a detail record', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...detailBody, city: null, state: null, par: null }),
    );

    const result = await getCourse('x');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.city).toBeUndefined();
    expect(result.data.state).toBeUndefined();
    expect(result.data.par).toBeUndefined();
  });

  it('tolerates a record with no tees or holes_data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'x', course_name: 'Nine Holer', lat: 40, lng: -100, holes: 9 }),
    );

    const result = await getCourse('x');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.tees).toEqual([]);
    expect(result.data.holes_data).toEqual([]);
  });

  it('resolves a non-2xx response to the request-failed variant', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404));

    const result = await getCourse('missing');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('http');
    expect(result.statusCode).toBe(404);
  });

  it('resolves a network rejection to the request-failed variant', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await getCourse('x');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('network');
  });

  it('resolves an aborted detail request to the aborted variant', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const result = await getCourse('x', controller.signal);

    expect(result.status).toBe('aborted');
  });

  it('resolves malformed JSON to the request-failed variant', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    const result = await getCourse('x');

    expect(result.status).toBe('failed');
  });
});
