import { dist, type Vec } from './geom';
import { drawingScale, invalidateLayouts, scaleGeneration } from './scale';
import type { Annotation, DatumEntity, DimEntity, ForceEntity, GpsSymbol, GtolEntity, LaidOut, LineLoadEntity, MomentEntity, SheetEntity, SheetFormat, SupportEntity, TextEntity } from './types';

/**
 * Layout of annotations as plain geometry (world mm): thin lines and arcs, filled
 * polygons (arrowheads, datum triangles), rectangles and texts. Rendering, hit
 * testing, bounds and export all use the same layout.
 */

/** Text height (DIN 406: 3.5 mm) and derived sizes. */
const BASE = { TEXT_H: 3.5, ARROW_L: 2.5, ARROW_HALF: 0.42, EXT_OVER: 2, TEXT_GAP: 0.9, FRAME_H: 7, CELL: 7, TEXT_RUN: 0.6 };
// Paper sizes in world mm at the current drawing scale (set by useScale before laying out).
let TEXT_H = BASE.TEXT_H;
let ARROW_L = BASE.ARROW_L;
let ARROW_HALF = BASE.ARROW_HALF;
let EXT_OVER = BASE.EXT_OVER;
let TEXT_GAP = BASE.TEXT_GAP;
let FRAME_H = BASE.FRAME_H;
let CELL = BASE.CELL;
let TEXT_RUN = BASE.TEXT_RUN;
/** Drawing scale the sizes above are set for. */
let K = 1;

function useScale(): void {
  const k = drawingScale();
  if (k === K) return;
  K = k;
  TEXT_H = BASE.TEXT_H * k;
  ARROW_L = BASE.ARROW_L * k;
  ARROW_HALF = BASE.ARROW_HALF * k;
  EXT_OVER = BASE.EXT_OVER * k;
  TEXT_GAP = BASE.TEXT_GAP * k;
  FRAME_H = BASE.FRAME_H * k;
  CELL = BASE.CELL * k;
  TEXT_RUN = BASE.TEXT_RUN * k;
}

export interface AnnoText {
  p: Vec;
  /** Reading direction in radians (world). */
  angle: number;
  text: string;
  size: number;
  /** 'bottom': p is the middle of the baseline side; 'middle': p is the text centre. */
  baseline: 'bottom' | 'middle';
}

export interface AnnoArc {
  c: Vec;
  r: number;
  start: number;
  sweep: number;
}

export interface AnnoLayout {
  lines: [Vec, Vec][];
  arcs: AnnoArc[];
  fills: Vec[][];
  texts: AnnoText[];
}

const add = (a: Vec, b: Vec, k = 1): Vec => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const unit = (v: Vec): Vec => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
const perp = (v: Vec): Vec => ({ x: -v.y, y: v.x });

/** Helvetica/Arial advance widths (1/1000 em) – the lettering font on screen and in PDFs. */

const HELV: Record<string, number> = {};
{
  const ascii =
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const w = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
    584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
    278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ];
  [...ascii].forEach((c, i) => (HELV[c] = w[i]));
  Object.assign(HELV, { 'Ø': 778, 'ø': 611, '°': 400, '±': 584, 'µ': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ä': 556, 'ö': 556, 'ü': 556, 'ß': 611, '×': 584, '²': 333, '³': 333 });
}

/** Width of a text at letter height `size` (Helvetica metrics). */
export function textWidth(text: string, size = TEXT_H): number {
  let w = 0;
  for (const c of text) w += HELV[c] ?? 556;
  return (w / 1000) * size;
}

/** "42,5" / "25" – one decimal, trailing zero dropped. */
export function formatMeasure(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)).replace('.', ',');
}

function arrow(tip: Vec, dir: Vec): Vec[] {
  // dir: direction the arrow points to (towards the tip).
  const d = unit(dir);
  const n = perp(d);
  const base = add(tip, d, -ARROW_L);
  return [tip, add(base, n, ARROW_HALF), add(base, n, -ARROW_HALF)];
}

/** Reading direction for text along direction u: readable from below or from the right. */
function readable(u: Vec): Vec {
  return u.x < -1e-9 || (Math.abs(u.x) <= 1e-9 && u.y > 0) ? { x: -u.x, y: -u.y } : u;
}

/** Side "above" text written along r (y points down in world). */
function above(r: Vec): Vec {
  return { x: r.y, y: -r.x };
}

export function dimValue(e: DimEntity): number {
  switch (e.type) {
    case 'lin': {
      const u = { x: Math.cos(e.dir ?? 0), y: Math.sin(e.dir ?? 0) };
      return Math.abs((e.p2.x - e.p1.x) * u.x + (e.p2.y - e.p1.y) * u.y);
    }
    case 'dia':
      return 2 * dist(e.p1, e.p2);
    case 'rad':
      return dist(e.p1, e.p2);
    case 'ang': {
      const a1 = Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x);
      const a2 = Math.atan2((e.p3 ?? e.p2).y - e.p1.y, (e.p3 ?? e.p2).x - e.p1.x);
      return (Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1))) * 180) / Math.PI;
    }
  }
}

export function dimText(e: DimEntity): string {
  if (e.text) return e.text;
  const v = dimValue(e);
  switch (e.type) {
    case 'lin':
      return formatMeasure(v);
    case 'dia':
      return `Ø${formatMeasure(v)}`;
    case 'rad':
      return `R${formatMeasure(v)}`;
    case 'ang':
      return `${formatMeasure(v)}°`;
  }
}

/** Frame of a linear dimension: dimension line d1–d2, its direction and the normal. */
function linFrame(e: DimEntity) {
  const u = { x: Math.cos(e.dir ?? 0), y: Math.sin(e.dir ?? 0) };
  const n = perp(u);
  const s1 = e.p1.x * n.x + e.p1.y * n.y;
  const s2 = e.p2.x * n.x + e.p2.y * n.y;
  const base = s1 + e.off;
  const d1 = add(e.p1, n, base - s1);
  const d2 = add(e.p2, n, base - s2);
  const len = dist(d1, d2);
  const along = len > 1e-9 ? unit({ x: d2.x - d1.x, y: d2.y - d1.y }) : u;
  const m = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
  return { u, n, s1, s2, base, d1, d2, len, along, m };
}

/** Frame of an angular dimension: vertex, first leg angle, signed sweep, arc radius. */
function angFrame(e: DimEntity) {
  const v = e.p1;
  const p3 = e.p3 ?? e.p2;
  const a1 = Math.atan2(e.p2.y - v.y, e.p2.x - v.x);
  const a2 = Math.atan2(p3.y - v.y, p3.x - v.x);
  const sweep = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
  return { v, p3, a1, a2, sweep, R: Math.max(e.off, 1) };
}


/**
 * Point on the dimension line (or arc) under the middle of the figure – where it
 * is grabbed to move the figure along the line and the line itself.
 */
export function dimTextAnchor(e: DimEntity): Vec {
  useScale();
  if (e.type === 'lin') {
    const f = linFrame(e);
    return add(f.m, f.along, e.tpos ?? 0);
  }
  if (e.type === 'dia' || e.type === 'rad') {
    const rad = dist(e.p1, e.p2);
    const u = unit({ x: e.p2.x - e.p1.x, y: e.p2.y - e.p1.y });
    return add(e.p1, u, e.tpos ?? rad * 0.5);
  }
  const f = angFrame(e);
  const am = f.a1 + f.sweep / 2 + (e.tpos ?? 0);
  return add(f.v, { x: Math.cos(am), y: Math.sin(am) }, f.R);
}

/**
 * The dimension with its figure dragged to q (the feature points stay):
 * linear – along the line and the line's distance; diameter/radius – direction
 * and position along it (inside or outside); angle – arc radius and position.
 * `stepDeg` snaps the direction of diameters and radii.
 */
export function dragDimText(e: DimEntity, q: Vec, stepDeg = 0): DimEntity {
  useScale();
  if (e.type === 'lin') {
    const f = linFrame(e);
    const off = (q.x - e.p1.x) * f.n.x + (q.y - e.p1.y) * f.n.y;
    const tpos = (q.x - f.m.x) * f.along.x + (q.y - f.m.y) * f.along.y;
    // The middle is a natural resting place: the figure settles there within 1 mm.
    return { ...e, off, tpos: Math.abs(tpos) < K ? undefined : tpos };
  }
  if (e.type === 'dia' || e.type === 'rad') {
    const rad = dist(e.p1, e.p2);
    let a = Math.atan2(q.y - e.p1.y, q.x - e.p1.x);
    if (stepDeg > 0) {
      const st = (stepDeg * Math.PI) / 180;
      a = Math.round(a / st) * st;
    }
    const u = { x: Math.cos(a), y: Math.sin(a) };
    return { ...e, p2: add(e.p1, u, rad), tpos: Math.max(0, dist(q, e.p1)) };
  }
  const f = angFrame(e);
  const aq = Math.atan2(q.y - f.v.y, q.x - f.v.x);
  const mid = f.a1 + f.sweep / 2;
  const tpos = Math.atan2(Math.sin(aq - mid), Math.cos(aq - mid));
  return { ...e, off: Math.max(1, dist(q, f.v)), tpos: Math.abs(tpos) < 1e-3 ? undefined : tpos };
}

function layoutDim(e: DimEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  // A typed dimension text can stand for a host value ("l" → "l = 2 m"), like labels.
  const text = e.text ? shownLabel(e.text) : dimText(e);
  const w = textWidth(text, TEXT_H);
  if (e.type === 'lin') {
    const { n, s1, s2, base, d1, d2, len, along, u, m } = linFrame(e);
    // Extension lines run from the feature past the dimension line.
    for (const [p, d, s] of [
      [e.p1, d1, s1],
      [e.p2, d2, s2],
    ] as [Vec, Vec, number][]) {
      const side = Math.sign(base - s) || 1;
      L.lines.push([p, add(d, n, side * EXT_OVER)]);
    }
    L.lines.push([d1, d2]);
    const short = len <= 2 * ARROW_L + 0.5 * K;
    if (!short) {
      L.fills.push(arrow(d1, { x: -along.x, y: -along.y }), arrow(d2, along));
    } else {
      // Short: arrows outside pointing in.
      L.fills.push(arrow(d1, along), arrow(d2, { x: -along.x, y: -along.y }));
      L.lines.push([d1, add(d1, along, -ARROW_L * 2)], [d2, add(d2, along, ARROW_L * 2)]);
    }
    const tp = e.tpos ?? 0;
    // A figure moved past the ends sits on the extended dimension line.
    const reach = short ? len / 2 + ARROW_L * 2 : len / 2;
    if (tp + w / 2 > reach) L.lines.push([add(m, along, reach), add(m, along, tp + w / 2 + TEXT_RUN)]);
    if (tp - w / 2 < -reach) L.lines.push([add(m, along, -reach), add(m, along, tp - w / 2 - TEXT_RUN)]);
    const r = readable(len > 1e-9 ? along : u);
    L.texts.push({ p: add(add(m, along, tp), above(r), TEXT_GAP), angle: Math.atan2(r.y, r.x), text, size: TEXT_H, baseline: 'bottom' });
  } else if (e.type === 'dia' || e.type === 'rad') {
    const c = e.p1;
    const rad = dist(c, e.p2);
    const u = unit({ x: e.p2.x - c.x, y: e.p2.y - c.y });
    const tip = add(c, u, rad);
    const fromT = e.type === 'dia' ? -rad : 0;
    const from = add(c, u, fromT);
    L.lines.push([from, tip]);
    L.fills.push(arrow(tip, u));
    if (e.type === 'dia') L.fills.push(arrow(from, { x: -u.x, y: -u.y }));
    const tp = e.tpos ?? rad * 0.5;
    if (tp + w / 2 > rad) L.lines.push([tip, add(c, u, tp + w / 2 + TEXT_RUN)]);
    if (tp - w / 2 < fromT) L.lines.push([from, add(c, u, tp - w / 2 - TEXT_RUN)]);
    const r = readable(u);
    L.texts.push({ p: add(add(c, u, tp), above(r), TEXT_GAP), angle: Math.atan2(r.y, r.x), text, size: TEXT_H, baseline: 'bottom' });
  } else {
    const { v, p3, a1, a2, sweep, R } = angFrame(e);
    L.arcs.push({ c: v, r: R, start: a1, sweep });
    // Extension lines where the legs end before the arc.
    for (const [p, a] of [
      [e.p2, a1],
      [p3, a2],
    ] as [Vec, number][]) {
      const lp = dist(v, p);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      if (lp < R) L.lines.push([add(v, dir, lp), add(v, dir, R + EXT_OVER)]);
    }
    const sgn = Math.sign(sweep) || 1;
    const end1 = add(v, { x: Math.cos(a1), y: Math.sin(a1) }, R);
    const end2 = add(v, { x: Math.cos(a1 + sweep), y: Math.sin(a1 + sweep) }, R);
    // Arrow directions: tangents pointing outwards at both ends.
    const t1 = { x: sgn * Math.sin(a1), y: -sgn * Math.cos(a1) };
    const t2 = { x: -sgn * Math.sin(a1 + sweep), y: sgn * Math.cos(a1 + sweep) };
    L.fills.push(arrow(end1, t1), arrow(end2, t2));
    const am = a1 + sweep / 2 + (e.tpos ?? 0);
    // Figure moved beyond the arc: extend the arc under it.
    const half = (w / 2 + TEXT_RUN) / R;
    const lo = Math.min(a1, a1 + sweep);
    const hi = Math.max(a1, a1 + sweep);
    if (am + half > hi) L.arcs.push({ c: v, r: R, start: hi, sweep: am + half - hi });
    if (am - half < lo) L.arcs.push({ c: v, r: R, start: lo, sweep: am - half - lo });
    const mid = add(v, { x: Math.cos(am), y: Math.sin(am) }, R);
    const tangent = { x: -Math.sin(am), y: Math.cos(am) };
    const r = readable(tangent);
    const out = { x: Math.cos(am), y: Math.sin(am) };
    // Put the text on the outer side of the arc.
    const up = above(r);
    const side = up.x * out.x + up.y * out.y >= 0 ? 1 : -1;
    L.texts.push({
      p: add(mid, out, side > 0 ? TEXT_GAP : TEXT_GAP + TEXT_H),
      angle: Math.atan2(r.y, r.x),
      text,
      size: TEXT_H,
      baseline: 'bottom',
    });
  }
  return L;
}

function rect(x: number, y: number, w: number, h: number): [Vec, Vec][] {
  const a = { x, y };
  const b = { x: x + w, y };
  const c = { x: x + w, y: y + h };
  const d = { x, y: y + h };
  return [
    [a, b],
    [b, c],
    [c, d],
    [d, a],
  ];
}

function layoutDatum(e: DatumEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const d = unit({ x: e.p.x - e.at.x, y: e.p.y - e.at.y });
  const n = perp(d);
  const hTri = 2.6 * K;
  const halfBase = 1.6 * K;
  L.fills.push([add(e.at, n, halfBase), add(e.at, n, -halfBase), add(e.at, d, hTri)]);
  const half = FRAME_H / 2;
  // Leader from the triangle to the nearest point of the frame.
  const box = { minX: e.p.x - half, maxX: e.p.x + half, minY: e.p.y - half, maxY: e.p.y + half };
  const apex = add(e.at, d, hTri);
  const toFrame = clampToBoxEdge(apex, e.p, box);
  if (dist(apex, toFrame) > 0.2) L.lines.push([apex, toFrame]);
  L.lines.push(...rect(e.p.x - half, e.p.y - half, FRAME_H, FRAME_H));
  L.texts.push({ p: e.p, angle: 0, text: e.letter, size: TEXT_H, baseline: 'middle' });
  return L;
}

/** Point where the segment from outside point q to box centre c crosses the box edge. */
function clampToBoxEdge(q: Vec, c: Vec, box: { minX: number; maxX: number; minY: number; maxY: number }): Vec {
  const dx = q.x - c.x;
  const dy = q.y - c.y;
  const hx = (box.maxX - box.minX) / 2;
  const hy = (box.maxY - box.minY) / 2;
  const t = Math.min(dx !== 0 ? hx / Math.abs(dx) : Infinity, dy !== 0 ? hy / Math.abs(dy) : Infinity);
  if (t >= 1) return q;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Width of the cells of a tolerance frame. */
export function gtolCells(e: GtolEntity): number[] {
  const value = (e.dia ? 'Ø' : '') + e.value;
  useScale();
  return [CELL, Math.max(10 * K, textWidth(value) + 3 * K), ...e.datums.map((d) => Math.max(CELL, textWidth(d) + 3 * K))];
}

function layoutGtol(e: GtolEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const cells = gtolCells(e);
  const total = cells.reduce((a, b) => a + b, 0);
  const x0 = e.p.x;
  const y0 = e.p.y - FRAME_H / 2;
  L.lines.push(...rect(x0, y0, total, FRAME_H));
  let x = x0;
  cells.forEach((w, i) => {
    if (i > 0) L.lines.push([{ x, y: y0 }, { x, y: y0 + FRAME_H }]);
    const c = { x: x + w / 2, y: e.p.y };
    if (i === 0) addSymbol(L, e.sym, c);
    else if (i === 1) L.texts.push({ p: c, angle: 0, text: (e.dia ? 'Ø' : '') + e.value, size: TEXT_H, baseline: 'middle' });
    else L.texts.push({ p: c, angle: 0, text: e.datums[i - 2], size: TEXT_H, baseline: 'middle' });
    x += w;
  });
  // Leader from the nearest frame side to the feature, arrow at the feature.
  const box = { minX: x0, maxX: x0 + total, minY: y0, maxY: y0 + FRAME_H };
  let start: Vec;
  if (e.at.x < box.minX) start = { x: box.minX, y: e.p.y };
  else if (e.at.x > box.maxX) start = { x: box.maxX, y: e.p.y };
  else start = { x: x0 + cells[0] / 2, y: e.at.y < box.minY ? box.minY : box.maxY };
  if (dist(start, e.at) > ARROW_L) {
    L.lines.push([start, e.at]);
    L.fills.push(arrow(e.at, { x: e.at.x - start.x, y: e.at.y - start.y }));
  }
  return L;
}

/** ISO 1101 characteristic symbols drawn with lines and arcs, centred at c (height ≈ 3.5 mm). */
function addSymbol(L: AnnoLayout, sym: GpsSymbol, c: Vec): void {
  const s = TEXT_H / 2; // half size
  const P = (x: number, y: number): Vec => ({ x: c.x + x * s, y: c.y + y * s });
  const line = (x1: number, y1: number, x2: number, y2: number) => L.lines.push([P(x1, y1), P(x2, y2)]);
  const circle = (r: number, x = 0, y = 0) => L.arcs.push({ c: P(x, y), r: r * s, start: 0, sweep: Math.PI * 2 });
  const tip = (x: number, y: number, dx: number, dy: number) => L.fills.push(arrowSmall(P(x, y), { x: dx, y: dy }));
  switch (sym) {
    case 'straightness':
      line(-1, 0, 1, 0);
      break;
    case 'flatness':
      line(-0.7, -0.5, 1, -0.5);
      line(1, -0.5, 0.7, 0.5);
      line(0.7, 0.5, -1, 0.5);
      line(-1, 0.5, -0.7, -0.5);
      break;
    case 'circularity':
      circle(0.9);
      break;
    case 'cylindricity':
      // Circle with two parallel slanted tangents.
      circle(0.6);
      line(0.25, 1.1, 0.88, -0.7);
      line(-0.88, 0.7, -0.25, -1.1);
      break;
    case 'profileLine':
      L.arcs.push({ c: P(0, 0.4), r: 0.9 * s, start: Math.PI, sweep: Math.PI });
      break;
    case 'profileSurface':
      L.arcs.push({ c: P(0, 0.4), r: 0.9 * s, start: Math.PI, sweep: Math.PI });
      line(-0.9, 0.4, 0.9, 0.4);
      break;
    case 'parallelism':
      line(-0.8, 0.8, -0.1, -0.8);
      line(0.1, 0.8, 0.8, -0.8);
      break;
    case 'perpendicularity':
      line(-0.9, 0.8, 0.9, 0.8);
      line(0, 0.8, 0, -0.9);
      break;
    case 'angularity':
      line(-0.9, 0.8, 0.9, 0.8);
      line(-0.9, 0.8, 0.7, -0.6);
      break;
    case 'position':
      circle(0.6);
      line(-1, 0, 1, 0);
      line(0, -1, 0, 1);
      break;
    case 'concentricity':
      circle(0.9);
      circle(0.45);
      break;
    case 'symmetry':
      line(-1, 0, 1, 0);
      line(-0.6, -0.55, 0.6, -0.55);
      line(-0.6, 0.55, 0.6, 0.55);
      break;
    case 'runout':
      line(-0.6, 0.9, 0.5, -0.7);
      tip(0.55, -0.8, 0.6, -1);
      break;
    case 'totalRunout':
      line(-0.9, 0.9, 0.9, 0.9);
      line(-0.9, 0.9, -0.2, -0.8);
      line(0.1, 0.9, 0.8, -0.8);
      tip(-0.15, -0.9, 0.4, -1);
      tip(0.85, -0.9, 0.4, -1);
      break;
  }
}

/** Layout of a characteristic symbol alone, centred at the origin (for buttons). */
export function symbolLayout(sym: GpsSymbol): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  addSymbol(L, sym, { x: 0, y: 0 });
  return L;
}

export const GPS_NAMES: Record<GpsSymbol, string> = {
  straightness: 'Geradheit',
  flatness: 'Ebenheit',
  circularity: 'Rundheit',
  cylindricity: 'Zylinderform',
  profileLine: 'Linienform',
  profileSurface: 'Flächenform',
  parallelism: 'Parallelität',
  perpendicularity: 'Rechtwinkligkeit',
  angularity: 'Neigung',
  position: 'Position',
  concentricity: 'Koaxialität',
  symmetry: 'Symmetrie',
  runout: 'Lauf',
  totalRunout: 'Gesamtlauf',
};

/** Characteristics that refer to datums (the others are form tolerances). */
export const GPS_NEEDS_DATUM: Record<GpsSymbol, boolean> = {
  straightness: false,
  flatness: false,
  circularity: false,
  cylindricity: false,
  profileLine: false,
  profileSurface: false,
  parallelism: true,
  perpendicularity: true,
  angularity: true,
  position: true,
  concentricity: true,
  symmetry: true,
  runout: true,
  totalRunout: true,
};

function arrowSmall(tip: Vec, dir: Vec): Vec[] {
  const d = unit(dir);
  const n = perp(d);
  const base = add(tip, d, -1.1 * K);
  return [tip, add(base, n, 0.35 * K), add(base, n, -0.35 * K)];
}

const layoutCache = new WeakMap<Annotation, { g: number; l: AnnoLayout }>();

/** Layout of a dimension, GPS symbol, text or sheet (hatches have none). */
export function layoutAnno(e: LaidOut): AnnoLayout {
  const g = scaleGeneration();
  const hit = layoutCache.get(e);
  if (hit && hit.g === g) return hit.l;
  useScale();
  let l: AnnoLayout;
  {
    switch (e.kind) {
      case 'dim':
        l = layoutDim(e);
        break;
      case 'datum':
        l = layoutDatum(e);
        break;
      case 'gtol':
        l = layoutGtol(e);
        break;
      case 'text':
        l = layoutText(e);
        break;
      case 'sheet':
        l = layoutSheet(e);
        break;
      case 'support':
        l = layoutSupport(e);
        break;
      case 'force':
        l = layoutForce(e);
        break;
      case 'moment':
        l = layoutMoment(e);
        break;
      case 'lineload':
        l = layoutLineLoad(e);
        break;
    }
    layoutCache.set(e, { g, l });
  }
  return l;
}

// ---- Technische Mechanik ---------------------------------------------------------------------

/** Paper sizes (mm at 1:1) of the free-body symbols. */
const MECH = { TRI_H: 7, TRI_HALF: 4.2, GROUND: 8, HATCH: 2, HATCH_GAP: 2, ROLLER_GAP: 1.6, PIN: 1, HINGE: 1.5, CLAMP: 10, HEAD_L: 3.5, HEAD_HALF: 0.85, LOAD_STEP: 6 };
const SUB_SCALE = 0.7;

/**
 * Turns the stored label into the shown text – a host (e.g. MathPad) can show
 * "F_1 = 500 N" for a label "F_1" from its own variables. Applies to labels of
 * forces, moments and line loads, typed dimension texts and one-line texts.
 * Default: as stored.
 */
let labelResolver: ((label: string) => string) | null = null;

export function setLabelResolver(fn: ((label: string) => string) | null): void {
  labelResolver = fn;
  invalidateLayouts();
}

/** Shown text of a free-body label. */
export function shownLabel(label: string): string {
  if (!labelResolver) return label;
  try {
    return labelResolver(label) ?? label;
  } catch {
    return label;
  }
}

/**
 * Display text of a label: "F_1 = 500 N" → main "F", subscript "1", rest " = 500 N".
 * The subscript runs up to the next space or "=".
 */
export function splitLabel(label: string): { main: string; sub: string; rest: string } {
  const m = /^([^_\s=]+)_([^\s=]+)(.*)$/s.exec(label);
  return m ? { main: m[1], sub: m[2], rest: m[3] } : { main: label, sub: '', rest: '' };
}

/** Width of a label including its smaller subscript. */
export function labelWidth(label: string, size = TEXT_H): number {
  const { main, sub, rest } = splitLabel(label);
  return textWidth(main, size) + textWidth(sub, size * SUB_SCALE) + textWidth(rest, size);
}

/**
 * Label (with subscript) centred on `c` (paper-horizontal). `away` pushes the
 * label box off `c` in that direction so it does not cover the symbol.
 */
function pushLabel(L: AnnoLayout, stored: string, c: Vec, away: Vec = { x: 0, y: 0 }): void {
  const label = shownLabel(stored);
  if (!label.trim()) return;
  const { main, sub, rest } = splitLabel(label);
  const subH = TEXT_H * SUB_SCALE;
  const w = labelWidth(label);
  const u = unit(away);
  // Move the box centre so its edge (not its centre) keeps the distance.
  const reach = Math.abs(u.x) * (w / 2) + Math.abs(u.y) * (TEXT_H / 2);
  const ctr = Math.hypot(away.x, away.y) > 0 ? add(c, u, reach) : c;
  let x = ctr.x - w / 2;
  const base = ctr.y + TEXT_H / 2;
  const put = (text: string, size: number, dy: number) => {
    if (!text) return;
    const tw = textWidth(text, size);
    L.texts.push({ p: { x: x + tw / 2, y: base + dy }, angle: 0, text, size, baseline: 'bottom' });
    x += tw;
  };
  put(main, TEXT_H, 0);
  put(sub, subH, subH * 0.35);
  put(rest, TEXT_H, 0);
}

/** Filled arrowhead of a load arrow (bigger than a dimension arrow). */
function loadHead(tip: Vec, dir: Vec, scale = 1): Vec[] {
  const d = unit(dir);
  const n = perp(d);
  const base = add(tip, d, -MECH.HEAD_L * K * scale);
  return [tip, add(base, n, MECH.HEAD_HALF * K * scale), add(base, n, -MECH.HEAD_HALF * K * scale)];
}

/** Ground line across `c` (perpendicular to `down`) with hatching on the far side. */
function ground(L: AnnoLayout, c: Vec, down: Vec, half: number): void {
  const t = perp(down);
  const a = add(c, t, -half);
  const b = add(c, t, half);
  L.lines.push([a, b]);
  const step = MECH.HATCH_GAP * K;
  const n = Math.max(2, Math.floor((2 * half) / step));
  const off = (2 * half - (n - 1) * step) / 2;
  // 45° strokes leaning the same way on every support.
  const slant = unit(add(down, t, -1));
  for (let i = 0; i < n; i++) {
    const q = add(a, t, off + i * step);
    L.lines.push([q, add(q, slant, MECH.HATCH * K * Math.SQRT2)]);
  }
}

function layoutSupport(e: SupportEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const down = { x: Math.cos(e.angle), y: Math.sin(e.angle) };
  const t = perp(down);
  if (e.type === 'hinge') {
    L.arcs.push({ c: e.at, r: MECH.HINGE * K, start: 0, sweep: Math.PI * 2 });
    return L;
  }
  if (e.type === 'clamp') {
    ground(L, e.at, down, (MECH.CLAMP * K) / 2);
    return L;
  }
  // Triangle hanging from a small pin at `at`.
  const pin = MECH.PIN * K;
  const h = MECH.TRI_H * K;
  const half = MECH.TRI_HALF * K;
  const baseC = add(e.at, down, h);
  const bl = add(baseC, t, -half);
  const br = add(baseC, t, half);
  // Legs start on the pin circle.
  const legStart = (q: Vec) => add(e.at, unit({ x: q.x - e.at.x, y: q.y - e.at.y }), pin);
  L.arcs.push({ c: e.at, r: pin, start: 0, sweep: Math.PI * 2 });
  L.lines.push([legStart(bl), bl], [legStart(br), br]);
  if (e.type === 'fixed') {
    ground(L, baseC, down, (MECH.GROUND * K) / 2);
  } else {
    L.lines.push([bl, br]);
    ground(L, add(baseC, down, MECH.ROLLER_GAP * K), down, (MECH.GROUND * K) / 2);
  }
  return L;
}

function layoutForce(e: ForceEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const d = { x: e.at.x - e.p.x, y: e.at.y - e.p.y };
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-6) return L;
  const head = loadHead(e.at, d);
  // Shaft ends at the arrowhead base so the tip stays sharp.
  L.lines.push([e.p, add(e.at, unit(d), -Math.min(len, MECH.HEAD_L * K) * 0.9)]);
  L.fills.push(head);
  // Label beside the tail, off the shaft.
  const side = perp(unit(d));
  const s = side.y > 0 || (Math.abs(side.y) < 1e-9 && side.x < 0) ? { x: -side.x, y: -side.y } : side;
  pushLabel(L, e.label, add(e.p, s, TEXT_GAP * 1.5), add(s, unit(d), -0.6));
  return L;
}

function layoutMoment(e: MomentEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const sign = Math.sign(e.sweep) || 1;
  // Leave room for the arrowhead at the end of the arc.
  const headAng = Math.min(Math.abs(e.sweep) * 0.5, (MECH.HEAD_L * K * 0.9) / Math.max(e.r, 1e-6));
  L.arcs.push({ c: e.c, r: e.r, start: e.start, sweep: e.sweep - sign * headAng });
  const endA = e.start + e.sweep;
  const tip = add(e.c, { x: Math.cos(endA), y: Math.sin(endA) }, e.r);
  // Tangent at the tip in the running direction.
  const tan = { x: -Math.sin(endA) * sign, y: Math.cos(endA) * sign };
  L.fills.push(loadHead(tip, tan));
  L.arcs.push({ c: e.c, r: Math.max(0.35 * K, e.r * 0.06), start: 0, sweep: Math.PI * 2 });
  // Label outside the arc at its tail (the end without arrowhead).
  const out = { x: Math.cos(e.start), y: Math.sin(e.start) };
  pushLabel(L, e.label, add(e.c, out, e.r + TEXT_GAP * 1.5), out);
  return L;
}

function layoutLineLoad(e: LineLoadEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const ab = { x: e.b.x - e.a.x, y: e.b.y - e.a.y };
  const len = Math.hypot(ab.x, ab.y);
  if (len < 1e-6) return L;
  const n = perp(unit(ab));
  const ta = add(e.a, n, e.h);
  const tb = add(e.b, n, e.h);
  L.lines.push([ta, tb]);
  const count = Math.max(2, Math.round(len / (MECH.LOAD_STEP * K)) + 1);
  const down = { x: -n.x * Math.sign(e.h || 1), y: -n.y * Math.sign(e.h || 1) };
  const headScale = Math.min(1, Math.abs(e.h) / (MECH.HEAD_L * K * 1.6)) * 0.8;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const foot = add(e.a, ab, f);
    const top = add(foot, n, e.h);
    L.lines.push([top, add(foot, down, -MECH.HEAD_L * K * headScale * 0.9)]);
    L.fills.push(loadHead(foot, down, headScale));
  }
  const out = { x: -down.x, y: -down.y };
  pushLabel(L, e.label, add(add(ta, ab, 0.5), out, TEXT_GAP * 1.5), out);
  return L;
}

// ---- text ------------------------------------------------------------------------------------

/** Line spacing as a multiple of the letter height (ISO 3098: about 1.43 … 1.6). */
export const LINE_SPACING = 1.6;

function layoutText(e: TextEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const size = e.size * K;
  const r = { x: Math.cos(e.angle), y: Math.sin(e.angle) };
  const below = { x: -r.y, y: r.x };
  // A one-line text can stand for a host value too ("A" → "A = 12 kN").
  const text = e.text.includes('\n') ? e.text : shownLabel(e.text);
  text.split('\n').forEach((line, i) => {
    if (!line) return;
    const w = textWidth(line, size);
    const start = add(e.at, below, i * size * LINE_SPACING);
    L.texts.push({ p: add(start, r, w / 2), angle: e.angle, text: line, size, baseline: 'bottom' });
  });
  return L;
}

// ---- sheets ----------------------------------------------------------------------------------

const PAPER: Record<SheetFormat, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
};

export const SHEET_FORMATS = Object.keys(PAPER) as SheetFormat[];

/** Paper size [width, height] in mm. */
export function paperSize(format: SheetFormat, landscape: boolean): [number, number] {
  const [a, b] = PAPER[format];
  return landscape ? [b, a] : [a, b];
}

/** World box of a sheet. */
export function sheetBox(e: SheetEntity): { minX: number; minY: number; maxX: number; maxY: number } {
  const [w, h] = paperSize(e.format, e.landscape);
  return { minX: e.at.x, minY: e.at.y, maxX: e.at.x + w * e.scale, maxY: e.at.y + h * e.scale };
}

/** "1:2", "1:1", "2:1". */
export function scaleText(k: number): string {
  const f = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
  return k >= 1 ? `1:${f(k)}` : `${f(1 / k)}:1`;
}

/** Wide frame line (ISO 5457: 0.7 mm) as a filled ring around the rectangle. */
function thickRect(L: AnnoLayout, P: (x: number, y: number) => Vec, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const h = w / 2;
  L.fills.push([P(x0 - h, y0 - h), P(x1 + h, y0 - h), P(x1 + h, y1 + h), P(x0 - h, y1 + h)]);
  // Inner outline in the opposite direction makes a hole (nonzero fill).
  L.fills.push([P(x0 + h, y0 + h), P(x0 + h, y1 - h), P(x1 - h, y1 - h), P(x1 - h, y0 + h)]);
}

function bar(L: AnnoLayout, P: (x: number, y: number) => Vec, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const h = w / 2;
  if (x0 === x1) L.fills.push([P(x0 - h, y0), P(x0 + h, y0), P(x0 + h, y1), P(x0 - h, y1)]);
  else L.fills.push([P(x0, y0 - h), P(x1, y0 - h), P(x1, y0 + h), P(x0, y0 + h)]);
}

/** Title block size (ISO 7200: 180 mm wide). */
export const TITLE_W = 180;
export const TITLE_H = 32;

/** Title block cells: [x, y, w, h, label, field] in paper mm relative to the block's top-left. */
export const TITLE_CELLS: [number, number, number, number, string, keyof SheetEntity['fields'] | 'scale' | 'format'][] = [
  [0, 0, 110, 12, 'Benennung', 'title'],
  [110, 0, 70, 12, 'Zeichnungsnummer', 'number'],
  [0, 12, 90, 10, 'Werkstoff', 'material'],
  [90, 12, 45, 10, 'Maßstab', 'scale'],
  [135, 12, 45, 10, 'Format', 'format'],
  [0, 22, 70, 10, 'Gezeichnet', 'drawnBy'],
  [70, 22, 40, 10, 'Datum', 'date'],
  [110, 22, 70, 10, 'Firma', 'company'],
];

function layoutSheet(e: SheetEntity): AnnoLayout {
  const L: AnnoLayout = { lines: [], arcs: [], fills: [], texts: [] };
  const k = e.scale;
  const P = (x: number, y: number): Vec => ({ x: e.at.x + x * k, y: e.at.y + y * k });
  const [W, H] = paperSize(e.format, e.landscape);
  const thick = 0.7;
  // Trimmed sheet edge (thin) and drawing frame: 20 mm filing margin left, 10 mm elsewhere.
  L.lines.push([P(0, 0), P(W, 0)], [P(W, 0), P(W, H)], [P(W, H), P(0, H)], [P(0, H), P(0, 0)]);
  const x0 = 20;
  const y0 = 10;
  const x1 = W - 10;
  const y1 = H - 10;
  thickRect(L, P, x0, y0, x1, y1, thick * k);
  // Centring marks from the sheet edge to 5 mm into the frame.
  bar(L, P, W / 2, 0, W / 2, y0 + 5, thick * k);
  bar(L, P, W / 2, H, W / 2, y1 - 5, thick * k);
  bar(L, P, 5, H / 2, x0 + 5, H / 2, thick * k);
  bar(L, P, W, H / 2, x1 - 5, H / 2, thick * k);
  // Title block in the bottom right corner of the frame.
  const bx = x1 - TITLE_W;
  const by = y1 - TITLE_H;
  thickRect(L, P, bx, by, x1, y1, thick * k);
  const values: Record<string, string> = { ...e.fields, scale: scaleText(k), format: e.format };
  for (const [cx, cy, cw, ch, label, key] of TITLE_CELLS) {
    // Inner cell borders (thin); the outer ones are the thick block border.
    if (cx > 0) L.lines.push([P(bx + cx, by + cy), P(bx + cx, by + cy + ch)]);
    if (cy > 0) L.lines.push([P(bx + cx, by + cy), P(bx + cx + cw, by + cy)]);
    const ls = 1.8;
    L.texts.push({ p: P(bx + cx + 1.2 + textWidth(label, ls) / 2, by + cy + 2.6), angle: 0, text: label, size: ls * k, baseline: 'bottom' });
    const v = values[key] ?? '';
    if (!v) continue;
    let vs = key === 'title' ? 5 : 3.5;
    // Shrink long entries to fit the cell.
    const room = cw - 3;
    if (textWidth(v, vs) > room) vs = Math.max(1.8, (vs * room) / textWidth(v, vs));
    L.texts.push({ p: P(bx + cx + 1.5 + textWidth(v, vs) / 2, by + cy + ch - 2), angle: 0, text: v, size: vs * k, baseline: 'bottom' });
  }
  return L;
}

/** Corners of a text box (for bounds and hit tests). */
export function textCorners(t: AnnoText): Vec[] {
  const w = textWidth(t.text, t.size);
  const r = { x: Math.cos(t.angle), y: Math.sin(t.angle) };
  const up = above(r);
  const origin = t.baseline === 'bottom' ? add(t.p, r, -w / 2) : add(add(t.p, r, -w / 2), up, -t.size / 2);
  const a = origin;
  const b = add(origin, r, w);
  return [a, b, add(b, up, t.size), add(a, up, t.size)];
}

/** Whether p lies on one of the texts of an annotation (inside its box). */
export function insideAnnoText(e: LaidOut, p: Vec): boolean {
  for (const t of layoutAnno(e).texts) {
    const c = textCorners(t);
    let inside = false;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      if (c[i].y > p.y !== c[j].y > p.y && p.x < ((c[j].x - c[i].x) * (p.y - c[i].y)) / (c[j].y - c[i].y) + c[i].x) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** All outline segments of a layout (texts as boxes, arcs flattened) – for hit tests and bounds. */
export function layoutSegments(l: AnnoLayout): [Vec, Vec][] {
  const out: [Vec, Vec][] = [...l.lines];
  for (const a of l.arcs) {
    const n = Math.max(8, Math.ceil(Math.abs(a.sweep) / 0.2));
    let prev = add(a.c, { x: Math.cos(a.start), y: Math.sin(a.start) }, a.r);
    for (let k = 1; k <= n; k++) {
      const t = a.start + (a.sweep * k) / n;
      const q = add(a.c, { x: Math.cos(t), y: Math.sin(t) }, a.r);
      out.push([prev, q]);
      prev = q;
    }
  }
  for (const f of l.fills) for (let i = 0; i < f.length; i++) out.push([f[i], f[(i + 1) % f.length]]);
  for (const t of l.texts) {
    const c = textCorners(t);
    for (let i = 0; i < 4; i++) out.push([c[i], c[(i + 1) % 4]]);
  }
  return out;
}
