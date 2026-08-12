import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * The design expresses hover as a `style-hover` attribute. React has no equivalent,
 * so components merge a hover style object themselves.
 */
export function useHover(base: CSSProperties, hovered: CSSProperties) {
  const [isHovered, setHovered] = useState(false);
  const style = useMemo(
    () => (isHovered ? { ...base, ...hovered } : base),
    [isHovered, base, hovered],
  );
  return {
    style,
    isHovered,
    handlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
  };
}
