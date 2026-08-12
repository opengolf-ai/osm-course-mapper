import { LANDMARKS } from '../data/course';
import { Button, Icon } from '../ds';
import { CourseImagery } from '../components/CourseImagery';
import { HoverButton } from '../components/HoverButton';

interface BoundaryScreenProps {
  courseName: string;
  flagged: boolean;
  onFlag: () => void;
  onConfirm: () => void;
  onBack: () => void;
}

export function BoundaryScreen({
  courseName,
  flagged,
  onFlag,
  onConfirm,
  onBack,
}: BoundaryScreenProps) {
  return (
    <section style={{ display: 'grid', gridTemplateColumns: '1fr 420px', height: 'calc(100vh - 56px)' }}>
      <div style={{ position: 'relative', overflow: 'hidden', background: '#22321f' }}>
        <CourseImagery />

        <div
          style={{
            position: 'absolute',
            top: 20,
            left: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(6,43,38,.82)',
            backdropFilter: 'var(--blur-panel)',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: 'var(--mint-400)',
              animation: 'ogPulse 2.4s var(--ease-out) infinite',
            }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{courseName}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)' }}>
            outline we traced
          </span>
        </div>

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
            <span style={{ width: 18, height: 0, borderTop: '2px dashed var(--mint-400)', display: 'block' }} />
            our line
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 11, height: 11, borderRadius: 2, background: '#cfc7b4', display: 'block' }} />
            clubhouse
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 11, height: 11, borderRadius: 2, background: '#1d3c47', display: 'block' }} />
            Carmel Bay
          </span>
        </div>
      </div>

      <div
        style={{
          background: 'var(--green-900)',
          borderLeft: '1px solid rgba(255,255,255,.1)',
          padding: 26,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              color: 'var(--mint-400)',
              marginBottom: 8,
            }}
          >
            Before we start
          </div>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: '-.015em',
              color: '#fff',
              margin: '0 0 8px',
            }}
          >
            Is this the whole course?
          </h2>
          <p style={{ margin: 0, color: 'var(--green-200)', fontSize: 14, textWrap: 'pretty' }}>
            Nobody can judge a mile-wide outline by eye. Check the facts instead — if they hold up,
            the line is right.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div
            style={{
              background: 'var(--green-800)',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: 'var(--green-200)',
              }}
            >
              Holes inside the line
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 26,
                color: '#fff',
                marginTop: 6,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              18
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 6,
                color: 'var(--mint-400)',
                fontSize: 12,
              }}
            >
              <Icon name="check" size={14} />
              the card says 18
            </div>
          </div>

          <div
            style={{
              background: 'var(--green-800)',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: 'var(--green-200)',
              }}
            >
              Land enclosed
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 26,
                color: '#fff',
                marginTop: 6,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              176 <span style={{ fontSize: 14, color: 'var(--green-200)' }}>acres</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--green-200)', fontSize: 12 }}>
              typical for 18 holes on the coast
            </div>
          </div>
        </div>

        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              color: 'var(--green-200)',
              marginBottom: 10,
            }}
          >
            Landmarks — where we put them
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {LANDMARKS.map((l) => (
              <div
                key={l.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'var(--green-800)',
                  border: '1px solid rgba(255,255,255,.1)',
                  borderRadius: 'var(--radius-md)',
                  padding: '11px 14px',
                }}
              >
                <span style={{ color: l.color, display: 'flex' }}>
                  <Icon name={l.icon} size={16} />
                </span>
                <span style={{ flex: 1, fontSize: 14, color: '#fff' }}>{l.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: l.color }}>
                  {l.verdict}
                </span>
                <HoverButton
                  onClick={onFlag}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(255,255,255,.16)',
                    borderRadius: 'var(--radius-sm)',
                    height: 26,
                    padding: '0 9px',
                    color: 'var(--green-200)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                  hoverStyle={{ background: 'rgba(255,255,255,.08)', color: '#fff' }}
                >
                  {l.action}
                </HoverButton>
              </div>
            ))}
          </div>
        </div>

        {flagged && (
          <div
            style={{
              background: 'rgba(201,138,21,.14)',
              border: '1px solid rgba(201,138,21,.5)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px',
              fontSize: 14,
              color: '#f6e3bd',
            }}
          >
            You flagged something. We will re-trace the edge near it before you review holes —
            nothing you do next is lost.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 'auto' }}>
          <Button size="lg" variant="accent" fullWidth onClick={onConfirm}>
            Yes, that is the course
          </Button>
          <HoverButton
            onClick={onBack}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,.18)',
              borderRadius: 'var(--radius-md)',
              height: 40,
              color: 'var(--green-100)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            hoverStyle={{ background: 'rgba(255,255,255,.07)' }}
          >
            Not my course — search again
          </HoverButton>
        </div>
      </div>
    </section>
  );
}
