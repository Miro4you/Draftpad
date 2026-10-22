import { worldWidth } from '../core/scale';
import type { Camera } from '../core/camera';
import { boxesIntersect, boxExpand, type Box } from '../core/geom';
import { entityBox, type SketchDocument } from '../core/document';
import { Painter } from './painter';
import { currentTheme, PAPER_COLORS } from '../core/pens';


const DIMMED_ALPHA = 0.28;

export interface SceneOptions {
  grid: boolean;
}

/** Draws paper, grid and all committed entities. */
export class SceneRenderer {
  private ctx: CanvasRenderingContext2D;
  private painter: Painter;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D wird nicht unterstützt');
    this.ctx = ctx;
    this.painter = new Painter(ctx);
  }

  render(doc: SketchDocument, cam: Camera, width: number, height: number, dpr: number, opts: SceneOptions): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER_COLORS[currentTheme()];
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const view = cam.visibleBox(width, height);
    this.painter.begin(cam, dpr, view);
    if (opts.grid) drawGrid(ctx, cam, view);

    const byLayer = doc.byLayer();
    const margin = cam.px(4);
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      const alpha = layer.dimmed ? DIMMED_ALPHA : 1;
      for (const e of byLayer.get(layer.id) ?? []) {
        if (!boxesIntersect(boxExpand(entityBox(e), worldWidth(e) + margin), view)) continue;
        this.painter.draw(e, alpha);
      }
    }
  }
}

/**
 * Millimetre grid with two levels (10^k and 10^(k+1) mm). The fine level fades in
 * as it gets room on screen, so zooming feels continuous.
 */
function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, view: Box): void {
  const minPx = 7;
  const minor = Math.pow(10, Math.ceil(Math.log10(minPx / cam.scale)));
  if (!Number.isFinite(minor) || minor <= 0) return;
  const major = minor * 10;
  const minorPx = minor * cam.scale;
  const fade = Math.min(1, Math.max(0, (minorPx - minPx) / (22 - minPx)));

  const dark = currentTheme() === 'dark';
  const rgb = dark ? '170, 190, 230' : '52, 78, 120';
  const k = dark ? 0.8 : 1;
  ctx.setLineDash([]);
  ctx.lineWidth = cam.px(1);
  const levels: [number, string][] = [
    [minor, `rgba(${rgb}, ${0.07 * fade * k})`],
    [major, `rgba(${rgb}, ${0.13 * k})`],
  ];
  for (const [step, color] of levels) {
    if (step === minor && fade <= 0.01) continue;
    ctx.strokeStyle = color;
    ctx.beginPath();
    const x0 = Math.floor(view.minX / step) * step;
    const y0 = Math.floor(view.minY / step) * step;
    for (let x = x0; x <= view.maxX; x += step) {
      if (step === minor && isMultiple(x, major)) continue;
      ctx.moveTo(x, view.minY);
      ctx.lineTo(x, view.maxY);
    }
    for (let y = y0; y <= view.maxY; y += step) {
      if (step === minor && isMultiple(y, major)) continue;
      ctx.moveTo(view.minX, y);
      ctx.lineTo(view.maxX, y);
    }
    ctx.stroke();
  }
}

function isMultiple(v: number, step: number): boolean {
  const r = Math.abs(v / step - Math.round(v / step));
  return r < 1e-6;
}
