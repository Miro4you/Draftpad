// Kurven und Profile für den CAD-Machbarkeitstest (reine Mathematik, ohne Geometriekern).
// Ein Profil ist eine geschlossene Schleife aus Segmenten in mm (Skizzenebene XY).

export type Vec = [number, number];

export type Segment =
  | { k: 'line'; a: Vec; b: Vec }
  | { k: 'arc'; a: Vec; m: Vec; b: Vec } // Kreisbogen durch drei Punkte
  | { k: 'spline'; pts: Vec[] } // exakte Kurve, wird im Kern als B-Spline angenähert
  | { k: 'circle'; c: Vec; r: number }; // Vollkreis (immer allein in seiner Schleife)

export type Loop = Segment[];

const polar = (r: number, a: number): Vec => [r * Math.cos(a), r * Math.sin(a)];
const inv = (a: number) => Math.tan(a) - a; // Evolventenfunktion

export function segStart(s: Segment): Vec {
  return s.k === 'spline' ? s.pts[0] : s.k === 'circle' ? [s.c[0] + s.r, s.c[1]] : s.a;
}
export function segEnd(s: Segment): Vec {
  return s.k === 'spline' ? s.pts[s.pts.length - 1] : s.k === 'circle' ? [s.c[0] + s.r, s.c[1]] : s.b;
}

// ---------------------------------------------------------------------------------------------
// Evolventen-Stirnrad (außenverzahnt) nach DIN 867 Bezugsprofil
// ---------------------------------------------------------------------------------------------

export interface GearParams {
  m: number; // Modul
  z: number; // Zähnezahl
  alpha: number; // Eingriffswinkel in Grad (20)
  x: number; // Profilverschiebungsfaktor
  backlash: number; // Flankenspiel (Zahndicke wird je Flanke um backlash/2 verringert), mm
  bore: number; // Bohrung Ø (0 = keine)
}

export interface GearInfo {
  d: number; // Teilkreis
  da: number; // Kopfkreis
  df: number; // Fußkreis
  db: number; // Grundkreis
  sa: number; // Zahndicke am Kopf
  undercut: boolean; // z kleiner als Grenzzähnezahl (Unterschnitt wird hier nicht nachgebildet)
}

export function gearInfo(p: GearParams): GearInfo {
  const a = (p.alpha * Math.PI) / 180;
  const r = (p.m * p.z) / 2;
  const rb = r * Math.cos(a);
  const ra = r + p.m * (1 + p.x);
  const rf = r - p.m * (1.25 - p.x);
  const psiB = halfAngleBase(p);
  const aa = Math.acos(rb / ra);
  const sa = 2 * ra * (psiB - inv(aa));
  const zmin = (2 * (1 - p.x)) / Math.sin(a) ** 2;
  return { d: 2 * r, da: 2 * ra, df: 2 * rf, db: 2 * rb, sa, undercut: p.z < zmin };
}

// halber Zahnwinkel am Grundkreis (Winkel von Zahnmitte bis Flankenbeginn auf dem Grundkreis)
function halfAngleBase(p: GearParams): number {
  const a = (p.alpha * Math.PI) / 180;
  const r = (p.m * p.z) / 2;
  const s = p.m * (Math.PI / 2 + 2 * p.x * Math.tan(a)) - p.backlash; // Zahndicke am Teilkreis
  return s / (2 * r) + inv(a);
}

export function gearProfile(p: GearParams, samples = 24): Loop[] {
  const a = (p.alpha * Math.PI) / 180;
  const r = (p.m * p.z) / 2;
  const rb = r * Math.cos(a);
  const ra = r + p.m * (1 + p.x);
  const rf = r - p.m * (1.25 - p.x);
  const psiB = halfAngleBase(p);
  const r0 = Math.max(rb, rf); // Flankenbeginn
  // Zahndicke am Kopf muss positiv sein, sonst ist der Zahn spitz
  if (psiB - inv(Math.acos(rb / ra)) <= 0) throw new Error('Zahn wird spitz – Kopfkreis/Profilverschiebung prüfen');
  const step = (2 * Math.PI) / p.z;
  // Flankenwinkel relativ zur Zahnmitte bei Radius rr
  const flankAngle = (rr: number) => psiB - inv(Math.acos(Math.min(1, rb / rr)));
  const flank = (center: number, sign: 1 | -1, from: number, to: number): Vec[] => {
    const pts: Vec[] = [];
    // gleichmäßig im Abrollwinkel abtasten (dichter am Grundkreis, wo die Krümmung groß ist)
    const t0 = Math.sqrt(Math.max(0, (from / rb) ** 2 - 1));
    const t1 = Math.sqrt(Math.max(0, (to / rb) ** 2 - 1));
    for (let i = 0; i <= samples; i++) {
      const t = t0 + ((t1 - t0) * i) / samples;
      const rr = rb * Math.sqrt(1 + t * t);
      pts.push(polar(rr, center + sign * flankAngle(rr)));
    }
    return pts;
  };
  const loop: Loop = [];
  for (let i = 0; i < p.z; i++) {
    const c = i * step;
    const lo = flankAngle(r0); // Winkel des Flankenfußes
    const tip = flankAngle(ra);
    // rechte Flanke (im Uhrzeigersinn vor der Zahnmitte) von unten nach oben
    loop.push({ k: 'spline', pts: flank(c, -1, r0, ra) });
    loop.push({ k: 'arc', a: polar(ra, c - tip), m: polar(ra, c), b: polar(ra, c + tip) });
    loop.push({ k: 'spline', pts: flank(c, 1, ra, r0) });
    // Fuß: radial bis zum Fußkreis (Unterschnitt/Trochoide nicht nachgebildet), Fußkreisbogen, radial hoch
    const n = c + step;
    if (rf < rb - 1e-9) loop.push({ k: 'line', a: polar(r0, c + lo), b: polar(rf, c + lo) });
    loop.push({ k: 'arc', a: polar(rf, c + lo), m: polar(rf, c + step / 2), b: polar(rf, n - lo) });
    if (rf < rb - 1e-9) loop.push({ k: 'line', a: polar(rf, n - lo), b: polar(r0, n - lo) });
  }
  const loops: Loop[] = [loop];
  if (p.bore > 0) loops.push(circleLoop([0, 0], p.bore / 2));
  return loops;
}

// ---------------------------------------------------------------------------------------------
// Zykloidenscheibe (Zykloidgetriebe) – Äquidistante der verkürzten Epizykloide
// ---------------------------------------------------------------------------------------------

export interface CycloidParams {
  R: number; // Radius des Bolzenkreises
  Rr: number; // Bolzenradius
  E: number; // Exzentrizität
  N: number; // Anzahl Bolzen (Scheibe hat N−1 Höcker)
  bore: number; // Bohrung Ø für das Exzenterlager
  holes: number; // Anzahl Abtriebsbohrungen (0 = keine)
  holeD: number; // Ø Abtriebsbohrung (= Abtriebsbolzen + 2·E)
  holeR: number; // Lochkreisradius
}

export function cycloidPoint(p: CycloidParams, t: number): Vec {
  const { R, Rr, E, N } = p;
  const psi = Math.atan2(Math.sin((1 - N) * t), R / (E * N) - Math.cos((1 - N) * t));
  return [R * Math.cos(t) - Rr * Math.cos(t + psi) - E * Math.cos(N * t), -R * Math.sin(t) + Rr * Math.sin(t + psi) + E * Math.sin(N * t)];
}

export function cycloidCheck(p: CycloidParams): string[] {
  const warn: string[] = [];
  if (p.E * p.N >= p.R) warn.push('E·N muss kleiner als R sein');
  // Krümmungsradius der Grundkurve (verkürzte Epizykloide) muss größer als der Bolzenradius sein
  let rhoMin = Infinity;
  const h = 1e-4;
  const base = (t: number): Vec => {
    const q = { ...p, Rr: 0 };
    return cycloidPoint(q, t);
  };
  for (let i = 0; i < 2000; i++) {
    const t = (2 * Math.PI * i) / 2000;
    const a = base(t - h), b = base(t), c = base(t + h);
    const dx = (c[0] - a[0]) / (2 * h), dy = (c[1] - a[1]) / (2 * h);
    const ddx = (c[0] - 2 * b[0] + a[0]) / (h * h), ddy = (c[1] - 2 * b[1] + a[1]) / (h * h);
    const k = (dx * ddy - dy * ddx) / Math.pow(dx * dx + dy * dy, 1.5);
    if (k < 0) rhoMin = Math.min(rhoMin, 1 / -k); // konkave Stellen (Täler)
  }
  if (p.Rr >= rhoMin) warn.push(`Bolzenradius zu groß: Kurve schneidet sich (max. ${rhoMin.toFixed(2)} mm)`);
  return warn;
}

export function cycloidProfile(p: CycloidParams, perLobe = 40): Loop[] {
  const lobes = p.N - 1;
  const loop: Loop = [];
  for (let k = 0; k < lobes; k++) {
    const pts: Vec[] = [];
    for (let i = 0; i <= perLobe; i++) {
      const t = ((k + i / perLobe) * 2 * Math.PI) / lobes;
      pts.push(cycloidPoint(p, t));
    }
    loop.push({ k: 'spline', pts });
  }
  // Spline-Enden exakt zusammenführen
  for (let k = 0; k < lobes; k++) {
    const s = loop[k] as { k: 'spline'; pts: Vec[] };
    const n = loop[(k + 1) % lobes] as { k: 'spline'; pts: Vec[] };
    n.pts[0] = s.pts[s.pts.length - 1];
  }
  const loops: Loop[] = [loop];
  if (p.bore > 0) loops.push(circleLoop([0, 0], p.bore / 2));
  for (let i = 0; i < p.holes; i++) loops.push(circleLoop(polar(p.holeR, (2 * Math.PI * i) / p.holes), p.holeD / 2));
  return loops;
}

// ---------------------------------------------------------------------------------------------
// Formelkurve x(t), y(t) – für alles, wofür es kein eigenes Werkzeug gibt
// ---------------------------------------------------------------------------------------------

export interface FormulaParams {
  x: string;
  y: string;
  t0: number;
  t1: number;
  vars: Record<string, number>;
  samples: number;
}

export function formulaPoints(p: FormulaParams): Vec[] {
  const names = Object.keys(p.vars);
  const mathNames = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs', 'pow', 'exp', 'log', 'PI', 'min', 'max', 'sign', 'floor'];
  const body = (e: string) => `"use strict"; return (${e.replace(/\^/g, '**').replace(/\bpi\b/g, 'PI')});`;
  const fx = new Function('t', ...names, ...mathNames, body(p.x));
  const fy = new Function('t', ...names, ...mathNames, body(p.y));
  const mvals = mathNames.map((n) => (Math as unknown as Record<string, unknown>)[n]);
  const vvals = names.map((n) => p.vars[n]);
  const pts: Vec[] = [];
  for (let i = 0; i <= p.samples; i++) {
    const t = p.t0 + ((p.t1 - p.t0) * i) / p.samples;
    const x = fx(t, ...vvals, ...mvals), y = fy(t, ...vvals, ...mvals);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Formel liefert keinen Wert bei t = ${t.toFixed(3)}`);
    pts.push([x, y]);
  }
  return pts;
}

/** Formelkurve als geschlossenes Profil; offene Kurven werden mit einer Geraden geschlossen. */
export function formulaProfile(p: FormulaParams): Loop[] {
  const pts = formulaPoints(p);
  const a = pts[0], b = pts[pts.length - 1];
  const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  // in mehrere Splines teilen (stabilere Annäherung, Ecken bleiben erhalten)
  const parts = Math.max(1, Math.round(p.samples / 60));
  const loop: Loop = [];
  const per = Math.ceil((pts.length - 1) / parts);
  for (let i = 0; i < pts.length - 1; i += per) loop.push({ k: 'spline', pts: pts.slice(i, Math.min(pts.length, i + per + 1)) });
  if (closed) {
    const last = loop[loop.length - 1] as { k: 'spline'; pts: Vec[] };
    last.pts[last.pts.length - 1] = a;
  } else loop.push({ k: 'line', a: b, b: a });
  return [loop];
}

// ---------------------------------------------------------------------------------------------
// Grundformen
// ---------------------------------------------------------------------------------------------

export function circleLoop(c: Vec, r: number): Loop {
  return [{ k: 'circle', c, r }];
}

export function polyLoop(pts: Vec[]): Loop {
  return pts.map((a, i) => ({ k: 'line' as const, a, b: pts[(i + 1) % pts.length] }));
}

/** Punkte entlang einer Schleife (für die 2D-Anzeige und den Flächeninhalt). */
export function loopPolyline(loop: Loop, arcSteps = 16): Vec[] {
  const out: Vec[] = [];
  for (const s of loop) {
    if (s.k === 'line') out.push(s.a);
    else if (s.k === 'spline') out.push(...s.pts.slice(0, -1));
    else if (s.k === 'circle') for (let i = 0; i < arcSteps * 4; i++) out.push(polar(Math.abs(s.r), (Math.sign(s.r) * i * 2 * Math.PI) / (arcSteps * 4)).map((v, j) => v + s.c[j]) as Vec);
    else out.push(...arcPoints(s.a, s.m, s.b, arcSteps).slice(0, -1));
  }
  return out;
}

export function arcPoints(a: Vec, m: Vec, b: Vec, steps: number): Vec[] {
  const c = circumcenter(a, m, b);
  if (!c) return [a, b];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ang = (p: Vec) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  let sweep = ang(b) - a0;
  let mid = ang(m) - a0;
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  sweep = norm(sweep);
  mid = norm(mid);
  if (mid > sweep) sweep -= 2 * Math.PI; // Bogen läuft andersherum
  if (Math.abs(sweep) < 1e-12) sweep = 2 * Math.PI;
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i++) out.push([c[0] + r * Math.cos(a0 + (sweep * i) / steps), c[1] + r * Math.sin(a0 + (sweep * i) / steps)]);
  return out;
}

export function circumcenter(a: Vec, b: Vec, c: Vec): Vec | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

export function signedArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Umlaufrichtung umkehren. */
export function reverseLoop(loop: Loop): Loop {
  return loop
    .slice()
    .reverse()
    .map((s): Segment => {
      if (s.k === 'line') return { k: 'line', a: s.b, b: s.a };
      if (s.k === 'arc') return { k: 'arc', a: s.b, m: s.m, b: s.a };
      if (s.k === 'spline') return { k: 'spline', pts: s.pts.slice().reverse() };
      return { k: 'circle', c: s.c, r: -s.r }; // negatives r = im Uhrzeigersinn
    });
}

/** Gegen den Uhrzeigersinn (ccw = true) bzw. im Uhrzeigersinn ausrichten. */
export function orientLoop(loop: Loop, ccw: boolean): Loop {
  if (loop.length === 1 && loop[0].k === 'circle') {
    const c = loop[0];
    return [{ k: 'circle', c: c.c, r: ccw ? Math.abs(c.r) : -Math.abs(c.r) }];
  }
  const a = signedArea(loopPolyline(loop, 8));
  return a > 0 === ccw ? loop : reverseLoop(loop);
}
