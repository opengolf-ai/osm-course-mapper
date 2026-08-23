import type { ProposalKind } from '../api/detect';

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

/** What a step says when detection proposed nothing of its kind. */
export interface EmptyStepCopy {
  title: string;
  note: string;
  accept: string;
}

/**
 * One question in the review sequence.
 *
 * A step names the **kind** of proposal it walks, never a fixed list of feature
 * ids. Detection returns a variable number of bunkers, tees and water bodies, and
 * a fixed `targets: ['bunkerA', 'bunkerB']` could only ever confirm a whole step
 * in one keystroke — which is precisely the batch confirmation R7 forbids. The
 * reviewable list is derived from the returned proposals at runtime and walked one
 * feature at a time.
 *
 * `kind: null` is a step with no detection class behind it: it exists so a
 * contributor can add something we never look for. It is not an unmet detection
 * requirement, and it is not a placeholder for one.
 */
export interface Step {
  id: string;
  kicker: string;
  /** The proposal kind this step reviews, or null for a contributor-add-only step. */
  kind: ProposalKind | null;
  /** The tee-naming controls ride on this step. */
  isTees?: boolean;
  /**
   * R14: this step's proposals are not hazards until the contributor says a ball
   * can find them. Spectral classification proposes water; it never decides
   * whether the water counts, so the step offers an in-play answer either way.
   */
  needsInPlay?: boolean;
  /** The noun the "we missed one" branch is about on this step. */
  missNoun: string;
  /** The question about a single proposal — the shape the step is asked in most often. */
  title: string;
  /** The same question when there is more than one. `{i}` is 1-based, `{n}` the count. */
  titleMany: string;
  note: string;
  accept: string;
  /**
   * The second confirming answer on an in-play step: yes it is water, no a ball
   * cannot find it. Present only where `needsInPlay` is.
   */
  outOfPlay?: string;
  reject: string;
  miss: string;
  /**
   * What the step says when nothing of its kind came back.
   *
   * The step is still shown. Skipping it would make detection silence and genuine
   * absence look identical, and would remove the only route a contributor has to
   * say "you missed one" — one of the three outcomes the review flow is built
   * around. The zero-proposal `hazards` step below is the same pattern by design
   * rather than by accident.
   */
  empty: EmptyStepCopy;
  done: string;
}

/**
 * The review sequence. Each step asks a golf question, never a geometry question.
 *
 * Detection proposes; the contributor disposes, one feature at a time (KTD1, R7).
 * Nothing in this sequence confirms a batch, and no step is skipped for being
 * empty — see `Step.empty` for why.
 */
export const STEPS: Step[] = [
  {
    id: 'green',
    kicker: 'The green',
    kind: 'green',
    missNoun: 'green',
    title: 'Is that the green?',
    titleMany: 'Green {i} of {n} — is that the one you putt on?',
    note: 'One shape, highlighted on the imagery. You have putted on it a hundred times.',
    accept: 'Yes, that is the green',
    reject: 'That is not the green',
    miss: 'The green is elsewhere',
    empty: {
      title: 'We did not find a green here.',
      note: 'Nothing was proposed for this hole. If you can see the green on the imagery, put it on the map yourself.',
      accept: 'Nothing to confirm — carry on',
    },
    done: 'Green confirmed.',
  },
  {
    id: 'bunkers',
    kicker: 'Bunkers',
    kind: 'bunker',
    missNoun: 'bunker',
    title: 'Is that a bunker?',
    titleMany: 'Bunker {i} of {n} — is that sand?',
    note: 'Sand only — waste areas come later.',
    accept: 'Yes, that is sand',
    reject: 'That is not sand',
    miss: 'There is another bunker',
    empty: {
      title: 'No bunkers proposed on this hole.',
      note: 'Either there are none, or we could not see them. You know which.',
      accept: 'There are no bunkers here',
    },
    done: 'Bunkers confirmed.',
  },
  {
    id: 'tees',
    kicker: 'Tee boxes',
    kind: 'tee',
    isTees: true,
    missNoun: 'tee box',
    title: 'Is that a tee box?',
    titleMany: 'Tee box {i} of {n} — is that one you play from?',
    note: 'We guessed the names by distance from the green. Change any that are wrong.',
    accept: 'Yes, that is a tee',
    reject: 'That is not a tee',
    miss: 'A tee is missing',
    empty: {
      title: 'No tee boxes proposed on this hole.',
      note: 'Tee boxes are small and often shaded. Add the ones you play from.',
      accept: 'Leave the tees for now',
    },
    done: 'Tees named.',
  },
  {
    id: 'fairway',
    kicker: 'Fairway',
    kind: 'fairway',
    missNoun: 'fairway edge',
    title: 'Does the fairway run where you would hit it?',
    titleMany: 'Fairway {i} of {n} — does it run where you would hit it?',
    note: 'Mown fairway only — the first cut and rough stay out of it.',
    accept: 'Yes, that is the fairway',
    reject: 'That is not the fairway',
    miss: 'It runs further than that',
    empty: {
      title: 'No fairway proposed on this hole.',
      note: 'On a par 3 that is expected. Anywhere else, trace it yourself.',
      accept: 'No fairway to confirm',
    },
    done: 'Fairway confirmed.',
  },
  {
    id: 'water',
    kicker: 'Water',
    kind: 'water',
    needsInPlay: true,
    missNoun: 'water',
    title: 'Can a ball find that water?',
    titleMany: 'Water {i} of {n} — can a ball find it?',
    note: 'We can see water from the imagery. Whether it is in play is a golf question, and that one is yours.',
    accept: 'Yes — it is in play',
    outOfPlay: 'It is water, but out of play',
    reject: 'That is not water',
    miss: 'There is other water',
    empty: {
      title: 'No water proposed on this hole.',
      note: 'If there is a pond or a creek we did not see, put it on the map.',
      accept: 'No water on this hole',
    },
    done: 'Water settled.',
  },
  {
    id: 'hazards',
    kicker: 'Other hazards',
    /* Nothing proposes these — we do not classify them. The step exists so the
     * contributor can add what we never look for, not because detection owes one. */
    kind: null,
    missNoun: 'hazard',
    title: 'Anything else in play out there?',
    titleMany: 'Anything else in play out there?',
    note: 'A waste area, a ditch, a stand of trees — only if a ball can find it.',
    accept: 'Nothing else on this hole',
    reject: 'Skip this one',
    miss: 'Yes, add one',
    empty: {
      title: 'Anything else in play out there?',
      note: 'A waste area, a ditch, a stand of trees. We do not look for these, so this one is entirely on you.',
      accept: 'Nothing else on this hole',
    },
    done: 'Hole checked.',
  },
];

/** Fill `{i}` (1-based position) and `{n}` (count) in a step's multi-proposal copy. */
function fillCount(text: string, position: number, count: number): string {
  /* split/join rather than `replaceAll`: the lib target here is ES2020. */
  return text.split('{i}').join(String(position)).split('{n}').join(String(count));
}

/**
 * The question on screen: about the one proposal being reviewed, or about the
 * absence of any. Three cases rather than a count-stuffed sentence, because
 * "Bunker 1 of 1" reads like a machine and "We found 2 bunkers" was a lie the
 * moment detection returned three.
 */
export function stepTitle(step: Step, position: number, count: number): string {
  if (count === 0) return step.empty.title;
  if (count === 1) return step.title;
  return fillCount(step.titleMany, position, count);
}

export function stepNote(step: Step, count: number): string {
  return count === 0 ? step.empty.note : step.note;
}

/** The confirming answer. With nothing proposed there is nothing to confirm — say so. */
export function stepAccept(step: Step, count: number): string {
  return count === 0 ? step.empty.accept : step.accept;
}
