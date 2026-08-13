import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import type { LngLat } from '../geo/coords';
import {
  DETECT_API_BASE,
  MAX_DECISIONS_PER_CALL,
  POLL_INTERVAL_MS,
  decisionFor,
  recordDecisions,
  requestProposals,
  type DetectRequest,
  type Proposal,
} from './detect';

/** A short hole, drawn tee → green, the way the review screen hands it over. */
const LINE: LngLat[] = [
  [-122.999797, 36.144174],
  [-122.995528, 36.144174],
];

const REQUEST: DetectRequest = {
  line: LINE,
  par: 4,
  teeSets: [{ name: 'Black', yards: 420, key: 'black' }],
};

/** A minimal `Response` stand-in — only what the client actually reads. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function submitAccepted(overrides: Record<string, unknown> = {}) {
  return jsonResponse(
    {
      status: 'pending',
      job_id: '77d2',
      poll_url: '/v1/detect/77d2',
      budget_seconds: 4,
      ...overrides,
    },
    202,
  );
}

function pending() {
  return jsonResponse({ job_id: '77d2', elapsed_seconds: 0.001, status: 'pending', budget_seconds: 4 });
}

const GREEN = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-122.9958, 36.1441],
        [-122.9955, 36.1441],
        [-122.9955, 36.1444],
        [-122.9958, 36.1444],
        [-122.9958, 36.1441],
      ],
    ],
  },
  properties: {
    kind: 'green',
    confidence: 0.82,
    area_sq_meters: 620.5,
    vertex_count: 5,
    notes: ['area within range'],
    tee_set: null,
    acquired: '2023-07-04',
    gsd_meters: 0.6,
    source: 'naip',
    model_id: 'sam2-hiera-large',
    item_id: 'ca_m_3612_2023',
  },
};

const TEE = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-122.9998, 36.1441],
        [-122.9996, 36.1441],
        [-122.9996, 36.1443],
        [-122.9998, 36.1443],
        [-122.9998, 36.1441],
      ],
    ],
  },
  properties: {
    kind: 'tee',
    confidence: 0.6,
    area_sq_meters: 210,
    vertex_count: 5,
    notes: [],
    tee_set: { name: 'Black', yards: 420, key: 'black' },
    acquired: '2023-07-04',
    gsd_meters: 0.6,
    source: 'naip',
    model_id: 'sam2-hiera-large',
    item_id: 'ca_m_3612_2023',
  },
};

function detected() {
  return jsonResponse({
    job_id: '77d2',
    elapsed_seconds: 12.4,
    status: 'ok',
    features: { type: 'FeatureCollection', features: [GREEN, TEE] },
    imagery: {
      source: 'naip',
      item_id: 'ca_m_3612_2023',
      acquired: '2023-07-04',
      gsd_meters: 0.6,
      asset_href: 'https://example.invalid/corridor.tif',
      bounds_wgs84: [-123.0, 36.143, -122.994, 36.146],
      crs: 'EPSG:26910',
      width: 800,
      height: 400,
    },
    missing_tee_sets: [{ name: 'Gold', yards: 300, key: 'gold' }],
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Nothing here may sleep: the poll delay is injected so the loop runs at test speed. */
const immediately = () => Promise.resolve();

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestProposals', () => {
  it('submits the drawn line to /v1/detect, then polls the reference it was given', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(detected());

    await requestProposals(REQUEST, { wait: immediately });

    const [submitUrl, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe(`${DETECT_API_BASE}/v1/detect`);
    expect(submitInit.method).toBe('POST');
    expect(JSON.parse(String(submitInit.body))).toEqual({
      line: [
        [-122.999797, 36.144174],
        [-122.995528, 36.144174],
      ],
      par: 4,
      tee_sets: [{ name: 'Black', yards: 420, key: 'black' }],
    });

    expect(fetchMock.mock.calls[1][0]).toBe(`${DETECT_API_BASE}/v1/detect/77d2`);
  });

  it('sends no par or tee sets when the card carries none, since unknown fields are rejected', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(detected());

    await requestProposals({ line: LINE }, { wait: immediately });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(Object.keys(body)).toEqual(['line']);
  });

  it('resolves a finished job into typed proposals carrying kind, confidence and provenance', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(detected());

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.proposals).toHaveLength(2);
    const [green, tee] = result.proposals;
    expect(green.kind).toBe('green');
    expect(green.confidence).toBeCloseTo(0.82);
    expect(green.acquired).toBe('2023-07-04');
    expect(green.geometry.type).toBe('Polygon');
    expect(tee.teeSet).toEqual({ name: 'Black', yards: 420, key: 'black' });
    /* Ids are stable within a response so the review sequence can key on them. */
    expect(new Set(result.proposals.map((p) => p.id)).size).toBe(2);
    expect(result.imagery?.acquired).toBe('2023-07-04');
    expect(result.imagery?.boundsWgs84).toEqual([-123.0, 36.143, -122.994, 36.146]);
    expect(result.missingTeeSets).toEqual([{ name: 'Gold', yards: 300, key: 'gold' }]);
  });

  it('keeps polling while the job is pending, waiting between polls', async () => {
    const wait = vi.fn(immediately);
    fetchMock
      .mockResolvedValueOnce(submitAccepted())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(detected());

    const result = await requestProposals(REQUEST, { wait });

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledWith(POLL_INTERVAL_MS, undefined);
  });

  it('resolves a no-coverage answer to its own variant, not to a failure', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
      jsonResponse({
        job_id: '77d2',
        status: 'no_coverage',
        message: 'No NAIP imagery covers this location.',
        detail: {},
      }),
    );

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('no_coverage');
    if (result.status !== 'no_coverage') return;
    expect(result.message).toBe('No NAIP imagery covers this location.');
  });

  it('resolves the service timeout to the timeout variant, carrying what it said', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
      jsonResponse(
        {
          job_id: '77d2',
          elapsed_seconds: 61,
          status: 'timeout',
          message: 'Detection did not finish within the time budget. The hole is still yours to map by hand.',
        },
        504,
      ),
    );

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('timeout');
    if (result.status !== 'timeout') return;
    expect(result.message).toContain('map by hand');
  });

  it('gives up with a timeout of its own when the job never stops being pending', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted({ budget_seconds: 4 })).mockResolvedValue(pending());

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('timeout');
    /* Bounded: a budget of 4 s at a 2 s poll interval is a handful of polls, not a spin. */
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
  });

  it('stops polling the moment the request is cancelled', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValue(pending());

    const result = await requestProposals(REQUEST, {
      signal: controller.signal,
      /* The contributor pressing cancel, in the gap between two polls. */
      wait: async () => controller.abort(),
    });

    expect(result.status).toBe('aborted');
    /* One submit and one poll, and nothing after the cancel. */
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const callsAtCancel = fetchMock.mock.calls.length;
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(callsAtCancel);
  });

  it('resolves a network rejection to the failed variant rather than throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('network');
  });

  it('resolves a rejected submit body to the validation variant, naming the field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          message: 'A playing line may be at most 1200 m long.',
          detail: { length_meters: 1997.6, cap_meters: 1200 },
          status: 'invalid',
          field: 'line',
        },
        422,
      ),
    );

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.field).toBe('line');
    expect(result.message).toContain('1200 m');
    /* Nothing to poll — the request never became a job. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves an upstream failure to the failed variant with its source', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
      jsonResponse(
        {
          job_id: '77d2',
          status: 'upstream',
          message: 'The imagery catalogue did not answer.',
          source: 'stac',
          cause: 'ReadTimeout',
        },
        502,
      ),
    );

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('upstream');
    expect(result.message).toContain('imagery catalogue');
  });

  it('resolves an unreadable answer to the failed variant rather than a half-parsed one', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('malformed');
  });

  it('drops a proposal whose geometry or kind it cannot read, keeping the rest', async () => {
    fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
      jsonResponse({
        job_id: '77d2',
        status: 'ok',
        features: {
          type: 'FeatureCollection',
          features: [
            GREEN,
            { type: 'Feature', geometry: null, properties: { kind: 'bunker' } },
            { type: 'Feature', geometry: GREEN.geometry, properties: { kind: 'helipad' } },
          ],
        },
        imagery: null,
        missing_tee_sets: [],
      }),
    );

    const result = await requestProposals(REQUEST, { wait: immediately });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.proposals.map((p) => p.kind)).toEqual(['green']);
  });

  /**
   * Geometry that parses but cannot be drawn.
   *
   * A degenerate ring is well-formed JSON, so nothing upstream rejects it — and it
   * is not the client that fails on it, it is `@turf/centroid` inside the review
   * screen's derived state, during render, where a throw takes the whole page. So
   * each of these is asserted to be dropped at the parse boundary, with `GREEN` in
   * the same answer proving one bad feature does not cost the rest.
   */
  describe('geometry the map cannot draw', () => {
    /** One detection answer carrying GREEN plus a feature with the given geometry. */
    async function kindsAlongsideGreen(geometry: unknown): Promise<string[]> {
      fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
        jsonResponse({
          job_id: '77d2',
          status: 'ok',
          features: {
            type: 'FeatureCollection',
            features: [GREEN, { type: 'Feature', geometry, properties: { kind: 'bunker' } }],
          },
          imagery: null,
          missing_tee_sets: [],
        }),
      );

      const result = await requestProposals(REQUEST, { wait: immediately });
      if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
      return result.proposals.map((p) => p.kind);
    }

    const RING = [
      [-122.9958, 36.1441],
      [-122.9955, 36.1441],
      [-122.9955, 36.1444],
      [-122.9958, 36.1441],
    ];

    const degenerate: Array<[string, unknown]> = [
      ['an empty ring', { type: 'Polygon', coordinates: [[]] }],
      [
        'a ring of fewer than three positions',
        {
          type: 'Polygon',
          coordinates: [
            [
              [-122.9958, 36.1441],
              [-122.9955, 36.1444],
            ],
          ],
        },
      ],
      [
        'a position that is not a pair',
        { type: 'Polygon', coordinates: [[[-122.9958, 36.1441], [-122.9955], [-122.9955, 36.1444]]] },
      ],
      [
        'a position that is not an array at all',
        { type: 'Polygon', coordinates: [[[-122.9958, 36.1441], -122.9955, [-122.9955, 36.1444]]] },
      ],
      [
        'a NaN coordinate',
        {
          type: 'Polygon',
          coordinates: [[[-122.9958, 36.1441], [Number.NaN, 36.1441], [-122.9955, 36.1444]]],
        },
      ],
      [
        'a null coordinate',
        {
          type: 'Polygon',
          coordinates: [[[-122.9958, 36.1441], [-122.9955, null], [-122.9955, 36.1444]]],
        },
      ],
      [
        'a coordinate sent as a string',
        {
          type: 'Polygon',
          coordinates: [[[-122.9958, 36.1441], ['-122.9955', '36.1441'], [-122.9955, 36.1444]]],
        },
      ],
      /* Polygon-depth coordinates under a MultiPolygon type: one level too shallow,
       * which the old length check waved through because the outer array was full. */
      ['a MultiPolygon nested one level too shallow', { type: 'MultiPolygon', coordinates: [RING] }],
      ['a MultiPolygon with a degenerate member', { type: 'MultiPolygon', coordinates: [[RING], [[]]] }],
      ['no rings at all', { type: 'Polygon', coordinates: [] }],
    ];

    it.each(degenerate)('drops a proposal with %s, keeping the rest of the answer', async (_label, geometry) => {
      expect(await kindsAlongsideGreen(geometry)).toEqual(['green']);
    });

    it('still accepts a polygon with an interior ring', async () => {
      const withHole = {
        type: 'Polygon',
        coordinates: [
          RING,
          [
            [-122.99575, 36.14415],
            [-122.99565, 36.14415],
            [-122.99565, 36.14425],
            [-122.99575, 36.14415],
          ],
        ],
      };

      expect(await kindsAlongsideGreen(withHole)).toEqual(['green', 'bunker']);
    });

    it('still accepts a well-formed MultiPolygon', async () => {
      expect(await kindsAlongsideGreen({ type: 'MultiPolygon', coordinates: [[RING]] })).toEqual([
        'green',
        'bunker',
      ]);
    });

    it('keeps the geometry it accepted intact, rings and all', async () => {
      const withAltitude = {
        type: 'Polygon',
        coordinates: [RING.map(([lng, lat]) => [lng, lat, 0])],
      };
      fetchMock.mockResolvedValueOnce(submitAccepted()).mockResolvedValueOnce(
        jsonResponse({
          job_id: '77d2',
          status: 'ok',
          features: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: withAltitude, properties: { kind: 'bunker' } }],
          },
          imagery: null,
          missing_tee_sets: [],
        }),
      );

      const result = await requestProposals(REQUEST, { wait: immediately });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.proposals[0].geometry).toEqual(withAltitude);
    });
  });
});

/**
 * Persisting what the contributor decided (R10, R15).
 *
 * A rejection is a record, not a discard, so both outcomes travel the same path —
 * and the store takes no contributor, session or device identifier, which is a
 * property of the payload worth pinning down rather than remembering.
 */
describe('recordDecisions', () => {
  const PROPOSAL: Proposal = {
    id: '77d2-0',
    kind: 'green',
    geometry: GREEN.geometry as Polygon,
    confidence: 0.86,
    areaSquareMeters: 620.5,
    vertexCount: 5,
    notes: [],
    teeSet: null,
    acquired: '2023-07-04',
    gsdMeters: 0.6,
    source: 'USDA NAIP via Microsoft Planetary Computer',
    modelId: 'facebook/sam2-hiera-large',
    itemId: 'ca_m_3812_2023',
  };

  it('posts geometry, classified kind and imagery provenance for both outcomes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', recorded: 2 }));

    const result = await recordDecisions('opengolf-1234', 7, [
      decisionFor(PROPOSAL, 'confirmed'),
      decisionFor({ ...PROPOSAL, id: '77d2-1', kind: 'bunker' }, 'rejected'),
    ]);

    expect(result).toEqual({ status: 'ok', recorded: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DETECT_API_BASE}/v1/decisions`);
    const body = JSON.parse(String(init.body));
    expect(body.course_id).toBe('opengolf-1234');
    expect(body.hole_number).toBe(7);
    expect(body.decisions.map((d: { outcome: string }) => d.outcome)).toEqual([
      'confirmed',
      'rejected',
    ]);
    expect(body.decisions[1].kind).toBe('bunker');
    expect(body.decisions[0].geometry.type).toBe('Polygon');
    expect(body.decisions[0].provenance).toEqual({
      acquired: '2023-07-04',
      gsd_meters: 0.6,
      source: 'USDA NAIP via Microsoft Planetary Computer',
      model_id: 'facebook/sam2-hiera-large',
      item_id: 'ca_m_3812_2023',
    });
    /* Nothing identifying is assembled, because the store accepts none. */
    expect(String(init.body)).not.toMatch(/user|session|device|contributor/i);
  });

  it('sends the in-play answer only when one was given (R14)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', recorded: 1 }));

    await recordDecisions('c', 1, [decisionFor({ ...PROPOSAL, kind: 'water' }, 'confirmed', false)]);
    await recordDecisions('c', 1, [decisionFor(PROPOSAL, 'confirmed')]);

    const answered = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const unasked = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(answered.decisions[0].in_play).toBe(false);
    /* Absent, not false: nobody was asked, and that is not a "no". */
    expect('in_play' in unasked.decisions[0]).toBe(false);
  });

  it('chunks past the store ceiling rather than refusing the call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));
    const many = Array.from({ length: MAX_DECISIONS_PER_CALL + 5 }, (_, i) =>
      decisionFor({ ...PROPOSAL, id: `p-${i}` }, 'confirmed'),
    );

    const result = await recordDecisions('c', 1, many);

    expect(result).toEqual({ status: 'ok', recorded: MAX_DECISIONS_PER_CALL + 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(second.decisions).toHaveLength(5);
  });

  it('reports a store the service cannot reach as a stated failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'upstream', source: 'configuration' }, 502),
    );

    const result = await recordDecisions('c', 1, [decisionFor(PROPOSAL, 'rejected')]);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('upstream');
    expect(result.statusCode).toBe(502);
  });

  it('does not call the store when there is nothing to record', async () => {
    expect(await recordDecisions('c', 1, [])).toEqual({ status: 'ok', recorded: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
