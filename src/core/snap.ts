import { arcEnds, arcPoint, intersectEntities, project } from './curves';
import { entityBox } from './document';
import type { SketchDocument } from './document';
import { boxContainsPoint, dist, drawingAngleDeg, mid, polar, type Vec } from './geom';
import type { Entity } from './types';

/** end = endpoint, mid = midpoint, int = intersection, cen = centre, quad = quadrant point, on = nearest point on a curve. */
export type SnapKind = 'end' | 'mid' | 'int' | 'cen' | 'quad' | 'on';

export interface SnapHit {
  p: Vec;
  kind: SnapKind;
}

export interface SnapOptions {
  end: boolean;
  mid: boolean;
  int: boolean;
  /** Centres and quadrant points of circles and arcs (default on). */
  cen?: boolean;
  /** Nearest point on lines, circles and arcs (lowest priority). */
  on?: boolean;
  /** Entity ids to ignore (e.g. the one being edited). */
  exclude?: ReadonlySet<string>;
}

/** Lower value wins when two candidates are about equally close. */
const PRIORITY: Record<SnapKind, number> = { end: 0, cen: 0.5, int: 1, quad: 1.5, mid: 2, on: 3 };

/**
 * Midpoints catch from further along the curve than other points (the pointer
 * still has to be on the curve), so the middle of a line is easy to hit.
 */
export const MID_REACH = 1.8;

/**
 * Find the best snap point within `radius` (world units) of `p`.
 * Endpoints beat centres beat intersections beat quadrants and midpoints,
 * unless another kind is clearly closer.
 */
export function findSnap(doc: SketchDocument, p: Vec, radius: number, opts: SnapOptions): SnapHit | null {
  let best: SnapHit | null = null;
  let bestScore = Infinity;
  const consider = (q: Vec, kind: SnapKind, reach = 1) => {
    const d = dist(p, q);
    if (d > radius * reach) return;
    // Bias by kind: a lower-priority candidate must be noticeably closer to win.
    const score = d + PRIORITY[kind] * radius * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = { p: q, kind };
    }
  };
  const centres = opts.cen !== false;

  const near: Entity[] = [];
  const onCurve: Vec[] = [];
  for (const e of doc.visibleEntities()) {
    if (opts.exclude?.has(e.id)) continue;
    const box = entityBox(e);
    // Centres may lie far from the drawn curve, so test them before culling.
    if ((e.kind === 'circle' || e.kind === 'arc') && centres) consider(e.c, 'cen');
    if (!boxContainsPoint(box, p, radius)) continue;
    // Pointer close to the curve itself (also gives midpoints their longer reach).
    const curve = e.kind === 'line' || e.kind === 'circle' || e.kind === 'arc';
    const pr = curve ? project(e, p) : null;
    const onIt = !!pr && pr.d <= radius;
    switch (e.kind) {
      case 'line':
        if (opts.end) {
          consider(e.a, 'end');
          consider(e.b, 'end');
        }
        if (opts.mid) consider(mid(e.a, e.b), 'mid', onIt ? MID_REACH : 1);
        break;
      case 'stroke':
        if (opts.end) {
          const n = e.pts.length;
          consider({ x: e.pts[0], y: e.pts[1] }, 'end');
          consider({ x: e.pts[n - 2], y: e.pts[n - 1] }, 'end');
        }
        break;
      case 'circle':
        if (centres) for (let k = 0; k < 4; k++) consider(arcPoint(e.c, e.r, (k * Math.PI) / 2), 'quad');
        break;
      case 'arc': {
        const [a, b] = arcEnds(e);
        if (opts.end) {
          consider(a, 'end');
          consider(b, 'end');
        }
        if (opts.mid) consider(arcPoint(e.c, e.r, e.start + e.sweep / 2), 'mid', onIt ? MID_REACH : 1);
        break;
      }
    }
    // Curves passing close to the pointer: candidates for intersections and for "on the curve".
    if (pr && onIt) {
      if (opts.int) near.push(e);
      if (opts.on) onCurve.push(pr.point);
    }
  }

  // Nearest point on a curve only when nothing more specific is around.
  if (!best) for (const q of onCurve) consider(q, 'on');
  if (opts.int && near.length > 1) {
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        for (const x of intersectEntities(near[i], near[j])) consider(x, 'int');
      }
    }
  }
  return best;
}

/**
 * Snap points near `p` (ends, midpoints, centres, quadrant points) for showing
 * where the pointer could catch – without intersections, which need pairs.
 */
export function snapCandidates(doc: SketchDocument, p: Vec, radius: number, exclude?: ReadonlySet<string>): SnapHit[] {
  const out: SnapHit[] = [];
  const add = (q: Vec, kind: SnapKind) => {
    if (dist(p, q) <= radius) out.push({ p: q, kind });
  };
  for (const e of doc.visibleEntities()) {
    if (exclude?.has(e.id)) continue;
    if (e.kind === 'circle' || e.kind === 'arc') add(e.c, 'cen');
    if (!boxContainsPoint(entityBox(e), p, radius)) continue;
    switch (e.kind) {
      case 'line':
        add(e.a, 'end');
        add(e.b, 'end');
        add(mid(e.a, e.b), 'mid');
        break;
      case 'stroke': {
        const n = e.pts.length;
        add({ x: e.pts[0], y: e.pts[1] }, 'end');
        add({ x: e.pts[n - 2], y: e.pts[n - 1] }, 'end');
        break;
      }
      case 'circle':
        for (let k = 0; k < 4; k++) add(arcPoint(e.c, e.r, (k * Math.PI) / 2), 'quad');
        break;
      case 'arc': {
        const [a, b] = arcEnds(e);
        add(a, 'end');
        add(b, 'end');
        add(arcPoint(e.c, e.r, e.start + e.sweep / 2), 'mid');
        break;
      }
    }
  }
  return out;
}

export type AngleMode = 'snap' | 'show' | 'off';

/**
 * Gentle magnet towards the main directions (every 45°): only pulls when the
 * direction start→end is within `tolDeg` of one, otherwise returns `end` unchanged.
 */
export function softSnapAngle(start: Vec, end: Vec, tolDeg: number, stepDeg = 45): Vec {
  const l = dist(start, end);
  if (l === 0) return { ...end };
  const deg = drawingAngleDeg(start, end);
  const target = Math.round(deg / stepDeg) * stepDeg;
  if (Math.abs(deg - target) > tolDeg) return { ...end };
  return polar(start, target, l);
}

/** Round the direction start→end to a multiple of `stepDeg`, keeping the length. */
export function snapAngle(start: Vec, end: Vec, stepDeg: number): Vec {
  const l = dist(start, end);
  if (l === 0) return { ...end };
  const deg = Math.round(drawingAngleDeg(start, end) / stepDeg) * stepDeg;
  return polar(start, deg, l);
}

/** Characteristic points of an entity (ends, centre) – e.g. to pick a move reference. */
export function keyPoints(e: Entity): Vec[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b, mid(e.a, e.b)];
    case 'stroke': {
      const n = e.pts.length;
      return [
        { x: e.pts[0], y: e.pts[1] },
        { x: e.pts[n - 2], y: e.pts[n - 1] },
      ];
    }
    case 'circle':
      return [e.c, ...[0, 1, 2, 3].map((k) => arcPoint(e.c, e.r, (k * Math.PI) / 2))];
    case 'arc':
      return [...arcEnds(e), e.c, arcPoint(e.c, e.r, e.start + e.sweep / 2)];
    case 'dim':
      return [e.p1, e.p2];
    case 'datum':
    case 'gtol':
    case 'force':
      return [e.at, e.p];
    case 'support':
      return [e.at];
    case 'moment':
      return [e.c];
    case 'lineload':
      return [e.a, e.b];
    case 'text':
      return [e.at];
    case 'hatch':
    case 'sheet':
      return [];
  }
}
