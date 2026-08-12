import { REVIEW_VIEWBOX, SHAPES, STEPS, TEE_IDS, TEE_POSITIONS } from '../data/course';
import { ell } from '../data/geometry';
import { Button, Icon } from '../ds';
import { HoleImagery } from '../components/HoleImagery';
import { HoverButton } from '../components/HoverButton';
import type { Mapper } from '../state/useMapper';

interface ShapeLabel {
  key: string;
  left: number;
  top: number;
  text: string;
  bg: string;
  fg: string;
}

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
    blocked,
    locateDone,
    locateYds,
    locateWithinTolerance,
    corridor,
    activeIds,
    confirmedIds,
    pendingIds,
    measured,
    scorecard,
    summary,
  } = derived;

  const { tee, green } = state.locate;
  const holeNum = state.course?.holes[hi]?.number ?? hi + 1;
  /* The card is a real record now, so every number on it can be absent. */
  const cardText = cardYds ?? '—';

  const labelFor = (id: string, active: boolean): ShapeLabel | null => {
    const sh = SHAPES[id];
    if (!sh || !sh.label) return null;
    const isTee = id.startsWith('tee');
    const text = isTee
      ? (state.teeAssign[id as (typeof TEE_IDS)[number]] ?? 'tee') + ' tee'
      : sh.label;
    return {
      key: id,
      left: (sh.lx / REVIEW_VIEWBOX.w) * 100,
      top: (sh.ly / REVIEW_VIEWBOX.h) * 100,
      text,
      bg: active ? 'var(--mint-400)' : 'rgba(6,43,38,.86)',
      fg: active ? '#062b26' : '#d3efe4',
    };
  };

  const candidateLabel = (id: string, key: string): ShapeLabel => {
    const sh = SHAPES[id];
    return {
      key: id,
      left: (sh.lx / REVIEW_VIEWBOX.w) * 100,
      top: (sh.ly / REVIEW_VIEWBOX.h) * 100,
      text: key,
      bg: 'var(--mint-400)',
      fg: '#062b26',
    };
  };

  const shapeLabels: ShapeLabel[] = isLocate
    ? ([
        tee && {
          key: 'locate-tee',
          left: Math.min(Math.max((tee.x / REVIEW_VIEWBOX.w) * 100, 2), 76),
          top: Math.max(((tee.y - 48) / REVIEW_VIEWBOX.h) * 100, 2),
          text: 'your tee',
          bg: 'rgba(6,43,38,.86)',
          fg: '#d3efe4',
        },
        green && {
          key: 'locate-green',
          left: Math.min(Math.max((green.x / REVIEW_VIEWBOX.w) * 100, 2), 76),
          top: Math.max(((green.y - 56) / REVIEW_VIEWBOX.h) * 100, 2),
          text: 'your green',
          bg: 'rgba(6,43,38,.86)',
          fg: '#d3efe4',
        },
      ].filter(Boolean) as ShapeLabel[])
    : (blocked
        ? [candidateLabel('greenAlt', 'A'), candidateLabel('green', 'B')]
        : (activeIds.map((id) => labelFor(id, true)).filter(Boolean) as ShapeLabel[])
      ).concat(confirmedIds.map((id) => labelFor(id, false)).filter(Boolean) as ShapeLabel[]);

  const confirmedShapes = isLocate
    ? [tee && { d: ell(tee.x, tee.y, 34, 22) }, green && { d: ell(green.x, green.y, 40, 30) }].filter(
        Boolean,
      )
    : confirmedIds.map((id) => ({ d: SHAPES[id].d })).concat(state.extra.map((e) => ({ d: e.d })));

  const activeShapes = isLocate
    ? corridor
      ? [{ d: corridor }]
      : []
    : activeIds.map((id) => ({ d: SHAPES[id].d }));

  const mapCursor = state.addMode || (isLocate && !locateDone) ? 'crosshair' : 'default';
  const stepCounter = isLocate
    ? 'first, the outline of the hole'
    : allDone
      ? 'all checks done'
      : `check ${state.step + 1} of ${STEPS.length}`;

  return (
    <section style={{ display: 'grid', gridTemplateColumns: '1fr 428px', height: 'calc(100vh - 56px)' }}>
      {/* ---------- Map pane ---------- */}
      <div style={{ position: 'relative', overflow: 'hidden', background: '#24391f' }}>
        <HoleImagery />

        <svg
          viewBox="0 0 1000 680"
          preserveAspectRatio="none"
          onClick={actions.onMapClick}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            cursor: mapCursor,
          }}
        >
          {!isLocate &&
            pendingIds.map((id) => (
              <path
                key={id}
                d={SHAPES[id].d}
                fill="rgba(255,255,255,.05)"
                stroke="rgba(255,255,255,.42)"
                strokeWidth={2}
                strokeDasharray="7 6"
              />
            ))}
          {confirmedShapes.map((c, i) => (
            <path
              key={i}
              d={(c as { d: string }).d}
              fill="rgba(163,220,199,.16)"
              stroke="#a3dcc7"
              strokeWidth={2.5}
            />
          ))}
          {activeShapes.map((a, i) => (
            <g key={i}>
              <path d={a.d} fill="none" stroke="rgba(62,207,180,.35)" strokeWidth={14} />
              <path
                d={a.d}
                fill="rgba(62,207,180,.14)"
                stroke="var(--mint-400)"
                strokeWidth={3.5}
                strokeDasharray="10 8"
                style={{ animation: 'ogDash 1.4s linear infinite' }}
              />
            </g>
          ))}
        </svg>

        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {shapeLabels.map((l) => (
            <span
              key={l.key}
              style={{
                position: 'absolute',
                left: `${l.left}%`,
                top: `${l.top}%`,
                display: 'inline-flex',
                alignItems: 'center',
                height: 26,
                padding: '0 10px',
                borderRadius: 6,
                background: l.bg,
                color: l.fg,
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                letterSpacing: '.02em',
                whiteSpace: 'nowrap',
                boxShadow: '0 1px 6px rgba(6,43,38,.4)',
              }}
            >
              {l.text}
            </span>
          ))}
        </div>

        <div
          style={{
            position: 'absolute',
            top: 20,
            left: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: 'rgba(6,43,38,.82)',
            backdropFilter: 'var(--blur-panel)',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 'var(--radius-md)',
            padding: '11px 16px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              fontWeight: 800,
              color: '#fff',
              letterSpacing: '-.02em',
            }}
          >
            Hole {holeNum}
          </span>
          <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.2)', display: 'block' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)' }}>
            tee to green {isLocate ? (locateDone ? locateYds : '—') : (measured ?? '—')} yd · card
            says {cardText}
          </span>
        </div>

        {state.addMode && (
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

        {isLocate && !locateDone && (
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
              {tee ? '2' : '1'}
            </span>
            {tee ? 'Now click the green you putt on.' : 'Click where you tee off.'}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            bottom: 20,
            right: 20,
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
            <span style={{ width: 18, height: 0, borderTop: '2px dashed var(--mint-400)', display: 'block' }} />
            asking you now
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 18, height: 0, borderTop: '2px solid #a3dcc7', display: 'block' }} />
            you confirmed
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              style={{ width: 18, height: 0, borderTop: '2px dashed rgba(255,255,255,.42)', display: 'block' }}
            />
            not asked yet
          </span>
        </div>
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
                : `Tee to green measures 250 yards. Your card says hole ${holeNum} plays ${cardText} from the back tee. Usually that means we grabbed the wrong green — pick the one you putt on.`}
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
              Two clicks on the imagery: where you tee off, then the green you putt on. We draw
              everything inside that line and you check it.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
              {[
                { num: '1', label: 'Where you tee off', done: !!tee, state: tee ? 'marked' : 'click the map' },
                {
                  num: '2',
                  label: 'The green you putt on',
                  done: !!green,
                  state: green ? 'marked' : tee ? 'click the map' : 'next',
                },
              ].map((p) => {
                const ring = p.done ? 'var(--mint-400)' : p.num === '1' || tee ? '#fff' : 'var(--green-200)';
                return (
                  <div
                    key={p.num}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 11,
                      background: 'var(--green-900)',
                      border: '1px solid rgba(255,255,255,.12)',
                      borderRadius: 'var(--radius-md)',
                      padding: '11px 13px',
                    }}
                  >
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
                  <span>yd tee to green</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      color: locateWithinTolerance ? 'var(--mint-400)' : 'var(--amber-500)',
                    }}
                  >
                    the card says {cardText} —{' '}
                    {locateWithinTolerance ? 'close enough' : 'check your two clicks'}
                  </span>
                </div>
                <Button size="lg" variant="accent" fullWidth onClick={actions.confirmLocate}>
                  Find the rest of the hole
                </Button>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                nothing is drawn until you click
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
            <div style={{ ...EYEBROW, color: 'var(--mint-400)', marginBottom: 10 }}>{q.kicker}</div>
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
              {q.title}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--green-200)', textWrap: 'pretty' }}>
              {q.note}
            </p>

            {q.isTees && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
                {TEE_IDS.map((id, i) => (
                  <div
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'var(--green-900)',
                      border: '1px solid rgba(255,255,255,.12)',
                      borderRadius: 'var(--radius-md)',
                      padding: '9px 12px',
                    }}
                  >
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button size="lg" variant="accent" fullWidth onClick={actions.accept}>
                {q.accept}
              </Button>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                <HoverButton
                  onClick={actions.reject}
                  style={{
                    height: 44,
                    background: 'var(--green-900)',
                    border: '1px solid rgba(255,255,255,.2)',
                    borderRadius: 'var(--radius-md)',
                    color: '#fff',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '0 10px',
                  }}
                  hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                >
                  {q.reject}
                </HoverButton>
                <HoverButton
                  onClick={actions.missing}
                  style={{
                    height: 44,
                    background: 'var(--green-900)',
                    border: '1px solid rgba(255,255,255,.2)',
                    borderRadius: 'var(--radius-md)',
                    color: '#fff',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '0 10px',
                  }}
                  hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
                >
                  {q.miss}
                </HoverButton>
              </div>
            </div>

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
