import { useEffect, useState, type ReactNode } from 'react';
import { searchCourses } from '../api/opengolf';
import type { CourseSummary } from '../api/types';
import { Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';

/** Long enough that a typed word is one request, short enough to feel immediate. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * What the result area is showing. Idle, loading, no-matches, and failed are four
 * separate surfaces per R5 — an empty list is never the answer to a question the
 * contributor asked.
 */
type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; courses: CourseSummary[] }
  | { kind: 'empty' }
  | { kind: 'failed'; message: string };

interface SearchScreenProps {
  query: string;
  onQuery: (q: string) => void;
  onOpen: (courseId: string) => void;
}

/**
 * The row's second line. `city` and `state` are null on most OpenGolfAPI records,
 * so it falls back to coordinates rather than to an empty line — two courses that
 * share a name still read as two different places, per R17.
 */
function locality(course: CourseSummary): string {
  const parts = [course.city, course.state].filter((part): part is string => !!part);
  if (parts.length > 0) return parts.join(' · ');
  return `${course.latitude.toFixed(3)}, ${course.longitude.toFixed(3)}`;
}

export function SearchScreen({ query, onQuery, onOpen }: SearchScreenProps) {
  const [result, setResult] = useState<SearchState>({ kind: 'idle' });

  /*
   * One request per settled query: the timer collapses a burst of keystrokes, and
   * the abort drops whatever the previous query left in flight so a slow early
   * response can never overwrite a later one.
   */
  useEffect(() => {
    if (query.trim() === '') {
      setResult({ kind: 'idle' });
      return;
    }

    setResult({ kind: 'loading' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchCourses(query, controller.signal).then((response) => {
        if (controller.signal.aborted || response.status === 'aborted') return;
        if (response.status === 'failed') {
          setResult({ kind: 'failed', message: response.message });
        } else if (response.status === 'empty') {
          setResult({ kind: 'empty' });
        } else {
          setResult({ kind: 'results', courses: response.data });
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

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
          {result.kind === 'idle' && (
            <Notice>Type a course name to search courses in the United States.</Notice>
          )}

          {result.kind === 'loading' && <Notice>Searching for “{query.trim()}” …</Notice>}

          {result.kind === 'empty' && (
            <Notice>
              No United States courses match “{query.trim()}”. Try the course name on its own, or a
              different spelling.
            </Notice>
          )}

          {result.kind === 'failed' && (
            <Notice tone="danger">
              Search could not reach OpenGolfAPI — {result.message}. Edit the query to try again.
            </Notice>
          )}

          {result.kind === 'results' &&
            result.courses.map((course) => (
              <HoverButton
                key={course.id}
                onClick={() => onOpen(course.id)}
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
                    {course.name}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--ink-500)',
                      marginTop: 3,
                    }}
                  >
                    {locality(course)}
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

/** The non-list surfaces share one plate, so idle, loading, empty and failed sit where rows would. */
function Notice({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <div
      style={{
        background: tone === 'danger' ? 'var(--status-danger-bg)' : 'var(--white)',
        border: `1px solid ${tone === 'danger' ? 'var(--status-danger-fg)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-xs)',
        padding: '16px 20px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        color: tone === 'danger' ? 'var(--clay-500)' : 'var(--ink-500)',
        textWrap: 'pretty',
      }}
    >
      {children}
    </div>
  );
}
