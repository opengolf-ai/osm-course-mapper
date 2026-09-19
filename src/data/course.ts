/**
 * Where one hole stands.
 *
 * `unmapped` and `unknown` are different answers and must stay that way (R16):
 * `unmapped` is "OpenStreetMap holds nothing for this hole", `unknown` is "the
 * OpenStreetMap lookup failed, so we cannot say". Collapsing the second into the
 * first would tell a contributor that a fully-mapped course is empty.
 *
 * `saved` is a hole a contributor finished here. It is in our own store, not in
 * OpenStreetMap — the upload path is not built — so it is never labelled as
 * though it were on the map.
 */
export type HoleStatus = 'ready' | 'attention' | 'complete' | 'saved' | 'unmapped' | 'unknown';

export const STATUS_META: Record<HoleStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready to review', tone: 'accent' },
  attention: { label: 'Needs attention', tone: 'warning' },
  complete: { label: 'On the map', tone: 'success' },
  saved: { label: 'Saved — not uploaded', tone: 'brand' },
  unmapped: { label: 'Nothing yet', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'info' },
};

/**
 * What a shape on a hole is, in the terms the review steps ask about.
 *
 * `hazard` is everything the last step collects — water, trees, a waste area —
 * and its `HazardType` says which. Water detection proposes lands there too:
 * whether a pond is part of the hole is a golf question, and the hazard step is
 * where the contributor answers golf questions about things off the short grass.
 */
export type ShapeKind = 'tee' | 'green' | 'fairway' | 'bunker' | 'hazard';

export type HazardType = 'water' | 'trees' | 'waste_area' | 'native_area' | 'other';

/** The hazard types, in the order the chips offer them. */
export const HAZARD_TYPES: { type: HazardType; label: string }[] = [
  { type: 'water', label: 'Water' },
  { type: 'trees', label: 'Trees' },
  { type: 'waste_area', label: 'Waste area' },
  { type: 'native_area', label: 'Native grass' },
  { type: 'other', label: 'Other' },
];

export function hazardLabel(type: HazardType | null): string {
  return HAZARD_TYPES.find((entry) => entry.type === type)?.label ?? 'Hazard';
}

/** The word a step and a caption use for a shape. */
export const SHAPE_NOUN: Record<ShapeKind, string> = {
  tee: 'tee box',
  green: 'green',
  fairway: 'fairway',
  bunker: 'bunker',
  hazard: 'hazard',
};

/**
 * The OpenStreetMap tags a saved shape would carry, where the golf schema has a
 * settled answer.
 *
 * Only settled answers: `golf=tee`, `golf=green`, `golf=fairway`, `golf=bunker`
 * and `golf=water_hazard` are the documented `golf=*` values, and trees are
 * `natural=wood` on any map. A waste area, native grass or "other" has no tag
 * everyone agrees on, so it gets none here — the kind and the contributor's
 * words are stored, and the tag is decided when the upload path is built rather
 * than invented now and baked into every saved hole.
 */
export function osmTagsFor(kind: ShapeKind, hazardType: HazardType | null): Record<string, string> {
  switch (kind) {
    case 'tee':
      return { golf: 'tee' };
    case 'green':
      return { golf: 'green' };
    case 'fairway':
      return { golf: 'fairway' };
    case 'bunker':
      return { golf: 'bunker', natural: 'sand' };
    case 'hazard':
      if (hazardType === 'water') return { golf: 'water_hazard', natural: 'water' };
      if (hazardType === 'trees') return { natural: 'wood' };
      return {};
  }
}

export type StepId = 'tees' | 'green' | 'fairway' | 'bunkers' | 'hazards';

/**
 * One question in the review sequence.
 *
 * The order is the order a golfer walks a hole: off the tee, onto the green,
 * then back down the fairway to the sand and whatever else is in play. Every
 * step is shown whether or not detection proposed anything for it — an empty
 * step is where "you missed one" lives, and skipping it would make detection's
 * silence look the same as genuine absence.
 */
export interface Step {
  id: StepId;
  kicker: string;
  /** The shape kind this step reviews. */
  kind: ShapeKind;
  /** Why this step exists, in one line under the question. */
  note: string;
  /** What the rail says once the step is answered. */
  done: string;
}

export const STEPS: Step[] = [
  {
    id: 'tees',
    kicker: 'Tee boxes',
    kind: 'tee',
    note: 'One tee off the card at a time. Click a different box on the map if we picked the wrong one.',
    done: 'Tees matched to the card.',
  },
  {
    id: 'green',
    kicker: 'The green',
    kind: 'green',
    note: 'One shape, highlighted on the imagery. You have putted on it a hundred times.',
    done: 'Green confirmed.',
  },
  {
    id: 'fairway',
    kicker: 'Fairway',
    kind: 'fairway',
    note: 'Mown fairway only — the first cut and rough stay out of it. Split fairways get a piece each.',
    done: 'Fairway confirmed.',
  },
  {
    id: 'bunkers',
    kicker: 'Sand',
    kind: 'bunker',
    note: 'Sand only — waste areas and grass hollows come next.',
    done: 'Sand confirmed.',
  },
  {
    id: 'hazards',
    kicker: 'Anything else',
    kind: 'hazard',
    note: 'Water, trees in play, a waste area. Click “Draw a hazard”, click the map where it is, then say what it is.',
    done: 'Hole checked.',
  },
];

/** "bunker" → "bunkers", "tee box" → "tee boxes". Enough English for the nouns this app says. */
export function plural(noun: string): string {
  return /[sx]$/.test(noun) ? `${noun}es` : `${noun}s`;
}

/** "1 bunker", "3 bunkers", "no bunkers". */
export function countOf(count: number, noun: string, none = `no ${plural(noun)}`): string {
  if (count === 0) return none;
  return `${count} ${count === 1 ? noun : plural(noun)}`;
}
