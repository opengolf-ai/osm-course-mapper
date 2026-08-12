import { COURSE_NAME } from '../data/course';
import { Button, Icon } from '../ds';

interface CompleteModalProps {
  holeNum: number;
  doneCount: number;
  onNextHole: () => void;
  onBack: () => void;
}

export function CompleteModal({ holeNum, doneCount, onNextHole, onBack }: CompleteModalProps) {
  const courseShortName = COURSE_NAME.replace(' Golf Links', '');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(6,43,38,.62)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        style={{
          width: 460,
          background: 'var(--paper)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: 28,
          color: 'var(--ink-800)',
          animation: 'ogRise 280ms var(--ease-out)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--green-500)',
            marginBottom: 12,
          }}
        >
          <Icon name="circle-check" size={15} />
          uploaded
        </div>

        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: '-.025em',
            color: 'var(--green-900)',
            margin: '0 0 8px',
          }}
        >
          Hole {holeNum} is on the map.
        </h2>
        <p style={{ margin: '0 0 18px', color: 'var(--ink-600)', fontSize: 14, textWrap: 'pretty' }}>
          Anyone pulling {courseShortName} now gets your green, your bunkers and your tees.
        </p>

        <div
          style={{
            background: 'var(--white)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 16px',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--ink-700)',
            marginBottom: 8,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          1 green · 2 bunkers · 4 tee boxes · 1 fairway
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--ink-400)',
            marginBottom: 22,
          }}
        >
          signed as your OpenStreetMap account · {doneCount} of 18 holes done
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Button size="lg" variant="primary" onClick={onNextHole}>
            Review the next hole
          </Button>
          <Button size="lg" variant="secondary" onClick={onBack}>
            Back to the holes
          </Button>
        </div>
      </div>
    </div>
  );
}
