import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { useHover } from './useHover';

interface HoverButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  children: ReactNode;
  style: CSSProperties;
  hoverStyle: CSSProperties;
}

/** A plain button that swaps in a hover style object, mirroring the design's `style-hover`. */
export function HoverButton({ children, style, hoverStyle, ...rest }: HoverButtonProps) {
  const h = useHover(style, hoverStyle);
  return (
    <button {...rest} {...h.handlers} style={h.style}>
      {children}
    </button>
  );
}
