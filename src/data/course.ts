import { ell, rr } from './geometry';

export interface Tee {
  name: string;
  yd: number;
  swatch: string;
}

/** Pebble Beach hole 1 tee set. Yardages for other holes are scaled from these. */
export const TEES: Tee[] = [
  { name: 'Blue', yd: 378, swatch: '#2b7fa8' },
  { name: 'Gold', yd: 349, swatch: '#c98a15' },
  { name: 'White', yd: 337, swatch: '#e8ebdf' },
  { name: 'Green', yd: 328, swatch: '#237a5c' },
  { name: 'Red', yd: 310, swatch: '#b4462f' },
];

export const PARS = [4, 5, 4, 4, 3, 5, 3, 4, 4, 4, 4, 3, 4, 5, 4, 4, 3, 5];
export const YDS = [378, 502, 390, 331, 192, 506, 106, 427, 481, 495, 390, 202, 445, 580, 397, 403, 178, 543];
export const INDEX = [6, 10, 2, 16, 8, 12, 18, 4, 14, 5, 9, 17, 3, 7, 11, 1, 15, 13];

export type HoleStatus = 'ready' | 'attention' | 'complete' | 'unmapped';

export const INITIAL_STATUS: HoleStatus[] = [
  'ready', 'complete', 'complete', 'attention', 'ready', 'ready',
  'ready', 'ready', 'ready', 'unmapped', 'unmapped', 'unmapped',
  'unmapped', 'unmapped', 'unmapped', 'unmapped', 'unmapped', 'unmapped',
];

export const STATUS_META: Record<HoleStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready to review', tone: 'accent' },
  attention: { label: 'Needs attention', tone: 'warning' },
  complete: { label: 'On the map', tone: 'success' },
  unmapped: { label: 'Nothing yet', tone: 'neutral' },
};

/** Three fairway silhouettes, cycled across the board tiles. */
export const MINIS = [
  'M8 78 C 30 60 50 48 72 34 C 88 24 100 18 116 12 L 120 26 C 104 32 92 38 78 46 C 58 58 38 70 18 88 Z',
  'M4 20 C 30 26 54 40 76 56 C 92 68 104 76 118 82 L 114 92 C 98 86 84 78 68 66 C 46 50 24 36 0 30 Z',
  'M14 84 C 24 58 40 40 62 26 C 80 14 98 10 118 8 L 120 22 C 102 24 86 28 70 38 C 50 50 36 64 28 88 Z',
];

export interface Shape {
  d: string;
  label: string;
  lx: number;
  ly: number;
}

/** Proposed features for the hole under review, in the review map's 1000x680 viewBox. */
export const SHAPES: Record<string, Shape> = {
  green: { d: ell(838, 150, 66, 50), label: 'green', lx: 758, ly: 206 },
  greenAlt: { d: ell(524, 330, 30, 20), label: 'green?', lx: 486, ly: 356 },
  bunkerA: { d: ell(744, 214, 34, 20), label: 'bunker', lx: 628, ly: 244 },
  bunkerB: { d: ell(906, 208, 27, 17), label: 'bunker', lx: 830, ly: 250 },
  fairway: {
    d: 'M180 590 C 268 512 348 458 436 390 C 528 318 648 246 776 200 L 818 272 C 696 316 578 384 494 448 C 410 512 336 566 250 636 Z',
    label: 'fairway',
    lx: 366,
    ly: 486,
  },
  tee1: { d: rr(118, 602, 76, 36, 6), label: 'back tee', lx: 208, ly: 618 },
  tee2: { d: rr(158, 568, 68, 32, 6), label: '', lx: 0, ly: 0 },
  tee3: { d: rr(196, 538, 64, 30, 6), label: '', lx: 0, ly: 0 },
  tee4: { d: rr(234, 510, 60, 28, 6), label: 'forward tee', lx: 306, ly: 486 },
};

export const TEE_IDS = ['tee1', 'tee2', 'tee3', 'tee4'] as const;
export type TeeId = (typeof TEE_IDS)[number];

export const TEE_POSITIONS = ['furthest back', 'second back', 'third back', 'furthest up'];

export interface Step {
  id: string;
  kicker: string;
  targets: string[];
  isTees?: boolean;
  title: string;
  note: string;
  accept: string;
  reject: string;
  miss: string;
  done: string;
}

/** The review sequence. Each step asks a golf question, never a geometry question. */
export const STEPS: Step[] = [
  {
    id: 'green',
    kicker: 'The green',
    targets: ['green'],
    title: 'Is that the green?',
    note: 'One shape, highlighted on the imagery. You have putted on it a hundred times.',
    accept: 'Yes, that is the green',
    reject: 'That is not the green',
    miss: 'The green is elsewhere',
    done: 'Green confirmed.',
  },
  {
    id: 'bunkers',
    kicker: 'Bunkers',
    targets: ['bunkerA', 'bunkerB'],
    title: 'We found 2 bunkers on this hole. Miss any?',
    note: 'One short right of the green, one long left. Sand only — waste areas come later.',
    accept: 'That is all 2 of them',
    reject: 'One of these is not sand',
    miss: 'There is another bunker',
    done: 'Bunkers confirmed.',
  },
  {
    id: 'tees',
    kicker: 'Tee boxes',
    targets: ['tee1', 'tee2', 'tee3', 'tee4'],
    isTees: true,
    title: 'Which tee is which?',
    note: 'We guessed by distance from the green. Change any that are wrong.',
    accept: 'That is right',
    reject: 'One of these is not a tee',
    miss: 'A tee is missing',
    done: 'Tees named.',
  },
  {
    id: 'fairway',
    kicker: 'Fairway',
    targets: ['fairway'],
    title: 'Does the fairway run where you would hit it?',
    note: 'Mown fairway only — the first cut and rough stay out of it.',
    accept: 'Yes, that is the fairway',
    reject: 'That is not the fairway',
    miss: 'It runs further than that',
    done: 'Fairway confirmed.',
  },
  {
    id: 'extras',
    kicker: 'Anything else',
    targets: [],
    title: 'Anything else in play out there?',
    note: 'A pond, a creek, a waste area — only if a ball can find it.',
    accept: 'Nothing else on this hole',
    reject: 'Skip this one',
    miss: 'Yes, add water',
    done: 'Hole checked.',
  },
];

export interface CourseSummary {
  name: string;
  place: string;
  done: number;
  state: string;
}

export const COURSES: CourseSummary[] = [
  { name: 'Pebble Beach Golf Links', place: 'Pebble Beach · California', done: 0, state: 'outline only · 0 of 18 holes' },
  { name: 'Spyglass Hill Golf Course', place: 'Pebble Beach · California', done: 4, state: '4 of 18 holes done' },
  { name: 'The Links at Spanish Bay', place: 'Pebble Beach · California', done: 0, state: 'nothing mapped yet' },
  { name: 'Poppy Hills Golf Course', place: 'Pebble Beach · California', done: 18, state: 'all 18 holes done' },
];

export interface Landmark {
  name: string;
  icon: string;
  verdict: string;
  color: string;
  action: string;
}

export const LANDMARKS: Landmark[] = [
  { name: 'Clubhouse and pro shop', icon: 'circle-check', verdict: 'inside', color: 'var(--mint-400)', action: 'not inside' },
  { name: 'Practice range and putting green', icon: 'circle-check', verdict: 'inside', color: 'var(--mint-400)', action: 'not inside' },
  { name: 'The Lodge at Pebble Beach', icon: 'circle-check', verdict: 'inside', color: 'var(--mint-400)', action: 'not inside' },
  { name: '17-Mile Drive', icon: 'x', verdict: 'outside', color: 'var(--green-200)', action: 'should be in' },
  { name: 'Carmel Bay shoreline', icon: 'x', verdict: 'outside', color: 'var(--green-200)', action: 'should be in' },
];

export const COURSE_NAME = 'Pebble Beach Golf Links';
export const COURSE_META = 'par 72 · 6,802 yd · 18 holes · Jack Neville & Douglas Grant, 1919';

/** Review map viewBox, shared by the imagery and the overlay so clicks land in the same space. */
export const REVIEW_VIEWBOX = { w: 1000, h: 680 };

/** Diagonal of the review viewBox, used to convert click distance into yards. */
export const REVIEW_DIAGONAL = 833;

/** How far the measured playing line may drift from the card before it reads as a mismatch. */
export const YARDAGE_TOLERANCE = 25;
