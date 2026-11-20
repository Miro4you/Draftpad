// Messung in Node: Kern laden, Profile bauen, verrunden, vernetzen, STEP/STL schreiben.
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { gearProfile, gearInfo, cycloidProfile, cycloidCheck, formulaProfile, polyLoop, circleLoop } from '../src/curves.ts';
import { buildSolid } from '../src/model.ts';

const require = createRequire(import.meta.url);
const wasm = require.resolve('replicad-opencascadejs/wasm');
let t = performance.now();
const oc = await (opencascade as any)({ locateFile: () => wasm });
setOC(oc);
console.log(`Kern laden: ${(performance.now() - t).toFixed(0)} ms`);

const cases: [string, any][] = [
  ['Platte mit Bohrungen', { loops: [polyLoop([[0,0],[80,0],[80,40],[0,40]]), circleLoop([20,20],4), circleLoop([60,20],4)], height: 8, fillet: 1 }],
  ['Zahnrad m1 z20', { loops: gearProfile({ m: 1, z: 20, alpha: 20, x: 0, backlash: 0.1, bore: 5 }), height: 6, fillet: 0 }],
  ['Zahnrad m1 z20 + Fase-Radius', { loops: gearProfile({ m: 1, z: 20, alpha: 20, x: 0, backlash: 0.1, bore: 5 }), height: 6, fillet: 0.2 }],
  ['Zahnrad m1 z80', { loops: gearProfile({ m: 1, z: 80, alpha: 20, x: 0, backlash: 0.1, bore: 8 }), height: 6, fillet: 0 }],
  ['Zykloidenscheibe N=12', { loops: cycloidProfile({ R: 30, Rr: 3, E: 1.5, N: 12, bore: 22, holes: 6, holeD: 9, holeR: 17 }), height: 8, fillet: 0 }],
  ['Formelkurve Rosette', { loops: formulaProfile({ x: '(a + b*cos(n*t))*cos(t)', y: '(a + b*cos(n*t))*sin(t)', t0: 0, t1: 2*Math.PI, vars: { a: 20, b: 4, n: 7 }, samples: 420 }), height: 5, fillet: 0.5 }],
];
console.log(gearInfo({ m: 1, z: 20, alpha: 20, x: 0, backlash: 0.1, bore: 5 }));
console.log('Zykloide:', cycloidCheck({ R: 30, Rr: 3, E: 1.5, N: 12, bore: 22, holes: 6, holeD: 9, holeR: 17 }));
for (const [name, p] of cases) {
  try {
    t = performance.now();
    const r = buildSolid(p);
    const t1 = performance.now();
    const m = r.shape.mesh({ tolerance: 0.02, angularTolerance: 0.2 });
    const t2 = performance.now();
    const step = await r.shape.blobSTEP().arrayBuffer();
    const t3 = performance.now();
    const stl = await r.shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 } as any).arrayBuffer();
    const t4 = performance.now();
    const fn = name.replace(/\W+/g, '_');
    writeFileSync(`bench/out_${fn}.step`, Buffer.from(step));
    console.log(`${name.padEnd(30)} Körper ${(t1-t).toFixed(0).padStart(5)} ms  Netz ${(t2-t1).toFixed(0).padStart(4)} ms (${m.triangles.length/3} Dreiecke)  STEP ${(t3-t2).toFixed(0).padStart(4)} ms (${(step.byteLength/1024).toFixed(0)} kB)  STL ${(t4-t3).toFixed(0)} ms  V=${r.volume.toFixed(1)} mm³  Flächen ${r.faces}  ${JSON.stringify(Object.fromEntries(Object.entries(r.times).map(([k,v])=>[k,Math.round(v)])))}`);
  } catch (e) { console.log(name, 'FEHLER', (e as Error).message ?? e); }
}
