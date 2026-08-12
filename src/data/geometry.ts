/** SVG path for an ellipse, built from two arc segments. */
export function ell(cx: number, cy: number, rx: number, ry: number): string {
  return (
    'M' + (cx - rx) + ' ' + cy +
    ' a' + rx + ' ' + ry + ' 0 1 0 ' + rx * 2 + ' 0' +
    ' a' + rx + ' ' + ry + ' 0 1 0 ' + -rx * 2 + ' 0'
  );
}

/** SVG path for a rounded rectangle. */
export function rr(x: number, y: number, w: number, h: number, r: number): string {
  return (
    'M' + (x + r) + ' ' + y +
    ' h' + (w - 2 * r) +
    ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
    ' v' + (h - 2 * r) +
    ' a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + r +
    ' h' + -(w - 2 * r) +
    ' a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + -r +
    ' v' + -(h - 2 * r) +
    ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r + ' z'
  );
}

export interface Point {
  x: number;
  y: number;
}

/** Distance between two points in the review map's viewBox units. */
export function distance(a: Point, b: Point): number {
  return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

/**
 * A rectangular corridor of half-width `halfWidth` running from `tee` to `green`.
 * Used to show the playing line the contributor just marked.
 */
export function corridorPath(tee: Point, green: Point, halfWidth = 52): string {
  const dx = green.x - tee.x;
  const dy = green.y - tee.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return (
    'M' + (tee.x + nx) + ' ' + (tee.y + ny) +
    ' L' + (green.x + nx) + ' ' + (green.y + ny) +
    ' L' + (green.x - nx) + ' ' + (green.y - ny) +
    ' L' + (tee.x - nx) + ' ' + (tee.y - ny) + ' Z'
  );
}
