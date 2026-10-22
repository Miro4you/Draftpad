import { Camera } from '../core/camera';
import { entityLength, subEntity } from '../core/curves';
import { entityBox, type SketchDocument } from '../core/document';
import { boxExpand, boxUnion, emptyBox, isEmptyBox, type Box } from '../core/geom';
import { currentTheme, setPenTheme } from '../core/pens';
import { isAnnotation, type Entity } from '../core/types';
import { setKnockout } from '../render/annotations';
import { Painter } from '../render/painter';

/**
 * Timelapse: the drawing replayed in the order it was made (z order). Lines,
 * circles, arcs and freehand strokes grow along their length; dimensions,
 * symbols, texts and hatches fade in. Edits show in their final form.
 */

export interface TimelineItem {
  e: Entity;
  alpha: number;
  /** Share of the replay (0…1) at which it starts and is complete. */
  t0: number;
  t1: number;
  /** Grows along its length (else fades in). */
  grows: boolean;
}

export interface Timeline {
  items: TimelineItem[];
  box: Box;
}

const DIMMED_ALPHA = 0.35;
const PAPER = '#ffffff';

/** Time weight of an entity: short ones still get a moment, long ones a bit more. */
function weight(e: Entity, typical: number): number {
  if (e.kind === 'sheet') return 1.2;
  if (e.kind === 'hatch') return 0.9;
  if (isAnnotation(e)) return 0.6;
  return 0.35 + 0.65 * Math.min(2, entityLength(e) / typical);
}

/** The visible drawing as a replay plan. */
export function planTimelapse(doc: SketchDocument): Timeline {
  const list: { e: Entity; alpha: number }[] = [];
  let box = emptyBox();
  for (const l of doc.layers) {
    if (!l.visible) continue;
    for (const e of doc.visibleEntities()) {
      if (e.layerId !== l.id) continue;
      list.push({ e, alpha: l.dimmed ? DIMMED_ALPHA : 1 });
      box = boxUnion(box, entityBox(e));
    }
  }
  list.sort((a, b) => a.e.z - b.e.z);
  const lengths = list.map(({ e }) => entityLength(e)).filter((v) => v > 0).sort((a, b) => a - b);
  const typical = lengths.length ? Math.max(lengths[Math.floor(lengths.length / 2)], 1e-6) : 1;
  const weights = list.map(({ e }) => weight(e, typical));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  let acc = 0;
  const items = list.map(({ e, alpha }, i) => {
    const t0 = acc / total;
    acc += weights[i];
    return { e, alpha, t0, t1: acc / total, grows: !isAnnotation(e) && entityLength(e) > 0 };
  });
  return { items, box: isEmptyBox(box) ? box : boxExpand(box, Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.04) };
}

/** The part of an item drawn at local progress f (0…1). */
export function partial(item: TimelineItem, f: number): { e: Entity; alpha: number } | null {
  if (f <= 0) return null;
  if (f >= 1) return { e: item.e, alpha: item.alpha };
  if (!item.grows) return { e: item.e, alpha: item.alpha * f };
  const piece = subEntity(item.e, 0, entityLength(item.e) * f, `${item.e.id}~`);
  // The centre-line cross comes with the finished circle.
  if ((piece.kind === 'arc' || piece.kind === 'circle') && piece.mark) return { e: { ...piece, mark: false }, alpha: item.alpha };
  return { e: piece, alpha: item.alpha };
}

/** Camera showing the whole box centred in a w × h frame. */
export function fitCamera(box: Box, w: number, h: number): Camera {
  const cam = new Camera();
  const bw = Math.max(box.maxX - box.minX, 1e-3);
  const bh = Math.max(box.maxY - box.minY, 1e-3);
  const scale = Math.min(w / bw, h / bh);
  cam.state = { scale, rot: 0, tx: w / 2 - ((box.minX + box.maxX) / 2) * scale, ty: h / 2 - ((box.minY + box.maxY) / 2) * scale };
  return cam;
}

/**
 * Draws the replay frame by frame onto `out`. Finished entities are kept on a
 * second canvas, so each frame only adds the newly finished ones and the one in progress.
 */
export class TimelapseRenderer {
  private base: HTMLCanvasElement;
  private basePainter: Painter;
  private outPainter: Painter;
  private outCtx: CanvasRenderingContext2D;
  private baseCtx: CanvasRenderingContext2D;
  private cam: Camera;
  private done = 0;

  constructor(
    private plan: Timeline,
    readonly out: HTMLCanvasElement,
  ) {
    this.base = document.createElement('canvas');
    this.base.width = out.width;
    this.base.height = out.height;
    this.baseCtx = this.base.getContext('2d')!;
    this.outCtx = out.getContext('2d')!;
    this.basePainter = new Painter(this.baseCtx);
    this.outPainter = new Painter(this.outCtx);
    this.cam = fitCamera(plan.box, out.width, out.height);
    this.reset();
  }

  reset(): void {
    this.done = 0;
    this.baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.baseCtx.fillStyle = PAPER;
    this.baseCtx.fillRect(0, 0, this.base.width, this.base.height);
  }

  /** Draw the frame at overall progress t (0…1). Progress only moves forward until `reset()`. */
  frame(t: number): void {
    const theme = currentTheme();
    // Videos are on white paper with graphite/black pens, like exports.
    setPenTheme('light');
    setKnockout(PAPER);
    try {
      const view = this.plan.box;
      const items = this.plan.items;
      if (this.done < items.length && items[this.done].t1 <= t) {
        this.basePainter.begin(this.cam, 1, view);
        while (this.done < items.length && items[this.done].t1 <= t) {
          const it = items[this.done++];
          this.basePainter.draw(it.e, it.alpha);
        }
      }
      const ctx = this.outCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.base, 0, 0);
      const cur = items[this.done];
      if (cur && t > cur.t0) {
        const p = partial(cur, (t - cur.t0) / Math.max(cur.t1 - cur.t0, 1e-9));
        if (p) {
          this.outPainter.begin(this.cam, 1, view);
          this.outPainter.draw(p.e, p.alpha);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } finally {
      setPenTheme(theme);
      setKnockout(undefined);
    }
  }
}

/** Best video format the browser can record (MP4 on Safari, WebM elsewhere). */
export function videoMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const options = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}
