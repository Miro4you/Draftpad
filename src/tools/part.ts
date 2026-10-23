import type { App } from '../app';
import { dist, type Vec } from '../core/geom';
import { partGeometry, type PartPrim } from '../core/parts';
import { INK_WIDTHS, PENCIL_WIDTHS } from '../core/pens';
import type { SnapHit } from '../core/snap';
import type { ArcEntity, CircleEntity, Entity, LineEntity, Style } from '../core/types';
import { drawGuideLine, drawPill, drawSnapMarker } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

const DRAG_PX = 8;

type State = { k: 'idle' } | { k: 'press'; start: Vec; at: Vec; hit: SnapHit | null; angle: number; moved: boolean };

/**
 * Places standard parts: the part follows the pen (snapping to centres, ends and
 * lines); tap to place it, or press and drag to turn it into a direction first.
 * Parts become ordinary lines, circles and arcs.
 */
export class PartTool implements Tool {
  readonly id = 'part';
  private state: State = { k: 'idle' };
  private hoverAt: { p: Vec; hit: SnapHit | null } | null = null;
  /** Direction of the part's axis when turned freely (radians, world); null = along the screen. */
  private angle: number | null = null;

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k !== 'idle';
  }

  get hoverSnap(): boolean {
    return this.state.k === 'idle';
  }

  /** The insertion angle chosen in the catalogue (radians, world), null = free. */
  private fixedAngle(): number | null {
    const a = this.app.settings.part.angle;
    return a === null || a === undefined ? null : (-a * Math.PI) / 180;
  }

  /** Angle a placement starts with. */
  private startAngle(): number {
    return this.fixedAngle() ?? this.angle ?? this.viewAngle();
  }

  private viewAngle(): number {
    const o = this.app.cam.toWorld({ x: 0, y: 0 });
    const r = this.app.cam.toWorld({ x: 1, y: 0 });
    return Math.atan2(r.y - o.y, r.x - o.x);
  }

  private styles(): Record<PartPrim['s'], Style> {
    const s = this.app.style;
    let thin: number = PENCIL_WIDTHS[0];
    if (s.pen === 'ink') {
      thin = INK_WIDTHS[0];
      for (const w of INK_WIDTHS) if (w <= s.width / 2 + 1e-9) thin = w;
    }
    return {
      thick: { ...s, lineType: 'solid' },
      thin: { ...s, width: thin, lineType: 'solid' },
      center: { ...s, width: thin, lineType: 'dashdot' },
    };
  }

  /** The part as entities at `at`, turned by `angle`. */
  entities(at: Vec, angle: number, preview: boolean): Entity[] {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const tp = (p: Vec): Vec => ({ x: at.x + c * p.x - s * p.y, y: at.y + s * p.x + c * p.y });
    const styles = this.styles();
    const base = (i: number, st: Style) =>
      preview ? { id: `part-preview-${i}`, layerId: '', z: 0, style: st } : { ...this.app.newEntity<LineEntity>({ kind: 'line', a: at, b: at }), style: st };
    return partGeometry(this.app.settings.part).map((p, i): Entity => {
      const b = base(i, styles[p.s]);
      if (p.t === 'line') return { ...b, kind: 'line', a: tp(p.a), b: tp(p.b) } as LineEntity;
      if (p.t === 'circle') return { ...b, kind: 'circle', c: tp(p.c), r: p.r } as CircleEntity;
      return { ...b, kind: 'arc', c: tp(p.c), r: p.r, start: p.start + angle, sweep: p.sweep } as ArcEntity;
    });
  }

  down(ev: ToolEvent): void {
    this.hoverAt = null;
    if (!this.app.ensureDrawableLayer()) return;
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    this.state = { k: 'press', start: ev.screen, at: s.p, hit: s.hit, angle: this.startAngle(), moved: false };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'press') return;
    // A fixed angle from the catalogue isn't turned by dragging.
    if (this.fixedAngle() !== null) return;
    if (!st.moved && dist(st.start, ev.screen) > DRAG_PX) st.moved = true;
    if (st.moved) {
      const q = this.app.resolveEnd(st.at, ev.world, ev.pointerType).p;
      if (dist(q, st.at) > 1e-9) st.angle = Math.atan2(q.y - st.at.y, q.x - st.at.x);
    }
    this.app.requestOverlay();
  }

  up(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'press') return;
    this.move(ev);
    this.state = { k: 'idle' };
    if (st.moved) this.angle = st.angle;
    this.app.addDrawn(...this.entities(st.at, st.angle, false));
    this.app.requestOverlay();
  }

  cancel(): void {
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    if (this.state.k !== 'idle') return;
    if (!ev) this.hoverAt = null;
    else {
      const s = this.app.snapPoint(ev.world, ev.pointerType);
      this.hoverAt = { p: s.p, hit: s.hit };
    }
    this.app.requestOverlay();
  }

  reset(): void {
    this.cancel();
    this.hoverAt = null;
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const st = this.state;
    const cam = this.app.cam;
    if (st.k === 'press') {
      for (const e of this.entities(st.at, st.angle, true)) this.app.paintPreview(e, 0.85);
      if (st.hit) drawSnapMarker(ctx, cam.toScreen(st.at), st.hit.kind);
      if (st.moved) {
        const a = cam.toScreen(st.at);
        const dir = { x: Math.cos(st.angle), y: Math.sin(st.angle) };
        const b = cam.toScreen({ x: st.at.x + dir.x * cam.px(60), y: st.at.y + dir.y * cam.px(60) });
        drawGuideLine(ctx, a, b);
        let deg = (-st.angle * 180) / Math.PI;
        deg = ((deg % 360) + 360) % 360;
        drawPill(ctx, { x: b.x, y: b.y - 22 }, `${deg.toFixed(deg % 1 ? 1 : 0).replace('.', ',')}°`);
      }
    } else if (this.hoverAt) {
      for (const e of this.entities(this.hoverAt.p, this.startAngle(), true)) this.app.paintPreview(e, 0.45);
    }
  }
}
