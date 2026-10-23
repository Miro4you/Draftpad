import type { Vec } from './geom';

/**
 * Standard parts drawn from size tables. Each part is generated as simple
 * primitives in local coordinates (mm): side views have the part's axis along +x
 * through the origin, top views are centred on the origin. The placing tool
 * rotates and moves them and turns them into ordinary lines, circles and arcs.
 *
 * The table values follow the usual standards (ISO 273, ISO 261, ISO 4762,
 * ISO 4017, ISO 4032, DIN 625, DIN 471/472) – check critical sizes against the
 * standard sheet.
 */

/** thick = visible edge (current pen), thin = thread/auxiliary line, center = centre line. */
export type PrimStyle = 'thick' | 'thin' | 'center';

export type PartPrim =
  | { t: 'line'; a: Vec; b: Vec; s: PrimStyle }
  | { t: 'circle'; c: Vec; r: number; s: PrimStyle }
  | { t: 'arc'; c: Vec; r: number; start: number; sweep: number; s: PrimStyle };

export type PartKind = 'hole' | 'tapped' | 'socketScrew' | 'hexScrew' | 'nut' | 'bearing' | 'grooveShaft' | 'grooveBore';
export type PartView = 'side' | 'top';

export interface PartSpec {
  kind: PartKind;
  size: string;
  view: PartView;
  /** Screw length, hole depth or thread depth (mm). */
  length: number;
  /** Insertion angle in degrees (counter-clockwise on the paper); null/missing = free (drag to turn). */
  angle?: number | null;
}

/** Insertion angles offered for parts (null = free). */
export const PART_ANGLES: (number | null)[] = [0, 45, 90, 135, 180, null];

// ---- tables ------------------------------------------------------------------------------

const METRIC = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20'] as const;
type Metric = (typeof METRIC)[number];

/** Nominal diameter and coarse pitch (ISO 261). */
const THREAD: Record<Metric, { d: number; p: number }> = {
  M3: { d: 3, p: 0.5 },
  M4: { d: 4, p: 0.7 },
  M5: { d: 5, p: 0.8 },
  M6: { d: 6, p: 1 },
  M8: { d: 8, p: 1.25 },
  M10: { d: 10, p: 1.5 },
  M12: { d: 12, p: 1.75 },
  M16: { d: 16, p: 2 },
  M20: { d: 20, p: 2.5 },
};

/** Clearance holes, medium series (ISO 273). */
const CLEARANCE: Record<Metric, number> = { M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M16: 17.5, M20: 22 };

/** Socket head cap screws ISO 4762: head diameter dk, head height k, socket size s. */
const SOCKET: Record<Metric, { dk: number; k: number; s: number }> = {
  M3: { dk: 5.5, k: 3, s: 2.5 },
  M4: { dk: 7, k: 4, s: 3 },
  M5: { dk: 8.5, k: 5, s: 4 },
  M6: { dk: 10, k: 6, s: 5 },
  M8: { dk: 13, k: 8, s: 6 },
  M10: { dk: 16, k: 10, s: 8 },
  M12: { dk: 18, k: 12, s: 10 },
  M16: { dk: 24, k: 16, s: 14 },
  M20: { dk: 30, k: 20, s: 17 },
};

/** Hexagon heads ISO 4017 (width across flats s, head height k) and nuts ISO 4032 (height m). */
const HEX: Record<Metric, { s: number; k: number; m: number }> = {
  M3: { s: 5.5, k: 2, m: 2.4 },
  M4: { s: 7, k: 2.8, m: 3.2 },
  M5: { s: 8, k: 3.5, m: 4.7 },
  M6: { s: 10, k: 4, m: 5.2 },
  M8: { s: 13, k: 5.3, m: 6.8 },
  M10: { s: 16, k: 6.4, m: 8.4 },
  M12: { s: 18, k: 7.5, m: 10.8 },
  M16: { s: 24, k: 10, m: 14.8 },
  M20: { s: 30, k: 12.5, m: 18 },
};

/** Deep groove ball bearings (DIN 625): bore d, outside D, width B. */
const BEARINGS: Record<string, { d: number; D: number; B: number }> = {
  '6000': { d: 10, D: 26, B: 8 },
  '6001': { d: 12, D: 28, B: 8 },
  '6002': { d: 15, D: 32, B: 9 },
  '6003': { d: 17, D: 35, B: 10 },
  '6004': { d: 20, D: 42, B: 12 },
  '6005': { d: 25, D: 47, B: 12 },
  '6006': { d: 30, D: 55, B: 13 },
  '6007': { d: 35, D: 62, B: 14 },
  '6008': { d: 40, D: 68, B: 15 },
  '6010': { d: 50, D: 80, B: 16 },
  '6200': { d: 10, D: 30, B: 9 },
  '6201': { d: 12, D: 32, B: 10 },
  '6202': { d: 15, D: 35, B: 11 },
  '6203': { d: 17, D: 40, B: 12 },
  '6204': { d: 20, D: 47, B: 14 },
  '6205': { d: 25, D: 52, B: 15 },
  '6206': { d: 30, D: 62, B: 16 },
  '6207': { d: 35, D: 72, B: 17 },
  '6208': { d: 40, D: 80, B: 18 },
  '6210': { d: 50, D: 90, B: 20 },
};

/** Retaining ring grooves: shaft DIN 471 / bore DIN 472 – groove diameter d2 and width m. */
const GROOVE_SHAFT: Record<string, { d2: number; m: number }> = {
  '10': { d2: 9.6, m: 1.1 },
  '12': { d2: 11.5, m: 1.1 },
  '15': { d2: 14.3, m: 1.1 },
  '17': { d2: 16.2, m: 1.1 },
  '20': { d2: 19, m: 1.3 },
  '25': { d2: 23.9, m: 1.3 },
  '30': { d2: 28.6, m: 1.6 },
  '35': { d2: 33, m: 1.6 },
  '40': { d2: 37.5, m: 1.85 },
  '50': { d2: 47, m: 2.15 },
};
const GROOVE_BORE: Record<string, { d2: number; m: number }> = {
  '20': { d2: 21, m: 1.1 },
  '25': { d2: 26.2, m: 1.3 },
  '30': { d2: 31.4, m: 1.3 },
  '35': { d2: 37, m: 1.6 },
  '40': { d2: 42.5, m: 1.85 },
  '47': { d2: 49.5, m: 1.85 },
  '52': { d2: 55, m: 2.15 },
  '62': { d2: 65, m: 2.15 },
};

export interface PartInfo {
  name: string;
  sizes: string[];
  views: PartView[];
  /** Label of the length parameter, if any, and the offered values. */
  length?: { label: string; values: number[]; def: (size: string) => number };
  /** Size label prefix shown in the dialog. */
  sizeLabel: string;
}

const SCREW_LENGTHS = [6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100];

export const PARTS: Record<PartKind, PartInfo> = {
  hole: {
    name: 'Durchgangsbohrung',
    sizes: [...METRIC],
    views: ['top', 'side'],
    sizeLabel: 'für Schraube',
    length: { label: 'Tiefe', values: [5, 8, 10, 15, 20, 30], def: () => 10 },
  },
  tapped: {
    name: 'Gewindebohrung',
    sizes: [...METRIC],
    views: ['top', 'side'],
    sizeLabel: 'Gewinde',
    length: { label: 'Gewindetiefe', values: [5, 8, 10, 12, 16, 20, 25], def: (s) => Math.round(THREAD[s as Metric].d * 1.5) },
  },
  socketScrew: {
    name: 'Zylinderschraube ISO 4762',
    sizes: [...METRIC],
    views: ['side', 'top'],
    sizeLabel: 'Gewinde',
    length: { label: 'Länge', values: SCREW_LENGTHS, def: (s) => Math.min(100, THREAD[s as Metric].d * 3) },
  },
  hexScrew: {
    name: 'Sechskantschraube ISO 4017',
    sizes: [...METRIC],
    views: ['side', 'top'],
    sizeLabel: 'Gewinde',
    length: { label: 'Länge', values: SCREW_LENGTHS, def: (s) => Math.min(100, THREAD[s as Metric].d * 3) },
  },
  nut: { name: 'Sechskantmutter ISO 4032', sizes: [...METRIC], views: ['top', 'side'], sizeLabel: 'Gewinde' },
  bearing: { name: 'Rillenkugellager DIN 625', sizes: Object.keys(BEARINGS), views: ['side', 'top'], sizeLabel: 'Lager' },
  grooveShaft: { name: 'Nut Sicherungsring Welle DIN 471', sizes: Object.keys(GROOVE_SHAFT), views: ['side'], sizeLabel: 'Wellen-Ø' },
  grooveBore: { name: 'Nut Sicherungsring Bohrung DIN 472', sizes: Object.keys(GROOVE_BORE), views: ['side'], sizeLabel: 'Bohrungs-Ø' },
};

/** Short description, e.g. "Zylinderschraube ISO 4762 M8×30". */
export function partLabel(spec: PartSpec): string {
  const info = PARTS[spec.kind];
  const len = spec.kind === 'socketScrew' || spec.kind === 'hexScrew' ? `×${spec.length}` : '';
  const size = spec.kind === 'bearing' ? spec.size : spec.kind.startsWith('groove') ? `Ø${spec.size}` : spec.size;
  return `${info.name} ${size}${len}`;
}

/** Bearing dimensions (d, D, B) for a designation. */
export function bearingSize(name: string): { d: number; D: number; B: number } | undefined {
  return BEARINGS[name];
}

// ---- geometry helpers ------------------------------------------------------------------

const v = (x: number, y: number): Vec => ({ x, y });

class Builder {
  out: PartPrim[] = [];
  line(x1: number, y1: number, x2: number, y2: number, s: PrimStyle = 'thick'): this {
    this.out.push({ t: 'line', a: v(x1, y1), b: v(x2, y2), s });
    return this;
  }
  /** Same line mirrored about the x axis as well (side views of round parts). */
  pair(x1: number, y1: number, x2: number, y2: number, s: PrimStyle = 'thick'): this {
    this.line(x1, y1, x2, y2, s);
    return this.line(x1, -y1, x2, -y2, s);
  }
  circle(r: number, s: PrimStyle = 'thick', c = v(0, 0)): this {
    this.out.push({ t: 'circle', c, r, s });
    return this;
  }
  arc(r: number, start: number, sweep: number, s: PrimStyle = 'thin', c = v(0, 0)): this {
    this.out.push({ t: 'arc', c, r, start, sweep, s });
    return this;
  }
  /** Centre cross for a top view of radius r. */
  cross(r: number): this {
    const e = r + Math.max(2, r * 0.25);
    return this.line(-e, 0, e, 0, 'center').line(0, -e, 0, e, 'center');
  }
  /** Centre line along the axis from x0 to x1 (overhanging a little). */
  axis(x0: number, x1: number): this {
    return this.line(x0 - 2, 0, x1 + 2, 0, 'center');
  }
  /** Regular hexagon with width across flats s (flats top and bottom). */
  hexagon(s: number): this {
    const R = s / Math.sqrt(3);
    const pts = [0, 1, 2, 3, 4, 5].map((i) => v(R * Math.cos((i * Math.PI) / 3), R * Math.sin((i * Math.PI) / 3)));
    pts.forEach((p, i) => this.line(p.x, p.y, pts[(i + 1) % 6].x, pts[(i + 1) % 6].y));
    return this;
  }
  /** 3/4 thread circle (ISO 6410), open in the upper right quadrant. */
  thread(d: number): this {
    return this.arc(d / 2, 0.08, Math.PI * 1.5 - 0.16, 'thin');
  }
}

/** Minor (core) diameter used for drawing threads. */
function minor(m: Metric): number {
  const t = THREAD[m];
  return t.d - 1.2269 * t.p;
}

// ---- parts -----------------------------------------------------------------------------------

/** Primitives of a part in local coordinates. */
export function partGeometry(spec: PartSpec): PartPrim[] {
  const g = new Builder();
  const L = spec.length;
  switch (spec.kind) {
    case 'hole': {
      const r = CLEARANCE[spec.size as Metric] / 2;
      if (spec.view === 'top') g.circle(r).cross(r);
      else g.pair(0, r, L, r).axis(0, L);
      break;
    }
    case 'tapped': {
      const m = spec.size as Metric;
      const { d, p } = THREAD[m];
      const r1 = (d - p) / 2; // tap drill
      if (spec.view === 'top') {
        g.circle(r1).thread(d).cross(d / 2);
      } else {
        const drill = L + Math.max(2 * p, 0.5 * d);
        const tip = r1 * Math.tan(Math.PI / 6); // 120° drill point
        g.pair(0, r1, drill, r1)
          .pair(0, d / 2, L, d / 2, 'thin')
          .line(L, -d / 2, L, d / 2)
          .pair(drill, r1, drill + tip, 0)
          .axis(0, drill + tip);
      }
      break;
    }
    case 'socketScrew':
    case 'hexScrew': {
      const m = spec.size as Metric;
      const { d } = THREAD[m];
      const d1 = minor(m);
      const hex = spec.kind === 'hexScrew';
      if (spec.view === 'top') {
        if (hex) {
          const s = HEX[m].s;
          g.hexagon(s).circle(s * 0.475, 'thin').cross(s / 2);
        } else {
          const { dk, s } = SOCKET[m];
          g.circle(dk / 2).hexagon(s).cross(dk / 2);
        }
        break;
      }
      // Side view: head from -k to 0, shank 0 … L.
      if (hex) {
        const { s, k } = HEX[m];
        const e = s / Math.cos(Math.PI / 6); // across corners
        g.line(-k, -e / 2, 0, -e / 2)
          .line(-k, e / 2, 0, e / 2)
          .line(-k, -e / 2, -k, e / 2)
          .line(0, -e / 2, 0, e / 2)
          .pair(-k, e / 4, 0, e / 4);
      } else {
        const { dk, k } = SOCKET[m];
        const c = Math.min(0.5, k * 0.08);
        g.line(-k + c, -dk / 2, 0, -dk / 2)
          .line(-k + c, dk / 2, 0, dk / 2)
          .line(-k, -dk / 2 + c, -k, dk / 2 - c)
          .pair(-k, dk / 2 - c, -k + c, dk / 2)
          .line(0, -dk / 2, 0, dk / 2);
      }
      const b = hex ? L : Math.min(L, 2 * d + 12); // thread length
      const ch = (d - d1) / 2; // end chamfer
      g.pair(0, d / 2, L - ch, d / 2)
        .pair(L - ch, d / 2, L, d1 / 2)
        .line(L, -d1 / 2, L, d1 / 2)
        .pair(L - b, d1 / 2, L, d1 / 2, 'thin');
      if (b < L) g.line(L - b, -d / 2, L - b, d / 2);
      g.axis(hex ? -HEX[m].k : -SOCKET[m].k, L);
      break;
    }
    case 'nut': {
      const m = spec.size as Metric;
      const { s, m: h } = HEX[m];
      const { d } = THREAD[m];
      if (spec.view === 'top') {
        g.hexagon(s).circle(s * 0.475, 'thin').circle(minor(m) / 2).thread(d).cross(s / 2);
      } else {
        const e = s / Math.cos(Math.PI / 6);
        g.line(0, -e / 2, h, -e / 2)
          .line(0, e / 2, h, e / 2)
          .line(0, -e / 2, 0, e / 2)
          .line(h, -e / 2, h, e / 2)
          .pair(0, e / 4, h, e / 4)
          .axis(0, h);
      }
      break;
    }
    case 'bearing': {
      const { d, D, B } = BEARINGS[spec.size];
      const rm = (d + D) / 4; // pitch radius
      const dw = (D - d) * 0.3; // ball diameter (drawing size)
      const ri = rm - dw * 0.35; // inner ring shoulder
      const ro = rm + dw * 0.35; // outer ring shoulder
      if (spec.view === 'top') {
        g.circle(D / 2).circle(d / 2).circle(ro, 'thin').circle(ri, 'thin').circle(rm, 'center').cross(D / 2);
        break;
      }
      // Section along the axis: both halves of the ring cross-section with the ball.
      const gapX = Math.sqrt(Math.max(0, (dw / 2) ** 2 - (dw * 0.35) ** 2));
      for (const sgn of [1, -1]) {
        const y = (r: number) => sgn * r;
        g.line(0, y(d / 2), B, y(d / 2))
          .line(0, y(D / 2), B, y(D / 2))
          .line(0, y(d / 2), 0, y(D / 2))
          .line(B, y(d / 2), B, y(D / 2))
          .line(0, y(ri), B / 2 - gapX, y(ri))
          .line(B / 2 + gapX, y(ri), B, y(ri))
          .line(0, y(ro), B / 2 - gapX, y(ro))
          .line(B / 2 + gapX, y(ro), B, y(ro))
          .circle(dw / 2, 'thick', v(B / 2, y(rm)))
          .line(B / 2 - dw / 2 - 1.5, y(rm), B / 2 + dw / 2 + 1.5, y(rm), 'center');
      }
      g.axis(0, B);
      break;
    }
    case 'grooveShaft':
    case 'grooveBore': {
      const d1 = Number(spec.size);
      const { d2, m } = (spec.kind === 'grooveShaft' ? GROOVE_SHAFT : GROOVE_BORE)[spec.size];
      // Groove profile at both sides of the axis; the surrounding contour is drawn by the user.
      g.pair(0, d1 / 2, 0, d2 / 2).pair(0, d2 / 2, m, d2 / 2).pair(m, d2 / 2, m, d1 / 2);
      break;
    }
  }
  return g.out;
}

/** Bounding radius of a part's geometry (for previews). */
export function partExtent(prims: PartPrim[]): number {
  let r = 0;
  for (const p of prims) {
    if (p.t === 'line') r = Math.max(r, Math.hypot(p.a.x, p.a.y), Math.hypot(p.b.x, p.b.y));
    else r = Math.max(r, Math.hypot(p.c.x, p.c.y) + p.r);
  }
  return r;
}
