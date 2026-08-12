import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';

const SIZES = {
  sm: { h: 30, px: 12, fs: 13, gap: 6, icon: 14, r: 'var(--radius-sm)' },
  md: { h: 38, px: 16, fs: 15, gap: 8, icon: 16, r: 'var(--radius-md)' },
  lg: { h: 46, px: 22, fs: 16, gap: 9, icon: 18, r: 'var(--radius-md)' },
};

export type ButtonSize = keyof typeof SIZES;
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';

function palette(variant: ButtonVariant, hover: boolean, active: boolean): CSSProperties {
  switch (variant) {
    case 'secondary':
      return {
        background: hover ? 'var(--paper-2)' : 'var(--white)',
        color: 'var(--text-heading)',
        border: '1px solid ' + (hover ? 'var(--border-strong)' : 'var(--border-default)'),
        boxShadow: active ? 'none' : 'var(--shadow-xs)',
      };
    case 'ghost':
      return {
        background: hover ? 'var(--green-50)' : 'transparent',
        color: 'var(--text-accent)',
        border: '1px solid transparent',
        boxShadow: 'none',
      };
    case 'accent':
      return {
        background: active ? 'var(--mint-600)' : hover ? 'var(--mint-500)' : 'var(--mint-400)',
        color: 'var(--green-950)',
        border: '1px solid transparent',
        boxShadow: 'none',
      };
    case 'danger':
      return {
        background: hover ? '#9d3b28' : 'var(--clay-500)',
        color: 'var(--white)',
        border: '1px solid transparent',
        boxShadow: 'none',
      };
    default:
      return {
        background: active
          ? 'var(--brand-primary-active)'
          : hover
            ? 'var(--brand-primary-hover)'
            : 'var(--brand-primary)',
        color: 'var(--text-inverse)',
        border: '1px solid transparent',
        boxShadow: active ? 'none' : 'var(--shadow-xs)',
      };
  }
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconLeft?: string;
  iconRight?: string;
  fullWidth?: boolean;
  style?: CSSProperties;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  disabled = false,
  fullWidth = false,
  style,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const s = SIZES[size] ?? SIZES.md;

  return (
    <button
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      {...rest}
      style={{
        display: fullWidth ? 'flex' : 'inline-flex',
        width: fullWidth ? '100%' : undefined,
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        height: s.h,
        padding: `0 ${s.px}px`,
        borderRadius: s.r,
        fontFamily: 'var(--font-sans)',
        fontSize: s.fs,
        fontWeight: 'var(--weight-semibold)' as CSSProperties['fontWeight'],
        letterSpacing: '-0.005em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        textDecoration: 'none',
        opacity: disabled ? 0.45 : 1,
        transform: active && !disabled ? 'translateY(1px)' : 'none',
        transition: 'var(--transition-control)',
        ...palette(variant, hover && !disabled, active && !disabled),
        ...style,
      }}
    >
      {iconLeft && <Icon name={iconLeft} size={s.icon} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s.icon} />}
    </button>
  );
}
