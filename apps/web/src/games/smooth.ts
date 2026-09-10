// Pure snapshot-interpolation math (no React) so it is unit-testable.

export type Pt = { x: number; y: number };

/**
 * Interpolate each id's position between `from` and `to` at fraction k
 * (clamped to 0..1). Ids missing from `from` snap to their `to` position;
 * ids missing from `to` are dropped.
 */
export function lerpPositions(
  from: Record<string, Pt>,
  to: Record<string, Pt>,
  k: number,
): Record<string, Pt> {
  const t = Math.min(1, Math.max(0, k));
  const out: Record<string, Pt> = {};
  for (const [id, b] of Object.entries(to)) {
    const a = from[id];
    out[id] = a
      ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      : { x: b.x, y: b.y };
  }
  return out;
}
