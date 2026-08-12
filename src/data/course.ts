/**
 * Where one hole stands.
 *
 * `unmapped` and `unknown` are different answers and must stay that way (R16):
 * `unmapped` is "OpenStreetMap holds nothing for this hole", `unknown` is "the
 * OpenStreetMap lookup failed, so we cannot say". Collapsing the second into the
 * first would tell a contributor that a fully-mapped course is empty.
 */
export type HoleStatus = 'ready' | 'attention' | 'complete' | 'unmapped' | 'unknown';

export const STATUS_META: Record<HoleStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready to review', tone: 'accent' },
  attention: { label: 'Needs attention', tone: 'warning' },
  complete: { label: 'On the map', tone: 'success' },
  unmapped: { label: 'Nothing yet', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'info' },
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

/**
 * The review sequence. Each step asks a golf question, never a geometry question.
 *
 * Nothing proposes features yet — detection is deferred, and inventing shapes to
 * review over a real course is exactly what KTD13 forbids. The sequence stays
 * built, and the playing-line flow is the path that produces geometry today.
 */
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
