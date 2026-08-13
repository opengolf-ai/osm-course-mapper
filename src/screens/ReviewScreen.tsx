/**
 * One hole, on real aerial imagery.
 *
 * The screen opens in the playing-line flow, because the line is what everything
 * else is bounded by: the contributor clicks the tee, any points where the hole
 * bends, then the green; the line is measured along its path and checked against
 * the tee set they started from. Only once it is finished can detection be asked
 * for the hole's features, and a detection that fails, times out or finds nothing
 * leaves the hand-mapping path exactly where it was (R12).
 *
 * Everything drawn is WGS84 GeoJSON on one MapLibre source. Pending, active,
 * proposed and confirmed styling comes from each feature's own `status` property
 * through a `match` expression, rather than from parallel arrays of path strings.
 *
 * What detection proposes is drawn as a suggestion — its own hue, dashed, lighter
 * fill — and stays that way until the contributor has answered about that one
 * feature (R8, KTD8). The review sequence walks them one at a time; nothing here
 * can confirm a batch, and no answer is inferred from moving on.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { STEPS, TEE_IDS, TEE_POSITIONS } from '../data/course';
import type { LngLat } from '../geo/coords';
import { Button, Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';
import { BaseMap, type ImageryStatus } from '../map/BaseMap';
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

/** Where a caption sits on screen once its coordinate has been projected. */
interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
}

export function ReviewScreen({ mapper }: { mapper: Mapper }) {
  const { state, derived, actions } = mapper;
  const {
    hi,
    cardYds,
    holePar,
    holeHandicapIndex,
    q,
    allDone,
    isLocate,
    locatePoints,
    locateDone,
    canFinish,
    canRequestProposals,
    detecting,
    locateYds,
    locateVerdict,
    features,
    labels,
    mapBounds,
    scorecard,
    summary,
    /* The per-feature review (R7): one proposal on screen, and the copy for it. */
    stepTitle,
    stepNote,
    stepAccept,
    stepProposalCount,
    activeProposal,
    activePosition,
    stepNeedsInPlay,
    rejectedHere,
  } = derived;

  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [imagery, setImagery] = useState<ImageryStatus>('loading');
  const [placed, setPlaced] = useState<PlacedLabel[]>([]);

  const course = state.course;
  const holeNum = course?.holes[hi]?.number ?? hi + 1;
  /* The card is a real record now, so every number on it can be absent. */
  const cardText = cardYds ?? '—';
  const imageryFailed = imagery === 'error';
  const placing = (state.addMode !== null || (isLocate && !locateDone)) && !imageryFailed;

  const teeSetName =
    course?.tees.find((tee) => tee.color === state.teeSet)?.name ?? course?.tees[0]?.name ?? 'the card';

  /*
   * The caption reports a measurement or says there is not one — it never echoes
   * the card back as though the line had been drawn. The attention branch keeps
   * its own two numbers, which are copy in that panel, not a measurement.
   */
  const measurement =
    state.mode === 'attention'
      ? `${state.attentionResolved ? 374 : 250} yd tee to green`
      : locatePoints.length >= 2
        ? `${locateYds} yd along your line`
        : 'no line drawn yet';

  /*
   * The camera is set once per hole: to the hole when it already has geometry,
   * to the course when it does not. Re-fitting as the contributor draws would
   * move the imagery out from under the point they were about to click.
   */
  const frame = useRef<{ hole: number; bounds: MapBounds | undefined } | null>(null);
  if (!frame.current || frame.current.hole !== hi) {
    frame.current = { hole: hi, bounds: mapBounds ?? undefined };
  }

  /* One source and three layers, added once the style exists. */
  const handleMapReady = useCallback((instance: MapLibreMap) => {
    const draw = () => {
      if (instance.getSource(FEATURE_SOURCE)) return;
      instance.addSource(FEATURE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      instance.addLayer({
        id: FILL_LAYER,
        type: 'fill',
        source: FEATURE_SOURCE,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': STATUS_COLOR,
          /* A suggestion sits lighter on the imagery than something confirmed. */
          'fill-opacity': ['case', ['==', ['get', 'status'], 'proposed'], 0.1, 0.16],
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
    };
    if (instance.isStyleLoaded()) draw();
    else instance.once('load', draw);
    setMap(instance);
  }, []);

  /* Whatever the contributor has drawn, pushed to the map as it changes. */
  const featuresKey = JSON.stringify(features);
  useEffect(() => {
    if (!map) return;
    const source = map.getSource(FEATURE_SOURCE) as
      | { setData?: (data: unknown) => void }
      | undefined;
    source?.setData?.({ type: 'FeatureCollection', features });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featuresKey stands in for features
  }, [map, featuresKey]);

  /*
   * Captions are anchored to coordinates, not to the container, so they are
   * projected here and re-projected whenever the camera moves.
   */
  const labelsKey = JSON.stringify(labels);
  useEffect(() => {
    if (!map) return;
    const project = () => {
      setPlaced(
        labels.map((label) => {
          const point = map.project(label.position as [number, number]);
          return { key: label.key, text: label.text, x: point.x, y: point.y };
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

  /* R19: with no imagery under the cursor there is nothing to place a point on. */
  const handleMapClick = useCallback(
    (position: LngLat) => {
      if (imageryFailed) return;
      actions.onMapClick(position);
    },
    [imageryFailed, actions],
  );

  const stepCounter = isLocate
    ? locateDone
      ? 'the line you drew'
      : 'draw the line the hole plays'
    : allDone
      ? 'all checks done'
      : `check ${state.step + 1} of ${STEPS.length}`;

  const turnPoints = Math.max(locatePoints.length - 2, 0);

  return (
    <section style={{ display: 'grid', gridTemplateColumns: '1fr 428px', height: 'calc(100vh - 56px)' }}>
      {/* ---------- Map pane ---------- */}
      <div style={{ position: 'relative', overflow: 'hidden', background: '#22321f' }}>
        <BaseMap
          bounds={frame.current.bounds}
          center={course ? [course.longitude, course.latitude] : undefined}
          label={`Hole ${holeNum}`}
          note={`${measurement} · ${teeSetName} says ${cardText}`}
          onMapReady={handleMapReady}
          onMapClick={handleMapClick}
          onImageryStatusChange={setImagery}
        >
          {/* The click target sits above the canvas only to carry the cursor. */}
          {placing && (
            <div
              style={{ position: 'absolute', inset: 0, cursor: 'crosshair', pointerEvents: 'none' }}
              aria-hidden="true"
            />
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
                  background: 'rgba(6,43,38,.86)',
                  color: '#d3efe4',
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

          {state.addMode && !imageryFailed && (
            <div
              style={{
                position: 'absolute',
                top: 20,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                background: 'var(--mint-400)',
                color: 'var(--green-950)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                fontSize: 14,
                fontWeight: 600,
                boxShadow: 'var(--shadow-lg)',
                animation: 'ogRise 190ms var(--ease-out)',
              }}
            >
              Click the map where the {state.addMode} is.
              <button
                onClick={actions.cancelAdd}
                style={{
                  background: 'rgba(6,43,38,.14)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  height: 26,
                  padding: '0 10px',
                  color: 'var(--green-950)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                cancel
              </button>
            </div>
          )}

          {isLocate && !locateDone && !imageryFailed && (
            <div
              style={{
                position: 'absolute',
                top: 20,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'var(--mint-400)',
                color: 'var(--green-950)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                fontSize: 14,
                fontWeight: 600,
                boxShadow: 'var(--shadow-lg)',
                animation: 'ogRise 190ms var(--ease-out)',
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: 'rgba(6,43,38,.16)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                }}
              >
                {locatePoints.length + 1}
              </span>
              {locatePoints.length === 0
                ? 'Click where you tee off.'
                : 'Click where the hole bends, then the green you putt on.'}
            </div>
          )}

          <div
            style={{
              position: 'absolute',
              bottom: 20,
              left: 20,
              display: 'flex',
              gap: 18,
              background: 'rgba(6,43,38,.78)',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 'var(--radius-md)',
              padding: '9px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--green-200)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 18, height: 0, borderTop: '2px solid var(--mint-400)', display: 'block' }} />
              asking you now
            </span>
            {/* R8: the suggestion layer says what it is, in its own hue and dashed. */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{ width: 18, height: 0, borderTop: `2px dashed ${PROPOSED_COLOR}`, display: 'block' }}
              />
              we suggest — not yours yet
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{ width: 18, height: 0, borderTop: `2px solid ${CONFIRMED_COLOR}`, display: 'block' }}
              />
              you confirmed
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{ width: 18, height: 0, borderTop: `2px dashed ${PENDING_COLOR}`, display: 'block' }}
              />
              not asked yet
            </span>
          </div>
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
                {state.attentionResolved
                  ? 'Sorted — 374 yards, that matches.'
                  : 'This one does not add up.'}
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
                  {
                    key: 'A',
                    label: 'The nearer green, short right',
                    yds: 250,
                    verdict: '128 yd short',
                    verdictColor: '#eec98a',
                    note: 'Kept the near green — we will re-measure.',
                  },
                  {
                    key: 'B',
                    label: 'The green up by the cypress',
                    yds: 374,
                    verdict: 'matches the card',
                    verdictColor: 'var(--mint-400)',
                    note: 'Right green. Back on track.',
                  },
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
                      <span style={{ display: 'block', fontSize: 14, color: '#fff', fontWeight: 600 }}>
                        {g.label}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--green-200)',
                          marginTop: 2,
                        }}
                      >
                        plays {g.yds} yd from the back tee
                      </span>
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: g.verdictColor }}>
                      {g.verdict}
                    </span>
                  </HoverButton>
                ))}
                <button
                  onClick={() =>
                    actions.resolveAttention('Noted — we will trust what you see over the card.')
                  }
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

        <div
          style={{
            background: 'var(--green-800)',
            border: '1px solid rgba(255,255,255,.12)',
            borderRadius: 'var(--radius-lg)',
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ ...EYEBROW, color: 'var(--green-200)' }}>The card</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--mint-400)',
                marginLeft: 'auto',
              }}
            >
              par {holePar ?? '—'} · index {holeHandicapIndex ?? '—'}
            </span>
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
              STEPS.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 22,
                    height: 5,
                    borderRadius: 3,
                    display: 'block',
                    background:
                      i < state.step
                        ? 'var(--mint-400)'
                        : i === state.step && !allDone
                          ? 'rgba(62,207,180,.55)'
                          : 'rgba(255,255,255,.14)',
                  }}
                />
              ))}
          </div>
        </div>

        {isLocate && (
          <div style={RAIL_CARD}>
            <div style={{ ...EYEBROW, color: 'var(--mint-400)', marginBottom: 10 }}>Nothing here yet</div>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '-.015em',
                color: '#fff',
                margin: '0 0 8px',
                textWrap: 'pretty',
              }}
            >
              Show us where this hole plays.
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--green-200)', textWrap: 'pretty' }}>
              Click the tee, then a point wherever the hole bends, then the green you putt on. We
              measure along the line you drew — the same way your card counts a dogleg.
            </p>

            {/* R15: the card the line is checked against is the set you played. */}
            <div style={{ ...STEP_ROW, marginBottom: 10 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)', width: 74 }}>
                measuring
              </span>
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
              {[
                {
                  num: '1',
                  label: 'Where you tee off',
                  done: locatePoints.length >= 1,
                  state: locatePoints.length >= 1 ? 'marked' : 'click the map',
                },
                {
                  num: '2',
                  label: 'Where the hole bends',
                  done: turnPoints > 0,
                  state:
                    turnPoints > 0
                      ? `${turnPoints} point${turnPoints === 1 ? '' : 's'}`
                      : locatePoints.length >= 1
                        ? 'optional'
                        : 'next',
                },
                {
                  num: '3',
                  label: 'The green you putt on',
                  done: locateDone,
                  state: locateDone ? 'marked' : locatePoints.length >= 1 ? 'click, then finish' : 'next',
                },
              ].map((p) => {
                const ring = p.done ? 'var(--mint-400)' : locatePoints.length >= 1 ? '#fff' : 'var(--green-200)';
                return (
                  <div key={p.num} style={STEP_ROW}>
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        border: `1.5px solid ${ring}`,
                        color: ring,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                      }}
                    >
                      {p.num}
                    </span>
                    <span style={{ flex: 1, fontSize: 14, color: '#fff' }}>{p.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: ring }}>{p.state}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 14 }}>
              <HoverButton
                onClick={actions.undoLastPoint}
                disabled={locatePoints.length === 0}
                style={{ ...GHOST_BUTTON, opacity: locatePoints.length === 0 ? 0.45 : 1 }}
                hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
              >
                Undo last point
              </HoverButton>
              <HoverButton
                onClick={actions.finishLine}
                disabled={!canFinish}
                style={{
                  ...GHOST_BUTTON,
                  background: canFinish ? 'var(--mint-400)' : 'var(--green-900)',
                  color: canFinish ? 'var(--green-950)' : '#fff',
                  borderColor: canFinish ? 'var(--mint-400)' : 'rgba(255,255,255,.2)',
                  opacity: canFinish ? 1 : 0.45,
                }}
                hoverStyle={canFinish ? {} : { background: 'var(--green-900)' }}
              >
                Finish the line
              </HoverButton>
            </div>

            {locateDone && (
              <div style={{ animation: 'ogRise 190ms var(--ease-out)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    background: 'var(--green-900)',
                    border: '1px solid rgba(255,255,255,.12)',
                    borderRadius: 'var(--radius-md)',
                    padding: '13px 14px',
                    marginBottom: 14,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--green-100)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span style={{ color: '#fff', fontSize: 20 }}>{locateYds}</span>
                  <span>yd along your line</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      color:
                        locateVerdict === LOCATE_CLOSE_ENOUGH ? 'var(--mint-400)' : 'var(--amber-500)',
                    }}
                  >
                    the {teeSetName} tees say {cardText} — {locateVerdict ?? 'no card to check'}
                  </span>
                </div>

                {/*
                 * Detection is an offer on a finished line, never a gate in front
                 * of one (R1). Whatever it answers — proposals, silence, or
                 * nothing at all — the button below is still there, so a hole is
                 * always hand-mappable (R12).
                 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 14 }}>
                  {detecting ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        background: 'var(--green-900)',
                        border: '1px solid rgba(255,255,255,.12)',
                        borderRadius: 'var(--radius-md)',
                        padding: '11px 13px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--green-100)',
                      }}
                    >
                      <span>Reading the imagery for hole {holeNum} …</span>
                      <button
                        onClick={actions.cancelProposals}
                        style={{
                          marginLeft: 'auto',
                          background: 'rgba(255,255,255,.1)',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          height: 26,
                          padding: '0 10px',
                          color: '#fff',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        cancel and map it myself
                      </button>
                    </div>
                  ) : (
                    <HoverButton
                      onClick={actions.requestProposals}
                      disabled={!canRequestProposals}
                      style={{ ...GHOST_BUTTON, height: 44, fontSize: 14 }}
                      hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                    >
                      Look for features in the imagery
                    </HoverButton>
                  )}

                  {/* Silence and failure are two different answers, said two different ways. */}
                  {state.detect.status === 'no_coverage' && (
                    <RailNotice>
                      No proposals for this hole — {state.detect.message} Nothing went wrong; there is
                      just nothing for you to confirm. Carry on and map it by hand.
                    </RailNotice>
                  )}

                  {state.detect.status === 'failed' && (
                    <RailNotice tone="danger">
                      Detection did not finish — {state.detect.message} The hole is still yours to map
                      by hand.
                    </RailNotice>
                  )}
                </div>

                <Button size="lg" variant="accent" fullWidth onClick={actions.confirmLocate}>
                  Save this line and carry on
                </Button>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                {locatePoints.length} point{locatePoints.length === 1 ? '' : 's'} marked
              </span>
              <button
                onClick={actions.resetLocate}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--green-200)',
                  fontSize: 12,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Start over
              </button>
            </div>
          </div>
        )}

        {!allDone && !isLocate && (
          <div style={RAIL_CARD}>
            <div
              style={{
                ...EYEBROW,
                color: 'var(--mint-400)',
                marginBottom: 10,
                display: 'flex',
                gap: 10,
              }}
            >
              <span>{q.kicker}</span>
              {/* Which one of how many — the count comes off the real list, not the copy. */}
              {stepProposalCount > 0 && (
                <span style={{ marginLeft: 'auto', color: PROPOSED_COLOR }}>
                  {activePosition} / {stepProposalCount} suggested
                </span>
              )}
            </div>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '-.015em',
                color: '#fff',
                margin: '0 0 8px',
                textWrap: 'pretty',
              }}
            >
              {stepTitle}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--green-200)', textWrap: 'pretty' }}>
              {stepNote}
            </p>

            {q.isTees && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
                {TEE_IDS.map((id, i) => (
                  <div key={id} style={{ ...STEP_ROW, gap: 10, padding: '9px 12px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--green-200)',
                        width: 74,
                      }}
                    >
                      {TEE_POSITIONS[i]}
                    </span>
                    <select
                      value={state.teeAssign[id]}
                      onChange={(e) => actions.setTee(id, e.target.value)}
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
                      {scorecard.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name} · {t.yd} yd
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {/*
              * One proposal, one answer (R7). The confirming button is about the
              * feature on screen and nothing behind it, and on the water step it
              * is the in-play question itself — the only thing that makes a pond
              * a hazard (R14). With nothing proposed the step still stands: the
              * contributor confirms the absence, or says we missed one.
              */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button size="lg" variant="accent" fullWidth onClick={actions.accept}>
                {stepAccept}
              </Button>
              {stepNeedsInPlay && q.outOfPlay && (
                <HoverButton
                  onClick={() => actions.answerInPlay(false)}
                  style={{ ...GHOST_BUTTON, height: 44, fontSize: 14 }}
                  hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                >
                  {q.outOfPlay}
                </HoverButton>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                {(activeProposal !== null || q.kind === null) && (
                  <HoverButton
                    onClick={actions.reject}
                    style={{ ...GHOST_BUTTON, height: 44, fontSize: 14 }}
                    hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                  >
                    {q.reject}
                  </HoverButton>
                )}
                <HoverButton
                  onClick={actions.missing}
                  style={{
                    ...GHOST_BUTTON,
                    height: 44,
                    fontSize: 14,
                    gridColumn: activeProposal === null && q.kind !== null ? '1 / -1' : undefined,
                  }}
                  hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                >
                  {q.miss}
                </HoverButton>
              </div>
            </div>

            {/* R10: a rejection is a record. Say so where it was made. */}
            {rejectedHere.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--green-200)',
                }}
              >
                {rejectedHere.length} turned down on this hole — kept, not discarded.
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                A accept · N not there · M missed one
              </span>
              <button
                onClick={actions.nudge}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--green-200)',
                  fontSize: 12,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Edges look off — let me drag them
              </button>
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

        {allDone && (
          <div
            style={{
              background: 'var(--green-800)',
              border: '1px solid var(--mint-400)',
              borderRadius: 'var(--radius-lg)',
              padding: 18,
              animation: 'ogRise 190ms var(--ease-out)',
            }}
          >
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 20,
                fontWeight: 700,
                color: '#fff',
                margin: '0 0 10px',
                letterSpacing: '-.015em',
              }}
            >
              Hole {holeNum}, confirmed.
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
              {summary.map((text) => (
                <div
                  key={text}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--green-100)',
                  }}
                >
                  <span style={{ color: 'var(--mint-400)', display: 'flex' }}>
                    <Icon name="check" size={14} />
                  </span>
                  {text}
                </div>
              ))}
            </div>
            <Button size="lg" variant="accent" fullWidth onClick={actions.upload}>
              Put hole {holeNum} on the map
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
            }}
            hoverStyle={{ background: 'rgba(255,255,255,.07)' }}
          >
            Back to the holes
          </HoverButton>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
            nothing is sent until you finish the hole
          </span>
        </div>
      </div>
    </section>
  );
}
