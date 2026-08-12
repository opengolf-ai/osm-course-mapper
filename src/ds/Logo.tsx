import type { CSSProperties } from 'react';

/* The flag mark is a raster asset extracted from the supplied brand art.
   Never redraw it; scale the PNG. */
interface LogoProps {
  variant?: 'mark' | 'lockup-v';
  height?: number;
  style?: CSSProperties;
}

export function Logo({ variant = 'mark', height, style }: LogoProps) {
  const h = height ?? (variant === 'mark' ? 34 : 28);
  const mark = (
    <img
      src="/logo-mark.png"
      alt=""
      style={{ height: variant === 'mark' ? h : h * 2.6, width: 'auto', display: 'block' }}
    />
  );

  if (variant === 'lockup-v') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 14, ...style }}>
        {mark}
      </span>
    );
  }
  return <span style={{ display: 'inline-flex', ...style }}>{mark}</span>;
}
