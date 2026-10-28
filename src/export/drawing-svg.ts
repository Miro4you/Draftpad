import { entityBox, validateFile } from '../core/document';
import { boxExpand, boxUnion, emptyBox, isEmptyBox } from '../core/geom';
import { currentTheme, PAPER_COLORS, setPenTheme, type Theme } from '../core/pens';
import { drawingScale, setDrawingScale } from '../core/scale';
import type { Entity } from '../core/types';
import { setKnockout } from '../render/annotations';
import { recordVector } from './export';
import { toSvg } from './vector';

const DIMMED_ALPHA = 0.35;

export interface DrawingSvgOptions {
  /** Margin around the drawing in paper mm (default 4). */
  margin?: number;
  /** Pen colours for a light or dark page (default light). */
  theme?: Theme;
  /** Page colour, null = transparent (default). */
  background?: string | null;
  title?: string;
}

export interface DrawingSvg {
  svg: string;
  /** Paper size in mm (at the drawing's scale). */
  width: number;
  height: number;
}

/**
 * SVG of a saved drawing without opening an editor – e.g. to show a sketch
 * inside a host page. Only visible layers; null for an empty drawing.
 * The XML prolog is left out so the result can go straight into HTML.
 */
export function drawingToSvg(data: unknown, opts: DrawingSvgOptions = {}): DrawingSvg | null {
  const file = validateFile(data);
  const entities: { e: Entity; alpha: number }[] = [];
  const prevScale = drawingScale();
  const prevTheme = currentTheme();
  const theme = opts.theme ?? 'light';
  // Sizes of texts, arrows and pens depend on the drawing's scale.
  setDrawingScale(file.scale ?? 1);
  setPenTheme(theme);
  setKnockout(opts.background ?? PAPER_COLORS[theme]);
  try {
    let box = emptyBox();
    for (const l of file.layers) {
      if (!l.visible) continue;
      for (const e of file.entities.filter((x) => x.layerId === l.id).sort((a, b) => a.z - b.z)) {
        entities.push({ e, alpha: l.dimmed ? DIMMED_ALPHA : 1 });
        box = boxUnion(box, entityBox(e));
      }
    }
    if (!entities.length || isEmptyBox(box)) return null;
    const k = drawingScale();
    box = boxExpand(box, (opts.margin ?? 4) * k);
    const rec = recordVector(entities);
    const page = { minX: box.minX, minY: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY, background: opts.background ?? null, scale: k };
    const svg = toSvg(rec, page, opts.title ?? 'Skizze').replace(/^<\?xml[^>]*>\s*/, '');
    return { svg, width: page.width / k, height: page.height / k };
  } finally {
    setDrawingScale(prevScale);
    setPenTheme(prevTheme);
    setKnockout(undefined);
  }
}
