import type { App } from '../app';
import { dist, drawingAngleDeg, polar, type Vec } from '../core/geom';
import { INK_WIDTHS, PENCIL_WIDTHS } from '../core/pens';
import type { SnapHit } from '../core/snap';
import type { ArcEntity, CircleEntity, DimEntity, LineEntity, Style } from '../core/types';
import { ACCENT, drawGuideLine, drawMeasureLabel, drawSnapMarker } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';
import { GripDrag, gripsFor } from './grips';
import { editAnnotation } from '../ui/edit-annotation';
import { insideAnnoText } from '../core/annotations';

const DRAG_PX = 8;

type Place =
  | { t: 'lin'; p1: Vec; p2: Vec }
  | { t: 'dia' | 'rad'; c: Vec; r: number }
  | { t: 'ang'; v: Vec; d1: Vec; d2: Vec; l1: LineEntity; l2: LineEntity };

type State =
  | { k: 'idle' }
  | { k: 'press'; start: Vec; p1: Vec; hit: SnapHit | null; cur: Vec; curHit: SnapHit | null; moved: boolean }
  | { k: 'leg'; line: LineEntity; press: Vec | null }
  | { k: 'place'; place: Place; q: Vec | null }
  /** Pressed on the figure of an existing dimension: drag to move it, tap to edit. */
  | { k: 'adjust'; drag: GripDrag; start: Vec; moved: boolean; e: DimEntity };

/** Intersection of two infinite lines, or null when (nearly) parallel. */
function lineCross(a: LineEntity, b: LineEntity): Vec | null {
  const r = { x: a.b.x - a.a.x, y: a.b.y - a.a.y };
  const s = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9 * Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y) * 1e3) return null;
  const t = ((b.a.x - a.a.x) * s.y - (b.a.y - a.a.y) * s.x) / den;
  return { x: a.a.x + r.x * t, y: a.a.y + r.y * t };
}

function unit(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

/** How far a line reaches from v in direction d (0 if it lies on the other side). */
function reach(l: LineEntity, v: Vec, d: Vec): number {
  return Math.max(0, (l.a.x - v.x) * d.x + (l.a.y - v.y) * d.y, (l.b.x - v.x) * d.x + (l.b.y - v.y) * d.y);
}

/**
 * Linear dimension for p1–p2 placed at q: horizontal when q lies above/below the
 * span, vertical when beside it, otherwise aligned with p1–p2.
 */
export function linearDim(p1: Vec, p2: Vec, q: Vec): { dir: number; off: number } {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);
  const inX = q.x >= minX && q.x <= maxX;
  const inY = q.y >= minY && q.y <= maxY;
  const aligned = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  let dir = aligned;
  // Axis-parallel lines are measured along themselves anyway.
  const ax = Math.abs(Math.sin(aligned)) < 1e-6 || Math.abs(Math.cos(aligned)) < 1e-6;
  if (!ax && inX && !inY) dir = 0;
  else if (!ax && inY && !inX) dir = Math.PI / 2;
  const n = { x: -Math.sin(dir), y: Math.cos(dir) };
  const off = (q.x - p1.x) * n.x + (q.y - p1.y) * n.y;
  return { dir, off };
}

/**
 * Dimension tool (DIN 406): drag from point to point, then place the dimension
 * line; tap a line and place it; tap a circle (Ø) or arc (R); tap two lines for
 * the angle, the pointer picks the sector. Drag the figure of an existing
 * dimension to move it (along, outside, line distance); tap it to edit the text.
 */
export class DimTool implements Tool {
  readonly id = 'dim';
  private state: State = { k: 'idle' };

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k === 'press' || this.state.k === 'adjust';
  }

  /** Existing (editable) dimension whose figure lies under p. */
  private figureAt(p: Vec): DimEntity | null {
    let found: DimEntity | null = null;
    for (const e of this.app.doc.visibleEntities(false)) if (e.kind === 'dim' && insideAnnoText(e, p)) found = e;
    return found;
  }

  get hoverSnap(): boolean {
    return this.state.k === 'idle';
  }

  private thinStyle(): Style {
    const width = this.app.style.pen === 'pencil' ? PENCIL_WIDTHS[0] : INK_WIDTHS[1];
    return { ...this.app.style, width, lineType: 'solid' };
  }

  private styled(d: Omit<DimEntity, 'id' | 'layerId' | 'z' | 'style'>): DimEntity {
    return { ...this.app.newEntity<DimEntity>(d, 'D'), style: this.thinStyle() };
  }

  /** The dimension for a placement at q. */
  private build(pl: Place, q: Vec, preview: boolean): DimEntity | null {
    const mk = (d: Omit<DimEntity, 'id' | 'layerId' | 'z' | 'style'>): DimEntity =>
      preview ? { ...d, id: 'preview-dim', layerId: '', z: 0, style: this.thinStyle() } : this.styled(d);
    const snapDeg = (deg: number) => (this.app.angleSnapOn ? Math.round(deg / 15) * 15 : deg);
    switch (pl.t) {
      case 'lin': {
        const { dir, off } = linearDim(pl.p1, pl.p2, q);
        return mk({ kind: 'dim', type: 'lin', p1: pl.p1, p2: pl.p2, dir, off });
      }
      case 'dia':
      case 'rad': {
        const deg = dist(pl.c, q) > 1e-9 ? snapDeg(drawingAngleDeg(pl.c, q)) : 45;
        return mk({ kind: 'dim', type: pl.t, p1: pl.c, p2: polar(pl.c, deg, pl.r), off: 0 });
      }
      case 'ang': {
        const w = unit({ x: q.x - pl.v.x, y: q.y - pl.v.y });
        // Pick the directions of both legs that enclose the pointer.
        let best: [Vec, Vec] | null = null;
        for (const s1 of [1, -1])
          for (const s2 of [1, -1]) {
            const a = { x: pl.d1.x * s1, y: pl.d1.y * s1 };
            const b = { x: pl.d2.x * s2, y: pl.d2.y * s2 };
            const cab = a.x * b.x + a.y * b.y;
            // w lies between a and b (the smaller angle) when both cross products agree.
            const c1 = a.x * w.y - a.y * w.x;
            const c2 = w.x * b.y - w.y * b.x;
            const cr = a.x * b.y - a.y * b.x;
            if (Math.sign(c1) === Math.sign(cr) && Math.sign(c2) === Math.sign(cr) && cab > -1) best = [a, b];
          }
        if (!best) return null;
        const [a, b] = best;
        const R = Math.max(dist(pl.v, q), this.app.cam.px(12));
        const la = reach(pl.l1, pl.v, a) || R;
        const lb = reach(pl.l2, pl.v, b) || R;
        return mk({
          kind: 'dim',
          type: 'ang',
          p1: pl.v,
          p2: { x: pl.v.x + a.x * la, y: pl.v.y + a.y * la },
          p3: { x: pl.v.x + b.x * lb, y: pl.v.y + b.y * lb },
          off: R,
        });
      }
    }
  }

  private commit(pl: Place, q: Vec): void {
    const e = this.build(pl, q, false);
    this.state = { k: 'idle' };
    this.legHover = null;
    if (e) this.app.addDrawn(e);
    this.app.requestOverlay();
  }

  private startPlace(place: Place, q: Vec | null): void {
    this.state = { k: 'place', place, q };
    this.app.requestOverlay();
  }

  down(ev: ToolEvent): void {
    const st = this.state;
    if (st.k === 'place') {
      st.q = ev.world;
      this.app.requestOverlay();
      return;
    }
    if (st.k === 'leg') {
      st.press = ev.screen;
      this.app.requestOverlay();
      return;
    }
    const fig = this.figureAt(ev.world);
    if (fig) {
      const g = gripsFor(this.app, fig, 'grips').find((x) => x.key === 'text');
      if (g) {
        this.state = { k: 'adjust', drag: new GripDrag(this.app, g, fig, ev.screen), start: ev.screen, moved: false, e: fig };
        this.app.requestOverlay();
        return;
      }
    }
    if (!this.app.ensureDrawableLayer()) return;
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    this.state = { k: 'press', start: ev.screen, p1: s.p, hit: s.hit, cur: s.p, curHit: null, moved: false };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k === 'adjust') {
      if (!st.moved && dist(st.start, ev.screen) > DRAG_PX) st.moved = true;
      if (st.moved) st.drag.move(ev);
      return;
    }
    if (st.k === 'press') {
      if (!st.moved && dist(st.start, ev.screen) > DRAG_PX) st.moved = true;
      if (st.moved) {
        const r = this.app.resolveEnd(st.p1, ev.world, ev.pointerType);
        st.cur = r.p;
        st.curHit = r.hit;
      }
      this.app.requestOverlay();
    } else if (st.k === 'place') {
      st.q = ev.world;
      this.app.requestOverlay();
    } else if (st.k === 'leg') {
      this.legHover = ev.world;
      this.app.requestOverlay();
    }
  }

  up(ev: ToolEvent): void {
    const st = this.state;
    if (st.k === 'adjust') {
      this.state = { k: 'idle' };
      if (st.moved) {
        st.drag.move(ev);
        st.drag.end();
      } else void editAnnotation(this.app, st.e);
      this.app.requestOverlay();
      return;
    }
    if (st.k === 'place') {
      this.commit(st.place, ev.world);
      return;
    }
    if (st.k === 'leg') {
      const tap = st.press && dist(st.press, ev.screen) <= DRAG_PX;
      st.press = null;
      const hit = tap ? this.app.hitEntity(ev.world, ev.pointerType, false) : null;
      if (hit && hit.e.kind === 'line' && hit.e.id !== st.line.id) {
        const v = lineCross(st.line, hit.e);
        if (!v) {
          this.app.toast('Die Linien sind parallel – kein Winkel');
          return;
        }
        const d1 = unit({ x: st.line.b.x - st.line.a.x, y: st.line.b.y - st.line.a.y });
        const d2 = unit({ x: hit.e.b.x - hit.e.a.x, y: hit.e.b.y - hit.e.a.y });
        this.startPlace({ t: 'ang', v, d1, d2, l1: st.line, l2: hit.e }, ev.pointerType === 'mouse' ? ev.world : null);
        return;
      }
      this.commit({ t: 'lin', p1: st.line.a, p2: st.line.b }, ev.world);
      return;
    }
    if (st.k !== 'press') return;
    if (st.moved) {
      if (dist(st.p1, st.cur) < 1e-6) {
        this.state = { k: 'idle' };
        this.app.requestOverlay();
        return;
      }
      this.startPlace({ t: 'lin', p1: st.p1, p2: st.cur }, null);
      return;
    }
    // Tap: dimension an existing element.
    this.state = { k: 'idle' };
    const hit = this.app.hitEntity(ev.world, ev.pointerType, false);
    const e = hit?.e;
    if (e?.kind === 'circle' || e?.kind === 'arc') {
      const c = e as CircleEntity | ArcEntity;
      this.startPlace({ t: e.kind === 'circle' ? 'dia' : 'rad', c: c.c, r: c.r }, ev.world);
    } else if (e?.kind === 'line') {
      this.state = { k: 'leg', line: e, press: null };
      this.app.toast('Zweite Linie antippen für einen Winkel – oder Maßlinie platzieren');
    } else {
      this.app.toast('Von Punkt zu Punkt ziehen – oder Linie, Kreis oder Bogen antippen');
    }
    this.app.requestOverlay();
  }

  cancel(): void {
    if (this.state.k === 'adjust') this.state.drag.cancel();
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    const st = this.state;
    if (st.k === 'place' || st.k === 'leg') {
      if (ev) {
        if (st.k === 'place') st.q = ev.world;
        else this.legHover = ev.world;
        this.app.requestOverlay();
      }
    }
  }

  private legHover: Vec | null = null;

  reset(): void {
    this.cancel();
    this.legHover = null;
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const st = this.state;
    const cam = this.app.cam;
    if (st.k === 'adjust') {
      const cur = this.app.doc.get(st.e.id);
      if (cur) this.app.paintHighlight([cur], ACCENT, 0.25);
      return;
    }
    if (st.k === 'press') {
      if (st.hit) drawSnapMarker(ctx, cam.toScreen(st.p1), st.hit.kind);
      if (st.moved) {
        drawGuideLine(ctx, cam.toScreen(st.p1), cam.toScreen(st.cur));
        if (st.curHit) drawSnapMarker(ctx, cam.toScreen(st.cur), st.curHit.kind);
        drawMeasureLabel(ctx, cam.toScreen(st.p1), cam.toScreen(st.cur), this.app.measureText(st.p1, st.cur));
      }
    } else if (st.k === 'leg') {
      this.app.paintHighlight([st.line], ACCENT, 0.35);
      if (this.legHover) {
        const e = this.build({ t: 'lin', p1: st.line.a, p2: st.line.b }, this.legHover, true);
        if (e) this.app.paintWorld(e);
      }
    } else if (st.k === 'place') {
      if (st.place.t === 'ang') this.app.paintHighlight([st.place.l1, st.place.l2], ACCENT, 0.3);
      if (st.place.t === 'lin') {
        for (const p of [st.place.p1, st.place.p2]) drawSnapMarker(ctx, cam.toScreen(p), 'end');
      }
      if (st.q) {
        const e = this.build(st.place, st.q, true);
        if (e) this.app.paintWorld(e);
      }
    }
  }
}
