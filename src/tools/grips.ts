import type { App } from '../app';
import { dimTextAnchor, dragDimText } from '../core/annotations';
import { arcEnds, arcPoint } from '../core/curves';
import { dist, normAngle, type Vec } from '../core/geom';
import { drawingScale } from '../core/scale';
import type { SnapHit } from '../core/snap';
import type { Entity } from '../core/types';
import { drawGrip, drawKnob, drawMeasureLabel, drawPill, drawSnapMarker, type KnobKind } from '../render/overlay';
import type { ToolEvent } from './tool';

/**
 * Handles for editing one entity: the correction knobs drawing tools show on the
 * shape just drawn ('knobs': offset from the point so pressing right on the point
 * still starts new drawing there) and the grips of the selection tool ('grips':
 * sitting right on the points).
 */
export interface Grip {
  key: string;
  /** World point the grip moves. */
  anchor: Vec;
  /** Screen offset of the knob from the anchor. */
  offset: Vec;
  kind: KnobKind;
  /** Reference point for angle snapping while dragging (e.g. the other end of a line). */
  angleFrom?: Vec;
  /** Follows the pointer without snapping to geometry (e.g. a dimension figure). */
  free?: boolean;
  /** The entity with the grabbed point moved to `target` (world). */
  apply(target: Vec): Entity;
}

export type GripStyle = 'knobs' | 'grips';

const KNOB_OFFSET = 24;

function unit(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

/** Grips of an entity; none for freehand strokes. */
export function gripsFor(app: App, e: Entity, style: GripStyle): Grip[] {
  const cam = app.cam;
  const knobs = style === 'knobs';
  const off = (dir: Vec) => (knobs ? { x: dir.x * KNOB_OFFSET, y: dir.y * KNOB_OFFSET } : { x: 0, y: 0 });
  const screenDir = (from: Vec, to: Vec) => unit({ x: cam.toScreen(to).x - cam.toScreen(from).x, y: cam.toScreen(to).y - cam.toScreen(from).y });
  // World direction that points right on screen.
  const right = unit({ x: cam.toWorld({ x: 1, y: 0 }).x - cam.toWorld({ x: 0, y: 0 }).x, y: cam.toWorld({ x: 1, y: 0 }).y - cam.toWorld({ x: 0, y: 0 }).y });

  switch (e.kind) {
    case 'line': {
      const u = screenDir(e.a, e.b);
      return [
        { key: 'a', anchor: e.a, offset: off({ x: -u.x, y: -u.y }), kind: 'end', angleFrom: e.b, apply: (t) => ({ ...e, a: t }) },
        { key: 'b', anchor: e.b, offset: off(u), kind: 'end', angleFrom: e.a, apply: (t) => ({ ...e, b: t }) },
      ];
    }
    case 'circle': {
      const rp = { x: e.c.x + right.x * e.r, y: e.c.y + right.y * e.r };
      return [
        { key: 'c', anchor: e.c, offset: knobs ? { x: -20, y: -20 } : { x: 0, y: 0 }, kind: 'move', apply: (t) => ({ ...e, c: t }) },
        { key: 'r', anchor: rp, offset: off({ x: 1, y: 0 }), kind: 'radius', apply: (t) => ({ ...e, r: Math.max(1e-3, dist(e.c, t)) }) },
      ];
    }
    case 'arc': {
      const [p0, p1] = arcEnds(e);
      const mid = arcPoint(e.c, e.r, e.start + e.sweep / 2);
      const sign = Math.sign(e.sweep || 1);
      // Tangent directions pointing away from the arc at both ends.
      const t0 = screenDir(p0, arcPoint(e.c, e.r, e.start - sign * 0.01));
      const t1 = screenDir(p1, arcPoint(e.c, e.r, e.start + e.sweep + sign * 0.01));
      const end = e.start + e.sweep;
      return [
        {
          key: 's',
          anchor: p0,
          offset: off(t0),
          kind: 'end',
          apply: (t) => {
            const a = Math.atan2(t.y - e.c.y, t.x - e.c.x);
            const sweep = sign > 0 ? normAngle(end - a) : -normAngle(a - end);
            return Math.abs(sweep) > 1e-4 ? { ...e, start: a, sweep } : e;
          },
        },
        {
          key: 'e',
          anchor: p1,
          offset: off(t1),
          kind: 'end',
          apply: (t) => {
            const a = Math.atan2(t.y - e.c.y, t.x - e.c.x);
            const sweep = sign > 0 ? normAngle(a - e.start) : -normAngle(e.start - a);
            return Math.abs(sweep) > 1e-4 ? { ...e, sweep } : e;
          },
        },
        { key: 'r', anchor: mid, offset: off(screenDir(e.c, mid)), kind: 'radius', apply: (t) => ({ ...e, r: Math.max(1e-3, dist(e.c, t)) }) },
        { key: 'c', anchor: e.c, offset: knobs ? { x: -20, y: -20 } : { x: 0, y: 0 }, kind: 'move', apply: (t) => ({ ...e, c: t }) },
      ];
    }
    case 'dim': {
      // The figure (on the dimension line under it) moves along and away; the
      // feature points can be re-attached elsewhere with snapping.
      const step = app.settings.angleMode === 'snap' ? 15 : 0;
      const grips: Grip[] = [
        { key: 'text', anchor: dimTextAnchor(e), offset: { x: 0, y: 0 }, kind: 'move', free: true, apply: (t) => dragDimText(e, t, step) },
      ];
      if (e.type === 'lin') {
        grips.push(
          { key: 'p1', anchor: e.p1, offset: { x: 0, y: 0 }, kind: 'end', apply: (t) => ({ ...e, p1: t }) },
          { key: 'p2', anchor: e.p2, offset: { x: 0, y: 0 }, kind: 'end', apply: (t) => ({ ...e, p2: t }) },
        );
      }
      return grips;
    }
    case 'force':
      return [
        { key: 'at', anchor: e.at, offset: { x: 0, y: 0 }, kind: 'end', apply: (t) => ({ ...e, at: t }) },
        { key: 'p', anchor: e.p, offset: { x: 0, y: 0 }, kind: 'end', angleFrom: e.at, apply: (t) => (dist(t, e.at) > 1e-6 ? { ...e, p: t } : e) },
      ];
    case 'lineload': {
      const ab = { x: e.b.x - e.a.x, y: e.b.y - e.a.y };
      const n = unit({ x: -ab.y, y: ab.x });
      const top = { x: (e.a.x + e.b.x) / 2 + n.x * e.h, y: (e.a.y + e.b.y) / 2 + n.y * e.h };
      return [
        { key: 'a', anchor: e.a, offset: { x: 0, y: 0 }, kind: 'end', angleFrom: e.b, apply: (t) => ({ ...e, a: t }) },
        { key: 'b', anchor: e.b, offset: { x: 0, y: 0 }, kind: 'end', angleFrom: e.a, apply: (t) => ({ ...e, b: t }) },
        {
          key: 'h',
          anchor: top,
          offset: { x: 0, y: 0 },
          kind: 'radius',
          free: true,
          apply: (t) => {
            const h = (t.x - (e.a.x + e.b.x) / 2) * n.x + (t.y - (e.a.y + e.b.y) / 2) * n.y;
            return Math.abs(h) > 1e-3 ? { ...e, h } : e;
          },
        },
      ];
    }
    case 'moment': {
      const s = { x: e.c.x + Math.cos(e.start) * e.r, y: e.c.y + Math.sin(e.start) * e.r };
      return [
        { key: 'c', anchor: e.c, offset: { x: 0, y: 0 }, kind: 'move', apply: (t) => ({ ...e, c: t }) },
        {
          key: 'r',
          anchor: s,
          offset: { x: 0, y: 0 },
          kind: 'radius',
          free: true,
          apply: (t) => (dist(t, e.c) > 1e-3 ? { ...e, r: dist(t, e.c), start: Math.atan2(t.y - e.c.y, t.x - e.c.x) } : e),
        },
      ];
    }
    case 'support': {
      const reach = 9.5 * drawingScale();
      const g = { x: e.at.x + Math.cos(e.angle) * reach, y: e.at.y + Math.sin(e.angle) * reach };
      return [
        { key: 'at', anchor: e.at, offset: { x: 0, y: 0 }, kind: 'move', apply: (t) => ({ ...e, at: t }) },
        {
          key: 'dir',
          anchor: g,
          offset: { x: 0, y: 0 },
          kind: 'radius',
          free: true,
          apply: (t) => {
            if (dist(t, e.at) < 1e-6) return e;
            const step = Math.PI / 12;
            return { ...e, angle: Math.round(Math.atan2(t.y - e.at.y, t.x - e.at.x) / step) * step };
          },
        },
      ];
    }
    default:
      return [];
  }
}

/** Screen position of a grip's knob. */
export function knobPos(app: App, g: Grip): Vec {
  const p = app.cam.toScreen(g.anchor);
  return { x: p.x + g.offset.x, y: p.y + g.offset.y };
}

export function hitGrip(app: App, grips: Grip[], screen: Vec, radius: number): Grip | null {
  let best: Grip | null = null;
  let bd = radius;
  for (const g of grips) {
    const d = dist(knobPos(app, g), screen);
    if (d <= bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}

export function drawGrips(app: App, ctx: CanvasRenderingContext2D, grips: Grip[], style: GripStyle, activeKey?: string): void {
  for (const g of grips) {
    const active = g.key === activeKey;
    if (style === 'grips') drawGrip(ctx, app.cam.toScreen(g.anchor), active);
    else {
      const anchor = app.cam.toScreen(g.anchor);
      const hasStub = Math.hypot(g.offset.x, g.offset.y) > 0 && g.kind !== 'move';
      drawKnob(ctx, knobPos(app, g), g.kind, active, hasStub ? anchor : undefined);
    }
  }
}

/** Label describing an entity while it is being edited. */
export function editLabel(app: App, e: Entity): string | null {
  switch (e.kind) {
    case 'line':
      return app.measureText(e.a, e.b);
    case 'circle':
      return app.radiusText(e.r);
    case 'arc':
      return app.arcText(e.r, e.sweep);
    default:
      return null;
  }
}

/** Draw the edit label next to the entity. */
export function drawEditLabel(app: App, ctx: CanvasRenderingContext2D, e: Entity): void {
  const text = editLabel(app, e);
  if (!text) return;
  if (e.kind === 'line') {
    drawMeasureLabel(ctx, app.cam.toScreen(e.a), app.cam.toScreen(e.b), text);
  } else if (e.kind === 'circle' || e.kind === 'arc') {
    const c = app.cam.toScreen(e.c);
    const rpx = e.r * app.cam.scale;
    drawPill(ctx, { x: c.x, y: c.y - rpx - 26 }, text);
  }
}

/** Dragging one grip with snapping; the entity updates live and commits as one undo step. */
export class GripDrag {
  hit: SnapHit | null = null;
  private grab: Vec;

  constructor(
    private app: App,
    readonly grip: Grip,
    readonly before: Entity,
    press: Vec,
  ) {
    const a = app.cam.toScreen(grip.anchor);
    this.grab = { x: press.x - a.x, y: press.y - a.y };
  }

  move(ev: ToolEvent): void {
    const target = this.app.cam.toWorld({ x: ev.screen.x - this.grab.x, y: ev.screen.y - this.grab.y });
    const exclude = new Set([this.before.id]);
    const r = this.grip.free
      ? { p: target, hit: null }
      : this.grip.angleFrom
        ? this.app.resolveEnd(this.grip.angleFrom, target, ev.pointerType, exclude)
        : this.app.snapPoint(target, ev.pointerType, exclude);
    this.hit = r.hit;
    const next = this.grip.apply(r.p);
    this.app.doc.replaceTransient(next);
    this.app.requestOverlay();
  }

  /** Commit; returns the edited entity. */
  end(): Entity | undefined {
    const after = this.app.doc.get(this.before.id);
    if (after && after !== this.before) this.app.doc.update(after, this.before);
    return after;
  }

  cancel(): void {
    if (this.app.doc.get(this.before.id)) this.app.doc.replaceTransient(this.before);
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const e = this.app.doc.get(this.before.id);
    if (!e) return;
    if (this.hit) drawSnapMarker(ctx, this.app.cam.toScreen(this.hit.p), this.hit.kind);
    drawEditLabel(this.app, ctx, e);
  }
}
