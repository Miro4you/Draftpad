import { layoutAnno, textWidth, type AnnoLayout, type AnnoText } from '../core/annotations';
import { currentTheme, PAPER_COLORS } from '../core/pens';
import { drawingScale } from '../core/scale';
import type { HatchEntity, LaidOut } from '../core/types';

/** Subset of the canvas API used for annotations (also implemented by the export recorder). */
export type DrawCtx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'closePath'
  | 'stroke'
  | 'fill'
  | 'clip'
  | 'setLineDash'
  | 'translate'
  | 'rotate'
  | 'fillText'
> & {
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

let knockoutOverride: string | null | undefined;

/** Export: colour behind dimension figures (undefined = paper colour of the theme). */
export function setKnockout(c: string | null | undefined): void {
  knockoutOverride = c;
}

/** Sans face used for dimension and GPS texts (close to ISO 3098 lettering). */
export const ANNO_FONT = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';

function drawText(ctx: DrawCtx, t: AnnoText, knockout: string | null): void {
  ctx.save();
  ctx.translate(t.p.x, t.p.y);
  ctx.rotate(t.angle);
  if (knockout) {
    // Lines (hatching, centre lines) must not run through dimension figures.
    const w = textWidth(t.text, t.size) + t.size * 0.3;
    const y0 = t.baseline === 'bottom' ? -t.size * 1.02 : -t.size * 0.6;
    const prev = ctx.fillStyle;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.fillStyle = knockout;
    ctx.beginPath();
    ctx.moveTo(-w / 2, y0);
    ctx.lineTo(w / 2, y0);
    ctx.lineTo(w / 2, y0 + t.size * 1.15);
    ctx.lineTo(-w / 2, y0 + t.size * 1.15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = prev;
    ctx.globalAlpha = alpha;
  }
  ctx.font = `${t.size}px ${ANNO_FONT}`;
  ctx.textAlign = 'center';
  if (t.baseline === 'bottom') {
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(t.text, 0, -t.size * 0.12);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(t.text, 0, t.size * 0.04);
  }
  ctx.restore();
}

/** Dimensions, datum symbols and tolerance frames. */
export function drawAnno(ctx: DrawCtx, e: LaidOut, color: string, width: number, alpha: number): void {
  drawLayout(ctx, layoutAnno(e), color, width, alpha, e.kind === 'dim' ? (knockoutOverride !== undefined ? knockoutOverride : PAPER_COLORS[currentTheme()]) : null);
}

/** Strokes, fills and texts of an annotation layout. */
export function drawLayout(ctx: DrawCtx, l: AnnoLayout, color: string, width: number, alpha: number, knockout: string | null = null): void {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const [a, b] of l.lines) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (const a of l.arcs) {
    ctx.moveTo(a.c.x + Math.cos(a.start) * a.r, a.c.y + Math.sin(a.start) * a.r);
    ctx.arc(a.c.x, a.c.y, a.r, a.start, a.start + a.sweep, a.sweep < 0);
  }
  ctx.stroke();
  ctx.beginPath();
  for (const f of l.fills) {
    ctx.moveTo(f[0].x, f[0].y);
    for (let i = 1; i < f.length; i++) ctx.lineTo(f[i].x, f[i].y);
    ctx.closePath();
  }
  ctx.fill();
  for (const t of l.texts) drawText(ctx, t, knockout);
  ctx.globalAlpha = 1;
}

interface HatchFamily {
  /** Direction of the lines in degrees (world, before the entity's extra angle). */
  deg: number;
  /** Offsets of the lines within one period, as multiples of the spacing. */
  lines: number[];
  /** Period as multiple of the spacing. */
  period: number;
  /** Optional dash pattern (multiples of the spacing) per line index. */
  dash?: (number[] | null)[];
}

/** Line families per pattern. 45° runs from lower left to upper right on paper. */
const PATTERNS: Record<HatchEntity['pattern'], HatchFamily[]> = {
  diag: [{ deg: -45, lines: [0], period: 1 }],
  diag2: [{ deg: 45, lines: [0], period: 1 }],
  cross: [
    { deg: -45, lines: [0], period: 1 },
    { deg: 45, lines: [0], period: 1 },
  ],
  steel: [{ deg: -45, lines: [0, 0.35], period: 2 }],
  plastic: [{ deg: -45, lines: [0, 1], period: 2, dash: [null, [0.9, 0.45]] }],
  dots: [],
};

export const HATCH_NAMES: Record<HatchEntity['pattern'], string> = {
  diag: 'Schraffur 45° (Metall, allgemein)',
  diag2: 'Schraffur −45°',
  cross: 'Kreuzschraffur',
  steel: 'Doppellinie (Stahl)',
  plastic: 'Voll/gestrichelt (Kunststoff)',
  dots: 'Punkte (Beton, Sand)',
};

/** Hatch lines clipped to the loops (even-odd), anchored to the world so neighbours line up. */
export function drawHatch(ctx: DrawCtx, e: HatchEntity, color: string, width: number, alpha: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  ctx.save();
  ctx.beginPath();
  for (const loop of e.loops) {
    for (let i = 0; i < loop.length; i += 2) {
      const x = loop[i];
      const y = loop[i + 1];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    ctx.closePath();
  }
  ctx.clip('evenodd');
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  const k = drawingScale();
  const s = Math.max(e.spacing, 0.2) * k;
  const corners = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  if (e.pattern === 'dots') {
    ctx.beginPath();
    const r = Math.max(width * 0.9, 0.12 * k);
    for (let y = Math.floor(minY / s) * s; y <= maxY; y += s) {
      const row = Math.round(y / s);
      for (let x = Math.floor(minX / s) * s + (row % 2 ? s / 2 : 0); x <= maxX + s; x += s) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  for (const fam of PATTERNS[e.pattern]) {
    const a = ((fam.deg + e.angle) * Math.PI) / 180;
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const n = { x: -d.y, y: d.x };
    const tn = corners.map(([x, y]) => x * n.x + y * n.y);
    const td = corners.map(([x, y]) => x * d.x + y * d.y);
    const t0 = Math.min(...tn);
    const t1 = Math.max(...tn);
    const u0 = Math.min(...td) - 1;
    const u1 = Math.max(...td) + 1;
    const P = fam.period * s;
    fam.lines.forEach((off, li) => {
      const dash = fam.dash?.[li];
      ctx.setLineDash(dash ? dash.map((k) => k * s) : []);
      ctx.beginPath();
      for (let t = Math.floor((t0 - off * s) / P) * P + off * s; t <= t1; t += P) {
        ctx.moveTo(n.x * t + d.x * u0, n.y * t + d.y * u0);
        ctx.lineTo(n.x * t + d.x * u1, n.y * t + d.y * u1);
      }
      ctx.stroke();
    });
  }
  ctx.setLineDash([]);
  ctx.restore();
  ctx.globalAlpha = 1;
}
