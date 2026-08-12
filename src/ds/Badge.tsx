import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';

const TONES: Record<string, [string, string, string]> = {
  neutral: ['var(--paper-2)', 'var(--ink-600)', 'var(--border-default)'],
  brand: ['var(--green-50)', 'var(--green-700)', 'var(--green-200)'],
  accent: ['var(--mint-100)', 'var(--mint-600)', 'var(--mint-200)'],
  success: ['var(--status-success-bg)', 'var(--status-success-fg)', 'var(--green-200)'],
  warning: ['var(--status-warning-bg)', 'var(--status-warning-fg)', '#eed9ac'],
  danger: ['var(--status-danger-bg)', 'var(--status-danger-fg)', '#eec6bb'],
  info: ['var(--status-info-bg)', 'var(--status-info-fg)', '#bcd9e8'],
};

export type BadgeTone = keyof typeof TONES;

interface BadgeProps {
  children: ReactNode;
  tone?: string;
  icon?: string;
  dot?: boolean;
  style?: CSSProperties;
}

export function Badge({ children, tone = 'neutral', icon, dot = false, style }: BadgeProps) {
  const [bg, fg, bd] = TONES[tone] ?? TONES.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        padding: '0 9px',
        borderRadius: 'var(--radius-pill)',
        background: bg,
        color: fg,
        border: '1px solid ' + bd,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-micro)',
        fontWeight: 'var(--weight-semibold)' as CSSProperties['fontWeight'],
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: fg }} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}
