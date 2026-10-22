import { worldWidth } from '../core/scale';
import type { App } from '../app';
import { capsuleRanges, project } from '../core/curves';
import { newId } from '../core/document';
import { dist, type Vec } from '../core/geom';
import type { Entity } from '../core/types';
import { ACCENT } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

type Traceable = Extract<Entity, { kind: 'line' | 'stroke' | 'circle' | 'arc' }>;

type State = { k: 'idle' } | { k: 'drag'; last: Vec; marked: Map<string, Traceable> };

function traceable(e: Entity): e is Traceable {
  return e.kind === 'line' || e.kind === 'stroke' || e.kind === 'circle' || e.kind === 'arc';
}

const near = (a: Vec, b: Vec) => dist(a, b) < 1e-6;

/** Same kind and shape (direction of lines and arcs ignored). */
export function sameGeometry(a: Entity, b: Entity): boolean {
  if (a.kind === 'line' && b.kind === 'line') return (near(a.a, b.a) && near(a.b, b.b)) || (near(a.a, b.b) && near(a.b, b.a));
  if (a.kind === 'circle' && b.kind === 'circle') return near(a.c, b.c) && Math.abs(a.r - b.r) < 1e-6;
  if (a.kind === 'arc' && b.kind === 'arc') {
    if (!near(a.c, b.c) || Math.abs(a.r - b.r) > 1e-6) return false;
    const lo = (e: typeof a) => Math.min(e.start, e.start + e.sweep);
    const d = Math.atan2(Math.sin(lo(a) - lo(b)), Math.cos(lo(a) - lo(b)));
    return Math.abs(d) < 1e-6 && Math.abs(Math.abs(a.sweep) - Math.abs(b.sweep)) < 1e-6;
  }
  if (a.kind === 'stroke' && b.kind === 'stroke') {
    return a.pts.length === b.pts.length && a.pts.every((v, i) => Math.abs(v - b.pts[i]) < 1e-6);
  }
  return false;
}

/**
 * Trace ("Nachzeichnen"): tap lines, circles, arcs or freehand strokes on other
 * layers – e.g. a rough sketch underneath – or swipe across several. They are
 * copied onto the active layer with the current pen, line type and colour.
 */
export class TraceTool implements Tool {
  readonly id = 'trace';
  private state: State = { k: 'idle' };
  private hover_: Traceable | null = null;

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k !== 'idle';
  }

  /** Traceable entities on visible layers other than the active one (locked ones too). */
  private *sources(): Generator<Traceable> {
    const active = this.app.doc.activeLayerId;
    for (const e of this.app.doc.visibleEntities(true)) if (e.layerId !== active && traceable(e)) yield e;
  }

  private nearest(world: Vec, ev: ToolEvent): Traceable | null {
    const r = this.app.hitRadius(ev.pointerType);
    let best: Traceable | null = null;
    let bd = r;
    for (const e of this.sources()) {
      const d = Math.max(0, project(e, world).d - worldWidth(e) / 2);
      if (d <= bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** The copy of a source entity on the active layer with the current style. */
  private copy(e: Traceable, preview = false): Traceable {
    const app = this.app;
    const style = { ...app.style };
    const base = { id: preview ? `trace-${e.id}` : newId('E'), layerId: app.doc.activeLayerId, z: preview ? 0 : app.doc.allocZ(), style };
    switch (e.kind) {
      case 'line': {
        // A dash-dot copy is a centre line (axis) – without switching mirroring on.
        const axis = style.lineType === 'dashdot' ? { axis: true, mirror: false } : {};
        return { kind: 'line', ...base, a: e.a, b: e.b, ...axis };
      }
      case 'stroke':
        return { kind: 'stroke', ...base, pts: [...e.pts] };
      case 'circle':
        return { kind: 'circle', ...base, c: e.c, r: e.r, ...(e.mark ? { mark: true } : {}) };
      case 'arc':
        return { kind: 'arc', ...base, c: e.c, r: e.r, start: e.start, sweep: e.sweep, ...(e.mark ? { mark: true } : {}) };
    }
  }

  down(ev: ToolEvent): void {
    this.hover_ = null;
    if (!this.app.ensureDrawableLayer()) return;
    const marked = new Map<string, Traceable>();
    const hit = this.nearest(ev.world, ev);
    if (hit) marked.set(hit.id, hit);
    this.state = { k: 'drag', last: ev.world, marked };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'drag') return;
    const R = this.app.hitRadius(ev.pointerType);
    for (const e of this.sources()) {
      if (st.marked.has(e.id)) continue;
      if (capsuleRanges(e, st.last, ev.world, R + worldWidth(e) / 2).length) st.marked.set(e.id, e);
    }
    st.last = ev.world;
    this.app.requestOverlay();
  }

  up(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'drag') return;
    this.move(ev);
    this.state = { k: 'idle' };
    this.app.requestOverlay();
    if (!st.marked.size) {
      this.app.toast('Linien einer anderen (sichtbaren) Ebene antippen oder überwischen');
      return;
    }
    const doc = this.app.doc;
    const active = doc.activeLayerId;
    const existing: Entity[] = [];
    for (const e of doc.all()) if (e.layerId === active) existing.push(e);
    let added = 0;
    doc.begin();
    for (const src of st.marked.values()) {
      if (existing.some((e) => sameGeometry(e, src))) continue;
      const c = this.copy(src);
      doc.add(c);
      existing.push(c);
      added++;
    }
    doc.commit();
    if (!added) this.app.toast('Schon nachgezeichnet');
  }

  cancel(): void {
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    if (this.state.k !== 'idle') return;
    const hit = ev ? this.nearest(ev.world, ev) : null;
    if (hit !== this.hover_) {
      this.hover_ = hit;
      this.app.requestOverlay();
    }
  }

  reset(): void {
    this.cancel();
    this.hover_ = null;
  }

  overlay(): void {
    const st = this.state;
    const shown = st.k === 'drag' ? [...st.marked.values()] : this.hover_ && this.app.doc.get(this.hover_.id) ? [this.hover_] : [];
    if (!shown.length) return;
    this.app.paintHighlight(shown, ACCENT, st.k === 'drag' ? 0.4 : 0.25);
    // Preview in the current pen so one sees what the copy will look like.
    for (const e of shown) this.app.paintPreview(this.copy(e, true));
  }
}
