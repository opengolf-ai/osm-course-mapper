import { renderToString } from 'react-dom/server';
import App from './App';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { INITIAL, computeDerived, type MapperState, type Mapper } from './state/useMapper';
import { buildCourseSession, defaultTeeAssign, statusesFor } from './state/courseSession';
import type { CourseDetail } from './api/types';
import { INITIAL_STATUS, STEPS } from './data/course';

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

function mapperFor(overrides: Partial<MapperState>): Mapper {
  const state: MapperState = {
    ...INITIAL,
    screen: 'review',
    course: COURSE,
    teeAssign: defaultTeeAssign(COURSE),
    holeStatus: statusesFor(COURSE, INITIAL_STATUS),
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
        courseName={COURSE.name}
        flagged={false}
        onFlag={noop}
        onConfirm={noop}
        onBack={noop}
      />,
    ),
    boundaryFlagged: renderToString(
      <BoundaryScreen courseName={COURSE.name} flagged onFlag={noop} onConfirm={noop} onBack={noop} />,
    ),

    board: renderToString(
      <BoardScreen
        course={COURSE}
        holeStatus={statusesFor(COURSE, INITIAL_STATUS)}
        doneCount={2}
        onOpenHole={noop}
        onBack={noop}
      />,
    ),

    reviewReady: renderToString(<ReviewScreen mapper={mapperFor({ mode: 'ready' })} />),
    reviewTees: renderToString(<ReviewScreen mapper={mapperFor({ mode: 'ready', step: 2 })} />),
    reviewDone: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'ready',
          step: STEPS.length,
          confirmed: ['green', 'bunkerA', 'bunkerB', 'tee1', 'tee2', 'tee3', 'tee4', 'fairway'],
        })}
      />,
    ),
    reviewAttention: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'attention', holeIndex: 3 })} />,
    ),
    reviewLocateEmpty: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'locate', holeIndex: 9 })} />,
    ),
    reviewLocateDone: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 9,
          locate: { tee: { x: 150, y: 620 }, green: { x: 838, y: 150 } },
        })}
      />,
    ),
    reviewAddMode: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'ready', step: 1, addMode: 'bunker' })} />,
    ),

    complete: renderToString(
      <CompleteModal
        courseName={COURSE.name}
        holeNum={1}
        doneCount={3}
        holeCount={COURSE.holes.length}
        onNextHole={noop}
        onBack={noop}
      />,
    ),
  };
}
