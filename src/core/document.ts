import { SHEET_FORMATS } from './annotations';
import { geomBox } from './curves';
import { drawingScale, scaleGeneration, setDrawingScale } from './scale';
import type { Box } from './geom';
import type { DocFile, Entity, Layer, ViewState } from './types';

export type Change =
  | { t: 'add'; e: Entity }
  | { t: 'del'; e: Entity }
  | { t: 'upd'; before: Entity; after: Entity }
  | { t: 'layers'; before: Layer[]; after: Layer[]; activeBefore: string; activeAfter: string }
  | { t: 'scale'; before: number; after: number };

/**
 * A change in a form other devices can apply (live editing): entities are put or
 * deleted as a whole, layers sent as the full list. Applying one twice is harmless.
 */
export type SyncOp =
  | { t: 'put'; e: Entity }
  | { t: 'del'; id: string }
  | { t: 'layers'; layers: Layer[] }
  | { t: 'scale'; scale: number };

/** The sync ops of changes (or of undoing them). */
export function toSyncOps(changes: readonly Change[], inverse = false): SyncOp[] {
  const list = inverse ? [...changes].reverse() : changes;
  return list.map((c): SyncOp => {
    switch (c.t) {
      case 'add':
        return inverse ? { t: 'del', id: c.e.id } : { t: 'put', e: c.e };
      case 'del':
        return inverse ? { t: 'put', e: c.e } : { t: 'del', id: c.e.id };
      case 'upd':
        return { t: 'put', e: inverse ? c.before : c.after };
      case 'layers':
        return { t: 'layers', layers: inverse ? c.before : c.after };
      case 'scale':
        return { t: 'scale', scale: inverse ? c.before : c.after };
    }
  });
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

const MAX_HISTORY = 300;
const bboxCache = new WeakMap<Entity, { g: number; box: Box }>();

/** How far centre lines reach beyond a circle of radius r (mm). */
export function markExtent(r: number): number {
  const k = drawingScale();
  return Math.min(4 * k, Math.max(2 * k, r * 0.25));
}

/**
 * Axis-aligned bounds of what an entity draws (geometry plus centre-line cross,
 * without line width). Cached per immutable entity object.
 */
export function entityBox(e: Entity): Box {
  const g = scaleGeneration();
  const hit = bboxCache.get(e);
  if (hit && hit.g === g) return hit.box;
  let bx = { ...geomBox(e) };
  if ((e.kind === 'circle' || e.kind === 'arc') && e.mark) {
    const m = e.r + markExtent(e.r);
    bx = {
      minX: Math.min(bx.minX, e.c.x - m),
      minY: Math.min(bx.minY, e.c.y - m),
      maxX: Math.max(bx.maxX, e.c.x + m),
      maxY: Math.max(bx.maxY, e.c.y + m),
    };
  }
  bboxCache.set(e, { g, box: bx });
  return bx;
}

/**
 * The drawing: layers plus entities, with transactional undo/redo.
 * Entities are treated as immutable – updates replace the object.
 */
export class SketchDocument {
  layers: Layer[] = [];
  activeLayerId = '';
  /** Bumped on every change; renderers and autosave compare against it. */
  version = 0;
  /**
   * Drawing scale (world mm per paper mm), 0 while not chosen yet: the first stroke
   * then picks it from the zoom. Pen widths, texts and arrows are paper sizes.
   */
  private scaleValue = 0;

  private entities = new Map<string, Entity>();
  private nextZ = 1;
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private pending: Change[] | null = null;
  private byLayerCache: { version: number; map: Map<string, Entity[]> } | null = null;
  private listeners = new Set<() => void>();
  private opListeners = new Set<(ops: SyncOp[]) => void>();

  constructor() {
    this.reset();
  }

  /** Fresh drawing with a sketch layer and a clean-drawing layer. */
  reset(): void {
    const sketch: Layer = { id: newId('L'), name: 'Skizze', visible: true, locked: false, dimmed: false };
    const clean: Layer = { id: newId('L'), name: 'Reinzeichnung', visible: true, locked: false, dimmed: false };
    this.layers = [sketch, clean];
    this.activeLayerId = sketch.id;
    this.entities.clear();
    this.setScaleRaw(0);
    this.nextZ = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.touch();
  }

  /** Called with the sync ops of every committed step, undo and redo (not for remote ops). */
  onOps(fn: (ops: SyncOp[]) => void): () => void {
    this.opListeners.add(fn);
    return () => this.opListeners.delete(fn);
  }

  private emitOps(ops: SyncOp[]): void {
    if (ops.length) for (const fn of this.opListeners) fn(ops);
  }

  /**
   * Apply changes made on another device: no undo step, no commit hooks. Layers
   * keep this device's display flags (visible, locked, dimmed).
   */
  applyRemote(ops: readonly SyncOp[]): void {
    for (const op of ops) {
      if (op.t === 'put') {
        this.entities.set(op.e.id, op.e);
        if (op.e.z >= this.nextZ) this.nextZ = op.e.z + 1;
      } else if (op.t === 'del') {
        this.entities.delete(op.id);
      } else if (op.t === 'scale') {
        if (op.scale > 0) this.setScaleRaw(op.scale);
      } else if (op.layers.length) {
        const flags = new Map(this.layers.map((l) => [l.id, l]));
        this.layers = op.layers.map((l) => {
          const cur = flags.get(l.id);
          return cur ? { ...l, visible: cur.visible, locked: cur.locked, dimmed: cur.dimmed } : { ...l };
        });
        if (!this.layer(this.activeLayerId)) this.activeLayerId = this.layers[0].id;
      }
    }
    this.touch();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private touch(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ---- queries -------------------------------------------------------------

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  all(): IterableIterator<Entity> {
    return this.entities.values();
  }

  get size(): number {
    return this.entities.size;
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  get activeLayer(): Layer {
    return this.layer(this.activeLayerId) ?? this.layers[this.layers.length - 1];
  }

  /** Entities grouped per layer, sorted by z. Rebuilt lazily after changes. */
  byLayer(): Map<string, Entity[]> {
    if (this.byLayerCache && this.byLayerCache.version === this.version) return this.byLayerCache.map;
    const map = new Map<string, Entity[]>();
    for (const l of this.layers) map.set(l.id, []);
    for (const e of this.entities.values()) {
      let arr = map.get(e.layerId);
      if (!arr) map.set(e.layerId, (arr = []));
      arr.push(e);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.z - b.z);
    this.byLayerCache = { version: this.version, map };
    return map;
  }

  /** Entities on visible layers (optionally only unlocked ones). */
  *visibleEntities(includeLocked = true): Generator<Entity> {
    const byLayer = this.byLayer();
    for (const l of this.layers) {
      if (!l.visible || (!includeLocked && l.locked)) continue;
      const arr = byLayer.get(l.id);
      if (arr) yield* arr;
    }
  }

  allocZ(): number {
    return this.nextZ++;
  }

  // ---- mutations -----------------------------------------------------------

  /** Groups subsequent mutations into one undo step until `commit()`. */
  begin(): void {
    if (!this.pending) this.pending = [];
  }

  /**
   * Called when a step is about to be committed, with its changes. Mutations made
   * in here (e.g. hatches following their outlines) join the same undo step.
   */
  beforeCommit: ((changes: readonly Change[]) => void) | null = null;
  private inHook = false;

  commit(): void {
    const changes = this.pending;
    if (changes && changes.length && this.beforeCommit && !this.inHook) {
      this.inHook = true;
      try {
        this.beforeCommit(changes.slice());
      } finally {
        this.inHook = false;
      }
    }
    this.pending = null;
    if (!changes || changes.length === 0) return;
    this.emitOps(toSyncOps(changes));
    this.undoStack.push(changes);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private record(c: Change): void {
    if (this.pending) {
      this.pending.push(c);
    } else {
      // A single change is a step of its own.
      this.pending = [c];
      this.commit();
    }
  }

  add(e: Entity): void {
    this.entities.set(e.id, e);
    this.record({ t: 'add', e });
    this.touch();
  }

  remove(id: string): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.entities.delete(id);
    this.record({ t: 'del', e });
    this.touch();
  }

  /**
   * Replace an entity. `before` defaults to the current object; pass it explicitly
   * after a series of `replaceTransient` calls (live dragging) so undo restores the start state.
   */
  update(after: Entity, before?: Entity): void {
    const prev = before ?? this.entities.get(after.id);
    if (!prev) return;
    this.entities.set(after.id, after);
    this.record({ t: 'upd', before: prev, after });
    this.touch();
  }

  /** Replace without recording history (for live previews while dragging). */
  replaceTransient(e: Entity): void {
    if (!this.entities.has(e.id)) return;
    this.entities.set(e.id, e);
    this.touch();
  }

  /** The drawing scale (1 until one is chosen). */
  get scale(): number {
    return this.scaleValue || 1;
  }

  /** Whether the scale was chosen (by the user or the first stroke). */
  get scaleSet(): boolean {
    return this.scaleValue > 0;
  }

  /** Set the drawing scale as an undoable step. */
  setScale(v: number): void {
    if (!(v > 0) || v === this.scaleValue) return;
    const c: Change = { t: 'scale', before: this.scaleValue, after: v };
    this.setScaleRaw(v);
    this.record(c);
    this.touch();
  }

  private setScaleRaw(v: number): void {
    this.scaleValue = v;
    setDrawingScale(v || 1);
  }

  setLayers(layers: Layer[], activeLayerId = this.activeLayerId): void {
    const c: Change = {
      t: 'layers',
      before: this.layers,
      after: layers,
      activeBefore: this.activeLayerId,
      activeAfter: activeLayerId,
    };
    this.layers = layers;
    this.activeLayerId = activeLayerId;
    this.record(c);
    this.touch();
  }

  /**
   * Change display flags (visible / locked / dimmed) of a layer. Like in other
   * drawing apps these are not undo steps – undo only covers drawing and layer structure.
   */
  patchLayerView(id: string, patch: Partial<Pick<Layer, 'visible' | 'locked' | 'dimmed'>>): void {
    this.layers = this.layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
    this.touch();
  }

  /** Change the active layer (not an undoable edit). */
  setActiveLayer(id: string): void {
    if (this.activeLayerId === id || !this.layer(id)) return;
    this.activeLayerId = id;
    this.touch();
  }

  /** Delete a layer together with its entities, as one undo step. */
  deleteLayer(id: string): void {
    if (this.layers.length <= 1) return;
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.begin();
    for (const e of [...this.entities.values()]) if (e.layerId === id) this.remove(e.id);
    const layers = this.layers.filter((l) => l.id !== id);
    const active = this.activeLayerId === id ? layers[Math.min(idx, layers.length - 1)].id : this.activeLayerId;
    this.setLayers(layers, active);
    this.commit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    this.commit();
    const changes = this.undoStack.pop();
    if (!changes) return false;
    for (let i = changes.length - 1; i >= 0; i--) this.apply(changes[i], true);
    this.redoStack.push(changes);
    this.touch();
    this.emitOps(toSyncOps(changes, true));
    return true;
  }

  redo(): boolean {
    this.commit();
    const changes = this.redoStack.pop();
    if (!changes) return false;
    for (const c of changes) this.apply(c, false);
    this.undoStack.push(changes);
    this.touch();
    this.emitOps(toSyncOps(changes));
    return true;
  }

  private apply(c: Change, inverse: boolean): void {
    switch (c.t) {
      case 'add':
        if (inverse) this.entities.delete(c.e.id);
        else this.entities.set(c.e.id, c.e);
        break;
      case 'del':
        if (inverse) this.entities.set(c.e.id, c.e);
        else this.entities.delete(c.e.id);
        break;
      case 'upd':
        this.entities.set(c.after.id, inverse ? c.before : c.after);
        break;
      case 'layers': {
        // Keep the current display flags; history only restores structure and names.
        const flags = new Map(this.layers.map((l) => [l.id, l]));
        this.layers = (inverse ? c.before : c.after).map((l) => {
          const cur = flags.get(l.id);
          return cur ? { ...l, visible: cur.visible, locked: cur.locked, dimmed: cur.dimmed } : l;
        });
        this.activeLayerId = inverse ? c.activeBefore : c.activeAfter;
        if (!this.layer(this.activeLayerId)) this.activeLayerId = this.layers[0].id;
        break;
      }
      case 'scale':
        this.setScaleRaw(inverse ? c.before : c.after);
        break;
    }
  }

  // ---- (de)serialisation ---------------------------------------------------

  toFile(view?: ViewState): DocFile {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const entities = [...this.entities.values()]
      .sort((a, b) => a.z - b.z)
      .map((e): Entity => {
        const rv = (v: { x: number; y: number }) => ({ x: round(v.x), y: round(v.y) });
        switch (e.kind) {
          case 'line':
            return { ...e, a: rv(e.a), b: rv(e.b) };
          case 'stroke':
            return { ...e, pts: e.pts.map(round) };
          case 'circle':
            return { ...e, c: rv(e.c), r: round(e.r) };
          case 'arc':
            // Angles need more precision than millimetres.
            return { ...e, c: rv(e.c), r: round(e.r), start: Math.round(e.start * 1e7) / 1e7, sweep: Math.round(e.sweep * 1e7) / 1e7 };
          case 'hatch':
            return { ...e, loops: e.loops.map((l) => l.map(round)) };
          case 'text':
          case 'sheet':
            return { ...e, at: rv(e.at) };
          default:
            return e;
        }
      });
    return {
      format: 'skizzen-cad',
      version: 1,
      layers: this.layers.map((l) => ({ ...l })),
      activeLayerId: this.activeLayerId,
      entities,
      nextZ: this.nextZ,
      scale: this.scaleValue || undefined,
      view,
    };
  }

  /** Load a file; throws on invalid input. Clears the undo history. Returns the validated file. */
  loadFile(data: unknown): DocFile {
    const f = validateFile(data);
    this.layers = f.layers;
    this.activeLayerId = f.layers.some((l) => l.id === f.activeLayerId) ? f.activeLayerId : f.layers[0].id;
    this.entities.clear();
    let maxZ = 0;
    for (const e of f.entities) {
      this.entities.set(e.id, e);
      maxZ = Math.max(maxZ, e.z);
    }
    this.nextZ = Math.max(f.nextZ || 0, maxZ + 1);
    // Files from before the drawing scale were drawn at 1:1.
    this.setScaleRaw(f.scale ?? (f.entities.length ? 1 : 0));
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.touch();
    return f;
  }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec(v: unknown): boolean {
  return !!v && typeof v === 'object' && isNum((v as { x: unknown }).x) && isNum((v as { y: unknown }).y);
}

export function validateFile(data: unknown): DocFile {
  const f = data as Partial<DocFile>;
  if (!f || typeof f !== 'object' || f.format !== 'skizzen-cad') throw new Error('Keine Draftpad-Datei');
  if (f.version !== 1) throw new Error(`Unbekannte Dateiversion ${String(f.version)}`);
  if (!Array.isArray(f.layers) || f.layers.length === 0) throw new Error('Datei enthält keine Ebenen');
  if (!Array.isArray(f.entities)) throw new Error('Datei enthält keine Objekte');
  const layerIds = new Set<string>();
  const layers: Layer[] = f.layers.map((l, i) => {
    if (!l || typeof l.id !== 'string') throw new Error('Ungültige Ebene');
    layerIds.add(l.id);
    return {
      id: l.id,
      name: typeof l.name === 'string' ? l.name : `Ebene ${i + 1}`,
      visible: l.visible !== false,
      locked: !!l.locked,
      dimmed: !!l.dimmed,
    };
  });
  const entities: Entity[] = [];
  for (const e of f.entities) {
    if (!e || typeof e.id !== 'string' || !layerIds.has(e.layerId) || !e.style) continue;
    if (e.kind === 'line' && isVec(e.a) && isVec(e.b)) entities.push(e);
    else if (e.kind === 'stroke' && Array.isArray(e.pts) && e.pts.length >= 4 && e.pts.every(isNum)) entities.push(e);
    else if (e.kind === 'circle' && isVec(e.c) && isNum(e.r) && e.r > 0) entities.push(e);
    else if (e.kind === 'arc' && isVec(e.c) && isNum(e.r) && e.r > 0 && isNum(e.start) && isNum(e.sweep) && e.sweep !== 0) {
      entities.push(e);
    } else if (e.kind === 'hatch' && Array.isArray(e.loops) && e.loops.every((l) => Array.isArray(l) && l.length >= 6 && l.every(isNum))) {
      entities.push(e);
    } else if (e.kind === 'dim' && isVec(e.p1) && isVec(e.p2) && isNum(e.off)) {
      entities.push(e);
    } else if ((e.kind === 'datum' || e.kind === 'gtol') && isVec(e.at) && isVec(e.p)) {
      entities.push(e);
    } else if (e.kind === 'text' && isVec(e.at) && typeof e.text === 'string' && isNum(e.size) && e.size > 0 && isNum(e.angle)) {
      entities.push(e);
    } else if (e.kind === 'sheet' && isVec(e.at) && SHEET_FORMATS.includes(e.format) && isNum(e.scale) && e.scale > 0 && e.fields) {
      entities.push(e);
    }
  }
  return {
    format: 'skizzen-cad',
    version: 1,
    layers,
    activeLayerId: typeof f.activeLayerId === 'string' ? f.activeLayerId : layers[0].id,
    entities,
    nextZ: isNum(f.nextZ) ? f.nextZ : 1,
    scale: isNum(f.scale) && f.scale > 0 ? f.scale : undefined,
    view: f.view && isNum(f.view.scale) && isNum(f.view.rot) && isNum(f.view.tx) && isNum(f.view.ty) ? f.view : undefined,
  };
}
