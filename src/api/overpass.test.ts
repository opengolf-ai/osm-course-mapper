import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CENTROID_CEILING_METRES,
  NAME_MATCH_THRESHOLD,
  OVERPASS_ENDPOINT,
  OVERPASS_RETRY_BACKOFF_MS,
  OVERPASS_TIMEOUT_MS,
  clearOsmCache,
  courseNameSimilarity,
  lookupOsmCourse,
  overpassBbox,
  overpassQuery,
} from './overpass';

/**
 * Overpass is answered from fixtures shaped like the real service: `out geom`
 * puts full member geometry on a relation, and the Pebble Beach bbox genuinely
 * returns seven golf courses, two of them relations. Nothing here talks to the
 * network.
 */

const PEBBLE = {
  id: 'course-1',
  name: 'Pebble Beach Golf Links',
  latitude: 36.5685,
  longitude: -121.949,
};

/* The square standing in for Pebble Beach's multipolygon boundary. */
const WEST = -121.955;
const EAST = -121.943;
const SOUTH = 36.563;
const NORTH = 36.574;

/** A relation whose outer ring arrives as two unordered ways, as OSM stores it. */
function pebbleRelation() {
  return {
    type: 'relation',
    id: 3741806,
    tags: { type: 'multipolygon', leisure: 'golf_course', name: 'Pebble Beach Golf Course' },
    members: [
      {
        type: 'way',
        ref: 900002,
        role: 'outer',
        geometry: [
          { lat: NORTH, lon: EAST },
          { lat: NORTH, lon: WEST },
          { lat: SOUTH, lon: WEST },
        ],
      },
      {
        type: 'way',
        ref: 900001,
        role: 'outer',
        geometry: [
          { lat: SOUTH, lon: WEST },
          { lat: SOUTH, lon: EAST },
          { lat: NORTH, lon: EAST },
        ],
      },
    ],
  };
}

/** A neighbouring course mapped as a plain closed way, well clear of Pebble Beach. */
function neighbourWay(id: number, name: string, west: number, south: number, size = 0.004) {
  const east = west + size;
  const north = south + size;
  return {
    type: 'way',
    id,
    tags: { leisure: 'golf_course', name },
    geometry: [
      { lat: south, lon: west },
      { lat: south, lon: east },
      { lat: north, lon: east },
      { lat: north, lon: west },
      { lat: south, lon: west },
    ],
  };
}

const CYPRESS = () => neighbourWay(36435651, 'Cypress Point Club', -121.975, 36.585);
const SPYGLASS = () => neighbourWay(281477606, 'Spyglass Hill Golf Course', -121.962, 36.578);

/** One `golf=hole` way, a short line at the given point. */
function holeWay(id: number, ref: number, lat: number, lon: number) {
  return {
    type: 'way',
    id,
    tags: { golf: 'hole', ref: String(ref), par: '4' },
    geometry: [
      { lat, lon },
      { lat: lat + 0.0004, lon: lon + 0.0004 },
    ],
  };
}

/** Refs 1–18 inside the adopted boundary, plus a nineteenth that is not. */
function holes() {
  const inside = Array.from({ length: 18 }, (_, i) =>
    holeWay(800000 + i, i + 1, 36.5665 + i * 0.0002, -121.951 + i * 0.0002),
  );
  return [...inside, holeWay(800099, 19, 36.5865, -121.9735)];
}

function landmarks() {
  return [
    {
      type: 'way',
      id: 700001,
      tags: { golf: 'clubhouse', building: 'yes', name: 'Pebble Beach Clubhouse' },
      geometry: [
        { lat: 36.5688, lon: -121.9494 },
        { lat: 36.569, lon: -121.9492 },
      ],
    },
    {
      type: 'node',
      id: 700002,
      lat: 36.5701,
      lon: -121.9502,
      tags: { golf: 'driving_range', name: 'Peter Hay Practice Range' },
    },
    /* Outside the adopted line: it belongs to the neighbour, not this course. */
    {
      type: 'node',
      id: 700003,
      lat: 36.5865,
      lon: -121.9735,
      tags: { building: 'clubhouse', name: 'Cypress Point Clubhouse' },
    },
  ];
}

function overpassBody(elements: unknown[]) {
  return { version: 0.6, generator: 'Overpass API', elements };
}

function overpassResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === null) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

function respondWith(elements: unknown[]) {
  return vi.fn(async () => overpassResponse(overpassBody(elements)));
}

beforeEach(() => {
  clearOsmCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Overpass request', () => {
  it('asks for courses and holes as nodes, ways and relations, with geometry', () => {
    const query = overpassQuery(overpassBbox(PEBBLE.latitude, PEBBLE.longitude));

    expect(query).toContain('nwr["leisure"="golf_course"]');
    expect(query).toContain('nwr["golf"="hole"]');
    /* Ways alone miss Pebble Beach, whose boundary is a relation. */
    expect(query).toContain('out geom');
  });

  it('boxes the course rather than the whole world', () => {
    const box = overpassBbox(PEBBLE.latitude, PEBBLE.longitude);

    expect(box.south).toBeLessThan(PEBBLE.latitude);
    expect(box.north).toBeGreaterThan(PEBBLE.latitude);
    expect(box.west).toBeLessThan(PEBBLE.longitude);
    expect(box.east).toBeGreaterThan(PEBBLE.longitude);
    expect(box.north - box.south).toBeLessThan(0.2);
  });

  it('posts the query form-encoded to the interpreter', async () => {
    const fetchMock = respondWith([pebbleRelation()]);
    vi.stubGlobal('fetch', fetchMock);

    await lookupOsmCourse(PEBBLE);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OVERPASS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('data=');
  });
});

describe('adopting an existing course boundary', () => {
  it('adopts a leisure=golf_course relation, assembling its member ways into a polygon', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), CYPRESS(), SPYGLASS(), ...holes()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.course.osmId).toBe('relation/3741806');
    expect(lookup.course.name).toBe('Pebble Beach Golf Course');
    expect(lookup.course.boundary.type).toBe('Polygon');
    expect(lookup.course.acres).toBeGreaterThan(200);
    expect(lookup.course.matchedBy).toBe('name');
  });

  it('counts the holes OpenStreetMap holds inside the adopted line, and no others', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), CYPRESS(), ...holes()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.mappedHoleRefs).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });

  it('keeps a hole whose playing line runs partly outside the boundary', async () => {
    /* Pebble Beach's 14th and 18th both leave relation 3741806 on live data
     * (measured 2026-08-12); a centre-point test lost two of its eighteen. */
    const crossing = {
      type: 'way',
      id: 800200,
      tags: { golf: 'hole', ref: '18' },
      geometry: [
        { lat: 36.5695, lon: -121.9505 },
        { lat: 36.5745, lon: -121.9595 },
      ],
    };
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), crossing]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.mappedHoleRefs).toEqual([18]);
  });

  it('keeps only the landmarks that fall inside the adopted line', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), CYPRESS(), ...landmarks()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    const names = lookup.course.landmarks.map((l) => l.name);
    expect(names).toContain('Pebble Beach Clubhouse');
    expect(names).toContain('Peter Hay Practice Range');
    expect(names).not.toContain('Cypress Point Clubhouse');
  });

  it('reports no landmarks rather than inventing them when OSM holds none', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.landmarks).toEqual([]);
  });
});

describe('confident matching', () => {
  it('treats the course as absent when the bbox holds only neighbouring courses', async () => {
    vi.stubGlobal('fetch', respondWith([CYPRESS(), SPYGLASS()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    /* Adopting the nearest neighbour would put Cypress Point's line around
     * Pebble Beach. Absent is the honest answer. */
    expect(lookup.status).toBe('absent');
  });

  it('treats an empty Overpass answer as absent, not as a failure', async () => {
    vi.stubGlobal('fetch', respondWith([]));

    expect((await lookupOsmCourse(PEBBLE)).status).toBe('absent');
  });

  it('falls back to the nearest centroid only inside the distance ceiling', async () => {
    /* Same name similarity as any stranger — the geometry is what is close. */
    const unnamed = {
      type: 'way',
      id: 555001,
      tags: { leisure: 'golf_course', name: 'Del Monte Forest Links' },
      geometry: [
        { lat: SOUTH, lon: WEST },
        { lat: SOUTH, lon: EAST },
        { lat: NORTH, lon: EAST },
        { lat: NORTH, lon: WEST },
        { lat: SOUTH, lon: WEST },
      ],
    };
    vi.stubGlobal('fetch', respondWith([unnamed]));

    const lookup = await lookupOsmCourse(PEBBLE);

    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.course.matchedBy).toBe('proximity');
    expect(CENTROID_CEILING_METRES).toBeLessThan(2000);
  });

  it('scores a differently-worded name for the same course above the threshold', () => {
    const similarity = courseNameSimilarity(
      'Pebble Beach Golf Course',
      'Pebble Beach Golf Links',
    );

    expect(similarity).toBeGreaterThanOrEqual(NAME_MATCH_THRESHOLD);
    expect(courseNameSimilarity('Cypress Point Club', 'Pebble Beach Golf Links')).toBeLessThan(
      NAME_MATCH_THRESHOLD,
    );
    expect(
      courseNameSimilarity('Spyglass Hill Golf Course', 'Pebble Beach Golf Links'),
    ).toBeLessThan(NAME_MATCH_THRESHOLD);
  });
});

describe('tolerating an unreliable endpoint', () => {
  it('leaves mapped state unknown when the request times out, after one retry', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = lookupOsmCourse(PEBBLE);
    await vi.advanceTimersByTimeAsync(OVERPASS_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(OVERPASS_RETRY_BACKOFF_MS);
    await vi.advanceTimersByTimeAsync(OVERPASS_TIMEOUT_MS);
    const lookup = await pending;

    expect(lookup.status).toBe('unknown');
    if (lookup.status !== 'unknown') return;
    expect(lookup.message).toMatch(/answer/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves a 504 followed by a success on the retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassResponse(null, 504))
      .mockResolvedValueOnce(overpassResponse(overpassBody([pebbleRelation(), ...holes()])));
    vi.stubGlobal('fetch', fetchMock);

    const pending = lookupOsmCourse(PEBBLE);
    await vi.advanceTimersByTimeAsync(OVERPASS_RETRY_BACKOFF_MS);
    const lookup = await pending;

    expect(lookup.status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an empty reply, which Overpass sends as often as it sends a 504', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassResponse(null))
      .mockResolvedValueOnce(overpassResponse(overpassBody([pebbleRelation()])));
    vi.stubGlobal('fetch', fetchMock);

    const pending = lookupOsmCourse(PEBBLE);
    await vi.advanceTimersByTimeAsync(OVERPASS_RETRY_BACKOFF_MS);

    expect((await pending).status).toBe('found');
  });

  it('gives up after the retry rather than hammering the endpoint', async () => {
    const fetchMock = vi.fn(async () => overpassResponse(null, 504));
    vi.stubGlobal('fetch', fetchMock);

    const pending = lookupOsmCourse(PEBBLE);
    await vi.advanceTimersByTimeAsync(OVERPASS_RETRY_BACKOFF_MS);
    const lookup = await pending;

    expect(lookup.status).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the per-session cache', () => {
  it('answers a second open of the same course without re-querying', async () => {
    const fetchMock = respondWith([pebbleRelation(), ...holes()]);
    vi.stubGlobal('fetch', fetchMock);

    const first = await lookupOsmCourse(PEBBLE);
    const second = await lookupOsmCourse(PEBBLE);

    expect(first.status).toBe('found');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a later open can still succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassResponse(null, 504))
      .mockResolvedValueOnce(overpassResponse(null, 504))
      .mockResolvedValue(overpassResponse(overpassBody([pebbleRelation()])));
    vi.stubGlobal('fetch', fetchMock);

    const failing = lookupOsmCourse(PEBBLE);
    await vi.advanceTimersByTimeAsync(OVERPASS_RETRY_BACKOFF_MS);
    expect((await failing).status).toBe('unknown');

    expect((await lookupOsmCourse(PEBBLE)).status).toBe('found');
  });

  it('keys the cache per course, so a second course is looked up on its own', async () => {
    const fetchMock = respondWith([pebbleRelation()]);
    vi.stubGlobal('fetch', fetchMock);

    await lookupOsmCourse(PEBBLE);
    await lookupOsmCourse({ ...PEBBLE, id: 'course-2', name: 'Spyglass Hill Golf Course' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
