import type { App } from '../app';
import { dist, type Vec } from '../core/geom';
import { drawingScale } from '../core/scale';
import type { SnapHit } from '../core/snap';
import type { Entity, ForceEntity, LineLoadEntity, MomentEntity, SupportEntity, SupportType } from '../core/types';
import { drawSnapMarker } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

const DRAG_PX = 8;

/** What the mechanics tool places. */
export type MechMode = SupportType | 'force' | 'moment' | 'lineload';

/** Paper sizes (mm at 1:1) for a tap without dragging. */
const DEFAULT_FORCE_LEN = 15;
const DEFAULT_MOMENT_R = 6;
const DEFAULT_LOAD_H = 8;
/** Supports turn in these steps unless snapping is suspended. */
const SUPPORT_STEP = Math.PI / 12;

type State =
  | { k: 'idle' }
  | { k: 'press'; start: Vec; at: Vec; hit: SnapHit | null; p: Vec; endHit: SnapHit | null; moved: boolean };

/** Prefix of the automatic labels (F₁, M₁, q₁ …). */
const LABEL_PREFIX: Partial<Record<MechMode, string>> = { force: 'F', moment: 'M', lineload: 'q' };

/** Next free label like "F_3" for this kind (counting labels already in the drawing). */
export function nextMechLabel(prefix: string, entities: Iterable<Entity>): string {
  const used = new Set<number>();
  const re = new RegExp(`^${prefix}_(\\d+)`);
  for (const e of entities) {
    if (e.kind !== 'force' && e.kind !== 'moment' && e.kind !== 'lineload') continue;
    const m = re.exec(e.label);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix}_${n}`;
}

/**
 * Free-body symbols (Technische Mechanik):
 * - supports: press on the part, drag towards the ground (tap = downwards);
 * - point load: press on the point of application, drag out to the tail
 *   (tip stays on the point; tap = from above);
 * - moment: press on the centre, drag for the radius and where the arrow starts;
 * - line load: drag from start to end of the load (arrows on the upper side).
 * Everything snaps to the geometry like dimensions do.
 */
export class MechTool implements Tool {
  readonly id = 'mech';
  private state: State = { k: 'idle' };

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k !== 'idle';
  }

  get hoverSnap(): boolean {
    return this.state.k === 'idle';
  }

  private get mode(): MechMode {
    return this.app.settings.mechMode;
  }

  /** World direction for a screen direction (the view may be rotated). */
  private screenDir(x: number, y: number): Vec {
    const a = this.app.cam.toWorld({ x: 0, y: 0 });
    const b = this.app.cam.toWorld({ x, y });
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  }

  private styled<T extends Entity>(e: T): T {
    return { ...e, style: { ...e.style, lineType: 'solid' } };
  }

  /** The symbol for the current gesture (also used for the live preview). */
  private build(st: Extract<State, { k: 'press' }>, preview: boolean): Entity | null {
    const k = drawingScale();
    const up = this.screenDir(0, -1);
    const id = preview ? { id: 'preview-mech', layerId: '', z: 0, style: { ...this.app.style, lineType: 'solid' as const } } : null;
    const make = <T extends Entity>(data: Omit<T, 'id' | 'layerId' | 'z' | 'style'>): T =>
      this.styled(id ? ({ ...data, ...id } as T) : this.app.newEntity<T>(data, 'M'));
    const label = (mode: MechMode) => nextMechLabel(LABEL_PREFIX[mode] ?? 'F', this.app.doc.visibleEntities());
    switch (this.mode) {
      case 'fixed':
      case 'roller':
      case 'clamp':
      case 'hinge': {
        let angle = Math.atan2(-up.y, -up.x);
        // A clamp tapped onto a line end continues the line into the wall.
        const out = this.mode === 'clamp' && !st.moved ? this.lineEndDir(st.at) : null;
        if (out) angle = Math.atan2(out.y, out.x);
        if (st.moved && dist(st.at, st.p) > 1e-9) {
          angle = Math.atan2(st.p.y - st.at.y, st.p.x - st.at.x);
          if (!this.app.snapSuspended) angle = Math.round(angle / SUPPORT_STEP) * SUPPORT_STEP;
        }
        return make<SupportEntity>({ kind: 'support', type: this.mode, at: st.at, angle });
      }
      case 'force': {
        const p = st.moved && dist(st.at, st.p) > 1e-9 ? st.p : { x: st.at.x + up.x * DEFAULT_FORCE_LEN * k, y: st.at.y + up.y * DEFAULT_FORCE_LEN * k };
        return make<ForceEntity>({ kind: 'force', at: st.at, p, label: label('force') });
      }
      case 'moment': {
        const moved = st.moved && dist(st.at, st.p) > 1e-9;
        const r = moved ? dist(st.at, st.p) : DEFAULT_MOMENT_R * k;
        // Arrow starts at the pointer (tap: lower right) and turns by 270°.
        const start = moved ? Math.atan2(st.p.y - st.at.y, st.p.x - st.at.x) : Math.atan2(-up.y, -up.x) - Math.PI / 4;
        const sweep = (this.app.settings.momentCcw ? -1 : 1) * Math.PI * 1.5;
        return make<MomentEntity>({ kind: 'moment', c: st.at, r, start, sweep, label: label('moment') });
      }
      case 'lineload': {
        if (!st.moved || dist(st.at, st.p) < 1e-6) return null;
        // Arrows from the side that is up on screen.
        const ab = { x: st.p.x - st.at.x, y: st.p.y - st.at.y };
        const left = { x: -ab.y, y: ab.x };
        const h = (left.x * up.x + left.y * up.y >= 0 ? 1 : -1) * DEFAULT_LOAD_H * k;
        return make<LineLoadEntity>({ kind: 'lineload', a: st.at, b: st.p, h, label: label('lineload') });
      }
    }
  }

  /** Outward direction of a line ending at `p`, if one does. */
  private lineEndDir(p: Vec): Vec | null {
    const tol = 1e-6;
    for (const e of this.app.doc.visibleEntities()) {
      if (e.kind !== 'line') continue;
      const other = dist(e.a, p) < tol ? e.b : dist(e.b, p) < tol ? e.a : null;
      if (other && dist(other, p) > tol) return { x: p.x - other.x, y: p.y - other.y };
    }
    return null;
  }

  down(ev: ToolEvent): void {
    if (!this.app.ensureDrawableLayer()) return;
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    this.state = { k: 'press', start: ev.screen, at: s.p, hit: s.hit, p: s.p, endHit: null, moved: false };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'press') return;
    if (!st.moved && dist(st.start, ev.screen) > DRAG_PX) st.moved = true;
    if (st.moved) {
      // Supports only need a direction; the others snap like line ends.
      if (this.mode === 'fixed' || this.mode === 'roller' || this.mode === 'clamp' || this.mode === 'hinge') {
        st.p = ev.world;
        st.endHit = null;
      } else {
        const r = this.app.resolveEnd(st.at, ev.world, ev.pointerType);
        st.p = r.p;
        st.endHit = r.hit;
      }
    }
    this.app.requestOverlay();
  }

  up(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'press') return;
    this.move(ev);
    this.state = { k: 'idle' };
    const e = this.build(st, false);
    if (e) this.app.addDrawn(e);
    else if (this.mode === 'lineload') this.app.toast('Streckenlast: vom Anfang bis zum Ende der Last ziehen');
    this.app.requestOverlay();
  }

  cancel(): void {
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(): void {}

  reset(): void {
    this.cancel();
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const st = this.state;
    if (st.k !== 'press') return;
    const cam = this.app.cam;
    if (st.hit) drawSnapMarker(ctx, cam.toScreen(st.at), st.hit.kind);
    if (st.endHit) drawSnapMarker(ctx, cam.toScreen(st.p), st.endHit.kind);
    const e = this.build(st, true);
    if (e) this.app.paintWorld(e);
  }
}
