import type { App } from '../app';
import { arcEnds, arcOffset, arcPoint, geomPoly, TAU } from '../core/curves';
import { dist, distToSegment, normAngle, type Vec } from '../core/geom';
import { snapAngle, softSnapAngle, type SnapHit } from '../core/snap';
import type { ArcEntity, CircleEntity, Entity, LineEntity } from '../core/types';
import { ACCENT, drawGuideLine, drawPill, drawSnapMarker, formatLength } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

const MIN_R_PX = 3;
/** Pull (CSS px) of the arc end towards sweeps of 45°, 90°, 135°, 180° … */
const SWEEP_MAGNET_PX = 10;

type ArcGeom = { c: Vec; r: number; start: number; sweep: number };

type State =
  | { k: 'idle' }
  /**
   * Pressed at p0, start direction not decided yet: it follows the way the pen
   * leaves p0 – along one of the curves through p0 (`axes`), or freely.
   */
  | { k: 'tan0'; p0: Vec; hit: SnapHit | null; axes: Vec[]; p: Vec }
  /** Tangential: leaves p0 in direction t and bends towards the pen. */
  | { k: 'tan'; p0: Vec; hit0: SnapHit | null; axes: Vec[]; t: Vec; p: Vec; hit: SnapHit | null; arc: ArcGeom | null }
  /** Centre mode, step 1: centre placed, dragging out radius and start point. */
  | { k: 'c1'; c: Vec; cHit: SnapHit | null; p: Vec; pHit: SnapHit | null }
  /** Centre mode, step 2: choose the end angle (hover or press and drag, lift to finish). */
  | { k: 'c2'; c: Vec; r: number; a0: number; a: number; last: number; pressed: boolean; hit: SnapHit | null };

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Circle through p that touches direction t at p0; null when p lies on the tangent
 * (a straight continuation).
 */
export function tangentArc(p0: Vec, t: Vec, p: Vec): ArcGeom | null {
  const dx = p.x - p0.x;
  const dy = p.y - p0.y;
  const dd = dx * dx + dy * dy;
  if (dd < 1e-18) return null;
  const nx = -t.y;
  const ny = t.x;
  const dn = dx * nx + dy * ny;
  if (Math.abs(dn) < 1e-6 * Math.sqrt(dd)) return null;
  const rs = dd / (2 * dn);
  const c = { x: p0.x + nx * rs, y: p0.y + ny * rs };
  const start = Math.atan2(p0.y - c.y, p0.x - c.x);
  const end = Math.atan2(p.y - c.y, p.x - c.x);
  const sweep = rs > 0 ? normAngle(end - start) : -normAngle(start - end);
  return { c, r: Math.abs(rs), start, sweep };
}

/** Distance (CSS px) the pen must move away from the start before the start direction is fixed. */
const LOCK_PX = 9;

/**
 * Tangent directions (unit vectors, either sense) of the lines, arcs, circles and
 * freehand strokes passing through p – the directions an arc starting at p can
 * continue in. Higher entities first.
 */
export function tangentAxes(entities: Iterable<Entity>, p: Vec, eps = 1e-5): Vec[] {
  const found: { t: Vec; z: number }[] = [];
  const add = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y);
    if (l < 1e-12) return;
    const t = { x: x / l, y: y / l };
    // Skip directions already present (e.g. two collinear lines meeting).
    if (found.some((f) => Math.abs(f.t.x * t.y - f.t.y * t.x) < 1e-6)) return;
    found.push({ t, z });
  };
  for (const e of entities) {
    if (e.kind === 'line') {
      if (distToSegment(p, e.a, e.b) <= eps) add(e.b.x - e.a.x, e.b.y - e.a.y, e.z);
    } else if (e.kind === 'circle' || e.kind === 'arc') {
      if (Math.abs(dist(p, e.c) - e.r) > eps) continue;
      const a = Math.atan2(p.y - e.c.y, p.x - e.c.x);
      if (e.kind === 'arc' && arcOffset(e.start, e.sweep, a) > Math.abs(e.sweep) + eps / e.r) continue;
      add(-Math.sin(a), Math.cos(a), e.z);
    } else if (e.kind === 'stroke') {
      const poly = geomPoly(e);
      for (let j = 0; j < poly.s.length - 1; j++) {
        const q0 = { x: poly.pts[j * 2], y: poly.pts[j * 2 + 1] };
        const q1 = { x: poly.pts[j * 2 + 2], y: poly.pts[j * 2 + 3] };
        if (distToSegment(p, q0, q1) <= Math.max(eps, 1e-3)) {
          add(q1.x - q0.x, q1.y - q0.y, e.z);
          break;
        }
      }
    }
  }
  return found.sort((a, b) => b.z - a.z).map((f) => f.t);
}

/**
 * Start direction for an arc leaving p0 towards `toward`: the curve direction
 * through p0 that best matches (in the sense of the movement), else the movement
 * itself.
 */
export function startDirection(axes: Vec[], p0: Vec, toward: Vec): Vec {
  const dx = toward.x - p0.x;
  const dy = toward.y - p0.y;
  const l = Math.hypot(dx, dy) || 1;
  const d = { x: dx / l, y: dy / l };
  let best: Vec | null = null;
  let bd = -1;
  for (const t of axes) {
    const c = d.x * t.x + d.y * t.y;
    if (Math.abs(c) > bd + 1e-9) {
      bd = Math.abs(c);
      best = c >= 0 ? t : { x: -t.x, y: -t.y };
    }
  }
  return best ?? d;
}

/**
 * Arc tool. Press where the arc starts and move off in the direction it should
 * leave: on a line, arc or circle (its end, middle or anywhere on it) the arc
 * starts tangentially along it – forwards or backwards, whichever way the pen
 * goes – otherwise it starts in the direction of the first movement. Then drag
 * to where the arc should end and lift. Going back to the start lets the
 * direction be chosen again. In centre mode the first drag sets centre and
 * radius, the second the end angle.
 */
export class ArcTool implements Tool {
  readonly id = 'arc';
  private state: State = { k: 'idle' };

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k !== 'idle';
  }

  get hoverSnap(): boolean {
    return this.state.k === 'idle';
  }

  private preview(g: ArcGeom): ArcEntity {
    return { kind: 'arc', id: 'preview', layerId: '', z: 0, style: this.app.style, ...g };
  }

  down(ev: ToolEvent): void {
    const st = this.state;
    if (st.k === 'c2') {
      st.pressed = true;
      this.updateSweep(st, ev);
      return;
    }
    if (!this.app.ensureDrawableLayer()) return;
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    if (this.app.settings.arcMode === 'auto') {
      const axes = s.hit ? tangentAxes(this.app.doc.visibleEntities(), s.p) : [];
      this.state = { k: 'tan0', p0: s.p, hit: s.hit, axes, p: s.p };
      this.app.requestOverlay();
      return;
    }
    this.state = { k: 'c1', c: s.p, cHit: s.hit, p: s.p, pHit: null };
    this.app.requestOverlay();
  }

  /** Direction for a free start (no curve under it), snapped like line angles. */
  private freeDirection(p0: Vec, q: Vec): Vec {
    let target = q;
    if (!this.app.snapSuspended) {
      if (this.app.angleSnapOn) target = snapAngle(p0, q, this.app.settings.angleStep);
      else target = softSnapAngle(p0, q, 3);
    }
    const l = dist(p0, target) || 1;
    return { x: (target.x - p0.x) / l, y: (target.y - p0.y) / l };
  }

  /** Fix the start direction once the pen has left p0, or release it when it comes back. */
  private updateStart(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'tan0' && st.k !== 'tan') return;
    const away = dist(this.app.cam.toScreen(st.p0), ev.screen);
    if (away < LOCK_PX) {
      this.state = { k: 'tan0', p0: st.p0, hit: st.k === 'tan0' ? st.hit : st.hit0, axes: st.axes, p: ev.world };
      this.app.requestOverlay();
      return;
    }
    if (st.k === 'tan0') {
      const t = st.axes.length ? startDirection(st.axes, st.p0, ev.world) : this.freeDirection(st.p0, ev.world);
      this.state = { k: 'tan', p0: st.p0, hit0: st.hit, axes: st.axes, t, p: ev.world, hit: null, arc: null };
    }
    const cur = this.state;
    if (cur.k === 'tan') this.updateTangent(cur, ev);
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k === 'tan0' || st.k === 'tan') this.updateStart(ev);
    else if (st.k === 'c1') {
      const s = this.app.snapPoint(ev.world, ev.pointerType);
      const onCentre = s.hit && dist(s.hit.p, st.c) < 1e-9;
      st.p = onCentre ? ev.world : s.p;
      st.pHit = onCentre ? null : s.hit;
      this.app.requestOverlay();
    } else if (st.k === 'c2' && st.pressed) this.updateSweep(st, ev);
  }

  up(ev: ToolEvent): void {
    if (this.state.k === 'tan0' || this.state.k === 'tan') this.updateStart(ev);
    const st = this.state;
    if (st.k === 'tan0') {
      this.state = { k: 'idle' };
      this.app.toast('Bogen: am Startpunkt in die Startrichtung losziehen, dann zum Endpunkt');
    } else if (st.k === 'tan') {
      this.state = { k: 'idle' };
      if (st.arc) this.commit(st.arc);
      else if (dist(this.app.cam.toScreen(st.p0), this.app.cam.toScreen(st.p)) >= MIN_R_PX) {
        // Pen went straight on: continue with a line.
        this.app.addDrawn(this.app.newEntity<LineEntity>({ kind: 'line', a: st.p0, b: st.p }));
      }
    } else if (st.k === 'c1') {
      this.move(ev);
      const r = dist(st.c, st.p);
      if (r * this.app.cam.scale < MIN_R_PX) {
        this.state = { k: 'idle' };
      } else {
        const a0 = Math.atan2(st.p.y - st.c.y, st.p.x - st.c.x);
        this.state = { k: 'c2', c: st.c, r, a0, a: a0, last: a0, pressed: false, hit: null };
        this.app.toast('Jetzt den Bogen bis zum Endpunkt ziehen');
      }
    } else if (st.k === 'c2' && st.pressed) {
      this.updateSweep(st, ev);
      this.state = { k: 'idle' };
      const sweep = st.a - st.a0;
      if (Math.abs(sweep) >= TAU - 1e-6) {
        this.app.addDrawn(
          this.app.newEntity<CircleEntity>({ kind: 'circle', c: st.c, r: st.r, ...(this.app.settings.centerMarks ? { mark: true } : {}) }),
        );
      } else if (Math.abs(sweep) * st.r * this.app.cam.scale >= MIN_R_PX) {
        this.commit({ c: st.c, r: st.r, start: st.a0, sweep });
      }
    }
    this.app.requestOverlay();
  }

  private commit(g: ArcGeom): void {
    this.app.addDrawn(this.app.newEntity<ArcEntity>({ kind: 'arc', ...g }));
  }

  private updateTangent(st: Extract<State, { k: 'tan' }>, ev: ToolEvent): void {
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    const hit = s.hit && dist(s.hit.p, st.p0) > 1e-9 ? s.hit : null;
    const target = hit ? hit.p : ev.world;
    let arc = tangentArc(st.p0, st.t, target);
    if (arc && !hit) arc = this.snapSweep(arc, target);
    st.hit = hit;
    st.arc = arc && arc.r * this.app.cam.scale >= MIN_R_PX && Math.abs(arc.sweep) > 1e-3 ? arc : null;
    st.p = st.arc ? arcEnds(this.preview(st.arc))[1] : target;
    this.app.requestOverlay();
  }

  /** Sweep snapping: 5° steps with the angle snap on, else a magnet towards multiples of 45°. */
  private snapSweep(arc: ArcGeom, pen: Vec): ArcGeom {
    if (this.app.snapSuspended) return arc;
    const deg = (Math.abs(arc.sweep) * 180) / Math.PI;
    const sign = Math.sign(arc.sweep);
    let target = deg;
    if (this.app.angleSnapOn) target = this.app.snapDegrees(deg);
    else {
      const k = Math.round(deg / 45) * 45;
      const end = arcPoint(arc.c, arc.r, arc.start + (sign * k * Math.PI) / 180);
      if (k > 0 && dist(this.app.cam.toScreen(end), this.app.cam.toScreen(pen)) <= SWEEP_MAGNET_PX) target = k;
    }
    if (target <= 0 || target >= 360) return arc;
    return { ...arc, sweep: (sign * target * Math.PI) / 180 };
  }

  private updateSweep(st: Extract<State, { k: 'c2' }>, ev: ToolEvent): void {
    const s = this.app.snapPoint(ev.world, ev.pointerType);
    const hit = s.hit && dist(s.hit.p, st.c) > 1e-9 ? s.hit : null;
    const q = hit ? hit.p : ev.world;
    const theta = Math.atan2(q.y - st.c.y, q.x - st.c.x);
    st.a += wrapPi(theta - st.last);
    st.last = theta;
    st.hit = hit;
    if (!hit) {
      const sweep = st.a - st.a0;
      const deg = (Math.abs(sweep) * 180) / Math.PI;
      let snapped = deg;
      if (this.app.angleSnapOn) snapped = this.app.snapDegrees(deg);
      else {
        const k = Math.round(deg / 45) * 45;
        const end = arcPoint(st.c, st.r, st.a0 + (Math.sign(sweep) * k * Math.PI) / 180);
        const pen = arcPoint(st.c, st.r, st.a);
        if (dist(this.app.cam.toScreen(end), this.app.cam.toScreen(pen)) <= SWEEP_MAGNET_PX) snapped = k;
      }
      if (snapped !== deg) st.a = st.a0 + (Math.sign(sweep) * snapped * Math.PI) / 180;
    }
    this.app.requestOverlay();
  }

  cancel(): void {
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    const st = this.state;
    if (st.k === 'c2') {
      if (ev) this.updateSweep(st, ev);
    }
  }

  reset(): void {
    this.cancel();
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const cam = this.app.cam;
    const st = this.state;
    const radiusLine = (c: Vec, p: Vec) => {
      const a = cam.toScreen(c);
      const b = cam.toScreen(p);
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };
    const label = (c: Vec, r: number, text: string) => {
      const p = cam.toScreen(c);
      drawPill(ctx, { x: p.x, y: p.y - r * cam.scale - 26 }, text);
    };
    if (st.k === 'tan0') {
      // Possible start directions: short dashed guides along the curves through p0.
      const p0 = cam.toScreen(st.p0);
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (const t of st.axes) {
        const q = cam.toScreen({ x: st.p0.x + t.x, y: st.p0.y + t.y });
        const l = Math.hypot(q.x - p0.x, q.y - p0.y) || 1;
        const ux = ((q.x - p0.x) / l) * 34;
        const uy = ((q.y - p0.y) / l) * 34;
        ctx.moveTo(p0.x - ux, p0.y - uy);
        ctx.lineTo(p0.x + ux, p0.y + uy);
      }
      ctx.stroke();
      ctx.restore();
      if (st.hit) drawSnapMarker(ctx, p0, st.hit.kind);
      else drawGuideLine(ctx, p0, p0);
    } else if (st.k === 'tan') {
      const p0 = cam.toScreen(st.p0);
      if (st.arc) {
        this.app.paintGuide(this.preview(st.arc));
        radiusLine(st.arc.c, st.p0);
        radiusLine(st.arc.c, st.p);
        label(st.arc.c, st.arc.r, this.app.arcText(st.arc.r, st.arc.sweep));
      } else {
        drawGuideLine(ctx, p0, cam.toScreen(st.p));
      }
      if (st.hit0) drawSnapMarker(ctx, p0, st.hit0.kind);
      if (st.hit) drawSnapMarker(ctx, cam.toScreen(st.hit.p), st.hit.kind);
    } else if (st.k === 'c1') {
      const r = dist(st.c, st.p);
      if (r * cam.scale >= MIN_R_PX) {
        this.app.paintGuide({ kind: 'circle', id: 'preview', layerId: '', z: 0, style: this.app.style, c: st.c, r }, false);
        radiusLine(st.c, st.p);
        label(st.c, r, `R ${formatLength(r, cam.scale)}`);
      }
      if (st.cHit) drawSnapMarker(ctx, cam.toScreen(st.c), st.cHit.kind);
      if (st.pHit) drawSnapMarker(ctx, cam.toScreen(st.p), st.pHit.kind);
    } else if (st.k === 'c2') {
      const circle: CircleEntity = { kind: 'circle', id: 'preview', layerId: '', z: 0, style: this.app.style, c: st.c, r: st.r };
      this.app.paintGuide(circle, false, 0.3);
      const sweep = st.a - st.a0;
      if (Math.abs(sweep) > 1e-4) {
        const g = { c: st.c, r: st.r, start: st.a0, sweep };
        this.app.paintGuide(this.preview(g));
        const [, end] = arcEnds(this.preview(g));
        radiusLine(st.c, end);
      }
      radiusLine(st.c, arcPoint(st.c, st.r, st.a0));
      label(st.c, st.r, this.app.arcText(st.r, sweep));
      if (st.hit) drawSnapMarker(ctx, cam.toScreen(st.hit.p), st.hit.kind);
    }
  }
}
