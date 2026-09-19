import { renderToString } from 'react-dom/server';
import App from './App';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import {
  INITIAL,
  computeDerived,
  guessTeeBoxes,
  shapesFromProposals,
  type MapperState,
  type Mapper,
} from './state/useMapper';
import { buildCourseSession, holeStatusesFrom, teeSetsFor } from './state/courseSession';
import type { CourseDetail } from './api/types';
import type { OsmCourse, OsmLookup } from './api/overpass';
import type { DetectionImagery, Proposal } from './api/detect';
import type { LngLat } from './geo/coords';
import { STEPS } from './data/course';

const noop = () => {};

/*
 * One course record, in the shape `/api/v1/courses/{id}` answers: gendered
 * `tee_key`s, a stray `web` yardage column, and a full per-hole card. The screens
 * take a loaded session now, so the harness supplies one rather than leaning on
 * constants the app no longer holds.
 */
const PARS = [4, 5, 4, 4, 3, 5, 3, 4, 4, 4, 4, 3, 4, 5, 4, 4, 3, 5];
const BACK_YDS = [378, 502, 390, 331, 192, 506, 106, 427, 481, 495, 390, 202, 445, 580, 397, 403, 178, 543];
const INDEX = [6, 10, 2, 16, 8, 12, 18, 4, 14, 5, 9, 17, 3, 7, 11, 1, 15, 13];

/** Ratios off the back tee, so the fixture reads like a real card without 90 literals. */
const TEE_RATIO: Array<[string, string, number]> = [
  ['blue', 'Blue', 1],
  ['gold', 'Gold', 349 / 378],
  ['white', 'White', 337 / 378],
  ['green', 'Green', 328 / 378],
  ['red', 'Red', 310 / 378],
];

const FIXTURE: CourseDetail = {
  id: 'smoke-course',
  course_name: 'Pebble Beach Golf Links',
  latitude: 36.5685,
  longitude: -121.949,
  par: 72,
  yardage: 6802,
  holes: 18,
  tees: TEE_RATIO.flatMap(([color, name, ratio]) => [
    {
      tee_key: `${color}-male`,
      tee_name: name,
      tee_color: color,
      gender: 'Male',
      yardage: Math.round(6802 * ratio),
    },
    {
      tee_key: `${color}-female`,
      tee_name: name,
      tee_color: color,
      gender: 'Female',
      yardage: Math.round(6802 * ratio),
    },
  ]),
  holes_data: PARS.map((par, i) => ({
    number: i + 1,
    par,
    handicap_index: INDEX[i],
    yardages: {
      /* The column no tee row claims — it must not become a scorecard row. */
      web: BACK_YDS[i],
      ...Object.fromEntries(
        TEE_RATIO.map(([color, , ratio]) => [color, Math.round(BACK_YDS[i] * ratio)]),
      ),
    },
  })),
};

const COURSE = buildCourseSession(FIXTURE);

/*
 * One adopted OpenStreetMap course, in the shape `lookupOsmCourse` returns. This
 * is not demo geometry for a screen to draw over imagery — it is the harness
 * standing in for a network answer so the server render has something to render.
 */
const OSM_COURSE: OsmCourse = {
  osmId: 'relation/3741806',
  name: 'Pebble Beach Golf Course',
  boundary: {
    type: 'Polygon',
    coordinates: [
      [
        [-121.955, 36.563],
        [-121.943, 36.563],
        [-121.943, 36.574],
        [-121.955, 36.574],
        [-121.955, 36.563],
      ],
    ],
  },
  acres: 176,
  bbox: [-121.955, 36.563, -121.943, 36.574],
  mappedHoleRefs: [1, 2, 3],
  holes: [],
  landmarks: [
    {
      id: 'way/700001',
      name: 'Pebble Beach Clubhouse',
      kind: 'Clubhouse',
      position: [-121.9494, 36.5688],
    },
  ],
  matchedBy: 'name',
};

const FOUND: OsmLookup = { status: 'found', course: OSM_COURSE };
const ABSENT: OsmLookup = { status: 'absent' };
const UNKNOWN: OsmLookup = { status: 'unknown', message: 'it did not answer within 8s' };

/*
 * A real playing line: OpenStreetMap way 671717506, Pebble Beach hole 1, tee,
 * corner and green. Not invented geometry — a copy of what OSM already holds, so
 * the server render has a line to measure.
 */
const PEBBLE_HOLE_ONE: LngLat[] = [
  [-121.9495343, 36.5693904],
  [-121.9477382, 36.5705598],
  [-121.9461359, 36.5706059],
];

/*
 * What a detection answer looks like once it has landed, so the server render
 * covers the suggestion layer and the one-at-a-time review as well as the empty
 * steps. Squares beside the real hole-1 line — placeholder geometry for a render
 * harness, never drawn over a real course in the app.
 */
function proposalSquare(id: string, kind: Proposal['kind'], lng: number): Proposal {
  return {
    id,
    kind,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, 36.5703],
          [lng + 0.0003, 36.5703],
          [lng + 0.0003, 36.5706],
          [lng, 36.5706],
          [lng, 36.5703],
        ],
      ],
    },
    confidence: 0.86,
    areaSquareMeters: 900,
    vertexCount: 5,
    notes: [],
    teeSet: null,
    acquired: '2023-07-04',
    gsdMeters: 0.6,
    source: 'USDA NAIP via Microsoft Planetary Computer',
    modelId: 'facebook/sam2-hiera-large',
    itemId: 'ca_m_3812_2023',
  };
}

const PROPOSALS: Proposal[] = [
  { ...proposalSquare('p-tee', 'tee', -121.9497), teeSet: { key: 'blue', name: 'Blue', yards: 378 } },
  proposalSquare('p-green', 'green', -121.9464),
  proposalSquare('p-bunker-1', 'bunker', -121.947),
  proposalSquare('p-bunker-2', 'bunker', -121.9476),
  proposalSquare('p-water', 'water', -121.9484),
];

/** The hole with detection's answer landed on it, at whichever step a render needs. */
function reviewing(overrides: Partial<MapperState> = {}): Partial<MapperState> {
  const shapes = shapesFromProposals(PROPOSALS);
  return {
    mode: 'ready',
    locate: { points: PEBBLE_HOLE_ONE, finished: true, source: 'drawn', edited: false },
    detect: { status: 'ready', jobId: 'smoke-job', proposals: PROPOSALS, imagery: CORRIDOR_COG, missingTeeSets: [] },
    shapes,
    teeBoxes: guessTeeBoxes(teeSetsFor(COURSE, 0), shapes, PEBBLE_HOLE_ONE),
    ...overrides,
  };
}

/*
 * The corridor raster the answer names (R9). Two versions, because the two paths
 * read differently on screen: what the service returns today is a signed href to
 * the whole Cloud-Optimized GeoTIFF, which a browser cannot decode and which the
 * rail therefore states as a gap rather than drawing; a browser-renderable
 * rendition of the same window is what turns the overlay on.
 */
const CORRIDOR_COG: DetectionImagery = {
  source: 'USDA NAIP via Microsoft Planetary Computer',
  itemId: 'ca_m_3812_2023',
  acquired: '2023-07-04',
  gsdMeters: 0.6,
  assetHref: 'https://naipeuwest.blob.core.windows.net/naip/ca_m_3812_2023.tif?sig=smoke',
  boundsWgs84: [-121.9505, 36.5688, -121.9455, 36.5715],
  crs: 'EPSG:26910',
  width: 1024,
  height: 1024,
};

const CORRIDOR_RENDITION: DetectionImagery = {
  ...CORRIDOR_COG,
  assetHref: 'https://example.invalid/corridor/ca_m_3812_2023.png?sig=smoke',
};

function mapperFor(overrides: Partial<MapperState>): Mapper {
  const state: MapperState = {
    ...INITIAL,
    screen: 'review',
    course: COURSE,
    teeSet: COURSE.tees[0]?.color ?? null,
    osm: FOUND,
    holeStatus: holeStatusesFrom(COURSE, FOUND),
    ...overrides,
  };
  return {
    state,
    derived: computeDerived(state),
    actions: new Proxy({}, { get: () => noop }),
  } as unknown as Mapper;
}

export function renderAll(): Record<string, string> {
  return {
    app: renderToString(<App />),

    boundary: renderToString(
      <BoundaryScreen
        course={OSM_COURSE}
        geometry={OSM_COURSE.boundary}
        edited={false}
        save={{ status: 'idle' }}
        courseName={COURSE.name}
        onChange={noop}
        onReset={noop}
        onSave={noop}
        onContinue={noop}
        onBack={noop}
      />,
    ),
    boundaryBare: renderToString(
      <BoundaryScreen
        course={{ ...OSM_COURSE, landmarks: [], mappedHoleRefs: [] }}
        geometry={OSM_COURSE.boundary}
        edited={false}
        save={{ status: 'idle' }}
        courseName={COURSE.name}
        onChange={noop}
        onReset={noop}
        onSave={noop}
        onContinue={noop}
        onBack={noop}
      />,
    ),
    boundarySaveFailed: renderToString(
      <BoundaryScreen
        course={OSM_COURSE}
        geometry={OSM_COURSE.boundary}
        edited
        save={{ status: 'failed', message: 'the service did not answer.' }}
        courseName={COURSE.name}
        onChange={noop}
        onReset={noop}
        onSave={noop}
        onContinue={noop}
        onBack={noop}
      />,
    ),

    board: renderToString(
      <BoardScreen
        course={COURSE}
        holeStatus={holeStatusesFrom(COURSE, FOUND)}
        doneCount={OSM_COURSE.mappedHoleRefs.length}
        osm={FOUND}
        onOpenHole={noop}
        onBack={noop}
      />,
    ),
    boardSaved: renderToString(
      <BoardScreen
        course={COURSE}
        holeStatus={holeStatusesFrom(COURSE, FOUND).map((status, i) => (i === 0 ? 'saved' : status))}
        doneCount={OSM_COURSE.mappedHoleRefs.length}
        osm={FOUND}
        onOpenHole={noop}
        onBack={noop}
      />,
    ),
    boardAbsent: renderToString(
      <BoardScreen
        course={COURSE}
        holeStatus={holeStatusesFrom(COURSE, ABSENT)}
        doneCount={0}
        osm={ABSENT}
        onOpenHole={noop}
        onBack={noop}
      />,
    ),
    boardUnknown: renderToString(
      <BoardScreen
        course={COURSE}
        holeStatus={holeStatusesFrom(COURSE, UNKNOWN)}
        doneCount={0}
        osm={UNKNOWN}
        onOpenHole={noop}
        onBack={noop}
      />,
    ),

    /* Mapped by hand, nothing proposed: every step still stands and asks. */
    reviewByHand: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'ready',
          locate: { points: PEBBLE_HOLE_ONE, finished: true, source: 'drawn', edited: false },
        })}
      />,
    ),
    /* Detection landed: the blue tee's matched box is the one asked about first. */
    reviewTees: renderToString(<ReviewScreen now={new Date('2026-08-12T00:00:00Z')} mapper={mapperFor(reviewing())} />),
    /* R9: with a renderable rendition of the same window, the overlay is offered. */
    reviewCorridor: renderToString(
      <ReviewScreen
        mapper={mapperFor(
          reviewing({
            detect: { status: 'ready', jobId: 'smoke-job', proposals: PROPOSALS, imagery: CORRIDOR_RENDITION, missingTeeSets: [] },
          }),
        )}
      />,
    ),
    reviewTeePick: renderToString(
      <ReviewScreen mapper={mapperFor(reviewing({ interaction: { kind: 'pick', purpose: 'tee' } }))} />,
    ),
    reviewGreen: renderToString(<ReviewScreen mapper={mapperFor(reviewing({ step: 1 }))} />),
    reviewGreenPlace: renderToString(
      <ReviewScreen
        mapper={mapperFor(reviewing({ step: 1, interaction: { kind: 'place', shape: 'green', forTee: null, replacing: true } }))}
      />,
    ),
    reviewFairwayEmpty: renderToString(<ReviewScreen mapper={mapperFor(reviewing({ step: 2 }))} />),
    reviewBunkers: renderToString(<ReviewScreen mapper={mapperFor(reviewing({ step: 3 }))} />),
    reviewBunkerPick: renderToString(
      <ReviewScreen mapper={mapperFor(reviewing({ step: 3, interaction: { kind: 'pick', purpose: 'remove' } }))} />,
    ),
    reviewBunkerEdit: renderToString(
      <ReviewScreen
        mapper={mapperFor(reviewing({ step: 3, interaction: { kind: 'edit', shapeIds: ['p-bunker-1', 'p-bunker-2'] } }))}
      />,
    ),
    reviewBunkerPlace: renderToString(
      <ReviewScreen
        mapper={mapperFor(reviewing({ step: 3, interaction: { kind: 'place', shape: 'bunker', forTee: null, replacing: false } }))}
      />,
    ),
    reviewHazards: renderToString(<ReviewScreen mapper={mapperFor(reviewing({ step: 4 }))} />),
    reviewNewHazard: renderToString(
      <ReviewScreen
        mapper={mapperFor(
          reviewing({
            step: 4,
            shapes: [
              ...shapesFromProposals(PROPOSALS),
              {
                id: 'drawn-1',
                kind: 'hazard',
                ring: [
                  [-121.948, 36.5698],
                  [-121.9478, 36.5698],
                  [-121.9478, 36.57],
                ],
                inner: [],
                original: [],
                origin: 'drawn',
                proposal: null,
                edited: false,
                confirmed: false,
                removed: false,
                hazardType: null,
              },
            ],
            interaction: { kind: 'new', shapeId: 'drawn-1' },
          }),
        )}
      />,
    ),
    reviewDone: renderToString(
      <ReviewScreen
        mapper={mapperFor(
          reviewing({
            step: STEPS.length,
            shapes: shapesFromProposals(PROPOSALS).map((shape) => ({ ...shape, confirmed: true })),
          }),
        )}
      />,
    ),
    reviewSaveFailed: renderToString(
      <ReviewScreen
        mapper={mapperFor(
          reviewing({ step: STEPS.length, save: { status: 'failed', message: 'the store is not configured.' } }),
        )}
      />,
    ),
    reviewAttention: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'attention', holeIndex: 3 })} />,
    ),
    reviewLocateEmpty: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'locate', holeIndex: 9 })} />,
    ),
    reviewLocateDrawing: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 0,
          locate: { points: PEBBLE_HOLE_ONE, finished: false, source: 'drawn', edited: false },
        })}
      />,
    ),
    reviewDetecting: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 0,
          locate: { points: PEBBLE_HOLE_ONE, finished: true, source: 'drawn', edited: false },
          detect: { status: 'working' },
        })}
      />,
    ),
    reviewDetectFailed: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 0,
          locate: { points: PEBBLE_HOLE_ONE, finished: true, source: 'drawn', edited: false },
          detect: { status: 'failed', message: 'the service did not answer.' },
        })}
      />,
    ),
    /*
     * A hole OpenStreetMap already holds: the line and the outlines arrive with
     * it, and the rail asks whether it runs that way rather than asking for a tee.
     */
    reviewOsmHole: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 0,
          locate: { points: PEBBLE_HOLE_ONE, finished: false, source: 'osm', edited: false },
          existing: [
            {
              id: 'way/820001',
              kind: 'green',
              tag: 'green',
              name: null,
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-121.9463, 36.5705],
                    [-121.946, 36.5705],
                    [-121.946, 36.5708],
                    [-121.9463, 36.5708],
                    [-121.9463, 36.5705],
                  ],
                ],
              },
            },
          ],
        })}
      />,
    ),

    complete: renderToString(
      <CompleteModal
        courseName={COURSE.name}
        holeNum={1}
        saved={['1 tee box', '1 green', '2 bunkers', 'water']}
        doneCount={3}
        holeCount={COURSE.holes.length}
        onNextHole={noop}
        onBack={noop}
      />,
    ),
  };
}
