import { Camera } from '../core/camera';
import { entityLength, pointAt, project, subEntity } from '../core/curves';
import { entityBox, type SketchDocument } from '../core/document';
import { boxExpand, boxUnion, emptyBox, isEmptyBox, type Box } from '../core/geom';
import { currentTheme, setPenTheme } from '../core/pens';
import { isAnnotation, type Entity, type JournalEntry, type SyncOp } from '../core/types';
import { setKnockout } from '../render/annotations';
import { Painter } from '../render/painter';

/**
 * Timelapse: the drawing replayed step by step. New lines, circles, arcs and
 * strokes grow along their length; dimensions, texts and hatches fade in;
 * deleted things fade out, changed ones (trimmed, moved) cross-fade; layers
 * fade when they are shown or hidden.
 *
 * Two modes: the whole process from the drawing's journal (every step,
 * including undo), or just the result built up in drawing order, with
 * layers that are hidden at the end fading out last.
 */

export type TimelapseMode = 'process' | 'result';

interface LayerView {
  id: string;
  visible: boolean;
  dimmed: boolean;
}

export interface ReplayStep {
  /** Share of the replay (0…1) at which it starts and is complete. */
  t0: number;
  t1: number;
  adds: Entity[];
  /** New entities that are what is left of deleted ones (trim, erase): shown at once, not grown. */
  rests: Entity[];
  dels: Entity[];
  upds: { before: Entity; after: Entity }[];
  /** Layers fading between two opacities. */
  vis: { id: string; from: number; to: number }[];
  /** Layer list after the step. */
  layers: LayerView[];
}

export interface Timeline {
  steps: ReplayStep[];
  box: Box;
  /** Layer order of the finished drawing (for layers no step names). */
  order: string[];
}

const DIMMED_ALPHA = 0.35;
/** How close (mm) a new piece must lie on a deleted entity to count as what is left of it. */
const REST_TOL = 0.05;

/** Whether `e` lies on one of `old` (a piece left after trimming or erasing). */
function isRest(e: Entity, old: readonly Entity[]): boolean {
  if (isAnnotation(e)) return false;
  const len = entityLength(e);
  if (len <= 0) return false;
  const probes = [0, 0.5, 1].map((k) => pointAt(e, len * k));
  return old.some((o) => o.kind !== 'hatch' && !isAnnotation(o) && probes.every((p) => project(o, p).d <= REST_TOL));
}
const PAPER = '#ffffff';

function layerAlpha(layers: readonly LayerView[], id: string): number {
  const l = layers.find((x) => x.id === id);
  if (!l) return 1;
  return !l.visible ? 0 : l.dimmed ? DIMMED_ALPHA : 1;
}

/** Time weight of a new entity: short ones still get a moment, long ones a bit more. */
function weight(e: Entity, typical: number): number {
  if (e.kind === 'sheet') return 1.2;
  if (e.kind === 'hatch') return 0.9;
  if (isAnnotation(e)) return 0.6;
  return 0.35 + 0.65 * Math.min(2, entityLength(e) / typical);
}

/** Journal steps showing the finished drawing being built up in drawing order. */
function resultJournal(doc: SketchDocument): JournalEntry[] {
  const t = Date.now();
  const all = [...doc.all()].sort((a, b) => a.z - b.z);
  const entries: JournalEntry[] = [{ t, ops: [{ t: 'layers', layers: doc.layers.map((l) => ({ ...l, visible: true })) }], base: true }];
  for (const e of all) entries.push({ t, ops: [{ t: 'put', e }] });
  const hide: SyncOp[] = doc.layers.filter((l) => !l.visible).map((l) => ({ t: 'vis', id: l.id, visible: false, dimmed: l.dimmed }));
  if (hide.length) entries.push({ t, ops: hide });
  return entries;
}

/** A base step (everything before the journal began) shown entity by entity. */
function expandBase(en: JournalEntry): JournalEntry[] {
  const layers = en.ops.filter((op) => op.t === 'layers');
  const puts = en.ops.filter((op) => op.t === 'put');
  return [{ t: en.t, ops: layers, base: true }, ...puts.map((op) => ({ t: en.t, ops: [op] }))];
}

/** Whether the drawing has a recorded process beyond what was there when the history began. */
export function hasProcess(doc: SketchDocument): boolean {
  return doc.history.some((en) => !en.base);
}

/** The replay plan for the drawing. */
export function planTimelapse(doc: SketchDocument, mode: TimelapseMode = 'result'): Timeline {
  const journal = (mode === 'process' && doc.history.length ? doc.history : resultJournal(doc)).flatMap((en) =>
    en.base && en.ops.length > 1 ? expandBase(en) : [en],
  );
  const ents = new Map<string, Entity>();
  let layers: LayerView[] = [];
  const raw: (Omit<ReplayStep, 't0' | 't1'> & { w: number })[] = [];
  let box = emptyBox();
  const lengths: number[] = [];
  for (const en of journal) for (const op of en.ops) if (op.t === 'put') lengths.push(entityLength(op.e));
  const nonzero = lengths.filter((v) => v > 0).sort((a, b) => a - b);
  const typical = nonzero.length ? Math.max(nonzero[Math.floor(nonzero.length / 2)], 1e-6) : 1;

  for (const en of journal) {
    const adds: Entity[] = [];
    const dels: Entity[] = [];
    const upds: { before: Entity; after: Entity }[] = [];
    const before = layers;
    for (const op of en.ops) {
      if (op.t === 'put') {
        const cur = ents.get(op.e.id);
        const added = adds.findIndex((e) => e.id === op.e.id);
        if (added >= 0) adds[added] = op.e;
        else if (cur) {
          const u = upds.find((x) => x.after.id === op.e.id);
          if (u) u.after = op.e;
          else upds.push({ before: cur, after: op.e });
        } else adds.push(op.e);
        ents.set(op.e.id, op.e);
      } else if (op.t === 'del') {
        const cur = ents.get(op.id);
        if (!cur) continue;
        ents.delete(op.id);
        const a = adds.findIndex((e) => e.id === op.id);
        if (a >= 0) adds.splice(a, 1);
        else {
          const u = upds.findIndex((x) => x.after.id === op.id);
          dels.push(u >= 0 ? upds.splice(u, 1)[0].before : cur);
        }
      } else if (op.t === 'layers') {
        const flags = new Map(layers.map((l) => [l.id, l]));
        layers = op.layers.map((l) => {
          const f = en.base ? undefined : flags.get(l.id);
          return { id: l.id, visible: f ? f.visible : l.visible, dimmed: f ? f.dimmed : l.dimmed };
        });
      } else if (op.t === 'vis') {
        const known = layers.some((l) => l.id === op.id);
        layers = known
          ? layers.map((l) => (l.id === op.id ? { id: l.id, visible: op.visible, dimmed: op.dimmed } : l))
          : [...layers, { id: op.id, visible: op.visible, dimmed: op.dimmed }];
      }
    }
    const vis: ReplayStep['vis'] = [];
    for (const l of layers) {
      const from = layerAlpha(before, l.id);
      const to = layerAlpha(layers, l.id);
      if (from !== to) vis.push({ id: l.id, from, to });
    }
    // Only what can be seen takes time.
    const seen = (e: Entity) => Math.max(layerAlpha(before, e.layerId), layerAlpha(layers, e.layerId)) > 0;
    const grown = dels.length ? adds.filter((e) => !isRest(e, dels)) : adds;
    let w = Math.min(3, grown.filter(seen).reduce((s, e) => s + weight(e, typical), 0));
    if (dels.some(seen)) w += 0.4;
    if (upds.some((u) => seen(u.after))) w += 0.5;
    const visSeen = vis.filter((v) => [...ents.values()].some((e) => e.layerId === v.id));
    if (visSeen.length) w += 1.2;
    for (const e of [...adds, ...upds.map((u) => u.after)]) if (seen(e)) box = boxUnion(box, entityBox(e));
    for (const v of visSeen) if (v.to > 0) for (const e of ents.values()) if (e.layerId === v.id) box = boxUnion(box, entityBox(e));
    const rests = dels.length ? adds.filter((e) => isRest(e, dels)) : [];
    raw.push({ adds: adds.filter((e) => !rests.includes(e)), rests, dels, upds, vis, layers, w });
  }

  const total = raw.reduce((s, r) => s + r.w, 0) || 1;
  let acc = 0;
  const steps = raw.map(({ w, ...r }) => {
    const t0 = acc / total;
    acc += w;
    return { ...r, t0, t1: acc / total };
  });
  const pad = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.04;
  return { steps, box: isEmptyBox(box) ? box : boxExpand(box, pad), order: doc.layers.map((l) => l.id) };
}

/** The part of a new entity drawn at local progress f (0…1). */
export function partial(e: Entity, alpha: number, f: number): { e: Entity; alpha: number } | null {
  if (f <= 0 || alpha <= 0) return null;
  if (f >= 1) return { e, alpha };
  if (isAnnotation(e) || entityLength(e) <= 0) return { e, alpha: alpha * f };
  const piece = subEntity(e, 0, entityLength(e) * f, `${e.id}~`);
  // The centre-line cross comes with the finished circle.
  if ((piece.kind === 'arc' || piece.kind === 'circle') && piece.mark) return { e: { ...piece, mark: false }, alpha };
  return { e: piece, alpha };
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
 * Draws the replay frame by frame onto `out`. What the current step doesn't
 * touch is kept on a second canvas, redrawn only when a step completes.
 */
export class TimelapseRenderer {
  private base: HTMLCanvasElement;
  private basePainter: Painter;
  private outPainter: Painter;
  private outCtx: CanvasRenderingContext2D;
  private baseCtx: CanvasRenderingContext2D;
  private cam: Camera;
  private ents = new Map<string, Entity>();
  private layers: LayerView[] = [];
  /** Steps completed so far. */
  private done = 0;
  private baseValid = false;

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
    this.ents.clear();
    this.layers = [];
    this.baseValid = false;
  }

  private apply(s: ReplayStep): void {
    for (const e of s.dels) this.ents.delete(e.id);
    for (const u of s.upds) this.ents.set(u.after.id, u.after);
    for (const e of [...s.adds, ...s.rests]) this.ents.set(e.id, e);
    this.layers = s.layers;
  }

  /** Drawing order: layer by layer (as on screen), then by z. */
  private sorted(list: Iterable<Entity>): Entity[] {
    const idx = (id: string) => {
      const i = this.layers.findIndex((l) => l.id === id);
      return i >= 0 ? i : 1000 + this.plan.order.indexOf(id);
    };
    return [...list].sort((a, b) => idx(a.layerId) - idx(b.layerId) || a.z - b.z);
  }

  private rebuildBase(cur: ReplayStep | undefined): void {
    const ctx = this.baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const busy = new Set<string>();
    const fading = new Set(cur?.vis.map((v) => v.id) ?? []);
    if (cur) for (const e of [...cur.dels, ...cur.upds.map((u) => u.before)]) busy.add(e.id);
    this.basePainter.begin(this.cam, 1, this.plan.box);
    for (const e of this.sorted(this.ents.values())) {
      if (busy.has(e.id) || fading.has(e.layerId)) continue;
      const a = layerAlpha(this.layers, e.layerId);
      if (a > 0) this.basePainter.draw(e, a);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.baseValid = true;
  }

  /** Draw the frame at overall progress t (0…1). Progress only moves forward until `reset()`. */
  frame(t: number): void {
    const theme = currentTheme();
    // Videos are on white paper with graphite/black pens, like exports.
    setPenTheme('light');
    setKnockout(PAPER);
    try {
      const steps = this.plan.steps;
      while (this.done < steps.length && steps[this.done].t1 <= t) {
        this.apply(steps[this.done++]);
        this.baseValid = false;
      }
      const cur = steps[this.done];
      if (!this.baseValid) this.rebuildBase(cur);
      const ctx = this.outCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.base, 0, 0);
      if (cur) {
        const f = Math.min(1, Math.max(0, (t - cur.t0) / Math.max(cur.t1 - cur.t0, 1e-9)));
        const va = new Map(cur.vis.map((v) => [v.id, v.from + (v.to - v.from) * f]));
        const before = this.layers;
        const alpha = (e: Entity) => va.get(e.layerId) ?? Math.max(layerAlpha(before, e.layerId), layerAlpha(cur.layers, e.layerId));
        const busy = new Set([...cur.dels, ...cur.upds.map((u) => u.before)].map((e) => e.id));
        const draw: { e: Entity; alpha: number }[] = [];
        // Layers fading in or out (the step's own changes are drawn below).
        for (const e of this.sorted(this.ents.values())) {
          if (va.has(e.layerId) && !busy.has(e.id)) draw.push({ e, alpha: va.get(e.layerId)! });
        }
        // Changed and trimmed: the new state stands at once, the old one fades on top
        // (so a cut-off end disappears while the rest stays).
        for (const e of cur.rests) draw.push({ e, alpha: alpha(e) });
        for (const u of cur.upds) draw.push({ e: u.after, alpha: alpha(u.after) });
        for (const e of cur.dels) draw.push({ e, alpha: alpha(e) * (1 - f) });
        for (const u of cur.upds) draw.push({ e: u.before, alpha: alpha(u.before) * (1 - f) });
        for (const e of cur.adds) {
          const p = partial(e, alpha(e), f);
          if (p) draw.push(p);
        }
        const visible = draw.filter((d) => d.alpha > 0.002);
        if (visible.length) {
          this.outPainter.begin(this.cam, 1, this.plan.box);
          for (const d of visible) this.outPainter.draw(d.e, d.alpha);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
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

