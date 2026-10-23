import type { App } from '../app';
import { drawingScale, worldWidth } from '../core/scale';
import { endPoints, geomBox, insideHatch, project } from '../core/curves';
import { boxesIntersect, boxExpand, dist, emptyBox, boxAddPoint, simplifyFlat, type Box, type Vec } from '../core/geom';
import { dilate, floodFill, labelComponents, traceLoops } from '../core/region';
import { isAnnotation, type Entity, type HatchEntity } from '../core/types';
import { traceEntity } from '../render/paths';
import { DANGER } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

/** How long open spots of a non-closed area stay marked (ms). */
const SPOT_MS = 2500;

/** Gap tolerances offered (mm); the first is the default. */
export const HATCH_GAPS = [0.5, 1] as const;

/** Longest side of the raster used to find the area (CSS px are scaled down beyond this). */
const MAX_RASTER = 2400;

/** Lines that bound areas: everything except annotations and centre/axis lines. */
export function isBoundary(e: Entity): boolean {
  if (isAnnotation(e)) return false;
  if (e.kind === 'line' && e.axis) return false;
  return e.style.lineType !== 'dashdot' && e.style.lineType !== 'dashdotdot';
}

export type RegionResult = { ok: true; loops: number[][] } | { ok: false; reason: 'onLine' | 'open' };

/** A raster over part of the world: world → raster px is the affine `m`. */
interface Frame {
  w: number;
  h: number;
  m: [number, number, number, number, number, number];
  pxPerMm: number;
  /** World area covered (for culling). */
  view: Box;
}

function toWorld(f: Frame, x: number, y: number): Vec {
  const [a, b, c, d, e, g] = f.m;
  const det = a * d - b * c;
  const px = x - e;
  const py = y - g;
  return { x: (d * px - c * py) / det, y: (-b * px + a * py) / det };
}

function toRaster(f: Frame, p: Vec): Vec {
  const [a, b, c, d, e, g] = f.m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + g };
}

/** Axis-aligned frame over a world box, with at most about `maxPx` pixels. */
function boxFrame(box: Box, maxPx = 1_500_000): Frame {
  const bw = Math.max(box.maxX - box.minX, 1);
  const bh = Math.max(box.maxY - box.minY, 1);
  const k = Math.min(16, Math.max(2, Math.sqrt(maxPx / (bw * bh))));
  return { w: Math.ceil(bw * k), h: Math.ceil(bh * k), m: [k, 0, 0, k, -box.minX * k, -box.minY * k], pxPerMm: k, view: box };
}

function newContext(w: number, h: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Boundary lines drawn thickened by the gap tolerance (so gaps up to `gap` close). */
function rasterize(entities: Iterable<Entity>, f: Frame, gap: number): { barrier: Uint8Array; bounds: Entity[]; maxHalf: number } | null {
  const ctx = newContext(f.w, f.h);
  if (!ctx) return null;
  ctx.setTransform(...f.m);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // At least 2 raster px so a line never leaks diagonally.
  const minW = 2 / f.pxPerMm;
  const view = boxExpand(f.view, gap);
  const bounds: Entity[] = [];
  let maxHalf = 0;
  for (const ent of entities) {
    if (!isBoundary(ent) || !boxesIntersect(geomBox(ent), view)) continue;
    bounds.push(ent);
    const lw = Math.max(worldWidth(ent) + gap, minW);
    maxHalf = Math.max(maxHalf, lw / 2);
    ctx.lineWidth = lw;
    ctx.beginPath();
    traceEntity(ctx, ent);
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, f.w, f.h).data;
  const barrier = new Uint8Array(f.w * f.h);
  for (let i = 0; i < f.w * f.h; i++) barrier[i] = img[i * 4 + 3] > 96 ? 1 : 0;
  return { barrier, bounds, maxHalf };
}

/** Filled raster area → world loops, grown back to the line centres and snapped onto the lines. */
function vectorize(filled: Uint8Array, f: Frame, bounds: Entity[], gap: number, maxHalf: number): number[][] {
  const grow = Math.max(0, Math.round((gap / 2 + 0.1) * f.pxPerMm));
  const area = dilate(filled, f.w, f.h, grow);
  const raw = traceLoops(area, f.w, f.h, 0);
  const snapTol = 2.5 / f.pxPerMm + 0.05;
  const loops: number[][] = [];
  for (const loop of raw) {
    let lb: Box = emptyBox();
    const pts: number[] = [];
    for (let i = 0; i < loop.length; i += 2) {
      const p = toWorld(f, loop[i], loop[i + 1]);
      pts.push(p.x, p.y);
      lb = boxAddPoint(lb, p.x, p.y);
    }
    const near = bounds.filter((ent) => boxesIntersect(boxExpand(geomBox(ent), snapTol + maxHalf), lb));
    for (let i = 0; i < pts.length; i += 2) {
      const p = { x: pts[i], y: pts[i + 1] };
      let best: Vec | null = null;
      let bd = snapTol + maxHalf;
      for (const ent of near) {
        const r = project(ent, p);
        if (r.d < bd) {
          bd = r.d;
          best = r.point;
        }
      }
      if (best && bd <= snapTol + (maxHalf - gap / 2)) {
        pts[i] = best.x;
        pts[i + 1] = best.y;
      }
    }
    pts.push(pts[0], pts[1]);
    const simple = simplifyFlat(pts, Math.max(0.01, 0.3 / f.pxPerMm));
    simple.length -= 2;
    if (simple.length >= 6) loops.push(simple.map((v) => Math.round(v * 1000) / 1000));
  }
  return loops;
}

/**
 * The closed area around a world point, found on a raster of the current view:
 * the free space around the point is flood-filled, grown back to the line
 * centres, traced and snapped onto the nearby lines.
 */
export function findRegion(app: App, world: Vec, gap: number): RegionResult {
  gap *= drawingScale();
  const cam = app.cam;
  const k = Math.min(1, MAX_RASTER / Math.max(app.width, app.height, 1));
  const [a, b, c, d, e, g] = cam.matrix();
  const f: Frame = {
    w: Math.max(8, Math.ceil(app.width * k)),
    h: Math.max(8, Math.ceil(app.height * k)),
    m: [a * k, b * k, c * k, d * k, e * k, g * k],
    pxPerMm: cam.scale * k,
    view: cam.visibleBox(app.width, app.height),
  };
  const r = rasterize(app.doc.visibleEntities(), f, gap);
  if (!r) return { ok: false, reason: 'open' };
  const s = toRaster(f, world);
  const fill = floodFill(r.barrier, f.w, f.h, Math.floor(s.x), Math.floor(s.y));
  if (!fill.ok) return fill;
  const loops = vectorize(fill.filled, f, r.bounds, gap, r.maxHalf);
  return loops.length ? { ok: true, loops } : { ok: false, reason: 'open' };
}

/**
 * Where a non-closed area is open: loose line ends (touching nothing, also not
 * with the gap tolerance) next to the free space around the tapped point,
 * nearest first.
 */
export function openSpots(app: App, world: Vec, gap: number, max = 6): Vec[] {
  gap *= drawingScale();
  const cam = app.cam;
  const k = Math.min(1, MAX_RASTER / Math.max(app.width, app.height, 1));
  const [a, b, c, d, e, g] = cam.matrix();
  const f: Frame = {
    w: Math.max(8, Math.ceil(app.width * k)),
    h: Math.max(8, Math.ceil(app.height * k)),
    m: [a * k, b * k, c * k, d * k, e * k, g * k],
    pxPerMm: cam.scale * k,
    view: cam.visibleBox(app.width, app.height),
  };
  const r = rasterize(app.doc.visibleEntities(), f, gap);
  if (!r) return [];
  const comp = labelComponents(r.barrier, f.w, f.h);
  const s = toRaster(f, world);
  const seed = comp.labels[Math.floor(s.y) * f.w + Math.floor(s.x)];
  if (!seed) return [];
  const loose: { p: Vec; ent: Entity }[] = [];
  for (const ent of r.bounds) {
    for (const p of endPoints(ent)) {
      const tol = gap / 2 + worldWidth(ent) / 2 + 0.05;
      const touching = r.bounds.some((o) => {
        if (o === ent) {
          // Its own other end (a freehand stroke closed on itself).
          const ends = endPoints(o);
          const other = dist(ends[0], p) < 1e-9 ? ends[1] : ends[0];
          return dist(other, p) <= tol;
        }
        return project(o, p).d <= tol + worldWidth(o) / 2;
      });
      if (touching) continue;
      // Next to the free space of the tapped area?
      const q = toRaster(f, p);
      const rad = Math.ceil(r.maxHalf * f.pxPerMm) + 3;
      let near = false;
      for (let y = Math.max(0, Math.floor(q.y) - rad); y <= Math.min(f.h - 1, Math.floor(q.y) + rad) && !near; y++) {
        for (let x = Math.max(0, Math.floor(q.x) - rad); x <= Math.min(f.w - 1, Math.floor(q.x) + rad); x++) {
          if (comp.labels[y * f.w + x] === seed) {
            near = true;
            break;
          }
        }
      }
      if (near) loose.push({ p, ent });
    }
  }
  // A stray line with both ends free is not part of the outline – unless another
  // line's free end lies close by (then it is a gap).
  const shown = loose.filter((l) => {
    const both = loose.filter((o) => o.ent === l.ent).length > 1;
    return !both || loose.some((o) => o.ent !== l.ent && dist(o.p, l.p) < 15);
  });
  return shown
    .map((l) => l.p)
    .sort((p, q) => dist(p, world) - dist(q, world))
    .slice(0, max);
}

function loopsBox(loops: number[][]): Box {
  let b = emptyBox();
  for (const l of loops) for (let i = 0; i < l.length; i += 2) b = boxAddPoint(b, l[i], l[i + 1]);
  return b;
}

/**
 * New outline of an existing hatch after the drawing changed: the areas inside
 * its old outline are found again on a raster around it. Areas that reach the
 * old outline are kept (so a line drawn across keeps both halves hatched), areas
 * enclosed only by new lines – a new hole – are left out. Returns null when the
 * area is now open (or nothing is left), so the hatch stays as it was.
 */
export function refitHatch(entities: () => Iterable<Entity>, hatch: HatchEntity, gap: number): number[][] | null {
  gap *= drawingScale();
  const ob = loopsBox(hatch.loops);
  const size = Math.max(ob.maxX - ob.minX, ob.maxY - ob.minY);
  for (const margin of [Math.max(10, size * 0.3), Math.max(30, size * 1.2)]) {
    const f = boxFrame(boxExpand(ob, margin));
    const r = rasterize(entities(), f, gap);
    if (!r) return null;
    const comp = labelComponents(r.barrier, f.w, f.h);
    // Pixels on and inside the old outline.
    const ctx = newContext(f.w, f.h);
    if (!ctx) return null;
    ctx.setTransform(...f.m);
    ctx.beginPath();
    for (const l of hatch.loops) {
      for (let i = 0; i < l.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, l[i], l[i + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = '#f00';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#00f';
    ctx.lineWidth = gap + 4 / f.pxPerMm;
    ctx.stroke();
    const img = ctx.getImageData(0, 0, f.w, f.h).data;
    const inside = new Map<number, number>();
    const onEdge = new Set<number>();
    for (let i = 0; i < f.w * f.h; i++) {
      const lab = comp.labels[i];
      if (!lab) continue;
      if (img[i * 4 + 2] > 128) onEdge.add(lab);
      else if (img[i * 4] > 128) inside.set(lab, (inside.get(lab) ?? 0) + 1);
    }
    let keep = [...inside.keys()].filter((lab) => onEdge.has(lab) && (inside.get(lab) ?? 0) > 4);
    if (!keep.length) {
      // Fallback: the component covering most of the old area.
      let best = 0;
      for (const [lab, n] of inside) if (!best || n > (inside.get(best) ?? 0)) best = lab;
      if (best) keep = [best];
    }
    if (!keep.length) return null;
    if (keep.some((lab) => comp.border[lab])) continue; // open now: look further out once
    const set = new Set(keep);
    const filled = new Uint8Array(f.w * f.h);
    for (let i = 0; i < f.w * f.h; i++) if (set.has(comp.labels[i])) filled[i] = 1;
    const loops = vectorize(filled, f, r.bounds, gap, r.maxHalf);
    return loops.length ? loops : null;
  }
  return null;
}

/**
 * Hatch fill: tap inside a closed area. Tapping an existing hatch gives it the
 * current pattern and spacing instead.
 */
export class HatchTool implements Tool {
  readonly id = 'hatch';
  private pressed: Vec | null = null;
  private spots: Vec[] = [];
  private spotTimer: number | undefined;

  constructor(private app: App) {}

  get busy(): boolean {
    return this.pressed !== null;
  }

  down(ev: ToolEvent): void {
    this.pressed = ev.screen;
  }

  move(): void {}

  up(ev: ToolEvent): void {
    const start = this.pressed;
    this.pressed = null;
    if (!start || Math.hypot(ev.screen.x - start.x, ev.screen.y - start.y) > 12) return;
    this.fillAt(ev.world);
  }

  /** Hatch the area around a world point. */
  fillAt(world: Vec): boolean {
    const app = this.app;
    const set = app.settings;
    const existing = [...app.doc.visibleEntities(false)]
      .reverse()
      .find((e): e is HatchEntity => e.kind === 'hatch' && insideHatch(e.loops, world));
    if (existing) {
      if (existing.pattern !== set.hatchPattern || existing.spacing !== set.hatchSpacing) {
        app.doc.update({ ...existing, pattern: set.hatchPattern, spacing: set.hatchSpacing });
      } else app.toast('Fläche ist schon schraffiert');
      return true;
    }
    if (!app.ensureDrawableLayer()) return false;
    const r = findRegion(app, world, set.hatchGap);
    if (!r.ok) {
      app.toast(
        r.reason === 'onLine'
          ? 'Bitte in eine Fläche tippen, nicht auf eine Linie'
          : 'Fläche nicht geschlossen – Lücke schließen oder herauszoomen, bis sie ganz sichtbar ist',
      );
      if (r.reason === 'open') this.showSpots(openSpots(app, world, set.hatchGap));
      return false;
    }
    // Hatch lines in the current pen (choose a thin one for ISO hatching).
    const e = app.newEntity<HatchEntity>({ kind: 'hatch', loops: r.loops, pattern: set.hatchPattern, angle: 0, spacing: set.hatchSpacing, gap: set.hatchGap }, 'H');
    app.addDrawn({ ...e, style: { ...e.style, lineType: 'solid' } });
    return true;
  }

  /** Mark the open spots in red for a moment. */
  private showSpots(spots: Vec[]): void {
    this.spots = spots;
    window.clearTimeout(this.spotTimer);
    this.app.requestOverlay();
    if (!spots.length) return;
    this.spotTimer = window.setTimeout(() => {
      this.spots = [];
      this.app.requestOverlay();
    }, SPOT_MS);
  }

  cancel(): void {
    this.pressed = null;
  }

  hover(): void {}

  reset(): void {
    this.pressed = null;
    this.spots = [];
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.spots.length) return;
    const cam = this.app.cam;
    const pts = this.spots.map((p) => cam.toScreen(p));
    ctx.save();
    ctx.strokeStyle = DANGER;
    ctx.fillStyle = 'rgba(224, 72, 59, 0.15)';
    ctx.lineWidth = 2;
    // Likely gaps: dashed lines between loose ends close to each other.
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    const used = new Set<number>();
    for (let i = 0; i < this.spots.length; i++) {
      if (used.has(i)) continue;
      let best = -1;
      let bd = Infinity;
      for (let j = 0; j < this.spots.length; j++) {
        if (j === i || used.has(j)) continue;
        const d = dist(this.spots[i], this.spots[j]);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      if (best >= 0 && bd < 15) {
        used.add(i).add(best);
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[best].x, pts[best].y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
