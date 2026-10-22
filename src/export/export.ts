import { Camera } from '../core/camera';
import { entityBox } from '../core/document';
import { boxExpand, boxUnion, emptyBox, isEmptyBox, type Box } from '../core/geom';
import { currentTheme, dashArray, penColor, setPenTheme } from '../core/pens';
import type { SketchDocument } from '../core/document';
import { isAnnotation, type Entity, type SheetEntity } from '../core/types';
import { sheetBox } from '../core/annotations';
import { drawAnno, drawHatch, setKnockout, type DrawCtx } from '../render/annotations';
import { centerMarks, Painter } from '../render/painter';
import { traceEntity } from '../render/paths';
import { drawingScale, worldWidth } from '../core/scale';
import { toPdf, toSvg, VectorRecorder, type Page } from './vector';

export type ExportFormat = 'pdf' | 'svg' | 'png' | 'jpeg';

export interface ExportOptions {
  format: ExportFormat;
  /** Only these entities (selection), otherwise everything visible. */
  only?: Set<string>;
  /** Raster resolution in dots per inch. */
  dpi: number;
  /** Background colour, null = transparent (PNG/SVG only). */
  background: string | null;
  /** Margin around the drawing in mm. */
  margin: number;
  /** Export exactly this sheet (its paper size and scale). */
  sheet?: SheetEntity;
}

/** Largest raster we create (iPad Safari refuses canvases above ~16.7 MP). */
const MAX_PIXELS = 16_000_000;
const DIMMED_ALPHA = 0.35;
const PENCIL_ALPHA = 0.9;

interface Job {
  entities: { e: Entity; alpha: number }[];
  box: Box;
  /** World mm per paper mm. */
  scale: number;
}

function collect(doc: SketchDocument, opts: ExportOptions): Job {
  const entities: { e: Entity; alpha: number }[] = [];
  let box = emptyBox();
  for (const l of doc.layers) {
    if (!l.visible) continue;
    for (const e of doc.visibleEntities()) {
      if (e.layerId !== l.id || (opts.only && !opts.only.has(e.id))) continue;
      entities.push({ e, alpha: l.dimmed ? DIMMED_ALPHA : 1 });
      box = boxUnion(box, entityBox(e));
    }
  }
  if (opts.sheet) return { entities, box: sheetBox(opts.sheet), scale: opts.sheet.scale };
  const k = drawingScale();
  return { entities, box: isEmptyBox(box) ? box : boxExpand(box, opts.margin * k), scale: k };
}

/** Vector drawing of the entities (no pencil grain: clean lines in the pen colour). */
export function recordVector(entities: { e: Entity; alpha: number }[]): VectorRecorder {
  const rec = new VectorRecorder();
  const ctx = rec as unknown as DrawCtx & CanvasRenderingContext2D;
  const strokeOne = (e: Entity, alpha: number, dashOffset: number) => {
    const s = e.style;
    ctx.globalAlpha = alpha * (s.pen === 'pencil' ? PENCIL_ALPHA : 1);
    ctx.strokeStyle = penColor(s);
    const w = worldWidth(e);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dashArray(s.lineType, w));
    ctx.lineDashOffset = dashOffset;
    ctx.beginPath();
    traceEntity(ctx, e);
    ctx.stroke();
    ctx.lineDashOffset = 0;
  };
  for (const { e, alpha } of entities) {
    if (isAnnotation(e)) {
      const a = alpha * (e.style.pen === 'pencil' ? PENCIL_ALPHA : 1);
      if (e.kind === 'hatch') drawHatch(ctx, e, penColor(e.style), worldWidth(e), a);
      else drawAnno(ctx, e, penColor(e.style), worldWidth(e), a);
      continue;
    }
    strokeOne(e, alpha, 0);
    if ((e.kind === 'circle' || e.kind === 'arc') && e.mark) {
      for (const l of centerMarks(e)) {
        const dash = dashArray(l.style.lineType, worldWidth(l));
        const period = dash.reduce((s, v) => s + v, 0);
        const half = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) / 2;
        strokeOne(l, alpha, (((dash[0] / 2 - half) % period) + period) % period);
      }
    }
  }
  ctx.globalAlpha = 1;
  return rec;
}

/** Raster image of the entities, drawn like on screen (pencil grain included). */
function rasterize(job: Job, opts: ExportOptions): Promise<Blob> {
  const w = job.box.maxX - job.box.minX;
  const h = job.box.maxY - job.box.minY;
  let pxPerMm = opts.dpi / 25.4 / job.scale;
  const need = w * h * pxPerMm * pxPerMm;
  if (need > MAX_PIXELS) pxPerMm *= Math.sqrt(MAX_PIXELS / need);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * pxPerMm));
  canvas.height = Math.max(1, Math.round(h * pxPerMm));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas nicht verfügbar'));
  const bg = opts.format === 'jpeg' ? (opts.background ?? '#ffffff') : opts.background;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const cam = new Camera();
  cam.state = { scale: pxPerMm, rot: 0, tx: -job.box.minX * pxPerMm, ty: -job.box.minY * pxPerMm };
  const painter = new Painter(ctx);
  painter.begin(cam, 1, job.box);
  for (const { e, alpha } of job.entities) painter.draw(e, alpha);
  const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, 0.92),
  );
}

/** Build the export file. Resolves null when there is nothing to export. */
export async function exportDrawing(doc: SketchDocument, opts: ExportOptions, title = 'Skizze'): Promise<Blob | null> {
  const job = collect(doc, opts);
  if (!job.entities.length) return null;
  const theme = currentTheme();
  // Exports are always on white paper with graphite/black pens.
  setPenTheme('light');
  setKnockout(opts.background ?? '#ffffff');
  try {
    if (opts.format === 'png' || opts.format === 'jpeg') return await rasterize(job, opts);
    const rec = recordVector(job.entities);
    const page: Page = {
      minX: job.box.minX,
      minY: job.box.minY,
      width: job.box.maxX - job.box.minX,
      height: job.box.maxY - job.box.minY,
      background: opts.format === 'pdf' ? (opts.background ?? null) : opts.background,
      scale: job.scale,
    };
    if (opts.format === 'svg') return new Blob([toSvg(rec, page, title)], { type: 'image/svg+xml' });
    const bytes = toPdf(rec, page, title);
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  } finally {
    setPenTheme(theme);
    setKnockout(undefined);
  }
}

export const EXT: Record<ExportFormat, string> = { pdf: 'pdf', svg: 'svg', png: 'png', jpeg: 'jpg' };

/** Size of the export in mm (for the dialog). */
/** Paper size of the export in mm (for the dialog). */
export function exportSize(doc: SketchDocument, opts: Pick<ExportOptions, 'only' | 'margin' | 'sheet'>): { w: number; h: number } | null {
  const job = collect(doc, { format: 'svg', dpi: 0, background: null, ...opts });
  if (!job.entities.length) return null;
  return { w: (job.box.maxX - job.box.minX) / job.scale, h: (job.box.maxY - job.box.minY) / job.scale };
}
