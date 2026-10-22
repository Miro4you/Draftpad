import type { Camera } from '../core/camera';
import { markExtent } from '../core/document';
import { annoSegments } from '../core/curves';
import type { Box } from '../core/geom';
import { dashArray, INK_WIDTHS, penColor, PENCIL_WIDTHS } from '../core/pens';
import { isAnnotation, type ArcEntity, type CircleEntity, type Entity, type LineEntity } from '../core/types';
import { drawAnno, drawHatch } from './annotations';
import { grain } from './grain';
import { hashString, traceEntity } from './paths';
import { roughAmpAtScale, roughAmplitude, traceRough } from './rough';
import { worldWidth } from '../core/scale';

interface RoughCache {
  key: string;
  box: Box;
  path: Path2D;
}
const roughCache = new WeakMap<Entity, RoughCache>();
const markCache = new WeakMap<Entity, LineEntity[]>();

/** Thinnest line drawn on screen, in CSS px, so fine pens stay visible when zoomed out. */
export const MIN_LINE_PX = 0.7;
const PENCIL_ALPHA = 0.9;

/** Thin partner of a pen width for centre lines (ISO: about half the width). */
function thinWidth(e: CircleEntity | ArcEntity): number {
  if (e.style.pen === 'pencil') return PENCIL_WIDTHS[0];
  const target = e.style.width / 2;
  let best: number = INK_WIDTHS[0];
  for (const w of INK_WIDTHS) if (w <= target + 1e-9) best = w;
  return best;
}

/** The two centre lines of a circle or arc as line entities (dash-dot, thin). */
export function centerMarks(e: CircleEntity | ArcEntity): LineEntity[] {
  const m = e.r + markExtent(e.r);
  const style = { ...e.style, width: thinWidth(e), lineType: 'dashdot' as const };
  const base = { kind: 'line' as const, layerId: e.layerId, z: e.z, style };
  return [
    { ...base, id: `${e.id}:h`, a: { x: e.c.x - m, y: e.c.y }, b: { x: e.c.x + m, y: e.c.y } },
    { ...base, id: `${e.id}:v`, a: { x: e.c.x, y: e.c.y - m }, b: { x: e.c.x, y: e.c.y + m } },
  ];
}

/**
 * Strokes entities onto a canvas in world coordinates.
 * One painter per canvas context (it caches pencil grain patterns per frame).
 */
export class Painter {
  private patterns = new Map<string, CanvasPattern | null>();
  private patternMatrix: DOMMatrix | null = null;
  private scale = 1;
  private view: Box = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

  constructor(private ctx: CanvasRenderingContext2D) {}

  /** Set the world transform for this frame; `view` is the visible world box. */
  begin(cam: Camera, dpr: number, view: Box): void {
    const [a, b, c, d, e, f] = cam.matrix();
    this.ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
    this.scale = cam.scale;
    this.view = view;
    grain.update(cam.scale, dpr);
    // Pattern space → world: one grain texel is `grain.texel` mm on the paper.
    try {
      this.patternMatrix = new DOMMatrix().scale(grain.texel);
    } catch {
      this.patternMatrix = null;
    }
    this.patterns.clear();
  }

  effectiveWidth(width: number): number {
    return Math.max(width, MIN_LINE_PX / this.scale);
  }

  private pencilPattern(color: string): CanvasPattern | null {
    if (this.patterns.has(color)) return this.patterns.get(color)!;
    let p: CanvasPattern | null = null;
    if (this.patternMatrix) {
      p = this.ctx.createPattern(grain.tile(color) as CanvasImageSource, 'repeat');
      // Without pattern transforms the grain can't follow the paper; plain graphite then.
      if (p && typeof p.setTransform === 'function') p.setTransform(this.patternMatrix);
      else p = null;
    }
    this.patterns.set(color, p);
    return p;
  }

  /** Draw an entity (plus its centre-line cross, if any). */
  draw(e: Entity, alpha = 1): void {
    if (isAnnotation(e)) {
      const color = penColor(e.style);
      const a = alpha * (e.style.pen === 'pencil' ? PENCIL_ALPHA : 1);
      const w = this.effectiveWidth(worldWidth(e));
      if (e.kind === 'hatch') drawHatch(this.ctx, e, color, w, a);
      else drawAnno(this.ctx, e, color, w, a);
      return;
    }
    this.drawOne(e, alpha, 0);
    if ((e.kind === 'circle' || e.kind === 'arc') && e.mark) {
      let marks = markCache.get(e);
      if (!marks) markCache.set(e, (marks = centerMarks(e)));
      for (const l of marks) {
        // Centre the pattern so the long dashes cross exactly at the centre.
        const w = this.effectiveWidth(worldWidth(l));
        const dash = dashArray(l.style.lineType, w);
        const period = dash.reduce((s, v) => s + v, 0);
        const half = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) / 2;
        const offset = (((dash[0] / 2 - half) % period) + period) % period;
        this.drawOne(l, alpha, offset);
      }
    }
  }

  private drawOne(e: Entity, alpha: number, dashOffset: number): void {
    const ctx = this.ctx;
    const s = e.style;
    const color = penColor(s);
    const ww = worldWidth(e);
    const w = this.effectiveWidth(ww);
    const dash = dashArray(s.lineType, w);

    if (s.pen === 'pencil') {
      ctx.globalAlpha = alpha * PENCIL_ALPHA;
      const paint = this.pencilPattern(color) ?? color;
      const amp = roughAmpAtScale(ww, this.scale);
      if (amp > 0) {
        // Up close: ragged graphite edge, filled as one outline.
        ctx.fillStyle = paint;
        ctx.fill(this.roughPath(e, w, dash, dashOffset, amp), 'nonzero');
        ctx.globalAlpha = 1;
        return;
      }
      ctx.strokeStyle = paint;
    } else {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
    }
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash);
    ctx.lineDashOffset = dashOffset;
    ctx.beginPath();
    traceEntity(ctx, e);
    ctx.stroke();
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
  }

  /**
   * The ragged outline, cached per entity. It is rebuilt only when the zoom crosses
   * a power of two (sampling level) or the view leaves the generously clipped area.
   */
  private roughPath(e: Entity, w: number, dash: number[], dashOffset: number, amp: number): Path2D {
    const level = Math.round(Math.log2(1 / this.scale));
    const px = Math.pow(2, -level);
    const ampQ = Math.round((amp / roughAmplitude(worldWidth(e))) * 8) / 8;
    const key = `${level}|${ampQ}|${w.toFixed(4)}|${dashOffset.toFixed(4)}`;
    const v = this.view;
    const c = roughCache.get(e);
    if (c && c.key === key && v.minX >= c.box.minX && v.maxX <= c.box.maxX && v.minY >= c.box.minY && v.maxY <= c.box.maxY) {
      return c.path;
    }
    const dx = v.maxX - v.minX;
    const dy = v.maxY - v.minY;
    const box = { minX: v.minX - dx / 2, maxX: v.maxX + dx / 2, minY: v.minY - dy / 2, maxY: v.maxY + dy / 2 };
    const path = new Path2D();
    traceRough(path, e, {
      width: w,
      dash,
      dashOffset,
      amp: ampQ * roughAmplitude(worldWidth(e)),
      pxPerMm: px,
      view: box,
      seed: hashString(e.id),
    });
    roughCache.set(e, { key, box, path });
    return path;
  }

  /** Coloured halo behind/over an entity (selection, delete preview). */
  highlight(e: Entity, color: string, alpha: number, extraPx = 5): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.effectiveWidth(worldWidth(e)) + extraPx / this.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    if (isAnnotation(e)) {
      for (const [a, b] of annoSegments(e)) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    } else {
      traceEntity(ctx, e);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Dashed construction guide along an entity's geometry (constant on screen). */
  guide(e: Entity, color: string, alpha = 1): void {
    const ctx = this.ctx;
    const px = 1 / this.scale;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * px;
    ctx.lineCap = 'butt';
    ctx.setLineDash([7 * px, 5 * px]);
    ctx.beginPath();
    traceEntity(ctx, { ...e, style: { ...e.style, lineType: 'solid' } });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}
