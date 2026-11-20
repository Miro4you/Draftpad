// Aus Skizzenprofilen einen Volumenkörper bauen (OpenCASCADE über replicad).
// Läuft im Web-Worker (Browser) und in Node (Messung).
import {
  assembleWire,
  basicFaceExtrusion,
  makeBSplineApproximation,
  makeFace,
  makeCircle,
  makeLine,
  makeThreePointArc,
  measureVolume,
  Vector,
  type Edge,
  type Shape3D,
} from 'replicad';
import { loopPolyline, orientLoop, pointInPolygon, signedArea, type Loop, type Vec } from './curves';

export interface BuildParams {
  loops: Loop[];
  height: number;
  fillet: number; // Radius an den Deck- und Bodenkanten (0 = keine)
}

export interface BuildResult {
  shape: Shape3D;
  volume: number;
  faces: number;
  times: Record<string, number>;
  warning?: string;
}

const P = (v: Vec): [number, number, number] => [v[0], v[1], 0];

function loopEdges(loop: Loop): Edge[] {
  return loop.map((s) => {
    if (s.k === 'line') return makeLine(P(s.a), P(s.b));
    if (s.k === 'arc') return makeThreePointArc(P(s.a), P(s.m), P(s.b));
    if (s.k === 'circle') return makeCircle(Math.abs(s.r), P(s.c), [0, 0, s.r < 0 ? -1 : 1]);
    return makeBSplineApproximation(s.pts.map(P), { tolerance: 1e-4, degMin: 3, degMax: 5, smoothing: null });
  });
}

/** Schleifen in Außenkonturen mit ihren Löchern einteilen (gerade Schachtelungstiefe = außen). */
export function nestLoops(loops: Loop[]): { outer: Loop; holes: Loop[] }[] {
  const polys = loops.map((l) => loopPolyline(l, 8));
  const area = polys.map((p) => Math.abs(signedArea(p)));
  const depth = polys.map((p, i) => polys.filter((q, j) => j !== i && area[j] > area[i] && pointInPolygon(p[0], q)).length);
  const result: { outer: Loop; holes: Loop[]; idx: number }[] = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) result.push({ outer: l, holes: [], idx: i });
  });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    // kleinstes umschließendes Außenprofil
    const parent = result
      .filter((r) => pointInPolygon(polys[i][0], polys[r.idx]))
      .sort((a, b) => area[a.idx] - area[b.idx])[0];
    parent?.holes.push(l);
  });
  return result;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function buildSolid(p: BuildParams): BuildResult {
  const times: Record<string, number> = {};
  let t = now();
  const groups = nestLoops(p.loops);
  if (!groups.length) throw new Error('Kein geschlossenes Profil');
  let shape: Shape3D | null = null;
  for (const g of groups) {
    const outer = assembleWire(loopEdges(orientLoop(g.outer, true)));
    const holes = g.holes.map((h) => assembleWire(loopEdges(orientLoop(h, false))));
    const face = makeFace(outer, holes);
    const solid = basicFaceExtrusion(face, new Vector([0, 0, p.height])) as unknown as Shape3D;
    shape = shape ? shape.fuse(solid) : solid;
  }
  times.profil_und_extrusion = now() - t;
  let warning: string | undefined;
  if (p.fillet > 0) {
    t = now();
    const h = p.height;
    try {
      shape = shape!.fillet(p.fillet, (e) => e.either([(f) => f.inPlane('XY', 0), (f) => f.inPlane('XY', h)]));
    } catch {
      warning = `Verrunden mit r = ${p.fillet} mm geht hier nicht (Radius größer als eine Kante oder Lücke) – Körper ohne Rundung angezeigt.`;
    }
    times.verrunden = now() - t;
  }
  t = now();
  const volume = measureVolume(shape!);
  times.volumen = now() - t;
  return { shape: shape!, volume, faces: shape!.faces.length, times, warning };
}
