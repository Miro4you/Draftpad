import { gearProfile, loopPolyline, signedArea, cycloidProfile, cycloidPoint } from '../src/curves.ts';
const L = gearProfile({ m: 1, z: 20, alpha: 20, x: 0, backlash: 0.1, bore: 5 }, 200);
const a = L.map(l => signedArea(loopPolyline(l, 200)));
console.log('Flächen', a, 'Volumen h=6:', (Math.abs(a[0]) - Math.abs(a[1])) * 6);
// Zahnrad: Kontinuität der Schleife
const segs = L[0]; let maxGap = 0;
const end = (s: any) => s.k==='spline'? s.pts[s.pts.length-1] : s.b; const st = (s: any) => s.k==='spline'? s.pts[0] : s.a;
for (let i = 0; i < segs.length; i++) { const e = end(segs[i]), n = st(segs[(i+1)%segs.length]); maxGap = Math.max(maxGap, Math.hypot(e[0]-n[0], e[1]-n[1])); }
console.log('größte Lücke im Zahnradprofil', maxGap);
// Zykloide: Abstand zu den Bolzen in Grundstellung muss >= Rr sein (berührt mehrere Bolzen)
const p = { R: 30, Rr: 3, E: 1.5, N: 12, bore: 22, holes: 6, holeD: 9, holeR: 17 };
const pts = loopPolyline(cycloidProfile(p, 400)[0]);
let rmin = Infinity, rmax = 0;
for (const q of pts) { const r = Math.hypot(q[0], q[1]); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
console.log('Zykloide r min/max', rmin.toFixed(3), rmax.toFixed(3), 'erwartet', (p.R - p.Rr - p.E), (p.R - p.Rr + p.E));
// Bolzen: Mittelpunkte auf R, Scheibe um E verschoben (Exzenter in +x)
const dists: number[] = [];
for (let k = 0; k < p.N; k++) { const phi = 2*Math.PI*k/p.N; const c = [p.R*Math.cos(phi) - p.E, p.R*Math.sin(phi)];
  let d = Infinity; for (const q of pts) d = Math.min(d, Math.hypot(q[0]-c[0], q[1]-c[1])); dists.push(d - p.Rr); }
console.log('Abstand Bolzen−Scheibe (− = Durchdringung):', dists.map(d=>d.toFixed(3)).join(' '));
