import opencascade from 'replicad-opencascadejs';
import { setOC, assembleWire, makeFace, basicFaceExtrusion, makeBSplineApproximation, Vector } from 'replicad';
import { createRequire } from 'node:module';
import { cycloidPoint } from '../src/curves.ts';
const require = createRequire(import.meta.url);
const oc = await (opencascade as any)({ locateFile: () => require.resolve('replicad-opencascadejs/wasm') });
setOC(oc);
const p = { R: 30, Rr: 3, E: 1.5, N: 12, bore: 0, holes: 0, holeD: 0, holeR: 0 };
const T = (n: string, f: () => any) => { const t = performance.now(); try { const r = f(); console.log(n, 'ok', (performance.now()-t).toFixed(0), 'ms', r?.faces?.length); } catch (e: any) { console.log(n, 'FEHLER', (performance.now()-t).toFixed(0)); } };
const fil = (s: any, r: number) => s.fillet(r, (e: any) => e.either([(f: any) => f.inPlane('XY', 0), (f: any) => f.inPlane('XY', 8)]));
// Variante A: ein Spline je Höcker, Teilung an Spitzen statt Tälern (dort ist die Krümmung kleiner)
for (const [name, offset, n] of [['Täler', 0, 40], ['Spitzen', 0.5, 40], ['halbe Höcker', 0, 80]] as const) {
  const lobes = p.N - 1; const per = name === 'halbe Höcker' ? 2 : 1;
  const edges = [];
  for (let k = 0; k < lobes * per; k++) {
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = ((k + offset + i / 40) * 2 * Math.PI) / (lobes * per); const q = cycloidPoint(p, t); pts.push([q[0], q[1], 0]); }
    edges.push(makeBSplineApproximation(pts as any, { tolerance: 1e-4, degMin: 3, degMax: 5, smoothing: null }));
  }
  const s = basicFaceExtrusion(makeFace(assembleWire(edges)), new Vector([0, 0, 8])) as any;
  T(name + ' r0.8', () => fil(s, 0.8)); T(name + ' r0.3', () => fil(s, 0.3));
}
// Variante B: ein einziger Spline über alles
{
  const pts = []; for (let i = 0; i <= 600; i++) { const q = cycloidPoint(p, (i / 600) * 2 * Math.PI); pts.push([q[0], q[1], 0]); }
  const s = basicFaceExtrusion(makeFace(assembleWire([makeBSplineApproximation(pts as any, { tolerance: 1e-4, degMin: 3, degMax: 8, smoothing: null })])), new Vector([0, 0, 8])) as any;
  T('ein Spline r0.8', () => fil(s, 0.8));
}
