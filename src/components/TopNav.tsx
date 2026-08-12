import { Logo } from '../ds';
import { HoverButton } from './HoverButton';

export interface NavItem {
  label: string;
  active: boolean;
  go: () => void;
}

export function TopNav({ items }: { items: NavItem[] }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        height: 56,
        padding: '0 24px',
        background: 'var(--green-900)',
        borderBottom: '1px solid rgba(255,255,255,.1)',
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Logo variant="mark" height={20} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            letterSpacing: '.06em',
            color: 'var(--green-200)',
          }}
        >
          course mapper
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
        {items.map((n) => (
          <HoverButton
            key={n.label}
            onClick={n.go}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              background: 'transparent',
              border: '1px solid transparent',
              borderRadius: 'var(--radius-sm)',
              height: 30,
              padding: '0 10px',
              color: 'var(--green-200)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '.04em',
              cursor: 'pointer',
              transition: 'var(--transition-control)',
            }}
            hoverStyle={{ background: 'rgba(255,255,255,.06)', color: '#fff' }}
          >
            {n.active && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--mint-400)',
                  display: 'block',
                }}
              />
            )}
            {n.label}
          </HoverButton>
        ))}
      </div>
    </div>
  );
}
