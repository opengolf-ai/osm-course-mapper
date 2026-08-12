import { COURSES } from '../data/course';
import { Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';

interface SearchScreenProps {
  query: string;
  onQuery: (q: string) => void;
  onOpen: (course: { name: string; done: number }) => void;
}

export function SearchScreen({ query, onQuery, onOpen }: SearchScreenProps) {
  const matches = COURSES.filter(
    (c) => !query || (c.name + ' ' + c.place).toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <section
      style={{
        background: 'var(--paper)',
        backgroundImage: 'var(--grid-plate)',
        backgroundSize: '32px 32px',
        color: 'var(--ink-800)',
        minHeight: 'calc(100vh - 56px)',
        padding: '88px 32px 64px',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 42,
            fontWeight: 800,
            letterSpacing: '-.03em',
            color: 'var(--green-900)',
            margin: '0 0 10px',
          }}
        >
          Map your home course.
        </h1>
        <p style={{ margin: '0 0 32px', color: 'var(--ink-600)', maxWidth: 520, textWrap: 'pretty' }}>
          Find the course you know best. We propose what is out there from the imagery — you confirm
          it, one hole at a time.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--white)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-xs)',
            padding: '0 16px',
            height: 52,
            marginBottom: 24,
          }}
        >
          <span style={{ color: 'var(--ink-400)', display: 'flex' }}>
            <Icon name="search" size={18} />
          </span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Course name, city or state"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 17,
              color: 'var(--ink-900)',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {matches.map((c) => (
            <HoverButton
              key={c.name}
              onClick={() => onOpen(c)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 20,
                textAlign: 'left',
                width: '100%',
                background: 'var(--white)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-xs)',
                padding: '16px 20px',
                cursor: 'pointer',
                transition: 'all 190ms var(--ease-out)',
              }}
              hoverStyle={{ boxShadow: 'var(--shadow-md)', transform: 'translateY(-2px)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    color: 'var(--green-900)',
                    letterSpacing: '-.01em',
                  }}
                >
                  {c.name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--ink-500)',
                    marginTop: 3,
                  }}
                >
                  {c.place}
                </div>
              </div>
              <div style={{ width: 180 }}>
                <div style={{ display: 'flex', gap: 2, marginBottom: 6 }}>
                  {Array.from({ length: 18 }, (_, i) => (
                    <span
                      key={i}
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 1,
                        background: i < c.done ? 'var(--green-500)' : 'var(--paper-3)',
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-500)' }}
                >
                  {c.state}
                </div>
              </div>
              <span style={{ color: 'var(--ink-400)', display: 'flex' }}>
                <Icon name="chevron-right" size={18} />
              </span>
            </HoverButton>
          ))}
        </div>
      </div>
    </section>
  );
}
