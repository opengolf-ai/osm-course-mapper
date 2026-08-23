import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CENTROID_CEILING_METRES,
  parseHoleRef,
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


/* --- A hole with its geometry, and what OSM outlines along it ------------- */

/** A `golf=hole` way running due north, long enough to be a real hole. */
function holeLine(id: number, ref: number, lon: number) {
  return {
    type: 'way',
    id,
    tags: { golf: 'hole', ref: String(ref), par: '4' },
    geometry: [
      { lat: 36.565, lon },
      { lat: 36.568, lon },
    ],
  };
}

/** A small closed way tagged `golf=<value>`, centred on a point. */
function golfArea(
  id: number,
  value: string,
  lat: number,
  lon: number,
  tags: Record<string, string> = {},
) {
  const d = 0.00015;
  return {
    type: 'way',
    id,
    tags: { golf: value, ...tags },
    geometry: [
      { lat: lat - d, lon: lon - d },
      { lat: lat - d, lon: lon + d },
      { lat: lat + d, lon: lon + d },
      { lat: lat + d, lon: lon - d },
      { lat: lat - d, lon: lon - d },
    ],
  };
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
  it('asks for courses and everything tagged golf, with geometry', () => {
    const query = overpassQuery(overpassBbox(PEBBLE.latitude, PEBBLE.longitude));

    expect(query).toContain('nwr["leisure"="golf_course"]');
    /* Any `golf` value, so a mapped hole's green and bunkers come back with it. */
    expect(query).toContain('nwr["golf"]');
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

/**
 * Hidden Valley Country Club, Sandy: twenty-seven holes as three nines, paired
 * into three eighteens, and tagged three different ways on the same course. The
 * Mountain nine carries `ref=1`…`9` with `name=Mountain #1`; the Lakes and
 * Valley nines carry `ref=Lakes #1` and `ref=Valley #1` and no name at all.
 * Every number and par below is what OpenStreetMap held on 2026-08-23.
 */
describe('a club that plays more than one nine', () => {
  const PARS = {
    Mountain: [5, 4, 4, 3, 4, 4, 4, 5, 3],
    Lakes: [5, 3, 4, 4, 4, 4, 3, 4, 5],
    Valley: [4, 4, 4, 3, 5, 4, 4, 3, 5],
  };

  /** Nine holes in a row, each a short line, spaced so none is near another. */
  function nine(kind: keyof typeof PARS, baseId: number, lonBase: number, tagAs: 'ref' | 'name') {
    return PARS[kind].map((par, i) => {
      const lon = lonBase + i * 0.0003;
      return {
        type: 'way',
        id: baseId + i,
        tags:
          tagAs === 'ref'
            ? { golf: 'hole', ref: `${kind} #${i + 1}`, par: String(par) }
            : { golf: 'hole', ref: String(i + 1), name: `${kind} #${i + 1}`, par: String(par) },
        geometry: [
          { lat: 36.5645, lon },
          { lat: 36.5675, lon },
        ],
      };
    });
  }

  const ALL_TWENTY_SEVEN = () => [
    ...nine('Mountain', 830000, -121.9540, 'name'),
    ...nine('Lakes', 831000, -121.9500, 'ref'),
    ...nine('Valley', 832000, -121.9460, 'ref'),
  ];

  /** An eighteen-hole card: two nines' pars, numbered 1 through 18. */
  function card(front: keyof typeof PARS, back: keyof typeof PARS) {
    return [...PARS[front], ...PARS[back]].map((par, i) => ({ number: i + 1, par }));
  }

  it('reads the nine and the number out of a decorated ref', () => {
    expect(parseHoleRef('Lakes #4')).toEqual({ nine: 'Lakes', number: 4 });
    expect(parseHoleRef('7')).toEqual({ nine: null, number: 7 });
    expect(parseHoleRef('Mountain #1')).toEqual({ nine: 'Mountain', number: 1 });
    expect(parseHoleRef('Back 9 - 3')).toEqual({ nine: 'Back 9', number: 3 });
    /* Nothing to read is not hole zero. */
    expect(parseHoleRef('')).toBeNull();
    expect(parseHoleRef(undefined)).toBeNull();
    expect(parseHoleRef('practice')).toBeNull();
  });

  it('pairs the card to the right two nines by their pars', async () => {
    /*
     * The bug this pins. `parseInt` read `Lakes #1` as NaN, so two nines out of
     * three were dropped and the third — the only one with bare numbers —
     * answered to every card number: opening the Lakes/Valley 1st drew the
     * Mountain 1st, a couple of hundred yards away across the property.
     */
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...ALL_TWENTY_SEVEN()]));

    const lookup = await lookupOsmCourse({ ...PEBBLE, name: 'Pebble Beach Lakes Valley', holes: card('Lakes', 'Valley') });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.mappedHoleRefs).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(lookup.course.holes.map((hole) => hole.osmRef)).toEqual([
      'Lakes #1', 'Lakes #2', 'Lakes #3', 'Lakes #4', 'Lakes #5', 'Lakes #6', 'Lakes #7', 'Lakes #8', 'Lakes #9',
      'Valley #1', 'Valley #2', 'Valley #3', 'Valley #4', 'Valley #5', 'Valley #6', 'Valley #7', 'Valley #8', 'Valley #9',
    ]);
    /* And the Mountain nine, which this eighteen does not play, is not on it. */
    expect(lookup.course.holes.some((hole) => hole.nine === 'Mountain')).toBe(false);
  });

  it('finds the nine whose holes are numbered plainly, named only on the way', async () => {
    /* The Mountain nine's refs are bare numbers; only its `name` says which
     * nine it is, and without reading that it is invisible to any pairing. */
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...ALL_TWENTY_SEVEN()]));

    const lookup = await lookupOsmCourse({
      ...PEBBLE,
      id: 'mountain-valley',
      name: 'Pebble Beach Mountain Valley',
      holes: card('Mountain', 'Valley'),
    });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes[0].osmRef).toBe('Mountain #1');
    expect(lookup.course.holes[0].nine).toBe('Mountain');
    expect(lookup.course.holes[9].osmRef).toBe('Valley #1');
    /* Card numbering, not tag numbering: the Valley 1st is played as the 10th. */
    expect(lookup.course.holes[9].ref).toBe(10);
  });

  it('falls back to the order the course name gives when there is no card', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...ALL_TWENTY_SEVEN()]));

    const lookup = await lookupOsmCourse({
      ...PEBBLE,
      id: 'no-card',
      name: 'Pebble Beach Lakes Mountain',
    });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes[0].osmRef).toBe('Lakes #1');
    expect(lookup.course.holes[9].osmRef).toBe('Mountain #1');
  });

  it('holds nothing rather than guess when neither the card nor the name says', async () => {
    /*
     * KTD12's rule, applied a level down: a course that cannot be identified is
     * absent rather than wearing a neighbour's boundary, and a hole that cannot
     * be identified is missing rather than wearing another nine's geometry.
     */
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...ALL_TWENTY_SEVEN()]));

    const lookup = await lookupOsmCourse({
      ...PEBBLE,
      id: 'anonymous',
      name: 'Pebble Beach Golf Links',
      /* A card whose pars match none of the three nines. */
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4 })),
    });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes).toEqual([]);
    expect(lookup.course.mappedHoleRefs).toEqual([]);
  });

  it('never plays one nine twice', async () => {
    /* A card of two identical nines matches the same OSM nine for both blocks;
     * the second block has to come out empty rather than duplicated. */
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...ALL_TWENTY_SEVEN()]));

    const lookup = await lookupOsmCourse({
      ...PEBBLE,
      id: 'doubled',
      name: 'Pebble Beach Lakes Lakes',
      holes: card('Lakes', 'Lakes'),
    });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    const refs = lookup.course.holes.map((hole) => hole.osmRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual(['Lakes #1', 'Lakes #2', 'Lakes #3', 'Lakes #4', 'Lakes #5', 'Lakes #6', 'Lakes #7', 'Lakes #8', 'Lakes #9']);
  });

  it('leaves an ordinary eighteen numbered exactly as OSM numbers it', async () => {
    /* One nine's worth of tags, all bare numbers: none of the above applies. */
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), ...holes()]));

    const lookup = await lookupOsmCourse({ ...PEBBLE, id: 'plain' });

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.mappedHoleRefs).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(lookup.course.holes[0].nine).toBeNull();
  });
});

describe('the holes OpenStreetMap already holds', () => {
  /* Two holes six hundred metres apart, so nothing is ambiguous about which
   * line an outline belongs to. */
  const HOLE_ONE = () => holeLine(810001, 1, -121.954);
  const HOLE_TWO = () => holeLine(810002, 2, -121.948);

  it('carries each hole’s playing line, not only its number', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), HOLE_ONE(), HOLE_TWO()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.mappedHoleRefs).toEqual([1, 2]);
    const first = lookup.course.holes[0];
    expect(first.osmId).toBe('way/810001');
    expect(first.par).toBe(4);
    expect(first.line.coordinates).toEqual([
      [-121.954, 36.565],
      [-121.954, 36.568],
    ]);
  });

  it('attaches the green and the bunkers that sit on a hole to that hole', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith([
        pebbleRelation(),
        HOLE_ONE(),
        HOLE_TWO(),
        golfArea(820001, 'green', 36.568, -121.954, { name: 'First green' }),
        golfArea(820002, 'bunker', 36.5672, -121.9543),
        golfArea(820003, 'bunker', 36.5668, -121.9537),
        golfArea(820004, 'green', 36.568, -121.948),
      ]),
    );

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    const [one, two] = lookup.course.holes;
    expect(one.features.map((f) => f.kind).sort()).toEqual(['bunker', 'bunker', 'green']);
    expect(one.features.find((f) => f.kind === 'green')?.name).toBe('First green');
    expect(one.features[0].geometry.type).toBe('Polygon');
    /* Hole 2's own green is not hole 1's, six hundred metres away. */
    expect(two.features.map((f) => f.id)).toEqual(['way/820004']);
  });

  it('believes a ref tag over distance', async () => {
    /* Sitting on hole 1's line, but its mapper says it belongs to hole 2. */
    vi.stubGlobal(
      'fetch',
      respondWith([
        pebbleRelation(),
        HOLE_ONE(),
        HOLE_TWO(),
        golfArea(820005, 'tee', 36.5655, -121.954, { ref: '2' }),
      ]),
    );

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes[0].features).toEqual([]);
    expect(lookup.course.holes[1].features.map((f) => f.kind)).toEqual(['tee']);
  });

  it('leaves an outline that is on no hole off every hole', async () => {
    /* A practice green by the clubhouse, well past the ceiling from both lines.
     * Attaching it to whichever hole is least distant would draw a shape on a
     * hole it has nothing to do with. */
    vi.stubGlobal(
      'fetch',
      respondWith([pebbleRelation(), HOLE_ONE(), HOLE_TWO(), golfArea(820006, 'green', 36.5725, -121.9455)]),
    );

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes.every((hole) => hole.features.length === 0)).toBe(true);
  });

  it('reads a cart path as a line rather than closing it into a shape', async () => {
    const path = {
      type: 'way',
      id: 820007,
      tags: { golf: 'path' },
      geometry: [
        { lat: 36.5655, lon: -121.9542 },
        { lat: 36.5665, lon: -121.9542 },
      ],
    };
    vi.stubGlobal('fetch', respondWith([pebbleRelation(), HOLE_ONE(), path]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    const feature = lookup.course.holes[0].features[0];
    expect(feature.kind).toBe('path');
    expect(feature.geometry.type).toBe('LineString');
  });

  it('holds no hole geometry for a course whose holes OSM has not drawn', async () => {
    vi.stubGlobal('fetch', respondWith([pebbleRelation()]));

    const lookup = await lookupOsmCourse(PEBBLE);

    if (lookup.status !== 'found') throw new Error('expected a boundary');
    expect(lookup.course.holes).toEqual([]);
    expect(lookup.course.mappedHoleRefs).toEqual([]);
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
