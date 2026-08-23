import type { OsmLookup } from '../api/overpass';
import { STATUS_META, type HoleStatus } from '../data/course';
import { holeYardage, type CourseSession } from '../state/courseSession';
import { Badge } from '../ds';
import { HoverButton } from '../components/HoverButton';

interface BoardScreenProps {
  course: CourseSession;
  holeStatus: HoleStatus[];
  doneCount: number;
  /** What OpenStreetMap answered for this course. Decides the header and the banner. */
  osm: OsmLookup;
  onOpenHole: (index: number) => void;
  onBack: () => void;
}

const PROGRESS_FILL: Record<HoleStatus, string> = {
  complete: 'var(--mint-400)',
  ready: 'rgba(62,207,180,.28)',
  attention: 'var(--amber-500)',
  unmapped: 'rgba(255,255,255,.12)',
  /* Hatched, so an unknown course does not read as an empty one at a glance. */
  unknown:
    'repeating-linear-gradient(45deg, rgba(188,217,232,.34) 0 3px, rgba(255,255,255,.06) 3px 6px)',
};

/** The tile's image slot until real per-hole imagery lands: flat, and plainly empty. */
const TILE_PLACEHOLDER: React.CSSProperties = {
  position: 'relative',
  height: 88,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background:
    'repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 6px, rgba(255,255,255,0) 6px 12px), var(--green-950)',
  borderBottom: '1px solid rgba(255,255,255,.08)',
};

/** The one banner the board carries, stating what the OpenStreetMap lookup found. */
function osmBanner(osm: OsmLookup, courseName: string): { tone: 'warning' | 'info'; text: string } | null {
  if (osm.status === 'absent') {
    return {
      tone: 'info',
      text:
        `OpenStreetMap holds no boundary for ${courseName} yet, so there was nothing to show you ` +
        'first. Every hole here starts from scratch.',
    };
  }
  if (osm.status === 'unknown') {
    return {
      tone: 'warning',
      text:
        `We could not check OpenStreetMap — ${osm.message}. What is already mapped is unknown, ` +
        'not empty, so nothing below is counted until it answers.',
    };
  }
  if (osm.status === 'pending') {
    return { tone: 'info', text: 'Still checking what OpenStreetMap already holds for this course.' };
  }
  return null;
}

export function BoardScreen({
  course,
  holeStatus,
  doneCount,
  osm,
  onOpenHole,
  onBack,
}: BoardScreenProps) {
  /* The course decides how many tiles there are; the status list only colors them. */
  const statusAt = (i: number): HoleStatus => holeStatus[i] ?? 'unmapped';
  /* R16: with no answer from OpenStreetMap there is no number to print. */
  const countKnown = osm.status === 'found' || osm.status === 'absent';
  const banner = osmBanner(osm, course.name);

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
            {course.name}
          </h1>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--green-200)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {course.meta}
          </div>
          {/* Said out loud rather than shown as blank tiles, per R5. */}
          {!course.cardAvailable && (
            <div style={{ fontSize: 13, color: 'var(--amber-500)', marginTop: 6 }}>
              A scorecard is not in this course’s record — pars and yardages are unknown.
            </div>
          )}
        </div>
        <div style={{ width: 360 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            {countKnown ? (
              <>
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
                <span style={{ fontSize: 14, color: 'var(--green-200)' }}>
                  of {course.holes.length} holes on the map
                </span>
              </>
            ) : (
              <span style={{ fontSize: 14, color: 'var(--green-200)' }}>
                Mapped state unknown — OpenStreetMap has not answered
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {course.holes.map((hole, i) => (
              <span
                key={hole.number}
                style={{ flex: 1, height: 8, borderRadius: 2, background: PROGRESS_FILL[statusAt(i)] }}
              />
            ))}
          </div>
        </div>
      </div>

      {banner && (
        <div
          style={{
            margin: '18px 32px 0',
            background: banner.tone === 'warning' ? 'rgba(201,138,21,.14)' : 'rgba(43,127,168,.14)',
            border: `1px solid ${banner.tone === 'warning' ? 'rgba(201,138,21,.5)' : 'rgba(43,127,168,.5)'}`,
            borderRadius: 'var(--radius-lg)',
            padding: '13px 16px',
            fontSize: 14,
            color: banner.tone === 'warning' ? '#f6e3bd' : '#cfe6f2',
            textWrap: 'pretty',
          }}
        >
          {banner.text}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6,1fr)',
          gap: 14,
          padding: '22px 32px 8px',
        }}
      >
        {course.holes.map((hole, i) => {
          const st = statusAt(i);
          const meta = STATUS_META[st];
          const yd = holeYardage(course, i);
          return (
            <HoverButton
              key={hole.number}
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
              {/*
               * A neutral placeholder, not a drawing of a hole. Per-hole thumbnails
               * off real imagery are deferred, and a generated silhouette here would
               * be a shape claiming to be this hole when it is not.
               */}
              <div style={TILE_PLACEHOLDER}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '.12em',
                    textTransform: 'uppercase',
                    color: 'rgba(211,239,228,.42)',
                  }}
                >
                  no thumbnail yet
                </span>
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
                    {hole.number}
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
                    par {hole.par ?? '—'} · {yd ?? '—'} yd
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
