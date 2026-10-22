import {
  boxesIntersect,
  boxExpand,
  closestOnSegment,
  dist,
  normAngle,
  segmentIntersection,
  simplifyFlat,
  type Box,
  type Vec,
} from './geom';
import { insideAnnoText, layoutAnno, layoutSegments } from './annotations';
import { scaleGeneration } from './scale';
import { isAnnotation, type Annotation, type ArcEntity, type Entity } from './types';

/** Outline segments of an annotation (hatch loops, dimension lines, frames, text boxes). */
export function annoSegments(e: Annotation): [Vec, Vec][] {
  if (e.kind !== 'hatch') return layoutSegments(layoutAnno(e));
  const out: [Vec, Vec][] = [];
  for (const loop of e.loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push([
        { x: loop[i * 2], y: loop[i * 2 + 1] },
        { x: loop[j * 2], y: loop[j * 2 + 1] },
      ]);
    }
  }
  return out;
}

/** Point inside a hatch (even-odd over all loops)? */
export function insideHatch(loops: number[][], p: Vec): boolean {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = loop[i * 2], yi = loop[i * 2 + 1], xj = loop[j * 2], yj = loop[j * 2 + 1];
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Geometry of entities as curves parametrised by arc length s ∈ [0, length]:
 * a line runs a→b, a circle starts at angle 0 and turns with increasing angle,
 * an arc runs from `start` along `sweep`, a stroke along its smoothed centreline.
 * Used for hit testing, trimming, erasing and snapping.
 */

export const TAU = Math.PI * 2;
/** Flattening tolerance in mm, independent of zoom so parameters stay stable. */
const FLATTEN_TOL = 0.002;

export interface Poly {
  /** Flat vertex list [x0, y0, x1, y1, …]. */
  pts: Float64Array;
  /** Curve parameter (arc length) at each vertex. */
  s: Float64Array;
  closed: boolean;
}

// ---- angles ---------------------------------------------------------------------------------

/** Position of angle θ along an arc (0 at start, |sweep| at the end, up to 2π beyond). */
export function arcOffset(start: number, sweep: number, theta: number): number {
  return sweep >= 0 ? normAngle(theta - start) : normAngle(start - theta);
}

export function arcPoint(c: Vec, r: number, angle: number): Vec {
  return { x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r };
}

export function arcEnds(e: ArcEntity): [Vec, Vec] {
  return [arcPoint(e.c, e.r, e.start), arcPoint(e.c, e.r, e.start + e.sweep)];
}

// ---- flattening -------------------------------------------------------------------------------

function arcSegments(r: number, sweep: number): number {
  if (r <= FLATTEN_TOL) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 8)));
  const step = 2 * Math.acos(1 - FLATTEN_TOL / r);
  return Math.min(4096, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
}

/** Flatten the midpoint-quadratic spline that strokes are drawn with. */
export function flattenSpline(pts: ArrayLike<number>, out: number[]): void {
  const n = pts.length / 2;
  out.push(pts[0], pts[1]);
  if (n < 3) {
    if (n === 2) out.push(pts[2], pts[3]);
    return;
  }
  let x0 = pts[0];
  let y0 = pts[1];
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const x2 = (cx + pts[i * 2 + 2]) / 2;
    const y2 = (cy + pts[i * 2 + 3]) / 2;
    const dd = Math.hypot(x0 - 2 * cx + x2, y0 - 2 * cy + y2);
    const m = Math.min(64, Math.max(1, Math.ceil(Math.sqrt(dd / (4 * FLATTEN_TOL)))));
    for (let k = 1; k <= m; k++) {
      const t = k / m;
      const u = 1 - t;
      out.push(u * u * x0 + 2 * u * t * cx + t * t * x2, u * u * y0 + 2 * u * t * cy + t * t * y2);
    }
    x0 = x2;
    y0 = y2;
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
}

/** Polyline through flat points with cumulative chord length; drops zero-length segments. */
export function chordPoly(raw: ArrayLike<number>, closed = false): Poly {
  const pts: number[] = [raw[0], raw[1]];
  for (let i = 2; i < raw.length; i += 2) {
    const px = pts[pts.length - 2];
    const py = pts[pts.length - 1];
    if (Math.hypot(raw[i] - px, raw[i + 1] - py) > 1e-7) pts.push(raw[i], raw[i + 1]);
  }
  if (pts.length === 2) pts.push(pts[0] + 1e-4, pts[1]);
  const n = pts.length / 2;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return { pts: Float64Array.from(pts), s, closed };
}

/** Polyline of an arc/circle whose parameter is the exact arc length. */
function arcPoly(c: Vec, r: number, start: number, sweep: number, closed: boolean): Poly {
  const n = arcSegments(r, sweep);
  const pts = new Float64Array((n + 1) * 2);
  const s = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const a = start + (sweep * k) / n;
    pts[k * 2] = c.x + Math.cos(a) * r;
    pts[k * 2 + 1] = c.y + Math.sin(a) * r;
    s[k] = (Math.abs(sweep) * r * k) / n;
  }
  return { pts, s, closed };
}

const polyCache = new WeakMap<Entity, Poly>();
/** Annotation outlines depend on the drawing scale. */
const annoPolyCache = new WeakMap<Entity, { g: number; p: Poly }>();

/** Flattened geometry of an entity (cached per immutable entity object). */
export function geomPoly(e: Entity): Poly {
  if (isAnnotation(e) && e.kind !== 'hatch') {
    const g = scaleGeneration();
    const hit = annoPolyCache.get(e);
    if (hit && hit.g === g) return hit.p;
    const raw: number[] = [];
    for (const [a, b] of annoSegments(e)) raw.push(a.x, a.y, b.x, b.y);
    const p = chordPoly(raw.length ? raw : [0, 0, 0, 0]);
    annoPolyCache.set(e, { g, p });
    return p;
  }
  let p = polyCache.get(e);
  if (p) return p;
  switch (e.kind) {
    case 'line':
      p = { pts: Float64Array.of(e.a.x, e.a.y, e.b.x, e.b.y), s: Float64Array.of(0, dist(e.a, e.b)), closed: false };
      break;
    case 'circle':
      p = arcPoly(e.c, e.r, 0, TAU, true);
      break;
    case 'arc':
      p = arcPoly(e.c, e.r, e.start, e.sweep, false);
      break;
    case 'stroke': {
      const raw: number[] = [];
      flattenSpline(e.pts, raw);
      p = chordPoly(raw);
      break;
    }
    default: {
      const raw: number[] = [];
      for (const [a, b] of annoSegments(e)) raw.push(a.x, a.y, b.x, b.y);
      p = chordPoly(raw.length ? raw : [0, 0, 0, 0]);
    }
  }
  polyCache.set(e, p);
  return p;
}

// ---- measures -----------------------------------------------------------------------------------

export function entityLength(e: Entity): number {
  switch (e.kind) {
    case 'line':
      return dist(e.a, e.b);
    case 'circle':
      return TAU * e.r;
    case 'arc':
      return Math.abs(e.sweep) * e.r;
    case 'stroke': {
      const p = geomPoly(e);
      return p.s[p.s.length - 1];
    }
    default:
      return 0;
  }
}

export function isClosed(e: Entity): boolean {
  return e.kind === 'circle';
}

/** Index of the polyline segment containing parameter s. */
function segAt(p: Poly, s: number): number {
  let lo = 0;
  let hi = p.s.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.s[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function polyPointAt(p: Poly, s: number): Vec {
  const j = segAt(p, s);
  const len = p.s[j + 1] - p.s[j];
  const t = len > 0 ? Math.min(1, Math.max(0, (s - p.s[j]) / len)) : 0;
  return {
    x: p.pts[j * 2] + (p.pts[j * 2 + 2] - p.pts[j * 2]) * t,
    y: p.pts[j * 2 + 1] + (p.pts[j * 2 + 3] - p.pts[j * 2 + 1]) * t,
  };
}

export function pointAt(e: Entity, s: number): Vec {
  switch (e.kind) {
    case 'line': {
      const l = dist(e.a, e.b) || 1;
      const t = s / l;
      return { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
    }
    case 'circle':
      return arcPoint(e.c, e.r, s / e.r);
    case 'arc':
      return arcPoint(e.c, e.r, e.start + Math.sign(e.sweep || 1) * (s / e.r));
    case 'stroke':
      return polyPointAt(geomPoly(e), s);
    default:
      return polyPointAt(geomPoly(e), 0);
  }
}

/** Closest point of the entity to p: parameter, point and distance. */
export function project(e: Entity, p: Vec): { s: number; point: Vec; d: number } {
  switch (e.kind) {
    case 'line': {
      const { point, t } = closestOnSegment(p, e.a, e.b);
      return { s: t * dist(e.a, e.b), point, d: dist(p, point) };
    }
    case 'circle': {
      const theta = normAngle(Math.atan2(p.y - e.c.y, p.x - e.c.x));
      const point = arcPoint(e.c, e.r, theta);
      return { s: theta * e.r, point, d: Math.abs(dist(p, e.c) - e.r) };
    }
    case 'arc': {
      const theta = Math.atan2(p.y - e.c.y, p.x - e.c.x);
      const u = arcOffset(e.start, e.sweep, theta);
      const len = Math.abs(e.sweep);
      if (u <= len) {
        const point = arcPoint(e.c, e.r, theta);
        return { s: u * e.r, point, d: Math.abs(dist(p, e.c) - e.r) };
      }
      const [p0, p1] = arcEnds(e);
      const d0 = dist(p, p0);
      const d1 = dist(p, p1);
      return d0 <= d1 ? { s: 0, point: p0, d: d0 } : { s: len * e.r, point: p1, d: d1 };
    }
    case 'stroke': {
      const poly = geomPoly(e);
      let best = { s: 0, point: { x: poly.pts[0], y: poly.pts[1] }, d: Infinity };
      for (let j = 0; j < poly.s.length - 1; j++) {
        const a = { x: poly.pts[j * 2], y: poly.pts[j * 2 + 1] };
        const b = { x: poly.pts[j * 2 + 2], y: poly.pts[j * 2 + 3] };
        const c = closestOnSegment(p, a, b);
        const d = dist(p, c.point);
        if (d < best.d) best = { s: poly.s[j] + c.t * (poly.s[j + 1] - poly.s[j]), point: c.point, d };
      }
      return best;
    }
    default: {
      if (e.kind === 'hatch' && insideHatch(e.loops, p)) return { s: 0, point: p, d: 0 };
      // Texts are hit anywhere on them, not just at their outline.
      if (e.kind !== 'hatch' && isAnnotation(e) && insideAnnoText(e, p)) return { s: 0, point: p, d: 0 };
      let best = { s: 0, point: p, d: Infinity };
      for (const [a, b] of annoSegments(e)) {
        const c = closestOnSegment(p, a, b);
        const d = dist(p, c.point);
        if (d < best.d) best = { s: 0, point: c.point, d };
      }
      return best;
    }
  }
}

/** Axis-aligned bounds of the geometry (without line width). */
export function geomBox(e: Entity): Box {
  switch (e.kind) {
    case 'line':
      return {
        minX: Math.min(e.a.x, e.b.x),
        minY: Math.min(e.a.y, e.b.y),
        maxX: Math.max(e.a.x, e.b.x),
        maxY: Math.max(e.a.y, e.b.y),
      };
    case 'circle':
      return { minX: e.c.x - e.r, minY: e.c.y - e.r, maxX: e.c.x + e.r, maxY: e.c.y + e.r };
    case 'arc': {
      const [p0, p1] = arcEnds(e);
      const bx = {
        minX: Math.min(p0.x, p1.x),
        minY: Math.min(p0.y, p1.y),
        maxX: Math.max(p0.x, p1.x),
        maxY: Math.max(p0.y, p1.y),
      };
      // Add the axis extremes the arc passes.
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        if (arcOffset(e.start, e.sweep, a) <= Math.abs(e.sweep)) {
          const q = arcPoint(e.c, e.r, a);
          bx.minX = Math.min(bx.minX, q.x);
          bx.minY = Math.min(bx.minY, q.y);
          bx.maxX = Math.max(bx.maxX, q.x);
          bx.maxY = Math.max(bx.maxY, q.y);
        }
      }
      return bx;
    }
    case 'stroke': {
      const bx = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 0; i < e.pts.length; i += 2) {
        bx.minX = Math.min(bx.minX, e.pts[i]);
        bx.minY = Math.min(bx.minY, e.pts[i + 1]);
        bx.maxX = Math.max(bx.maxX, e.pts[i]);
        bx.maxY = Math.max(bx.maxY, e.pts[i + 1]);
      }
      return bx;
    }
    default: {
      const bx = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const seg of annoSegments(e)) {
        for (const q of seg) {
          bx.minX = Math.min(bx.minX, q.x);
          bx.minY = Math.min(bx.minY, q.y);
          bx.maxX = Math.max(bx.maxX, q.x);
          bx.maxY = Math.max(bx.maxY, q.y);
        }
      }
      return bx;
    }
  }
}

// ---- intersections --------------------------------------------------------------------------------

type Prim = { k: 'seg'; a: Vec; b: Vec } | { k: 'circ'; c: Vec; r: number; start: number; sweep: number };

function prims(e: Entity, near?: Box): Prim[] {
  switch (e.kind) {
    case 'line':
      return [{ k: 'seg', a: e.a, b: e.b }];
    case 'circle':
      return [{ k: 'circ', c: e.c, r: e.r, start: 0, sweep: TAU }];
    case 'arc':
      return [{ k: 'circ', c: e.c, r: e.r, start: e.start, sweep: e.sweep }];
    case 'stroke': {
      const p = geomPoly(e);
      const out: Prim[] = [];
      for (let j = 0; j < p.s.length - 1; j++) {
        const a = { x: p.pts[j * 2], y: p.pts[j * 2 + 1] };
        const b = { x: p.pts[j * 2 + 2], y: p.pts[j * 2 + 3] };
        if (
          near &&
          (Math.max(a.x, b.x) < near.minX ||
            Math.min(a.x, b.x) > near.maxX ||
            Math.max(a.y, b.y) < near.minY ||
            Math.min(a.y, b.y) > near.maxY)
        ) {
          continue;
        }
        out.push({ k: 'seg', a, b });
      }
      return out;
    }
    default:
      return [];
  }
}

function onArc(q: Prim & { k: 'circ' }, p: Vec): boolean {
  if (Math.abs(q.sweep) >= TAU - 1e-12) return true;
  const u = arcOffset(q.start, q.sweep, Math.atan2(p.y - q.c.y, p.x - q.c.x));
  return u <= Math.abs(q.sweep) + 1e-9 || u >= TAU - 1e-9;
}

function segCircle(a: Vec, b: Vec, q: Prim & { k: 'circ' }): Vec[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - q.c.x;
  const fy = a.y - q.c.y;
  const A = dx * dx + dy * dy;
  if (A < 1e-18) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - q.r * q.r;
  let disc = B * B - 4 * A * C;
  if (disc < -1e-12 * A) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const out: Vec[] = [];
  for (const t of ts) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const p = { x: a.x + dx * t, y: a.y + dy * t };
    if (onArc(q, p)) out.push(p);
  }
  return out;
}

function circleCircle(p: Prim & { k: 'circ' }, q: Prim & { k: 'circ' }): Vec[] {
  const dx = q.c.x - p.c.x;
  const dy = q.c.y - p.c.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) return [];
  const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
  const mx = p.c.x + (dx * a) / d;
  const my = p.c.y + (dy * a) / d;
  const pts = h < 1e-12 ? [{ x: mx, y: my }] : [
    { x: mx - (dy * h) / d, y: my + (dx * h) / d },
    { x: mx + (dy * h) / d, y: my - (dx * h) / d },
  ];
  return pts.filter((x) => onArc(p, x) && onArc(q, x));
}

function intersectPrims(p: Prim, q: Prim): Vec[] {
  if (p.k === 'seg' && q.k === 'seg') {
    const x = segmentIntersection(p.a, p.b, q.a, q.b);
    return x ? [x] : [];
  }
  if (p.k === 'seg' && q.k === 'circ') return segCircle(p.a, p.b, q);
  if (p.k === 'circ' && q.k === 'seg') return segCircle(q.a, q.b, p);
  return circleCircle(p as Prim & { k: 'circ' }, q as Prim & { k: 'circ' });
}

/** Intersection points of two entities. */
export function intersectEntities(e1: Entity, e2: Entity): Vec[] {
  const b1 = geomBox(e1);
  const b2 = geomBox(e2);
  if (!boxesIntersect(boxExpand(b1, 1e-6), boxExpand(b2, 1e-6))) return [];
  const p1 = prims(e1, boxExpand(b2, 1e-6));
  const p2 = prims(e2, boxExpand(b1, 1e-6));
  const out: Vec[] = [];
  for (const a of p1) for (const b of p2) out.push(...intersectPrims(a, b));
  return out;
}

/** Intersections of an entity with a straight segment (e.g. a trim swipe). */
export function intersectSegment(e: Entity, a: Vec, b: Vec): Vec[] {
  const seg: Prim = { k: 'seg', a, b };
  const bx = boxExpand(
    { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) },
    1e-6,
  );
  if (!boxesIntersect(geomBox(e), bx)) return [];
  const out: Vec[] = [];
  for (const p of prims(e, bx)) out.push(...intersectPrims(seg, p));
  return out;
}

// ---- pieces -------------------------------------------------------------------------------------------

/** Minimal length (mm) of a piece worth keeping. */
const MIN_PIECE = 1e-4;

/** The part [s0, s1] of an entity as a new entity (same style, layer and z). s1 may exceed the length of a circle. */
export function subEntity(e: Entity, s0: number, s1: number, id: string): Entity {
  switch (e.kind) {
    case 'line':
      return { ...e, id, a: pointAt(e, s0), b: pointAt(e, s1) };
    case 'circle': {
      const { mark, ...rest } = e;
      return { ...rest, kind: 'arc', id, start: s0 / e.r, sweep: (s1 - s0) / e.r, ...(mark ? { mark } : {}) };
    }
    case 'arc': {
      const sign = Math.sign(e.sweep || 1);
      return { ...e, id, start: e.start + (sign * s0) / e.r, sweep: (sign * (s1 - s0)) / e.r };
    }
    case 'stroke': {
      const p = geomPoly(e);
      const out: number[] = [];
      const a = polyPointAt(p, s0);
      out.push(a.x, a.y);
      for (let i = 0; i < p.s.length; i++) if (p.s[i] > s0 && p.s[i] < s1) out.push(p.pts[i * 2], p.pts[i * 2 + 1]);
      const b = polyPointAt(p, s1);
      out.push(b.x, b.y);
      let pts = simplifyFlat(out, 0.003);
      if (pts.length < 4) pts = [a.x, a.y, b.x + 1e-4, b.y];
      return { ...e, id, pts };
    }
    default:
      return e;
  }
}

/** Merge overlapping ranges (sorted by start). */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * What remains of an entity after removing the given parameter ranges.
 * Returns [e] unchanged when nothing is removed, [] when everything is.
 * `minLength` drops crumbs too short to see.
 */
export function removeRanges(e: Entity, ranges: [number, number][], newId: () => string, minLength = MIN_PIECE): Entity[] {
  if (ranges.length === 0 || isAnnotation(e)) return [e];
  const L = entityLength(e);
  const keep: [number, number][] = [];
  if (isClosed(e)) {
    // Normalise into [0, L), splitting ranges that wrap around the seam.
    const norm: [number, number][] = [];
    for (const [a0, b0] of ranges) {
      if (b0 - a0 >= L - 1e-9) return [];
      const a = ((a0 % L) + L) % L;
      const b = a + (b0 - a0);
      if (b > L) {
        norm.push([a, L], [0, b - L]);
      } else {
        norm.push([a, b]);
      }
    }
    const merged = mergeRanges(norm);
    if (merged.length === 1 && merged[0][0] <= 1e-9 && merged[0][1] >= L - 1e-9) return [];
    // Gaps between removed ranges, the last one wrapping over the seam.
    for (let i = 0; i < merged.length; i++) {
      const from = merged[i][1];
      const to = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + L;
      if (to - from > minLength) keep.push([from, to]);
    }
  } else {
    const merged = mergeRanges(ranges.map(([a, b]) => [Math.max(0, a), Math.min(L, b)] as [number, number]));
    let cur = 0;
    for (const [a, b] of merged) {
      if (a - cur > minLength) keep.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (L - cur > minLength) keep.push([cur, L]);
    if (keep.length === 1 && keep[0][0] <= 1e-12 && keep[0][1] >= L - 1e-12) return [e];
  }
  return keep.map(([a, b]) => subEntity(e, a, b, newId()));
}

// ---- trimming ----------------------------------------------------------------------------------------------

/** Parameters where other entities cross this one (sorted, de-duplicated). */
export function cutParams(e: Entity, cutters: Iterable<Entity>, touchTol = 0): number[] {
  const out: number[] = [];
  const box = boxExpand(geomBox(e), 1e-6 + touchTol);
  for (const o of cutters) {
    if (o.id === e.id || isAnnotation(o) || !boxesIntersect(box, geomBox(o))) continue;
    for (const p of intersectEntities(e, o)) out.push(project(e, p).s);
    // An end of another object resting on this one (a T-junction) also bounds a trim.
    if (touchTol > 0) {
      for (const q of endPoints(o)) {
        const pr = project(e, q);
        if (pr.d <= touchTol) out.push(pr.s);
      }
    }
  }
  out.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const s of out) if (!uniq.length || s - uniq[uniq.length - 1] > 1e-7) uniq.push(s);
  return uniq;
}

/** Open ends of an entity (none for circles). */
export function endPoints(e: Entity): Vec[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b];
    case 'arc':
      return arcEnds(e);
    case 'stroke': {
      const n = e.pts.length;
      return [
        { x: e.pts[0], y: e.pts[1] },
        { x: e.pts[n - 2], y: e.pts[n - 1] },
      ];
    }
    default:
      return [];
  }
}

/**
 * The piece of an entity between the cuts around parameter s — what a trim at
 * that spot removes. For a circle with fewer than two cuts that is the whole circle.
 */
export function trimRange(e: Entity, cuts: number[], s: number): [number, number] {
  const L = entityLength(e);
  if (isClosed(e)) {
    if (cuts.length < 2) return [0, L];
    let lo = -Infinity;
    let hi = Infinity;
    for (const c of cuts) {
      if (c <= s) lo = Math.max(lo, c);
      if (c > s) hi = Math.min(hi, c);
    }
    if (lo === -Infinity) lo = cuts[cuts.length - 1] - L;
    if (hi === Infinity) hi = cuts[0] + L;
    return [lo, hi];
  }
  let lo = 0;
  let hi = L;
  for (const c of cuts) {
    if (c <= s && c > lo) lo = c;
    if (c > s && c < hi) hi = c;
  }
  return [lo, hi];
}

// ---- erasing -----------------------------------------------------------------------------------------------------

/** Interval of t ∈ [0,1] where segment q0→q1 lies within distance R of segment p0→p1 (a capsule), or null. */
export function segmentInCapsule(q0: Vec, q1: Vec, p0: Vec, p1: Vec, R: number): [number, number] | null {
  const dx = q1.x - q0.x;
  const dy = q1.y - q0.y;
  let t0 = Infinity;
  let t1 = -Infinity;
  const addDisc = (c: Vec) => {
    const fx = q0.x - c.x;
    const fy = q0.y - c.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - R * R;
    if (A < 1e-18) {
      if (C <= 0) {
        t0 = Math.min(t0, 0);
        t1 = Math.max(t1, 1);
      }
      return;
    }
    const disc = B * B - 4 * A * C;
    if (disc < 0) return;
    const sq = Math.sqrt(disc);
    const a = (-B - sq) / (2 * A);
    const b = (-B + sq) / (2 * A);
    if (b < 0 || a > 1) return;
    t0 = Math.min(t0, Math.max(0, a));
    t1 = Math.max(t1, Math.min(1, b));
  };
  addDisc(p0);
  const ux = p1.x - p0.x;
  const uy = p1.y - p0.y;
  const len = Math.hypot(ux, uy);
  if (len > 1e-12) {
    addDisc(p1);
    // Rectangle part in capsule coordinates (along u, across v).
    const ax = ux / len;
    const ay = uy / len;
    const u0 = (q0.x - p0.x) * ax + (q0.y - p0.y) * ay;
    const du = dx * ax + dy * ay;
    const v0 = -(q0.x - p0.x) * ay + (q0.y - p0.y) * ax;
    const dv = -dx * ay + dy * ax;
    let lo = 0;
    let hi = 1;
    const clip = (p: number, q: number) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
      return true;
    };
    if (clip(-du, u0) && clip(du, len - u0) && clip(-dv, v0 + R) && clip(dv, R - v0) && lo <= hi) {
      t0 = Math.min(t0, lo);
      t1 = Math.max(t1, hi);
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** Parameter ranges of an entity within distance R of the segment p0→p1. */
export function capsuleRanges(e: Entity, p0: Vec, p1: Vec, R: number): [number, number][] {
  const bx = {
    minX: Math.min(p0.x, p1.x) - R,
    minY: Math.min(p0.y, p1.y) - R,
    maxX: Math.max(p0.x, p1.x) + R,
    maxY: Math.max(p0.y, p1.y) + R,
  };
  if (!boxesIntersect(geomBox(e), bx)) return [];
  const poly = geomPoly(e);
  const out: [number, number][] = [];
  for (let j = 0; j < poly.s.length - 1; j++) {
    const ax = poly.pts[j * 2];
    const ay = poly.pts[j * 2 + 1];
    const bx2 = poly.pts[j * 2 + 2];
    const by = poly.pts[j * 2 + 3];
    if (Math.max(ax, bx2) < bx.minX || Math.min(ax, bx2) > bx.maxX || Math.max(ay, by) < bx.minY || Math.min(ay, by) > bx.maxY) {
      continue;
    }
    const t = segmentInCapsule({ x: ax, y: ay }, { x: bx2, y: by }, p0, p1, R);
    if (!t) continue;
    const s0 = poly.s[j];
    const ds = poly.s[j + 1] - s0;
    out.push([s0 + t[0] * ds, s0 + t[1] * ds]);
  }
  return mergeRanges(out);
}
