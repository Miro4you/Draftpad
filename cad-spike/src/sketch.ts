// 2D-Skizze mit Stift: Linienzug, Rechteck, Kreis, eingefügte Kurvenprofile. Fang wie im Draftpad (vereinfacht).
import {
  circleLoop,
  cycloidProfile,
  formulaProfile,
  gearProfile,
  loopPolyline,
  polyLoop,
  type CycloidParams,
  type FormulaParams,
  type GearParams,
  type Loop,
  type Segment,
  type Vec,
} from './curves';

export type Entity =
  | { id: number; kind: 'poly'; pts: Vec[] }
  | { id: number; kind: 'rect'; a: Vec; b: Vec }
  | { id: number; kind: 'circle'; c: Vec; r: number }
  | { id: number; kind: 'gear'; c: Vec; p: GearParams }
  | { id: number; kind: 'cycloid'; c: Vec; p: CycloidParams }
  | { id: number; kind: 'formula'; c: Vec; p: FormulaParams };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEntity = DistOmit<Entity, 'id'>;

export type Tool = 'select' | 'line' | 'rect' | 'circle';

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function moveSeg(s: Segment, d: Vec): Segment {
  if (s.k === 'line') return { k: 'line', a: add(s.a, d), b: add(s.b, d) };
  if (s.k === 'arc') return { k: 'arc', a: add(s.a, d), m: add(s.m, d), b: add(s.b, d) };
  if (s.k === 'circle') return { k: 'circle', c: add(s.c, d), r: s.r };
  return { k: 'spline', pts: s.pts.map((p) => add(p, d)) };
}

export function entityLoops(e: Entity): Loop[] {
  let loops: Loop[];
  switch (e.kind) {
    case 'poly':
      return [polyLoop(e.pts)];
    case 'rect': {
      const [a, b] = [e.a, e.b];
      return [polyLoop([a, [b[0], a[1]], b, [a[0], b[1]]])];
    }
    case 'circle':
      return [circleLoop(e.c, e.r)];
    case 'gear':
      loops = gearProfile(e.p);
      break;
    case 'cycloid':
      loops = cycloidProfile(e.p);
      break;
    case 'formula':
      loops = formulaProfile(e.p);
      break;
  }
  return loops.map((l) => l.map((s) => moveSeg(s, e.c)));
}

export class Sketch {
  entities: Entity[] = [];
  open: Vec[][] = []; // noch nicht geschlossene Linienzüge
  tool: Tool = 'line';
  selected: number | null = null;
  onChange: () => void = () => {};
  onSelect: (e: Entity | null) => void = () => {};
  onStatus: (t: string) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private scale = 6; // px pro mm
  private off: Vec = [0, 0]; // Bildschirmposition des Ursprungs
  private cache = new Map<number, { key: string; polys: Vec[][] }>();
  private nextId = 1;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private penSeen = false;
  private drag: null | { kind: 'draw'; start: Vec; cur: Vec; chain: number | null } | { kind: 'move'; last: Vec } | { kind: 'pan'; d0: number; mid: Vec; scale0: number; off0: Vec; mid0: Vec } = null;
  private hover: Vec | null = null;
  private snapMark: Vec | null = null;
  private raf = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.redraw();
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.resize();
  }

  // ---- Daten ----------------------------------------------------------------------------------

  addEntity(e: NewEntity): Entity {
    const ent = { ...e, id: this.nextId++ } as Entity;
    this.entities.push(ent);
    this.changed();
    return ent;
  }

  updateEntity(ent: Entity) {
    const i = this.entities.findIndex((e) => e.id === ent.id);
    if (i >= 0) this.entities[i] = ent;
    this.changed();
  }

  remove(id: number) {
    this.entities = this.entities.filter((e) => e.id !== id);
    if (this.selected === id) this.select(null);
    this.changed();
  }

  clear() {
    this.entities = [];
    this.open = [];
    this.select(null);
    this.changed();
  }

  loops(): Loop[] {
    return this.entities.flatMap(entityLoops);
  }

  center(): Vec {
    const r = this.canvas.getBoundingClientRect();
    return this.toWorld(r.width / 2, r.height / 2).map((v) => Math.round(v)) as Vec;
  }

  private changed() {
    this.onChange();
    this.redraw();
  }

  select(id: number | null) {
    this.selected = id;
    this.onSelect(this.entities.find((e) => e.id === id) ?? null);
    this.redraw();
  }

  // ---- Ansicht --------------------------------------------------------------------------------

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    if (this.off[0] === 0 && this.off[1] === 0) this.off = [r.width / 2, r.height / 2];
    this.redraw();
  }

  fit() {
    const polys = this.entities.flatMap((e) => this.polys(e));
    const r = this.canvas.getBoundingClientRect();
    if (!polys.length) {
      this.scale = 6;
      this.off = [r.width / 2, r.height / 2];
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polys.flat()) {
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      }
      this.scale = Math.min((r.width * 0.8) / Math.max(1, x1 - x0), (r.height * 0.8) / Math.max(1, y1 - y0));
      this.off = [r.width / 2 - ((x0 + x1) / 2) * this.scale, r.height / 2 + ((y0 + y1) / 2) * this.scale];
    }
    this.redraw();
  }

  private toWorld(x: number, y: number): Vec {
    return [(x - this.off[0]) / this.scale, (this.off[1] - y) / this.scale];
  }
  private toScreen(p: Vec): Vec {
    return [this.off[0] + p[0] * this.scale, this.off[1] - p[1] * this.scale];
  }
  private local(e: PointerEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---- Fang -----------------------------------------------------------------------------------

  private snapPoints(): Vec[] {
    const pts: Vec[] = [[0, 0]];
    for (const c of this.open) pts.push(c[0], c[c.length - 1]);
    for (const e of this.entities) {
      if (e.kind === 'poly') pts.push(...e.pts);
      else if (e.kind === 'rect') pts.push(e.a, e.b, [e.a[0], e.b[1]], [e.b[0], e.a[1]]);
      else pts.push(e.c);
    }
    return pts;
  }

  /** Punkt fangen: Endpunkte zuerst, sonst Winkel (15°) und Länge (0,5 mm) bezogen auf `from`. */
  private snap(p: Vec, from: Vec | null, free: boolean): Vec {
    const tol = 14 / this.scale;
    let best: Vec | null = null;
    let bd = tol;
    for (const q of this.snapPoints()) {
      const d = dist(p, q);
      if (d < bd) { bd = d; best = q; }
    }
    this.snapMark = best;
    if (best) return [...best] as Vec;
    if (free) return p;
    if (!from) return [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2];
    let ang = Math.atan2(p[1] - from[1], p[0] - from[0]);
    const step = Math.PI / 12;
    const snapped = Math.round(ang / step) * step;
    if (Math.abs(ang - snapped) < (4 * Math.PI) / 180) ang = snapped;
    const len = Math.max(0.5, Math.round(dist(p, from) * 2) / 2);
    return [from[0] + len * Math.cos(ang), from[1] + len * Math.sin(ang)];
  }

  // ---- Eingabe --------------------------------------------------------------------------------

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') this.penSeen = true;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    // Finger: Ansicht (sobald ein Stift benutzt wurde, zeichnen Finger nie)
    if (e.pointerType === 'touch' && (this.penSeen || touches.length >= 2)) {
      this.drag = null;
      this.startPan(touches);
      return;
    }
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', d0: 0, mid: [e.clientX, e.clientY], scale0: this.scale, off0: [...this.off] as Vec, mid0: [e.clientX, e.clientY] };
      return;
    }
    const w = this.toWorld(...this.local(e));
    if (this.tool === 'select') {
      const hit = this.hit(w);
      this.select(hit);
      if (hit !== null) this.drag = { kind: 'move', last: w };
      return;
    }
    const start = this.snap(w, null, e.shiftKey);
    // Linienzug fortsetzen, wenn an einem offenen Ende angesetzt wird
    let chain: number | null = null;
    if (this.tool === 'line') {
      this.open.forEach((c, i) => {
        if (dist(c[c.length - 1], start) < 1e-6) chain = i;
        else if (dist(c[0], start) < 1e-6) {
          c.reverse();
          chain = i;
        }
      });
    }
    this.drag = { kind: 'draw', start, cur: start, chain };
    this.redraw();
  }

  private startPan(touches: { x: number; y: number }[]) {
    const mid: Vec = touches.length >= 2 ? [(touches[0].x + touches[1].x) / 2, (touches[0].y + touches[1].y) / 2] : [touches[0].x, touches[0].y];
    const d0 = touches.length >= 2 ? Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y) : 0;
    this.drag = { kind: 'pan', d0, mid, scale0: this.scale, off0: [...this.off] as Vec, mid0: mid };
  }

  private move(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const w = this.toWorld(...this.local(e));
    const d = this.drag;
    if (!d) {
      if (e.pointerType !== 'touch' && this.tool !== 'select') {
        this.hover = this.snap(w, null, e.shiftKey);
        this.redraw();
      }
      return;
    }
    if (d.kind === 'pan') {
      const ps = [...this.pointers.values()];
      const mid: Vec = ps.length >= 2 ? [(ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2] : [e.clientX, e.clientY];
      if (ps.length >= 2 && d.d0 > 0) {
        const dd = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        const r = this.canvas.getBoundingClientRect();
        const m0: Vec = [d.mid0[0] - r.left, d.mid0[1] - r.top];
        const wm: Vec = [(m0[0] - d.off0[0]) / d.scale0, (d.off0[1] - m0[1]) / d.scale0];
        this.scale = Math.min(400, Math.max(0.2, (d.scale0 * dd) / d.d0));
        const m1: Vec = [mid[0] - r.left, mid[1] - r.top];
        this.off = [m1[0] - wm[0] * this.scale, m1[1] + wm[1] * this.scale];
      } else {
        this.off = [d.off0[0] + mid[0] - d.mid0[0], d.off0[1] + mid[1] - d.mid0[1]];
      }
      this.redraw();
      return;
    }
    if (d.kind === 'move') {
      const delta: Vec = [Math.round((w[0] - d.last[0]) * 2) / 2, Math.round((w[1] - d.last[1]) * 2) / 2];
      if (delta[0] || delta[1]) {
        const ent = this.entities.find((x) => x.id === this.selected);
        if (ent) this.translate(ent, delta);
        d.last = add(d.last, delta);
        this.redraw();
      }
      return;
    }
    if (this.tool === 'circle') {
      const r = Math.max(0.5, Math.round(dist(w, d.start) * 2) / 2);
      d.cur = [d.start[0] + r, d.start[1]];
      this.snapMark = null;
      this.onStatus(`R ${fmt(r)} · Ø ${fmt(2 * r)} mm`);
    } else if (this.tool === 'rect') {
      d.cur = this.snap(w, null, e.shiftKey);
      this.onStatus(`${fmt(Math.abs(d.cur[0] - d.start[0]))} × ${fmt(Math.abs(d.cur[1] - d.start[1]))} mm`);
    } else {
      d.cur = this.snap(w, d.start, e.shiftKey);
      const ang = (Math.atan2(d.cur[1] - d.start[1], d.cur[0] - d.start[0]) * 180) / Math.PI;
      this.onStatus(`${fmt(dist(d.cur, d.start))} mm · ${fmt((ang + 360) % 360)}°`);
    }
    this.redraw();
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (d?.kind === 'pan') {
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length) this.startPan(touches);
      else this.drag = null;
      return;
    }
    this.drag = null;
    if (!d) return;
    if (d.kind === 'move') {
      this.changed();
      return;
    }
    this.onStatus('');
    const { start, cur } = d;
    if (this.tool === 'circle') {
      if (dist(start, cur) >= 0.5) this.addEntity({ kind: 'circle', c: start, r: dist(start, cur) });
    } else if (this.tool === 'rect') {
      if (Math.abs(cur[0] - start[0]) > 0.1 && Math.abs(cur[1] - start[1]) > 0.1) this.addEntity({ kind: 'rect', a: start, b: cur });
    } else if (dist(start, cur) > 0.1) {
      let chain = d.chain !== null ? this.open[d.chain] : null;
      if (!chain) {
        chain = [start];
        this.open.push(chain);
      }
      // trifft das Ende den Anfang eines Linienzugs → schließen
      if (chain.length >= 3 && dist(cur, chain[0]) < 1e-6) {
        this.open = this.open.filter((c) => c !== chain);
        this.addEntity({ kind: 'poly', pts: chain });
        this.onStatus('Profil geschlossen');
        return;
      }
      // trifft das Ende den Anfang eines anderen offenen Zugs → verbinden
      const other = this.open.find((c) => c !== chain && (dist(c[0], cur) < 1e-6 || dist(c[c.length - 1], cur) < 1e-6));
      if (other) {
        if (dist(other[0], cur) > 1e-6) other.reverse();
        chain.push(...other);
        this.open = this.open.filter((c) => c !== other);
      } else chain.push(cur);
    }
    this.redraw();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x, y] = this.local(e as unknown as PointerEvent);
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const w = this.toWorld(x, y);
      this.scale = Math.min(400, Math.max(0.2, this.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      this.off = [x - w[0] * this.scale, y + w[1] * this.scale];
    } else this.off = [this.off[0] - e.deltaX, this.off[1] - e.deltaY];
    this.redraw();
  }

  private translate(ent: Entity, d: Vec) {
    if (ent.kind === 'poly') ent.pts = ent.pts.map((p) => add(p, d));
    else if (ent.kind === 'rect') {
      ent.a = add(ent.a, d);
      ent.b = add(ent.b, d);
    } else ent.c = add(ent.c, d);
  }

  private hit(w: Vec): number | null {
    const tol = 10 / this.scale;
    let best: number | null = null;
    let bd = tol;
    for (const e of this.entities) {
      for (const poly of this.polys(e)) {
        for (let i = 0; i < poly.length; i++) {
          const d = segDist(w, poly[i], poly[(i + 1) % poly.length]);
          if (d < bd) { bd = d; best = e.id; }
        }
      }
    }
    return best;
  }

  /** zum Abbrechen offener Linienzüge (Taste Esc / Knopf) */
  dropOpen() {
    this.open = [];
    this.redraw();
  }

  undoLast() {
    if (this.open.length) {
      const c = this.open[this.open.length - 1];
      c.pop();
      if (c.length < 2) this.open.pop();
      this.redraw();
    } else if (this.entities.length) this.remove(this.entities[this.entities.length - 1].id);
  }

  // ---- Zeichnen -------------------------------------------------------------------------------

  private polys(e: Entity): Vec[][] {
    const key = JSON.stringify(e);
    const c = this.cache.get(e.id);
    if (c && c.key === key) return c.polys;
    let polys: Vec[][];
    try {
      polys = entityLoops(e).map((l) => loopPolyline(l, 24));
    } catch {
      polys = [];
    }
    this.cache.set(e.id, { key, polys });
    return polys;
  }

  redraw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private paint() {
    const ctx = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const r = this.canvas.getBoundingClientRect();
    ctx.fillStyle = col('--paper');
    ctx.fillRect(0, 0, r.width, r.height);
    // Raster: 1/10/100 mm je nach Zoom
    let step = 1;
    while (step * this.scale < 12) step *= 10;
    for (const [s, a] of [[step, 0.35], [step * 10, 0.7]] as const) {
      ctx.strokeStyle = col('--grid');
      ctx.globalAlpha = a;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const w0 = this.toWorld(0, r.height), w1 = this.toWorld(r.width, 0);
      for (let x = Math.ceil(w0[0] / s) * s; x <= w1[0]; x += s) {
        const sx = Math.round(this.toScreen([x, 0])[0]) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, r.height);
      }
      for (let y = Math.ceil(w0[1] / s) * s; y <= w1[1]; y += s) {
        const sy = Math.round(this.toScreen([0, y])[1]) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(r.width, sy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Achsen
    const o = this.toScreen([0, 0]);
    ctx.strokeStyle = col('--axis');
    ctx.setLineDash([12, 3, 2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, o[1]); ctx.lineTo(r.width, o[1]); ctx.moveTo(o[0], 0); ctx.lineTo(o[0], r.height);
    ctx.stroke();
    ctx.setLineDash([]);
    // Profile
    for (const e of this.entities) {
      const sel = e.id === this.selected;
      ctx.strokeStyle = sel ? col('--accent') : col('--ink');
      ctx.fillStyle = col('--fill');
      ctx.lineWidth = sel ? 2.4 : 1.6;
      const polys = this.polys(e);
      ctx.beginPath();
      for (const poly of polys) {
        poly.forEach((p, i) => {
          const s = this.toScreen(p);
          if (i) ctx.lineTo(s[0], s[1]);
          else ctx.moveTo(s[0], s[1]);
        });
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
      if (!polys.length) {
        const s = this.toScreen((e as { c: Vec }).c ?? [0, 0]);
        ctx.fillStyle = col('--bad');
        ctx.fillText('Profil ungültig – Werte prüfen', s[0] + 6, s[1] - 6);
      }
    }
    // offene Linienzüge
    ctx.strokeStyle = col('--open');
    ctx.lineWidth = 1.6;
    for (const c of this.open) {
      ctx.beginPath();
      c.forEach((p, i) => {
        const s = this.toScreen(p);
        if (i) ctx.lineTo(s[0], s[1]);
        else ctx.moveTo(s[0], s[1]);
      });
      ctx.stroke();
      for (const p of [c[0], c[c.length - 1]]) {
        const s = this.toScreen(p);
        ctx.beginPath();
        ctx.arc(s[0], s[1], 3.5, 0, 2 * Math.PI);
        ctx.fillStyle = col('--open');
        ctx.fill();
      }
    }
    // Vorschau
    const d = this.drag;
    if (d?.kind === 'draw') {
      ctx.strokeStyle = col('--accent');
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const a = this.toScreen(d.start), b = this.toScreen(d.cur);
      if (this.tool === 'circle') ctx.arc(a[0], a[1], Math.abs(b[0] - a[0]), 0, 2 * Math.PI);
      else if (this.tool === 'rect') ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      else { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const mark = this.snapMark && (d?.kind === 'draw' || this.hover) ? this.snapMark : null;
    if (mark) {
      const s = this.toScreen(mark);
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.6;
      ctx.strokeRect(s[0] - 5, s[1] - 5, 10, 10);
    } else if (this.hover && !d) {
      const s = this.toScreen(this.hover);
      ctx.fillStyle = col('--accent');
      ctx.beginPath();
      ctx.arc(s[0], s[1], 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
    // Maßstab
    ctx.fillStyle = col('--muted');
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`Raster ${fmt(step)} mm`, 10, r.height - 10);
  }
}

function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString('de-DE');
