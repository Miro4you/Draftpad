import type { Entity } from './types';

/**
 * Drawing scale: how many world mm one mm on paper stands for (10 = 1:10,
 * 0.5 = 2:1). Lengths stay real mm; pen widths, lettering, arrows and hatch
 * spacing are paper sizes and are drawn this many times larger, so a big part
 * zoomed out looks like a drawing on paper at that scale.
 */
let k = 1;
let generation = 0;

/** Scales offered (world mm per paper mm). */
export const SCALES = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100] as const;

export function drawingScale(): number {
  return k;
}

/** Bumped on every change, so caches of sizes can tell they are stale. */
export function scaleGeneration(): number {
  return generation;
}

/** Mark all cached sizes and layouts stale (e.g. when label texts change). */
export function invalidateLayouts(): void {
  generation++;
}

export function setDrawingScale(v: number): void {
  if (!(v > 0) || v === k) return;
  k = v;
  generation++;
}

/** Line width in world mm (sheets carry their own scale). */
export function worldWidth(e: Entity): number {
  return e.kind === 'sheet' ? e.style.width : e.style.width * k;
}

/** The offered scale closest to `raw` (on a log scale). */
export function nearestScale(raw: number): number {
  let best: number = SCALES[0];
  for (const s of SCALES) if (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw))) best = s;
  return best;
}

/** "1:10", "1:1", "2:1". */
export function formatScale(v: number): string {
  const f = (x: number) => String(Math.round(x * 100) / 100).replace('.', ',');
  return v >= 1 ? `1:${f(v)}` : `${f(1 / v)}:1`;
}
