/**
 * One hole, on real aerial imagery, walked in the order a golfer plays it.
 *
 * First the line: the contributor draws the hole tee to green — or checks the
 * line OpenStreetMap already holds — and drags any point that misses a bend.
 * Confirming it is the request for features. Then five questions, each about
 * shapes highlighted on the imagery: which box each tee on the card plays from,
 * the green, the fairway, the sand, and anything else in play. Every one of
 * them can be answered "yes", fixed by dragging its edges, removed, or added to
 * by clicking the map — and a detection that fails or finds nothing leaves every
 * one of those routes exactly where it was (R12).
 *
 * Everything drawn is WGS84 GeoJSON on one MapLibre source, styled off each
 * feature's own `status`. What the model proposed draws as a suggestion — its
 * own hue, dashed — until the contributor has answered about it (R8), and every
 * suggestion carries where it came from: the model's confidence and the NAIP
 * frame it read (R5, R9).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { HAZARD_TYPES, SHAPE_NOUN, STEPS, plural } from '../data/course';
import type { CourseFeature, LngLat } from '../geo/coords';
import { Button, Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';
import { BaseMap, type ImageryStatus } from '../map/BaseMap';
import { corridorOverlay, type CorridorOverlay } from '../map/imagerySources';
import { useShapeEditor } from '../map/useShapeEditor';
import type { DetectionImagery, Proposal } from '../api/detect';
import { LOCATE_CLOSE_ENOUGH, type MapBounds, type Mapper } from '../state/useMapper';

const FEATURE_SOURCE = 'review-features';
const FILL_LAYER = 'review-features-fill';
const LINE_LAYER = 'review-features-line';
const PROPOSED_LINE_LAYER = 'review-features-proposed-line';
const POINT_LAYER = 'review-features-point';

/** What the contributor has confirmed. Nothing else may ever be drawn in it (R8). */
export const CONFIRMED_COLOR = '#a3dcc7';
/** The one being asked about right now. */
export const ACTIVE_COLOR = '#3ecfb4';
/** Not asked yet — the least-committal thing this map can say about a shape. */
export const PENDING_COLOR = 'rgba(255,255,255,.42)';
/**
 * A machine's suggestion, awaiting a human (R8, KTD8).
 *
 * Amber rather than another green on purpose: mint and its tints are the palette
 * this screen uses for things the contributor has settled, and a suggestion that
 * shades towards them is a suggestion that reads as settled.
 */
export const PROPOSED_COLOR = '#f0c26a';

/**
 * What OpenStreetMap already holds — the playing line and the outlines filed
 * against this hole (R10).
 *
 * A fourth hue for a fourth thing, and not one of the three above. It is not the
 * contributor's confirmed work, it is not a machine suggestion waiting on them,
 * and it is not something nobody has been asked about yet: it is already in the
 * map. Cool blue keeps it clearly outside the mint family this screen uses for
 * everything the contributor settles.
 */
export const EXISTING_COLOR = '#8fc4e0';

/**
 * What the contributor saved for this hole in an earlier session: theirs, but
 * not what they are working on now. The confirmed hue, drawn lighter.
 */
export const SAVED_COLOR = 'rgba(163,220,199,.55)';

/**
 * One expression, read by every layer: the feature says what it is and the paint
 * follows.
 *
 * Every status is an explicit branch, and the fallback is the *pending* colour,
 * not the confirmed one. The fallback used to be `CONFIRMED_COLOR`, which meant a
 * status this expression did not know about — `proposed`, before it existed here —
 * rendered as confirmed geometry. That is the one thing R8 forbids, and it would
 * have happened silently. An unknown status now reads as "not asked yet", which is
 * the truthful answer for a shape nobody has ruled on.
 */
export const STATUS_COLOR = [
  'match',
  ['get', 'status'],
  'confirmed',
  CONFIRMED_COLOR,
  'active',
  ACTIVE_COLOR,
  'proposed',
  PROPOSED_COLOR,
  'existing',
  EXISTING_COLOR,
  'saved',
  SAVED_COLOR,
  'pending',
  PENDING_COLOR,
  PENDING_COLOR,
];

export const STATUS_WIDTH = [
  'match',
  ['get', 'status'],
  'active',
  4,
  'proposed',
  2,
  /* Lighter than the contributor's own line: it is context, not the subject. */
  'existing',
  2,
  2.5,
];

/**
 * A suggestion is drawn dashed, and `line-dasharray` is not data-driven the way
 * `line-color` is — there is no `match` on `status` to be had. So the dashed
 * suggestion gets its own layer with a filter, and the solid line layer excludes
 * what this one draws rather than drawing underneath it.
 */
const PROPOSED_FILTER = ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'status'], 'proposed']];

const RAIL_CARD = {
  background: 'var(--green-800)',
  border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 'var(--radius-lg)',
  padding: 18,
  boxShadow: 'var(--shadow-md)',
} as const;

const EYEBROW = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
} as const;

const STEP_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  background: 'var(--green-900)',
  border: '1px solid rgba(255,255,255,.12)',
  borderRadius: 'var(--radius-md)',
  padding: '11px 13px',
} as const;

const GHOST_BUTTON = {
  height: 38,
  background: 'var(--green-900)',
  border: '1px solid rgba(255,255,255,.2)',
  borderRadius: 'var(--radius-md)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '0 12px',
} as const;

/**
 * The rail's version of the search screen's `Notice`: one plate that carries a
 * stated outcome, tinted for the dark rail. `danger` is for something that went
 * wrong; the untinted plate is for an answer that is simply empty.
 */
function RailNotice({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <div
      style={{
        background: tone === 'danger' ? 'rgba(180,70,47,.16)' : 'var(--green-900)',
        border: `1px solid ${tone === 'danger' ? 'rgba(214,132,110,.6)' : 'rgba(255,255,255,.12)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '11px 13px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        color: tone === 'danger' ? '#f0cabd' : 'var(--green-100)',
        textWrap: 'pretty',
      }}
    >
      {children}
    </div>
  );
}

/* --- How old the imagery is (R5) ------------------------------------------ */

/**
 * Past this, the imagery gets a warning rather than only a year.
 *
 * Three years, not "anything not from this season". Planetary Computer's NAIP
 * holdings end at 2023 and NAIP flies each state on a two-to-three-year cadence,
 * so a warning framed as an exception would fire on very nearly every proposal —
 * and a warning that is always on is a warning nobody reads. Three years is the
 * point past which a course could plausibly have rebuilt a green or added a
 * bunker without the model having any way to know.
 */
export const IMAGERY_STALE_YEARS = 3;

/** The age of one acquisition, in the terms the rail states it. */
export interface ImageryAge {
  /** The acquisition year, which is always shown. */
  year: number;
  /** Whole years elapsed, for the always-visible line. */
  years: number;
  /** More than `IMAGERY_STALE_YEARS` old, which is the only case that warns. */
  stale: boolean;
}

/**
 * How old a `YYYY-MM-DD` acquisition is, against a reference date.
 *
 * `now` is a parameter with a default rather than a `new Date()` inside the
 * component, so the three-year boundary can be tested at exactly three years
 * instead of only near it. Everything is compared in UTC: an acquisition date
 * carries no timezone, and letting the local one shift it would move the
 * boundary by a day depending on where the contributor is sitting.
 *
 * Staleness is a date comparison, not a rounded year count — exactly three years
 * to the day is not "more than three years old", and one day more is.
 */
export function imageryAge(acquired: string | null | undefined, now: Date = new Date()): ImageryAge | null {
  if (!acquired) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acquired.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const acquiredMs = Date.UTC(year, month - 1, day);
  const nowYear = now.getUTCFullYear();
  const todayMs = Date.UTC(nowYear, now.getUTCMonth(), now.getUTCDate());

  /* Whole years: the difference in years, minus one if this year's anniversary
   * has not come round yet. Never negative — imagery dated ahead of `now` is a
   * service problem, not something to render as "-1 years old". */
  let years = nowYear - year;
  if (todayMs < Date.UTC(nowYear, month - 1, day)) years -= 1;
  if (years < 0) years = 0;

  return {
    year,
    years,
    stale: acquiredMs < Date.UTC(nowYear - IMAGERY_STALE_YEARS, now.getUTCMonth(), now.getUTCDate()),
  };
}

/** `0.83` as `83%`. Confidence is 0–1 on the wire and a percentage in the rail. */
function percent(confidence: number): string {
  return `${Math.round((Number.isFinite(confidence) ? confidence : 0) * 100)}%`;
}

/** "USDA NAIP via Microsoft Planetary Computer" is a credit line, not a label. */
function shortSource(source: string | null): string {
  if (!source) return 'imagery';
  return /naip/i.test(source) ? 'NAIP' : source.split(/[—·|(]/, 1)[0].trim() || 'imagery';
}

const PROVENANCE_ROW = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--green-100)',
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * Where this suggestion came from, stated before it is answered (R5, R9).
 *
 * Confidence and the acquisition year are always here — not folded into a
 * warning, not behind a disclosure. A contributor deciding whether to trust a
 * traced bunker edge is entitled to know the model was 41% sure of it and read
 * it off a frame flown in 2021, and both facts are as relevant when nothing is
 * wrong as when something is.
 */
function ProvenancePanel({
  proposal,
  imagery,
  corridor,
  showing,
  onToggle,
  now,
}: {
  proposal: Proposal | null;
  imagery: DetectionImagery | null;
  corridor: CorridorOverlay | null;
  showing: boolean;
  onToggle: () => void;
  now?: Date;
}) {
  /* The proposal is the authority — R5 puts the date on each one — and the
   * corridor answer is the fallback for a step with nothing being asked about. */
  const acquired = proposal?.acquired ?? imagery?.acquired ?? null;
  const age = imageryAge(acquired, now);
  const gsd = proposal?.gsdMeters ?? imagery?.gsdMeters ?? null;
  const source = shortSource(proposal?.source ?? imagery?.source ?? null);
  if (!proposal && !imagery) return null;

  return (
    <div
      style={{
        background: 'var(--green-900)',
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: 'var(--radius-md)',
        padding: '11px 13px',
        marginBottom: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <div style={{ ...EYEBROW, color: 'var(--green-200)' }}>What the model read</div>

      {proposal && (
        <div style={PROVENANCE_ROW}>
          <span style={{ color: 'var(--green-200)', width: 74 }}>confidence</span>
          <span style={{ color: '#fff' }}>{percent(proposal.confidence)}</span>
          <span
            aria-hidden="true"
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,.12)',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: percent(proposal.confidence),
                background: PROPOSED_COLOR,
              }}
            />
          </span>
        </div>
      )}

      <div style={PROVENANCE_ROW}>
        <span style={{ color: 'var(--green-200)', width: 74 }}>imagery</span>
        <span style={{ color: '#fff' }}>
          {source} {age ? age.year : 'date unknown'}
        </span>
        <span style={{ color: 'var(--green-200)' }}>
          {age ? `${age.years} yr old` : 'no acquisition date'}
          {gsd === null ? '' : ` · ${gsd} m/px`}
        </span>
      </div>

      {/* R5: warn only past three years, so the warning still means something. */}
      {age?.stale && (
        <div
          style={{
            background: 'rgba(201,138,21,.14)',
            border: '1px solid rgba(201,138,21,.55)',
            borderRadius: 'var(--radius-sm)',
            padding: '9px 11px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            color: '#f2e0c4',
            textWrap: 'pretty',
          }}
        >
          This came out of {age.year} imagery — more than {IMAGERY_STALE_YEARS} years old. Anything
          the course has changed since is not in what the model saw.
        </div>
      )}

      {/*
        * R9. The overlay is the corridor frame inference read, not the display
        * basemap and not the live NAIP mosaic — see `corridorOverlay`.
        */}
      {corridor?.status === 'ready' && (
        <>
          <HoverButton
            onClick={onToggle}
            style={{ ...GHOST_BUTTON, height: 36, fontSize: 13, textAlign: 'left' }}
            hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
          >
            {showing ? 'Back to the display imagery' : 'Show me the imagery you read'}
          </HoverButton>
          {showing && corridor.spec.placement === 'envelope' && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
              Laid on its {imagery?.crs ?? 'projected'} footprint — position is good to about a pixel.
            </div>
          )}
        </>
      )}

      {corridor?.status === 'unrenderable' && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--green-200)', textWrap: 'pretty' }}>
          We cannot put that frame on screen yet. {corridor.reason}
        </div>
      )}
    </div>
  );
}

/**
 * What OpenStreetMap outlines on this hole, in one line: "a green, 3 bunkers and
 * a fairway".
 *
 * Counted off the real features rather than templated off a fixed list, for the
 * same reason the step copy is (R5): a hole with two bunkers must not be
 * described as having three, and a kind OSM holds nothing of must not be named
 * at all.
 */
export function summariseExisting(features: readonly { tag: string }[]): string {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const noun = feature.tag.replace(/_/g, ' ');
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const parts = [...counts].map(([noun, count]) =>
    count === 1 ? `a ${noun}` : `${count} ${noun}${noun.endsWith('s') ? '' : 's'}`,
  );
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Where a caption sits on screen once its coordinate has been projected. */
interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  active?: boolean;
}

  /** The review source and its layers. Module scope: it closes over no state. */
const addFeatureLayers = (instance: MapLibreMap, features: CourseFeature[]) => {
  {
    /*
     * Seeded with whatever is already drawn, not with an empty collection.
     * `onMapReady` fires at construction, before the style will take a source,
     * so the add lands later — by which time the effect that pushes features
     * has already run and will not run again until they next change. Created
     * empty, the source stayed empty and the contributor's line was invisible
     * until they happened to click once more.
     */
    instance.addSource(FEATURE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    instance.addLayer({
      id: FILL_LAYER,
      type: 'fill',
      source: FEATURE_SOURCE,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': STATUS_COLOR,
        /* A suggestion sits lighter on the imagery than something confirmed, and
         * what OSM already holds is lighter again — it is the ground the
         * contributor is working over, not the thing they are working on. */
        'fill-opacity': [
          'case',
          ['==', ['get', 'status'], 'proposed'],
          0.1,
          ['==', ['get', 'status'], 'existing'],
          0.12,
          ['==', ['get', 'status'], 'saved'],
          0.06,
          ['==', ['get', 'status'], 'active'],
          0.2,
          0.16,
        ],
      },
    } as never);
    instance.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: FEATURE_SOURCE,
      /* Everything but the suggestions, which the dashed layer below owns. */
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'status'], 'proposed']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': STATUS_COLOR, 'line-width': STATUS_WIDTH },
    } as never);
    instance.addLayer({
      id: PROPOSED_LINE_LAYER,
      type: 'line',
      source: FEATURE_SOURCE,
      filter: PROPOSED_FILTER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': STATUS_COLOR,
        'line-dasharray': [2, 2],
        /* The one being asked about is drawn heavier than the ones queued behind it. */
        'line-width': ['case', ['==', ['get', 'focus'], true], 3.5, 2],
      },
    } as never);
    instance.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: FEATURE_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': STATUS_COLOR,
        'circle-stroke-width': 2,
        'circle-stroke-color': 'rgba(6,43,38,.8)',
      },
    } as never);
  }
};

const H3 = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: '-.015em',
  color: '#fff',
  margin: '0 0 8px',
  textWrap: 'pretty',
} as const;

const NOTE = { margin: '0 0 16px', fontSize: 14, color: 'var(--green-200)', textWrap: 'pretty' } as const;

const GHOST_HOVER = { background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' };

/** The mint plate across the top of the map: what the next click will do. */
function MapPrompt({
  children,
  onCancel,
  cancelLabel = 'Never mind',
  tone = 'mint',
}: {
  children: ReactNode;
  onCancel?: () => void;
  cancelLabel?: string;
  tone?: 'mint' | 'amber';
}) {
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        top: 78,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100% - 40px)',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        background: tone === 'amber' ? '#e9b45a' : 'var(--mint-400)',
        color: 'var(--green-950)',
        borderRadius: 'var(--radius-md)',
        padding: '11px 14px',
        fontSize: 14,
        fontWeight: 600,
        boxShadow: 'var(--shadow-lg)',
        animation: 'ogRise 190ms var(--ease-out)',
        zIndex: 4,
      }}
    >
      <span>{children}</span>
      {onCancel && (
        <button
          onClick={onCancel}
          style={{
            background: 'rgba(6,43,38,.14)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            height: 26,
            padding: '0 10px',
            color: 'var(--green-950)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {cancelLabel}
        </button>
      )}
    </div>
  );
}

function LegendSwatch({ color, dashed, children }: { color: string; dashed?: boolean; children: ReactNode }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 18, height: 0, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, display: 'block' }} />
      {children}
    </span>
  );
}

/** Yards along the line against the card, with the verdict. */
function YardageCheck({
  yards,
  lineFromOsm,
  teeSetName,
  cardText,
  verdict,
}: {
  yards: number;
  lineFromOsm: boolean;
  teeSetName: string;
  cardText: string | number;
  verdict: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: 10,
        background: 'var(--green-900)',
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: 'var(--radius-md)',
        padding: '12px 14px',
        marginBottom: 14,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        color: 'var(--green-100)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: '#fff', fontSize: 20 }}>{yards}</span>
      <span>yd along {lineFromOsm ? "OpenStreetMap's line" : 'this line'}</span>
      <span
        style={{
          marginLeft: 'auto',
          color: verdict === LOCATE_CLOSE_ENOUGH ? 'var(--mint-400)' : 'var(--amber-500)',
        }}
      >
        the {teeSetName} tees say {cardText} — {verdict ?? 'no card to check'}
      </span>
    </div>
  );
}

export function ReviewScreen({ mapper, now }: { mapper: Mapper; now?: Date }) {
  const { state, derived, actions } = mapper;
  const {
    hi,
    holeNumber: holeNum,
    cardYds,
    holePar,
    holeHandicapIndex,
    step,
    allDone,
    isLocate,
    locatePoints,
    locateDone,
    canConfirmLine,
    detecting,
    locateYds,
    locateVerdict,
    lineFromOsm,
    lineSource,
    existing,
    osmHoleRef,
    features,
    labels,
    mapBounds,
    scorecard,
    summary,
    question,
    teeSets,
    hazards,
    activeProposal,
    editablePaths,
    rejectedHere,
    canSave,
    detectionImagery,
  } = derived;

  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [imagery, setImagery] = useState<ImageryStatus>('loading');
  const [placed, setPlaced] = useState<PlacedLabel[]>([]);
  const [corridorAsked, setCorridorAsked] = useState(false);

  /* The corridor overlay, on demand (R9) — only when it can honestly be drawn. */
  const corridor = corridorOverlay(detectionImagery);
  const corridorSpec = corridor?.status === 'ready' ? corridor.spec : null;
  const showingCorridor = corridorAsked && corridorSpec !== null;

  const course = state.course;
  const cardText = cardYds ?? '—';
  const imageryFailed = imagery === 'error';
  const interaction = state.interaction;
  const drawingLine = isLocate && !locateDone && lineSource === 'drawn' && !detecting;
  const placing =
    !imageryFailed && (interaction.kind === 'place' || interaction.kind === 'pick' || drawingLine);

  const teeSetName =
    course?.tees.find((tee) => tee.color === state.teeSet)?.name ?? course?.tees[0]?.name ?? 'the card';

  const measurement =
    state.mode === 'attention'
      ? `${state.attentionResolved ? 374 : 250} yd tee to green`
      : locatePoints.length >= 2
        ? `${locateYds} yd along ${lineFromOsm ? "OpenStreetMap's line" : 'the line'}`
        : 'no line drawn yet';

  /*
   * The camera is set when a hole opens — on the hole when it already has
   * geometry, on the course when it does not — and once more when the line is
   * confirmed, so a hole drawn from a course-wide view is then worked on up
   * close. Never while the contributor is drawing: re-fitting then would move
   * the imagery out from under the point they were about to click.
   */
  const frame = useRef<{ hole: number; locked: boolean; bounds: MapBounds | undefined } | null>(null);
  if (!frame.current || frame.current.hole !== hi || frame.current.locked !== locateDone) {
    frame.current = { hole: hi, locked: locateDone, bounds: mapBounds ?? undefined };
  }

  /*
   * One source and four layers, added as soon as the style will take them.
   * `isStyleLoaded()` is false whenever any tile is still loading, so this
   * attempts the add immediately and retries on `styledata`.
   */
  const handleMapReady = useCallback((instance: MapLibreMap) => {
    const draw = () => {
      try {
        if (instance.getSource(FEATURE_SOURCE)) {
          instance.off('styledata', draw);
          return;
        }
        addFeatureLayers(instance, featuresRef.current);
        instance.off('styledata', draw);
      } catch {
        /* The style will not take layers yet; `styledata` brings us back. */
      }
    };
    draw();
    instance.on('styledata', draw);
    setMap(instance);
  }, []);

  const featuresRef = useRef(features);
  featuresRef.current = features;
  const featuresKey = JSON.stringify(features);
  useEffect(() => {
    if (!map) return;
    const source = map.getSource(FEATURE_SOURCE) as { setData?: (data: unknown) => void } | undefined;
    source?.setData?.({ type: 'FeatureCollection', features });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featuresKey stands in for features
  }, [map, featuresKey]);

  /* Captions are anchored to coordinates and re-projected as the camera moves. */
  const labelsKey = JSON.stringify(labels);
  useEffect(() => {
    if (!map) return;
    const project = () => {
      setPlaced(
        labels.map((label) => {
          const point = map.project(label.position as [number, number]);
          return { key: label.key, text: label.text, x: point.x, y: point.y, active: label.active };
        }),
      );
    };
    project();
    map.on('move', project);
    map.on('zoom', project);
    return () => {
      map.off('move', project);
      map.off('zoom', project);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsKey stands in for labels
  }, [map, labelsKey]);

  /* Drag handles on the line while it is being checked, and on outlines being fixed. */
  const editor = useShapeEditor(map, editablePaths, (id, coords) => {
    if (id === 'line') actions.moveLine(coords);
    else actions.moveShape(id, coords);
  });

  /*
   * Each new question flies the camera to what it is about: onto the green for
   * "Is that the green?", across every bunker for the sand, onto each box in
   * turn for the tees. Keyed on the question, not on the shapes, so dragging an
   * edge or picking a different box never yanks the map away mid-thought — it
   * moves only when the rail moves on. Animated so the contributor sees where
   * they went; instant for anyone who has asked for reduced motion.
   */
  const questionKey =
    !isLocate && !allDone && step && interaction.kind === 'none' ? `${hi}:${state.step}:${state.teeIndex}` : '';
  const framedQuestion = useRef('');
  useEffect(() => {
    if (!map || !questionKey || framedQuestion.current === questionKey) return;
    const ids = new Set(derived.activeShapeIds);
    const coords = state.shapes.filter((shape) => ids.has(shape.id)).flatMap((shape) => shape.ring);
    if (coords.length === 0) return;
    framedQuestion.current = questionKey;
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const reduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    try {
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        /* Close enough to judge an edge, not so close the green fills the screen
         * with no surround to judge it against. The right padding clears the
         * credits panel; the top clears the prompts. */
        { padding: { top: 130, bottom: 110, left: 90, right: 90 }, maxZoom: 18.5, duration: reduced ? 0 : 900, essential: true },
      );
    } catch {
      /* A map that cannot fit yet has nothing on screen to move. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the question changes
  }, [map, questionKey]);

  /*
   * An outline opened for editing is brought close enough to grab. A bunker
   * dropped at hole-wide zoom is twenty pixels across, and ten handles on it
   * are one blob; past a couple of hundred pixels it is already workable and
   * the camera is left where the contributor put it.
   */
  const editingKey =
    interaction.kind === 'edit' ? interaction.shapeIds.join(',') : interaction.kind === 'new' ? interaction.shapeId : '';
  useEffect(() => {
    if (!map || !editingKey) return;
    const coords = editablePaths.flatMap((path) => path.coords);
    if (coords.length === 0) return;
    try {
      const points = coords.map((c) => map.project(c as [number, number]));
      const span = Math.max(
        Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
        Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
      );
      if (span >= 180) return;
      const lngs = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 140, maxZoom: 19.5, duration: 350 },
      );
    } catch {
      /* A map that cannot project yet has nothing on screen to be too small. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a different outline is opened
  }, [map, editingKey]);

  /* R19: with no imagery under the cursor there is nothing to place a point on.
   * And letting go of a drag handle is not a click on the map. */
  const handleMapClick = useCallback(
    (position: LngLat) => {
      if (imageryFailed || editor.hitsHandle(position)) return;
      actions.onMapClick(position);
    },
    [imageryFailed, editor, actions],
  );

  const currentTee = teeSets[state.teeIndex] ?? null;
  const stepKind = step?.kind ?? null;
  const editingShapes =
    interaction.kind === 'edit'
      ? state.shapes.filter((shape) => interaction.shapeIds.includes(shape.id))
      : [];
  const editNoun =
    editingShapes.length === 0
      ? 'shape'
      : editingShapes.length > 1
        ? plural(SHAPE_NOUN[editingShapes[0].kind])
        : SHAPE_NOUN[editingShapes[0].kind];
  const newShape =
    interaction.kind === 'new' ? state.shapes.find((shape) => shape.id === interaction.shapeId) ?? null : null;

  const stepCounter = isLocate
    ? 'first, the line of the hole'
    : allDone
      ? 'all checks done'
      : `check ${state.step + 1} of ${STEPS.length}`;

  /* --- What the map is waiting for, said across its top ------------------- */
  let prompt: ReactNode = null;
  if (!imageryFailed) {
    if (interaction.kind === 'place') {
      prompt = (
        <MapPrompt onCancel={actions.cancelInteraction}>
          {interaction.replacing && interaction.shape === 'green'
            ? 'Click the green you putt on.'
            : `Click the map where the ${SHAPE_NOUN[interaction.shape]} is.`}
        </MapPrompt>
      );
    } else if (interaction.kind === 'pick') {
      prompt =
        interaction.purpose === 'tee' ? (
          <MapPrompt onCancel={actions.cancelInteraction}>
            Click the box you play the {currentTee?.name.toLowerCase() ?? ''} tee from — open ground draws a new
            one.
          </MapPrompt>
        ) : (
          <MapPrompt onCancel={actions.cancelInteraction} tone="amber">
            Click the one that is not {stepKind === 'bunker' ? 'sand' : `a ${stepKind ? SHAPE_NOUN[stepKind] : 'match'}`}.
          </MapPrompt>
        );
    } else if (interaction.kind === 'edit' || interaction.kind === 'new') {
      prompt = <MapPrompt>Drag the white dots. Drag a small dot to add a corner; right-click a dot to remove it.</MapPrompt>;
    } else if (isLocate && !locateDone && !detecting) {
      prompt =
        lineSource === 'osm' ? (
          <MapPrompt>Drag any dot that misses a bend.</MapPrompt>
        ) : locatePoints.length === 0 ? (
          <MapPrompt>Click the tee you play from.</MapPrompt>
        ) : locatePoints.length === 1 ? (
          <MapPrompt>Click the turn in the fairway, or the green.</MapPrompt>
        ) : (
          <MapPrompt>Click another turn, or drag a dot to fix the line.</MapPrompt>
        );
    }
  }

  const showLegend = interaction.kind === 'none' && !(isLocate && !locateDone);

  return (
    <section style={{ display: 'grid', gridTemplateColumns: '1fr 428px', height: 'calc(100vh - 56px)' }}>
      {/* ---------- Map pane ---------- */}
      <div style={{ position: 'relative', overflow: 'hidden', background: '#22321f' }}>
        <BaseMap
          bounds={frame.current.bounds}
          center={course ? [course.longitude, course.latitude] : undefined}
          label={osmHoleRef ? `Hole ${holeNum} · ${osmHoleRef}` : `Hole ${holeNum}`}
          note={`${measurement} · ${teeSetName} says ${cardText}`}
          onMapReady={handleMapReady}
          onMapClick={handleMapClick}
          onImageryStatusChange={setImagery}
          overlay={corridorSpec}
          overlayVisible={showingCorridor}
          overlayBeneathLayerId={FILL_LAYER}
        >
          {placing && (
            <div style={{ position: 'absolute', inset: 0, cursor: 'crosshair', pointerEvents: 'none' }} aria-hidden="true" />
          )}

          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
            {placed.map((label) => (
              <span
                key={label.key}
                style={{
                  position: 'absolute',
                  left: label.x,
                  top: label.y,
                  transform: 'translate(-50%, calc(-100% - 12px))',
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 24,
                  padding: '0 9px',
                  borderRadius: 6,
                  background: label.active ? 'var(--mint-400)' : 'rgba(6,43,38,.86)',
                  color: label.active ? '#062b26' : '#d3efe4',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  letterSpacing: '.02em',
                  whiteSpace: 'nowrap',
                  boxShadow: '0 1px 6px rgba(6,43,38,.4)',
                }}
              >
                {label.text}
              </span>
            ))}
          </div>

          {prompt}

          {showLegend && (
            <div
              style={{
                position: 'absolute',
                bottom: 20,
                left: 20,
                display: 'flex',
                flexWrap: 'wrap',
                maxWidth: 'calc(100% - 520px)',
                minWidth: 220,
                gap: '8px 18px',
                background: 'rgba(6,43,38,.78)',
                border: '1px solid rgba(255,255,255,.12)',
                borderRadius: 'var(--radius-md)',
                padding: '9px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--green-200)',
              }}
            >
              <LegendSwatch color={ACTIVE_COLOR}>asking you now</LegendSwatch>
              {/* R8: the suggestion layer says what it is, in its own hue and dashed. */}
              <LegendSwatch color={PROPOSED_COLOR} dashed>
                we suggest — not yours yet
              </LegendSwatch>
              <LegendSwatch color={CONFIRMED_COLOR}>you confirmed</LegendSwatch>
              {(lineFromOsm || existing.length > 0) && (
                <LegendSwatch color={EXISTING_COLOR}>already in OpenStreetMap</LegendSwatch>
              )}
              {state.previous.length > 0 && <LegendSwatch color={SAVED_COLOR}>you saved earlier</LegendSwatch>}
            </div>
          )}
        </BaseMap>
      </div>

      {/* ---------- Review rail ---------- */}
      <div
        style={{
          background: 'var(--green-900)',
          borderLeft: '1px solid rgba(255,255,255,.1)',
          padding: 22,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {state.mode === 'attention' && (
          <div
            style={{
              background: 'rgba(201,138,21,.14)',
              border: '1px solid rgba(201,138,21,.55)',
              borderRadius: 'var(--radius-lg)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8, color: '#eec98a' }}>
              <Icon name="circle-alert" size={18} />
              <span style={{ fontSize: 15, fontWeight: 700, color: '#f6e3bd' }}>
                {state.attentionResolved ? 'Sorted — 374 yards, that matches.' : 'This one does not add up.'}
              </span>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 14, color: '#f2e0c4', textWrap: 'pretty' }}>
              {state.attentionResolved
                ? 'We swapped in the green further up the hole. Everything below is back to a normal check.'
                : `Tee to green measures 250 yards. Your card says hole ${holeNum} plays ${cardText} from the ${teeSetName.toLowerCase()} tee. Usually that means we grabbed the wrong green — pick the one you putt on.`}
            </p>
            {!state.attentionResolved && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { key: 'A', label: 'The nearer green, short right', yds: 250, verdict: '128 yd short', verdictColor: '#eec98a', note: 'Kept the near green — we will re-measure.' },
                  { key: 'B', label: 'The green up by the cypress', yds: 374, verdict: 'matches the card', verdictColor: 'var(--mint-400)', note: 'Right green. Back on track.' },
                ].map((g) => (
                  <HoverButton
                    key={g.key}
                    onClick={() => actions.resolveAttention(g.note)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      textAlign: 'left',
                      background: 'var(--green-800)',
                      border: '1px solid rgba(255,255,255,.16)',
                      borderRadius: 'var(--radius-md)',
                      padding: '12px 14px',
                      cursor: 'pointer',
                    }}
                    hoverStyle={{ borderColor: 'var(--mint-400)', background: 'var(--green-700)' }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 999,
                        border: '1.5px solid var(--mint-400)',
                        color: 'var(--mint-400)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                      }}
                    >
                      {g.key}
                    </span>
                    <span style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 14, color: '#fff', fontWeight: 600 }}>{g.label}</span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)', marginTop: 2 }}>
                        plays {g.yds} yd from the back tee
                      </span>
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: g.verdictColor }}>{g.verdict}</span>
                  </HoverButton>
                ))}
                <button
                  onClick={() => actions.resolveAttention('Noted — we will trust what you see over the card.')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--green-200)',
                    fontSize: 13,
                    textAlign: 'left',
                    padding: '4px 2px',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Neither — the yardage on my card is different
                </button>
              </div>
            )}
          </div>
        )}

        {/* The card, named for the hole it belongs to. */}
        <div style={{ background: 'var(--green-800)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ ...EYEBROW, color: 'var(--green-200)' }}>Hole {holeNum}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--mint-400)', marginLeft: 'auto' }}>
                par {holePar ?? '—'} · index {holeHandicapIndex ?? '—'}
              </span>
            </div>
            {course?.name && (
              <div
                title={course.name}
                style={{
                  marginTop: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--green-100)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {course.name}
              </div>
            )}
          </div>
          {scorecard.length === 0 && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)' }}>
              No yardages for this hole in the course record.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {scorecard.map((t) => (
              <div
                key={t.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: 'var(--green-100)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 2, background: t.swatch, display: 'block' }} />
                <span style={{ flex: 1 }}>{t.name}</span>
                <span style={{ color: '#fff' }}>{t.yd}</span>
                <span style={{ color: 'var(--green-200)', fontSize: 11 }}>yd</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...EYEBROW, color: 'var(--green-200)' }}>{stepCounter}</span>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {!isLocate &&
              STEPS.map((entry, i) => (
                <span
                  key={entry.id}
                  title={entry.kicker}
                  style={{
                    width: 22,
                    height: 5,
                    borderRadius: 3,
                    display: 'block',
                    background:
                      i < state.step ? 'var(--mint-400)' : i === state.step && !allDone ? 'rgba(62,207,180,.55)' : 'rgba(255,255,255,.14)',
                  }}
                />
              ))}
          </div>
        </div>

        {/* ---------- 1. The line of the hole ---------- */}
        {isLocate && (
          <div style={RAIL_CARD}>
            {detecting ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      background: 'var(--mint-400)',
                      display: 'block',
                      animation: 'ogPulse 1.2s var(--ease-out) infinite',
                    }}
                  />
                  <span style={{ ...EYEBROW, color: 'var(--mint-400)' }}>Reading the imagery</span>
                </div>
                <h3 style={{ ...H3, fontSize: 20 }}>Your line is locked in.</h3>
                <p style={NOTE}>Looking along it for the tees, the green, the fairway and the sand. A few seconds — longer the first time.</p>
                <HoverButton onClick={actions.cancelProposals} style={{ ...GHOST_BUTTON, width: '100%' }} hoverStyle={GHOST_HOVER}>
                  Stop looking — I will map it myself
                </HoverButton>
              </>
            ) : (
              <>
                <div style={{ ...EYEBROW, color: lineFromOsm ? EXISTING_COLOR : 'var(--mint-400)', marginBottom: 10 }}>
                  {lineFromOsm ? 'Already in OpenStreetMap' : locatePoints.length >= 2 ? 'First, the hole itself' : 'Nothing here yet'}
                </div>
                <h3 style={H3}>{locatePoints.length >= 2 ? 'Does the hole run this way?' : 'Walk us down the hole.'}</h3>
                <p style={NOTE}>
                  {locatePoints.length >= 2 ? (
                    <>
                      Tee at the first dot, green at the last. Drag any dot if the line misses a bend — drag a small dot
                      to add one, right-click a dot to take it out. Everything we look for hangs off this line.
                      {lineFromOsm && osmHoleRef && (
                        <>
                          {' '}
                          OpenStreetMap files this hole as <strong>{osmHoleRef}</strong>.
                        </>
                      )}
                    </>
                  ) : (
                    'Click the furthest-back tee, click each turn in the fairway, then click the green you putt on. Most holes take two or three clicks.'
                  )}
                </p>

                {existing.length > 0 && (
                  <div style={{ ...STEP_ROW, alignItems: 'flex-start', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                      outlined on this hole already
                    </span>
                    <span style={{ fontSize: 13, color: '#fff', textWrap: 'pretty' }}>{summariseExisting(existing)}</span>
                  </div>
                )}

                {/* R15: the card the line is checked against is the set you played. */}
                <div style={{ ...STEP_ROW, marginBottom: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)', width: 74 }}>measuring</span>
                  <select
                    value={state.teeSet ?? ''}
                    onChange={(e) => actions.setTeeSet(e.target.value)}
                    aria-label="Tee set to measure against"
                    style={{
                      flex: 1,
                      height: 32,
                      background: 'var(--green-800)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,.18)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0 8px',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {(course?.tees ?? []).map((tee) => (
                      <option key={tee.color} value={tee.color}>
                        from the {tee.name} tees
                      </option>
                    ))}
                  </select>
                </div>

                {locatePoints.length >= 2 && (
                  <YardageCheck
                    yards={locateYds}
                    lineFromOsm={lineFromOsm}
                    teeSetName={teeSetName}
                    cardText={cardText}
                    verdict={locateVerdict}
                  />
                )}

                {/* Detection answered, or was stopped: say so, and keep both ways on. */}
                {locateDone ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {state.detect.status === 'no_coverage' && (
                      <RailNotice>
                        Nothing to propose on this hole — {state.detect.message} Nothing went wrong; every step is yours to
                        draw.
                      </RailNotice>
                    )}
                    {state.detect.status === 'failed' && (
                      <RailNotice tone="danger">
                        Detection did not finish — {state.detect.message} The hole is still yours to map by hand.
                      </RailNotice>
                    )}
                    <Button size="lg" variant="accent" fullWidth onClick={actions.confirmLocate}>
                      Carry on and map it by hand
                    </Button>
                    <HoverButton onClick={actions.requestProposals} style={{ ...GHOST_BUTTON, height: 42 }} hoverStyle={GHOST_HOVER}>
                      Look in the imagery again
                    </HoverButton>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    <Button size="lg" variant="accent" fullWidth onClick={actions.confirmLine} disabled={!canConfirmLine}>
                      {locatePoints.length >= 2 ? 'Yes, that is the hole' : 'Click the tee and the green first'}
                    </Button>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                      {lineSource === 'drawn' ? (
                        <HoverButton
                          onClick={actions.undoLastPoint}
                          disabled={locatePoints.length === 0}
                          style={{ ...GHOST_BUTTON, opacity: locatePoints.length === 0 ? 0.45 : 1 }}
                          hoverStyle={GHOST_HOVER}
                        >
                          Undo last point
                        </HoverButton>
                      ) : (
                        <span />
                      )}
                      <HoverButton onClick={actions.resetLocate} style={GHOST_BUTTON} hoverStyle={GHOST_HOVER}>
                        {lineSource === 'osm' ? 'Draw it myself' : 'Start over'}
                      </HoverButton>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ---------- 2. Reshaping an outline ---------- */}
        {!isLocate && interaction.kind === 'edit' && (
          <div style={{ ...RAIL_CARD, border: '1px solid var(--mint-400)', animation: 'ogRise 190ms var(--ease-out)' }}>
            <div style={{ ...EYEBROW, color: 'var(--mint-400)', marginBottom: 10 }}>Editing the {editNoun} outline</div>
            <h3 style={{ ...H3, fontSize: 20 }}>Pull the dots until it fits.</h3>
            <p style={NOTE}>
              Every corner of the {editNoun} is draggable on the map. Drag the small dots between them to add a corner,
              right-click one to take it out. Nothing else changes while you do this.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button size="lg" variant="accent" fullWidth onClick={actions.finishEdit}>
                Save this shape
              </Button>
              <HoverButton onClick={actions.resetEdit} style={{ ...GHOST_BUTTON, height: 40 }} hoverStyle={GHOST_HOVER}>
                {editingShapes.some((shape) => shape.origin === 'osm')
                  ? 'Put it back how OpenStreetMap has it'
                  : 'Put it back how we drew it'}
              </HoverButton>
            </div>
          </div>
        )}

        {/* ---------- 3. A shape just dropped or picked ---------- */}
        {!isLocate && newShape && (
          <div style={{ ...RAIL_CARD, border: '1px solid var(--mint-400)', animation: 'ogRise 190ms var(--ease-out)' }}>
            <div style={{ ...EYEBROW, color: 'var(--mint-400)', marginBottom: 10 }}>
              {newShape.origin === 'drawn' ? `Your new ${SHAPE_NOUN[newShape.kind]}` : `That ${SHAPE_NOUN[newShape.kind]}`}
            </div>
            <h3 style={{ ...H3, fontSize: 20 }}>Pull the dots until it fits.</h3>
            <p style={NOTE}>
              {newShape.origin === 'drawn'
                ? `We dropped a rough ${SHAPE_NOUN[newShape.kind]} where you clicked. Drag its corners to match what is on the ground.`
                : `Drag its corners to match what is on the ground, then save it.`}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button size="lg" variant="accent" fullWidth onClick={actions.confirmNew}>
                Save this {SHAPE_NOUN[newShape.kind]}
              </Button>
              <HoverButton onClick={actions.discardNew} style={{ ...GHOST_BUTTON, height: 40 }} hoverStyle={GHOST_HOVER}>
                Remove it
              </HoverButton>
            </div>
          </div>
        )}

        {/* ---------- 4. The question ---------- */}
        {!isLocate && question && (interaction.kind === 'none' || interaction.kind === 'place' || interaction.kind === 'pick') && (
          <div style={{ ...RAIL_CARD, opacity: interaction.kind === 'none' ? 1 : 0.6 }}>
            <div style={{ ...EYEBROW, color: 'var(--mint-400)', marginBottom: 10 }}>{question.kicker}</div>
            <h3 style={H3}>{question.title}</h3>
            <p style={NOTE}>{question.note}</p>

            {step?.id === 'tees' && teeSets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {teeSets.map((tee, i) => {
                  const current = i === state.teeIndex;
                  const box = state.teeBoxes[tee.key];
                  const stateText = current
                    ? box
                      ? 'highlighted'
                      : 'no box yet'
                    : i < state.teeIndex
                      ? box
                        ? 'matched'
                        : 'no tee'
                      : box
                        ? 'our guess'
                        : 'no box';
                  return (
                    <div
                      key={tee.key}
                      style={{
                        ...STEP_ROW,
                        padding: '10px 12px',
                        background: current ? 'rgba(62,207,180,.16)' : 'var(--green-900)',
                        border: `1px solid ${current ? 'var(--mint-400)' : 'rgba(255,255,255,.12)'}`,
                      }}
                    >
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: tee.swatch, display: 'block' }} />
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: current ? '#fff' : 'var(--green-100)' }}>
                        {tee.name}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)', fontVariantNumeric: 'tabular-nums' }}>
                        {tee.yards} yd
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          width: 82,
                          textAlign: 'right',
                          color: current ? 'var(--mint-400)' : box === undefined && i >= state.teeIndex ? PROPOSED_COLOR : 'var(--green-200)',
                        }}
                      >
                        {stateText}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {step?.id === 'hazards' && hazards.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {hazards.map((hazard, i) => (
                  <div
                    key={hazard.id}
                    style={{
                      background: 'var(--green-900)',
                      border: `1px solid ${hazard.hazardType ? 'rgba(255,255,255,.12)' : PROPOSED_COLOR}`,
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ flex: 1, fontSize: 14, color: '#fff', fontWeight: 600 }}>
                        Hazard {i + 1}
                        {hazard.fromSaved && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: SAVED_COLOR, fontWeight: 400 }}>
                            {' '}
                            · you saved it earlier
                          </span>
                        )}
                        {!hazard.fromSaved && hazard.origin === 'proposed' && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: PROPOSED_COLOR, fontWeight: 400 }}>
                            {' '}
                            · we spotted it
                          </span>
                        )}
                        {!hazard.fromSaved && hazard.origin === 'osm' && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: EXISTING_COLOR, fontWeight: 400 }}>
                            {' '}
                            · already in OpenStreetMap
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => actions.startEdit([hazard.id])}
                        style={{ ...GHOST_BUTTON, height: 26, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 400, padding: '0 9px' }}
                      >
                        edges
                      </button>
                      <button
                        onClick={() => actions.removeShape(hazard.id)}
                        style={{ ...GHOST_BUTTON, height: 26, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 400, padding: '0 9px' }}
                      >
                        remove
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label={`What hazard ${i + 1} is`}>
                      {HAZARD_TYPES.map(({ type, label }) => {
                        const chosen = hazard.hazardType === type;
                        return (
                          <button
                            key={type}
                            role="radio"
                            aria-checked={chosen}
                            onClick={() => actions.setHazardType(hazard.id, type)}
                            style={{
                              background: chosen ? 'rgba(62,207,180,.18)' : 'var(--green-800)',
                              border: `1px solid ${chosen ? 'var(--mint-400)' : 'rgba(255,255,255,.14)'}`,
                              borderRadius: 'var(--radius-sm)',
                              height: 30,
                              padding: '0 11px',
                              color: chosen ? '#fff' : 'var(--green-100)',
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* R5, R9: where a suggestion came from, before it is answered. */}
            <ProvenancePanel
              proposal={activeProposal}
              imagery={detectionImagery}
              corridor={corridor}
              showing={showingCorridor}
              onToggle={() => setCorridorAsked((shown) => !shown)}
              now={now}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button
                size="lg"
                variant="accent"
                fullWidth
                onClick={() => actions.accept()}
                disabled={question.acceptDisabled || interaction.kind !== 'none'}
              >
                {question.accept}
              </Button>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {question.actions.map((action) => (
                  <HoverButton
                    key={action.id}
                    onClick={() => actions.runAction(action.id)}
                    disabled={interaction.kind !== 'none'}
                    style={{ ...GHOST_BUTTON, flex: '1 1 44%', minWidth: 150, height: 44, fontSize: 14 }}
                    hoverStyle={GHOST_HOVER}
                  >
                    {action.label}
                  </HoverButton>
                ))}
              </div>
            </div>

            {/* R10: a rejection is a record. Say so where it was made. */}
            {rejectedHere.length > 0 && (
              <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                {rejectedHere.length} turned down on this hole — kept, not discarded.
              </div>
            )}

            <div style={{ marginTop: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
              {step?.id === 'hazards' ? 'A to accept · M to draw one' : 'A to accept · N for the first “no” · M missed one · Esc to back out'}
            </div>
          </div>
        )}

        {state.lastAction && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              background: 'var(--green-950)',
              border: '1px solid rgba(255,255,255,.1)',
              borderRadius: 'var(--radius-md)',
              padding: '11px 14px',
              fontSize: 13,
              color: 'var(--green-100)',
              animation: 'ogRise 190ms var(--ease-out)',
            }}
          >
            <span style={{ color: 'var(--mint-400)', display: 'flex' }}>
              <Icon name="circle-check" size={16} />
            </span>
            {state.lastAction}
          </div>
        )}

        {/* ---------- 5. Save the hole ---------- */}
        {!isLocate && allDone && (
          <div
            style={{
              background: 'var(--green-800)',
              border: '1px solid var(--mint-400)',
              borderRadius: 'var(--radius-lg)',
              padding: 18,
              animation: 'ogRise 190ms var(--ease-out)',
            }}
          >
            <h3 style={{ ...H3, fontSize: 20, margin: '0 0 10px' }}>Hole {holeNum}, confirmed.</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
              {summary.map((text) => (
                <div
                  key={text}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--green-100)' }}
                >
                  <span style={{ color: 'var(--mint-400)', display: 'flex' }}>
                    <Icon name="check" size={14} />
                  </span>
                  {text}
                </div>
              ))}
            </div>
            {state.save.status === 'failed' && (
              <div style={{ marginBottom: 12 }}>
                <RailNotice tone="danger">
                  Not saved — {state.save.message} Everything is still here; try again when the service is back.
                </RailNotice>
              </div>
            )}
            <Button size="lg" variant="accent" fullWidth onClick={actions.saveHole} disabled={!canSave}>
              {state.save.status === 'saving'
                ? 'Saving …'
                : state.save.status === 'failed'
                  ? `Try saving hole ${holeNum} again`
                  : `Save hole ${holeNum}`}
            </Button>
          </div>
        )}

        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
          <HoverButton
            onClick={() => actions.go('board')}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,.18)',
              borderRadius: 'var(--radius-md)',
              height: 36,
              padding: '0 14px',
              color: 'var(--green-100)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            hoverStyle={{ background: 'rgba(255,255,255,.07)' }}
          >
            Back to the holes
          </HoverButton>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
            nothing is saved until you finish the hole
          </span>
        </div>
      </div>
    </section>
  );
}
