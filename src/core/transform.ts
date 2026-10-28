import { sheetBox, textWidth } from './annotations';
import type { Vec } from './geom';
import type { Entity } from './types';

/** Affine map x' = a·x + c·y + e, y' = b·x + d·y + f (same layout as DOMMatrix / canvas). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function applyAffine(m: Affine, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** m ∘ n: first n, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function translation(dx: number, dy: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

/** Rotation by `angle` radians (world coordinates, positive = clockwise on screen) around `center`. */
export function rotation(center: Vec, angle: number): Affine {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: center.x - cos * center.x + sin * center.y,
    f: center.y - sin * center.x - cos * center.y,
  };
}

/** Reflection across the infinite line through p and q. */
export function reflection(p: Vec, q: Vec): Affine {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const l2 = dx * dx + dy * dy || 1;
  const a = (dx * dx - dy * dy) / l2;
  const b = (2 * dx * dy) / l2;
  // Linear part [[a, b], [b, -a]], chosen so that p stays fixed.
  return { a, b, c: b, d: -a, e: p.x - a * p.x - b * p.y, f: p.y - b * p.x + a * p.y };
}

export function det(m: Affine): number {
  return m.a * m.d - m.b * m.c;
}

/** Map an angle (radians) through the linear part of m. */
function mapAngle(m: Affine, angle: number): number {
  const x = Math.cos(angle);
  const y = Math.sin(angle);
  return Math.atan2(m.b * x + m.d * y, m.a * x + m.c * y);
}

/**
 * Apply a rigid transform (translation, rotation, reflection) to an entity.
 * Pass `id` to create a copy with a new id.
 */
export function transformEntity<T extends Entity>(e: T, m: Affine, id: string = e.id): T {
  switch (e.kind) {
    case 'line':
      return { ...e, id, a: applyAffine(m, e.a), b: applyAffine(m, e.b) };
    case 'stroke': {
      const pts = new Array<number>(e.pts.length);
      for (let i = 0; i < e.pts.length; i += 2) {
        const x = e.pts[i];
        const y = e.pts[i + 1];
        pts[i] = m.a * x + m.c * y + m.e;
        pts[i + 1] = m.b * x + m.d * y + m.f;
      }
      return { ...e, id, pts };
    }
    case 'circle':
      return { ...e, id, c: applyAffine(m, e.c) };
    case 'arc': {
      const flip = det(m) < 0;
      return { ...e, id, c: applyAffine(m, e.c), start: mapAngle(m, e.start), sweep: flip ? -e.sweep : e.sweep };
    }
    case 'hatch': {
      const loops = e.loops.map((l) => {
        const out = new Array<number>(l.length);
        for (let i = 0; i < l.length; i += 2) {
          out[i] = m.a * l[i] + m.c * l[i + 1] + m.e;
          out[i + 1] = m.b * l[i] + m.d * l[i + 1] + m.f;
        }
        return out;
      });
      const rad = (e.angle * Math.PI) / 180;
      return { ...e, id, loops, angle: (mapAngle(m, rad) * 180) / Math.PI };
    }
    case 'dim': {
      const flip = det(m) < 0;
      return {
        ...e,
        id,
        p1: applyAffine(m, e.p1),
        p2: applyAffine(m, e.p2),
        ...(e.p3 ? { p3: applyAffine(m, e.p3) } : {}),
        ...(e.dir !== undefined ? { dir: mapAngle(m, e.dir) } : {}),
        off: e.type === 'lin' && flip ? -e.off : e.off,
        // Mirroring reverses the arc of angular dimensions.
        ...(e.type === 'ang' && flip && e.tpos !== undefined ? { tpos: -e.tpos } : {}),
      };
    }
    case 'datum':
    case 'gtol':
    case 'force':
      return { ...e, id, at: applyAffine(m, e.at), p: applyAffine(m, e.p) };
    case 'support':
      return { ...e, id, at: applyAffine(m, e.at), angle: mapAngle(m, e.angle) };
    case 'moment':
      // Mirroring reverses the turning direction.
      return { ...e, id, c: applyAffine(m, e.c), start: mapAngle(m, e.start), sweep: det(m) < 0 ? -e.sweep : e.sweep };
    case 'lineload':
      // The load stays on the same side of the feature when mirrored.
      return { ...e, id, a: applyAffine(m, e.a), b: applyAffine(m, e.b), h: det(m) < 0 ? -e.h : e.h };
    case 'text': {
      let angle = mapAngle(m, e.angle);
      let at = applyAffine(m, e.at);
      if (det(m) < 0) {
        // Mirrored text stays readable: start from the mirrored end of the first line.
        const w = textWidth(e.text.split('\n')[0] ?? '', e.size);
        at = { x: at.x + Math.cos(angle) * w, y: at.y + Math.sin(angle) * w };
        angle += Math.PI;
      }
      return { ...e, id, at, angle: Math.atan2(Math.sin(angle), Math.cos(angle)) };
    }
    case 'sheet': {
      // Sheets stay upright: only their centre moves.
      const b = sheetBox(e);
      const c = applyAffine(m, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      return { ...e, id, at: { x: c.x - (b.maxX - b.minX) / 2, y: c.y - (b.maxY - b.minY) / 2 } };
    }
  }
}

function sameAffine(m: Affine, n: Affine): boolean {
  const eps = 1e-7;
  return (
    Math.abs(m.a - n.a) < eps &&
    Math.abs(m.b - n.b) < eps &&
    Math.abs(m.c - n.c) < eps &&
    Math.abs(m.d - n.d) < eps &&
    Math.abs(m.e - n.e) < 1e-5 &&
    Math.abs(m.f - n.f) < 1e-5
  );
}

/**
 * All copies produced by mirroring across the given axes (without the identity).
 * Two perpendicular axes give the three copies of the other quadrants; axes at
 * 60° or 45° give the full dihedral pattern. If the axes would generate an endless
 * pattern (odd angles), only the single reflections are used.
 */
export function mirrorGroup(axes: [Vec, Vec][], cap = 16): Affine[] {
  const gens = axes.map(([p, q]) => reflection(p, q));
  const unique: Affine[] = [];
  for (const g of gens) if (!unique.some((u) => sameAffine(u, g))) unique.push(g);
  if (unique.length === 0) return [];
  const group: Affine[] = [IDENTITY];
  const queue: Affine[] = [IDENTITY];
  while (queue.length) {
    const m = queue.shift()!;
    for (const g of unique) {
      const n = compose(g, m);
      if (group.some((x) => sameAffine(x, n))) continue;
      group.push(n);
      queue.push(n);
      if (group.length > cap) return unique;
    }
  }
  return group.slice(1);
}
