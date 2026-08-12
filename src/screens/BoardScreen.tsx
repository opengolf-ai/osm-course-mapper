import {
  COURSE_META,
  COURSE_NAME,
  MINIS,
  PARS,
  STATUS_META,
  YDS,
  type HoleStatus,
} from '../data/course';
import { Badge } from '../ds';
import { HoverButton } from '../components/HoverButton';

interface BoardScreenProps {
  holeStatus: HoleStatus[];
  doneCount: number;
  onOpenHole: (index: number) => void;
  onBack: () => void;
}

const PROGRESS_FILL: Record<HoleStatus, string> = {
  complete: 'var(--mint-400)',
  ready: 'rgba(62,207,180,.28)',
  attention: 'var(--amber-500)',
  unmapped: 'rgba(255,255,255,.12)',
};

const STROKE: Record<HoleStatus, string> = {
  complete: '#a3dcc7',
  attention: '#eec98a',
  ready: '#3ecfb4',
  unmapped: '#3ecfb4',
};

export function BoardScreen({ holeStatus, doneCount, onOpenHole, onBack }: BoardScreenProps) {
  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 32,
          padding: '28px 32px 22px',
          borderBottom: '1px solid rgba(255,255,255,.09)',
        }}
      >
        <div style={{ flex: 1 }}>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-.025em',
              color: '#fff',
              margin: '0 0 6px',
            }}
          >
            {COURSE_NAME}
          </h1>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--green-200)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {COURSE_META}
          </div>
        </div>
        <div style={{ width: 360 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 22,
                color: '#fff',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {doneCount}
            </span>
            <span style={{ fontSize: 14, color: 'var(--green-200)' }}>of 18 holes on the map</span>
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {holeStatus.map((st, i) => (
              <span
                key={i}
                style={{ flex: 1, height: 8, borderRadius: 2, background: PROGRESS_FILL[st] }}
              />
            ))}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6,1fr)',
          gap: 14,
          padding: '22px 32px 8px',
        }}
      >
        {holeStatus.map((st, i) => {
          const meta = STATUS_META[st];
          return (
            <HoverButton
              key={i}
              onClick={() => onOpenHole(i)}
              style={{
                display: 'block',
                textAlign: 'left',
                padding: 0,
                background: 'var(--green-900)',
                border: '1px solid rgba(255,255,255,.1)',
                borderRadius: 'var(--radius-lg)',
                overflow: 'hidden',
                cursor: 'pointer',
                transition: 'all 190ms var(--ease-out)',
              }}
              hoverStyle={{
                transform: 'translateY(-2px)',
                boxShadow: 'var(--shadow-md)',
                borderColor: 'rgba(255,255,255,.22)',
              }}
            >
              <div style={{ position: 'relative', height: 88, background: '#2a3f24' }}>
                <svg
                  viewBox="0 0 120 88"
                  preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                >
                  <rect width="120" height="88" fill="#2c4126" />
                  <ellipse cx="20" cy="18" rx="26" ry="20" fill="#1d2f16" />
                  <ellipse cx="104" cy="74" rx="24" ry="18" fill="#1d2f16" />
                  <path d={MINIS[i % 3]} fill="#527d3b" />
                  {st !== 'unmapped' && (
                    <g>
                      <ellipse
                        cx={92}
                        cy={20}
                        rx={9}
                        ry={7}
                        fill="#8bb256"
                        stroke={STROKE[st]}
                        strokeWidth={1.6}
                        strokeDasharray={st === 'complete' ? undefined : '3 3'}
                      />
                      <ellipse
                        cx={74}
                        cy={34}
                        rx={5}
                        ry={3.4}
                        fill="#ded1a8"
                        stroke={STROKE[st]}
                        strokeWidth={1.2}
                        strokeDasharray={st === 'complete' ? undefined : '3 3'}
                      />
                    </g>
                  )}
                </svg>
              </div>
              <div style={{ padding: '12px 14px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 22,
                      fontWeight: 800,
                      color: '#fff',
                      letterSpacing: '-.02em',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--green-200)',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    par {PARS[i]} · {YDS[i]} yd
                  </span>
                </div>
                <Badge tone={meta.tone} dot>
                  {meta.label}
                </Badge>
              </div>
            </HoverButton>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '20px 32px 40px' }}>
        <p
          style={{
            margin: 0,
            flex: 1,
            color: 'var(--green-200)',
            fontSize: 14,
            maxWidth: 560,
            textWrap: 'pretty',
          }}
        >
          Stop whenever you like. Every hole you finish is already live in OpenStreetMap — the rest
          will wait for you.
        </p>
        <HoverButton
          onClick={onBack}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,.18)',
            borderRadius: 'var(--radius-md)',
            height: 38,
            padding: '0 16px',
            color: 'var(--green-100)',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
          hoverStyle={{ background: 'rgba(255,255,255,.07)' }}
        >
          Another course
        </HoverButton>
      </div>
    </section>
  );
}
