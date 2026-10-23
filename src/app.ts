import { drawingScale, formatScale, nearestScale, setDrawingScale, worldWidth } from './core/scale';
import { Camera } from './core/camera';
import { intersectSegment, project } from './core/curves';
import { entityBox, newId, SketchDocument, type Change, type SyncOp } from './core/document';
import { boxExpand, boxesIntersect, boxUnion, drawingAngleDeg, dist, emptyBox, isEmptyBox, type Box, type Vec } from './core/geom';
import { DEFAULT_STYLE, PAPER_COLORS, penColor, setPenTheme, type Theme } from './core/pens';
import { findSnap, snapAngle, snapCandidates, softSnapAngle, type AngleMode, type SnapHit } from './core/snap';
import { mirrorGroup, transformEntity, type Affine } from './core/transform';
import { isAnnotation, type Entity, type HatchPattern, type LineEntity, type Style } from './core/types';
import { ACCENT, drawCursorDot, drawMirrorToggle, drawSnapMarker, formatAngle, formatLength } from './render/overlay';
import { Painter } from './render/painter';
import { SceneRenderer } from './render/scene';
import { idbGet, idbSet, loadPref, savePref } from './storage/idb';
import { ArcTool } from './tools/arc';
import { CircleTool } from './tools/circle';
import { CrossTool } from './tools/cross';
import { DeleteTool } from './tools/delete';
import { EraserTool } from './tools/eraser';
import { DimTool } from './tools/dim';
import { FilletTool } from './tools/fillet';
import { RectTool } from './tools/rect';
import { TextTool } from './tools/text';
import { sameGeometry, TraceTool } from './tools/trace';
import { PartTool } from './tools/part';
import type { PartSpec } from './core/parts';
import type { LiveSession } from './storage/live';
import { GpsTool } from './tools/gps';
import { FreehandTool } from './tools/freehand';
import { HATCH_GAPS, HatchTool, isBoundary, refitHatch } from './tools/hatch';
import { LineTool } from './tools/line';
import { SelectTool } from './tools/select';
import type { PointerKind, Tool } from './tools/tool';
import { TrimTool } from './tools/trim';

export type ToolId =
  | 'select'
  | 'freehand'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'cross'
  | 'delete'
  | 'trim'
  | 'erase'
  | 'fillet'
  | 'trace'
  | 'hatch'
  | 'dim'
  | 'gps'
  | 'text'
  | 'part';

export interface Settings {
  grid: boolean;
  /** Endpoint/midpoint/intersection snapping. */
  snap: boolean;
  angleMode: AngleMode;
  /** Correction handles on the most recent line or circle. */
  handles: boolean;
  /** Draw with the finger (otherwise one finger pans). */
  fingerDraws: boolean;
  /** Two-finger rotation of the view. */
  rotate: boolean;
  /** New circles get a centre-line cross. */
  centerMarks: boolean;
  /** Arc tool: 'auto' = tangential at line/arc ends, else centre first; 'center' = always centre first. */
  arcMode: 'auto' | 'center';
  /** Angle snap step in degrees. */
  angleStep: number;
  /** Freehand smoothing: length of the lazy string in CSS px (0 = off). */
  stabilizer: number;
  theme: 'system' | 'light' | 'dark';
  hatchPattern: HatchPattern;
  /** Hatch line spacing in mm. */
  hatchSpacing: number;
  /** Gaps up to this size (mm) still close an area for hatching. */
  hatchGap: number;
  /** GPS tool: place datum symbols or tolerance frames. */
  gpsMode: 'datum' | 'gtol';
  /** Fillet radius in mm (0 = sharp corner). */
  filletRadius: number;
  /** Letter height of new texts in mm. */
  textSize: number;
  /** Lengths of new lines (and radii, rectangle sides) go in these steps (mm, 0 = free). */
  lengthStep: number;
  /** Standard part placed by the parts tool. */
  part: PartSpec;
}

/** With the angle snap off, lines still settle onto 0°/45°/90°… when this close (degrees). */
export const SOFT_ANGLE_TOL = 1;
/** CSS px per mm at 100 % zoom (96 dpi). */
export const MM_PX = 96 / 25.4;
const SNAP_PX: Record<PointerKind, number> = { pen: 12, mouse: 10, touch: 20 };
const HANDLE_PX: Record<PointerKind, number> = { pen: 16, mouse: 12, touch: 24 };
/** How close (CSS px) the pointer must be to pick an entity. */
const HIT_PX: Record<PointerKind, number> = { pen: 10, mouse: 8, touch: 16 };
const AUTOSAVE_KEY = 'current';
/** Snap points within this many snap radii are shown (faintly) under a hovering pen. */
const HOVER_CANDIDATES = 4;

const DEFAULT_SETTINGS: Settings = {
  grid: true,
  snap: true,
  angleMode: 'snap',
  handles: false,
  fingerDraws: false,
  rotate: true,
  centerMarks: true,
  arcMode: 'auto',
  angleStep: 5,
  stabilizer: 0,
  theme: 'system',
  hatchPattern: 'diag',
  hatchSpacing: 2,
  hatchGap: 0.5,
  gpsMode: 'datum',
  filletRadius: 3,
  textSize: 3.5,
  lengthStep: 0.5,
  part: { kind: 'socketScrew', size: 'M8', view: 'side', length: 30 },
};

/**
 * Whether new drawing of this kind is mirrored at active axes. Axes themselves are
 * not (that would multiply them), nor are dimensions and GPS symbols.
 */
function mirrorable(e: Entity): boolean {
  if (e.kind === 'line' && e.axis) return false;
  return e.kind !== 'dim' && e.kind !== 'datum' && e.kind !== 'gtol' && e.kind !== 'text' && e.kind !== 'sheet';
}

interface Widget {
  p: Vec;
  r: number;
  onTap: () => void;
}

/** Central application state and render loop. */
export class App {
  readonly doc = new SketchDocument();
  readonly cam = new Camera();
  settings: Settings = loadPref('settings', DEFAULT_SETTINGS);
  style: Style = loadPref('style', DEFAULT_STYLE);
  toolId: ToolId;
  readonly tools: Record<ToolId, Tool>;
  /** Selected entity ids (only used by the selection tool). */
  selection = new Set<string>();
  /** Set by the input controller (Alt key / finger held while drawing with the pen). */
  snapSuspended = false;
  /** Live editing session (set up by main). */
  live: LiveSession | null = null;
  /** Shift held: lengths are free (no length steps) while it is down. */
  lengthFree = false;
  /** Pen or mouse hovering over the canvas without contact (screen CSS px). */
  private hoverAt: { screen: Vec; type: PointerKind } | null = null;

  width = 0;
  height = 0;
  dpr = 1;

  private scene: SceneRenderer;
  private overlayCtx: CanvasRenderingContext2D;
  private overlayPainter: Painter;
  private sceneDirty = true;
  private overlayDirty = true;
  private frameRequested = false;
  private uiListeners = new Set<() => void>();
  private viewListeners = new Set<() => void>();
  private viewDirty = false;
  private toastFn: (msg: string) => void = () => {};
  private saveTimer: number | undefined;
  private loaded = false;
  private widgets: Widget[] = [];
  /** Last full scene render, reused (transformed) while zooming/panning heavy drawings. */
  private snapshot: { canvas: HTMLCanvasElement; m: DOMMatrix } | null = null;
  private lastRenderMs = 0;
  private docDirty = true;
  private settleTimer: number | undefined;
  private mirrorCache: { version: number; list: Affine[] } | null = null;

  constructor(
    private sceneCanvas: HTMLCanvasElement,
    private overlayCanvas: HTMLCanvasElement,
  ) {
    this.scene = new SceneRenderer(sceneCanvas);
    const octx = overlayCanvas.getContext('2d');
    if (!octx) throw new Error('Canvas 2D wird nicht unterstützt');
    this.overlayCtx = octx;
    this.overlayPainter = new Painter(octx);
    this.tools = {
      select: new SelectTool(this),
      freehand: new FreehandTool(this),
      line: new LineTool(this),
      circle: new CircleTool(this),
      arc: new ArcTool(this),
      cross: new CrossTool(this),
      delete: new DeleteTool(this),
      trim: new TrimTool(this),
      erase: new EraserTool(this),
      hatch: new HatchTool(this),
      dim: new DimTool(this),
      gps: new GpsTool(this),
      rect: new RectTool(this),
      fillet: new FilletTool(this),
      trace: new TraceTool(this),
      part: new PartTool(this),
      text: new TextTool(this),
    };
    this.doc.beforeCommit = (changes) => {
      this.autoScale(changes);
      this.refitHatches(changes);
    };
    // Gap tolerances that are no longer offered fall back to the smallest one.
    if (!(HATCH_GAPS as readonly number[]).includes(this.settings.hatchGap)) this.settings.hatchGap = HATCH_GAPS[0];
    const savedTool = loadPref<{ id: ToolId }>('tool', { id: 'line' }).id;
    this.toolId = savedTool in this.tools ? savedTool : 'line';

    this.applyTheme();
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());

    this.doc.onChange(() => {
      this.docDirty = true;
      this.sceneDirty = true;
      this.overlayDirty = true;
      this.scheduleFrame();
      this.emit();
      this.scheduleSave();
    });
  }

  get tool(): Tool {
    return this.tools[this.toolId];
  }

  // ---- lifecycle ------------------------------------------------------------

  async load(): Promise<void> {
    const saved = await idbGet<unknown>(AUTOSAVE_KEY);
    let viewRestored = false;
    if (saved) {
      try {
        const view = this.doc.loadFile(saved).view;
        if (view) {
          this.cam.state = view;
          viewRestored = true;
        }
      } catch (err) {
        console.warn('Autosave konnte nicht geladen werden', err);
        this.doc.reset();
      }
    }
    if (!viewRestored) this.resetView();
    this.loaded = true;
    this.viewChanged();
    this.emit();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    // Keep the view centre stable across rotations of the device.
    if (this.width > 0) this.cam.panBy((w - this.width) / 2, (h - this.height) / 2);
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    for (const c of [this.sceneCanvas, this.overlayCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.docDirty = true;
    this.snapshot = null;
    this.viewChanged();
  }

  // ---- UI plumbing ----------------------------------------------------------

  onUiChange(fn: () => void): void {
    this.uiListeners.add(fn);
  }

  emit(): void {
    for (const fn of this.uiListeners) fn();
  }

  /** Called once per frame after the view (pan/zoom/rotation) changed. */
  onViewChange(fn: () => void): void {
    this.viewListeners.add(fn);
  }

  setToast(fn: (msg: string) => void): void {
    this.toastFn = fn;
  }

  toast(msg: string): void {
    this.toastFn(msg);
  }

  setTool(id: ToolId): void {
    if (id === this.toolId) return;
    this.tool.reset();
    this.toolId = id;
    if (id !== 'select') this.selection.clear();
    savePref('tool', { id });
    this.requestOverlay();
    this.emit();
  }

  /**
   * Change the drawing style. With a selection in the selection tool the change
   * also applies to the selected entities (one undo step).
   */
  setStyle(p: Partial<Style>): void {
    this.style = { ...this.style, ...p };
    savePref('style', this.style);
    const sel = this.selectedEntities();
    if (this.toolId === 'select' && sel.length) {
      this.doc.begin();
      for (const e of sel) this.doc.update({ ...e, style: { ...e.style, ...p } } as Entity);
      this.doc.commit();
    }
    this.emit();
  }

  /** Resolved colour theme. */
  get theme(): Theme {
    const t = this.settings.theme;
    if (t !== 'system') return t;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private applyTheme(): void {
    this.docDirty = true;
    const t = this.theme;
    setPenTheme(t);
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#1c1d21' : '#fbfaf6');
    this.sceneDirty = true;
    this.overlayDirty = true;
    this.scheduleFrame();
  }

  updateSettings(p: Partial<Settings>): void {
    this.docDirty = true;
    const themeChanged = p.theme !== undefined && p.theme !== this.settings.theme;
    this.settings = { ...this.settings, ...p };
    if (themeChanged) this.applyTheme();
    savePref('settings', this.settings);
    this.sceneDirty = true;
    this.overlayDirty = true;
    this.scheduleFrame();
    this.emit();
  }

  undo(): void {
    this.tool.cancel();
    if (!this.doc.undo()) this.toast('Nichts zum Rückgängigmachen');
  }

  redo(): void {
    this.tool.cancel();
    if (!this.doc.redo()) this.toast('Nichts zum Wiederherstellen');
  }

  /** Checks that the active layer can take new drawing; otherwise explains why not. */
  ensureDrawableLayer(): boolean {
    const l = this.doc.activeLayer;
    if (!l.visible) {
      this.toast(`Ebene „${l.name}“ ist ausgeblendet`);
      return false;
    }
    if (l.locked) {
      this.toast(`Ebene „${l.name}“ ist gesperrt`);
      return false;
    }
    return true;
  }

  /** A new entity on the active layer with the current style. */
  newEntity<T extends Entity>(data: Omit<T, 'id' | 'layerId' | 'z' | 'style'>, prefix = 'E'): T {
    return {
      ...data,
      id: newId(prefix),
      layerId: this.doc.activeLayerId,
      z: this.doc.allocZ(),
      style: { ...this.style },
    } as T;
  }

  // ---- selection --------------------------------------------------------------

  /** Selected entities that still exist (undo may have removed some). */
  selectedEntities(): Entity[] {
    const out: Entity[] = [];
    for (const id of [...this.selection]) {
      const e = this.doc.get(id);
      if (e && this.isEditable(e)) out.push(e);
      else this.selection.delete(id);
    }
    return out;
  }

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set(ids);
    this.requestOverlay();
    this.emit();
  }

  /** Entity on a visible, unlocked layer. */
  isEditable(e: Entity): boolean {
    const l = this.doc.layer(e.layerId);
    return !!l && l.visible && !l.locked;
  }

  selectAll(): void {
    this.setTool('select');
    const ids: string[] = [];
    for (const e of this.doc.visibleEntities(false)) ids.push(e.id);
    this.setSelection(ids);
  }

  /** Nearest entity under a pointer (visible; `editable` = on unlocked layers only). */
  hitEntity(world: Vec, pointerType: PointerKind, editable = true): { e: Entity; d: number; s: number } | null {
    const r = this.cam.px(HIT_PX[pointerType]);
    let best: { e: Entity; d: number; s: number } | null = null;
    for (const e of this.doc.visibleEntities(!editable)) {
      const bx = entityBox(e);
      const m = r + worldWidth(e) / 2;
      if (world.x < bx.minX - m || world.x > bx.maxX + m || world.y < bx.minY - m || world.y > bx.maxY + m) continue;
      const pr = project(e, world);
      // Inside a hatch counts as a weak hit so lines within it still win.
      const d = e.kind === 'hatch' ? Math.max(r * 0.9, pr.d) : Math.max(0, pr.d - worldWidth(e) / 2);
      // Later (upper) entities win ties.
      if (d <= r && (!best || d <= best.d)) best = { e, d, s: pr.s };
    }
    return best;
  }

  hitRadius(pointerType: PointerKind): number {
    return this.cam.px(HIT_PX[pointerType]);
  }

  // ---- symmetry -------------------------------------------------------------------

  /** Active symmetry axes: lines marked as axis with mirroring on, on visible layers. */
  axes(): LineEntity[] {
    const out: LineEntity[] = [];
    for (const e of this.doc.visibleEntities()) if (e.kind === 'line' && e.axis) out.push(e);
    return out;
  }

  /** Transforms producing the mirrored copies of new drawing (empty without active axes). */
  mirrors(): Affine[] {
    if (this.mirrorCache && this.mirrorCache.version === this.doc.version) return this.mirrorCache.list;
    const list = mirrorGroup(this.axes().filter((a) => a.mirror).map((a) => [a.a, a.b] as [Vec, Vec]));
    this.mirrorCache = { version: this.doc.version, list };
    return list;
  }

  /** Mirrored copies of an entity; previews get stable ids so their look doesn't flicker. */
  mirrorCopies<T extends Entity>(e: T, preview = false): T[] {
    return this.mirrors().map((m, i) => transformEntity(e, m, preview ? `${e.id}~${i}` : newId('M')));
  }

  /** The scale the zoom suggests (1:1 at 100 %). */
  zoomScale(): number {
    return nearestScale(MM_PX / this.cam.scale);
  }

  /** The first stroke on an empty drawing fixes the scale from the zoom (same undo step). */
  private autoScale(changes: readonly Change[]): void {
    if (this.doc.scaleSet) return;
    const added = new Set(changes.flatMap((c) => (c.t === 'add' ? [c.e.id] : [])));
    if (!added.size || this.doc.size === 0) return;
    for (const e of this.doc.all()) if (!added.has(e.id)) return;
    this.doc.setScale(drawingScale());
  }

  /** Set the drawing scale; a sheet in the drawing follows it. */
  setScale(v: number): void {
    if (v === this.doc.scale && this.doc.scaleSet) return;
    this.doc.begin();
    this.doc.setScale(v);
    this.onScaleChange?.(v);
    this.doc.commit();
    this.toast(`Maßstab ${formatScale(v)}`);
  }

  /** Hook for the sheet to follow the drawing scale (set by the sheet module). */
  onScaleChange: ((v: number) => void) | null = null;

  /**
   * Hatches follow their outlines: after a step that changed boundary lines near a
   * hatch, its area is found again (same undo step).
   */
  private refitHatches(changes: readonly Change[]): void {
    const boxes: Box[] = [];
    for (const c of changes) {
      const es = c.t === 'upd' ? [c.before, c.after] : c.t === 'add' || c.t === 'del' ? [c.e] : [];
      for (const e of es) if (isBoundary(e)) boxes.push(entityBox(e));
    }
    if (!boxes.length) return;
    for (const h of [...this.doc.all()]) {
      if (h.kind !== 'hatch') continue;
      const l = this.doc.layer(h.layerId);
      if (!l?.visible) continue;
      const hb = boxExpand(entityBox(h), 2);
      if (!boxes.some((b) => boxesIntersect(b, hb))) continue;
      const loops = refitHatch(() => this.doc.visibleEntities(), h, h.gap ?? this.settings.hatchGap);
      if (loops && JSON.stringify(loops) !== JSON.stringify(h.loops)) this.doc.update({ ...h, loops });
    }
  }

  /**
   * Counterparts of an existing entity at the active symmetry axes: entities whose
   * shape is its mirror image (with the transform that maps it there). The entity
   * itself is included when it is its own mirror image (e.g. a line across the axis).
   */
  mirrorTwins(e: Entity): { twin: Entity; m: Affine }[] {
    const out: { twin: Entity; m: Affine }[] = [];
    // Axes are never mirrored (as when drawing).
    if (isAnnotation(e) || (e.kind === 'line' && e.axis)) return out;
    for (const m of this.mirrors()) {
      const img = transformEntity(e, m);
      const bx = boxExpand(entityBox(img), 0.01);
      for (const c of this.doc.visibleEntities(false)) {
        if (c.kind !== e.kind || !boxesIntersect(entityBox(c), bx)) continue;
        if (sameGeometry(c, img)) out.push({ twin: c, m });
      }
    }
    return out;
  }

  /** Add new entities together with their mirrored copies as one undo step. */
  addDrawn(...entities: Entity[]): void {
    this.doc.begin();
    for (const e of entities) {
      this.doc.add(e);
      if (!mirrorable(e)) continue;
      // A shape symmetric to the axis (e.g. a line across it) is its own mirror image: no duplicates.
      const placed: Entity[] = [e];
      for (const c of this.mirrorCopies(e)) {
        if (placed.some((p) => sameGeometry(p, c))) continue;
        placed.push(c);
        this.doc.add({ ...c, z: this.doc.allocZ() });
      }
    }
    this.doc.commit();
  }

  toggleMirror(axis: LineEntity): void {
    const on = !axis.mirror;
    this.doc.update({ ...axis, mirror: on });
    this.toast(on ? 'Spiegeln an dieser Achse: an' : 'Spiegeln an dieser Achse: aus');
  }

  /** Tap on an on-canvas control (e.g. mirror toggle)? Handles it and returns true. */
  tapWidget(screen: Vec): boolean {
    for (const w of this.widgets) {
      if (dist(w.p, screen) <= w.r) {
        w.onTap();
        return true;
      }
    }
    return false;
  }

  private drawAxes(ctx: CanvasRenderingContext2D): void {
    this.widgets = [];
    const W = this.width;
    const H = this.height;
    for (const axis of this.axes()) {
      const a = this.cam.toScreen(axis.a);
      const b = this.cam.toScreen(axis.b);
      const len = dist(a, b);
      if (len < 1e-6) continue;
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      // The whole infinite line across the screen.
      const far = W + H;
      const p0 = { x: a.x - u.x * far, y: a.y - u.y * far };
      const p1 = { x: a.x + u.x * far, y: a.y + u.y * far };
      if (axis.mirror) {
        ctx.save();
        ctx.strokeStyle = ACCENT;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.restore();
      }
      // Toggle beyond the axis end, pulled back on screen if necessary.
      const inset = 28;
      const inside = (p: Vec) => p.x >= inset && p.x <= W - inset && p.y >= inset && p.y <= H - inset;
      // Prefer the upper end: the palette usually sits at the bottom.
      const atB = { x: b.x + u.x * 26, y: b.y + u.y * 26 };
      const atA = { x: a.x - u.x * 26, y: a.y - u.y * 26 };
      let pos = atA.y <= atB.y ? atA : atB;
      if (!inside(pos)) pos = pos === atA ? atB : atA;
      if (!inside(pos)) {
        // Walk along the infinite line to the last on-screen spot on b's side.
        let best: Vec | null = null;
        for (let t = -far; t <= far; t += 8) {
          const q = { x: a.x + u.x * t, y: a.y + u.y * t };
          if (inside(q) && (!best || t > 0)) best = q;
        }
        if (!best) continue;
        pos = best;
      }
      drawMirrorToggle(ctx, pos, !!axis.mirror, u);
      this.widgets.push({ p: pos, r: 18, onTap: () => this.toggleMirror(axis) });
    }
  }

  // ---- snapping ---------------------------------------------------------------

  snapRadius(pointerType: PointerKind): number {
    return this.cam.px(SNAP_PX[pointerType]);
  }

  handleHitRadius(pointerType: PointerKind): number {
    return HANDLE_PX[pointerType];
  }

  /** Snap a free point (e.g. line start) to existing geometry. */
  snapPoint(world: Vec, pointerType: PointerKind, exclude?: ReadonlySet<string>): { p: Vec; hit: SnapHit | null } {
    if (!this.settings.snap || this.snapSuspended) return { p: world, hit: null };
    const hit = findSnap(this.doc, world, this.snapRadius(pointerType), { end: true, mid: true, int: true, on: true, exclude });
    return hit ? { p: hit.p, hit } : { p: world, hit: null };
  }

  /**
   * Resolve the moving end of a segment anchored at `anchor`. With the angle snap on
   * the angle always holds (`holdAngle`, e.g. drawing lines); otherwise, or when
   * moving things, geometry snaps win and the angle snap applies in between.
   */
  resolveEnd(
    anchor: Vec,
    world: Vec,
    pointerType: PointerKind,
    exclude?: ReadonlySet<string>,
    holdAngle = true,
  ): { p: Vec; hit: SnapHit | null } {
    const s = this.snapPoint(world, pointerType, exclude);
    if (holdAngle && this.settings.angleMode === 'snap' && !this.snapSuspended) {
      // The angle snap always holds: a snap point only counts when it lies on the
      // snapped direction; otherwise the end goes where that ray meets the geometry.
      const step = this.settings.angleStep;
      const a = snapAngle(anchor, world, step);
      if (s.hit && s.hit.kind !== 'on' && dist(s.hit.p, anchor) > 1e-9) {
        const deg = drawingAngleDeg(anchor, s.hit.p);
        const off = Math.abs(((deg - Math.round(deg / step) * step + 540) % 360) - 180);
        if (off < 0.05) return s;
      }
      if (this.settings.snap) {
        const r = this.rayHit(anchor, a, this.snapRadius(pointerType) * 1.5, exclude);
        if (r) return r;
      }
      return { p: this.stepLength(anchor, a), hit: null };
    }
    if (s.hit && dist(s.hit.p, anchor) > 1e-9) return s;
    if (this.snapSuspended) return { p: world, hit: null };
    const p = this.settings.angleMode === 'snap' ? snapAngle(anchor, world, this.settings.angleStep) : softSnapAngle(anchor, world, SOFT_ANGLE_TOL);
    return { p: holdAngle ? this.stepLength(anchor, p) : p, hit: null };
  }

  /** Length rounded to the length step (unless free: step off, Shift or snapping suspended). */
  stepValue(len: number): number {
    const step = this.settings.lengthStep * this.doc.scale;
    if (step <= 0 || this.lengthFree || this.snapSuspended) return len;
    return Math.max(step, Math.round(len / step) * step);
  }

  /** p moved along anchor→p so the distance is a whole number of length steps. */
  stepLength(anchor: Vec, p: Vec): Vec {
    const l = dist(anchor, p);
    if (l < 1e-9) return p;
    const k = this.stepValue(l) / l;
    return { x: anchor.x + (p.x - anchor.x) * k, y: anchor.y + (p.y - anchor.y) * k };
  }

  /** Where the ray anchor→target first meets existing geometry near the target (within r). */
  private rayHit(anchor: Vec, target: Vec, r: number, exclude?: ReadonlySet<string>): { p: Vec; hit: SnapHit } | null {
    const len = dist(anchor, target);
    if (len < 1e-9) return null;
    const u = { x: (target.x - anchor.x) / len, y: (target.y - anchor.y) / len };
    const far = { x: anchor.x + u.x * (len + 2 * r), y: anchor.y + u.y * (len + 2 * r) };
    let best: Vec | null = null;
    let bd = r;
    for (const e of this.doc.visibleEntities()) {
      if (exclude?.has(e.id) || isAnnotation(e)) continue;
      const bx = entityBox(e);
      if (target.x < bx.minX - r || target.x > bx.maxX + r || target.y < bx.minY - r || target.y > bx.maxY + r) continue;
      for (const q of intersectSegment(e, anchor, far)) {
        const d = dist(q, target);
        if (d <= bd && dist(q, anchor) > 1e-6) {
          bd = d;
          best = q;
        }
      }
    }
    return best ? { p: best, hit: { p: best, kind: 'int' } } : null;
  }

  /**
   * Snap an angle in degrees (rotation, arc sweep): 5° steps with the angle snap on,
   * otherwise only a gentle pull to multiples of 45°.
   */
  snapDegrees(deg: number): number {
    if (this.snapSuspended) return deg;
    const step = this.settings.angleStep;
    if (this.settings.angleMode === 'snap') return Math.round(deg / step) * step;
    const t = Math.round(deg / 45) * 45;
    return Math.abs(deg - t) <= SOFT_ANGLE_TOL ? t : deg;
  }

  measureText(a: Vec, b: Vec): string {
    const len = formatLength(dist(a, b), this.cam.scale);
    if (this.settings.angleMode === 'off') return len;
    return `${len}  ·  ${formatAngle(drawingAngleDeg(a, b))}`;
  }

  radiusText(r: number): string {
    const f = (v: number) => formatLength(v, this.cam.scale).replace(' mm', '');
    return `R ${f(r)}  ·  Ø ${f(2 * r)} mm`;
  }

  arcText(r: number, sweep: number): string {
    const f = formatLength(r, this.cam.scale).replace(' mm', '');
    return `R ${f} mm  ·  ${formatAngle((Math.abs(sweep) * 180) / Math.PI)}`;
  }

  // ---- view -----------------------------------------------------------------

  viewChanged(): void {
    this.sceneDirty = true;
    this.overlayDirty = true;
    this.viewDirty = true;
    this.scheduleFrame();
    this.scheduleSave();
    // Heavy drawings show a moved snapshot while the view is in motion; render crisply once it settles.
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.docDirty = true;
      this.sceneDirty = true;
      this.scheduleFrame();
    }, 140);
  }

  private deviceMatrix(): DOMMatrix {
    const [a, b, c, d, e, f] = this.cam.matrix();
    const k = this.dpr;
    return new DOMMatrix([a * k, b * k, c * k, d * k, e * k, f * k]);
  }

  private renderScene(): void {
    const fast = !this.docDirty && this.snapshot && this.lastRenderMs > 12;
    const ctx = this.sceneCanvas.getContext('2d')!;
    if (fast && this.snapshot) {
      const rel = this.deviceMatrix().multiply(this.snapshot.m.inverse());
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER_COLORS[this.theme];
      ctx.fillRect(0, 0, this.sceneCanvas.width, this.sceneCanvas.height);
      ctx.setTransform(rel);
      ctx.drawImage(this.snapshot.canvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    const t0 = performance.now();
    this.scene.render(this.doc, this.cam, this.width, this.height, this.dpr, { grid: this.settings.grid });
    this.lastRenderMs = performance.now() - t0;
    this.docDirty = false;
    // Keep a copy for fast view changes.
    if (this.lastRenderMs > 12) {
      let c = this.snapshot?.canvas;
      if (!c || c.width !== this.sceneCanvas.width || c.height !== this.sceneCanvas.height) {
        c = document.createElement('canvas');
        c.width = this.sceneCanvas.width;
        c.height = this.sceneCanvas.height;
      }
      c.getContext('2d')!.drawImage(this.sceneCanvas, 0, 0);
      this.snapshot = { canvas: c, m: this.deviceMatrix() };
    } else {
      this.snapshot = null;
    }
  }

  resetView(): void {
    this.cam.state = { scale: MM_PX, rot: 0, tx: 0, ty: 0 };
    this.cam.anchor({ x: 0, y: 0 }, { x: this.width / 2, y: this.height / 2 });
    this.viewChanged();
  }

  /** Zoom to show the whole drawing (or reset when empty). */
  /** Show a world box (with a margin). */
  fitBox(bx: import('./core/geom').Box): void {
    this.cam.fit(bx, this.width, this.height, Math.min(60, Math.min(this.width, this.height) / 8));
    this.viewChanged();
  }

  fitAll(): void {
    let bx = emptyBox();
    for (const e of this.doc.visibleEntities()) bx = boxUnion(bx, entityBox(e));
    if (isEmptyBox(bx)) {
      this.resetView();
      return;
    }
    this.cam.fit(bx, this.width, this.height, Math.min(80, Math.min(this.width, this.height) / 6));
    this.viewChanged();
  }

  resetRotation(): void {
    this.cam.rotateAt({ x: this.width / 2, y: this.height / 2 }, 0);
    this.viewChanged();
  }

  // ---- rendering --------------------------------------------------------------

  requestOverlay(): void {
    this.overlayDirty = true;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.frame();
    });
  }

  private frame(): void {
    // Until the scale is chosen, it follows the zoom (so the first stroke looks as it will).
    if (!this.doc.scaleSet) {
      const k = this.zoomScale();
      if (k !== drawingScale()) {
        setDrawingScale(k);
        this.sceneDirty = true;
        this.overlayDirty = true;
        this.viewDirty = true;
      }
    }
    if (this.viewDirty) {
      this.viewDirty = false;
      for (const fn of this.viewListeners) fn();
    }
    if (this.sceneDirty) {
      this.sceneDirty = false;
      this.renderScene();
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      const ctx = this.overlayCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawAxes(ctx);
      this.tool.overlay(ctx);
      this.drawHover(ctx);
    }
  }

  /** Pointer hovering without contact (null when it leaves or touches down). */
  setHover(screen: Vec | null, type: PointerKind = 'pen'): void {
    const prev = this.hoverAt;
    this.hoverAt = screen ? { screen, type } : null;
    if (prev || screen) this.requestOverlay();
  }

  /**
   * Under a hovering pen: a small cursor dot, the snap points nearby (faint) and
   * the one a press would catch (bold) – the same snap the tool then uses.
   */
  private drawHover(ctx: CanvasRenderingContext2D): void {
    const h = this.hoverAt;
    const tool = this.tool;
    if (!h || tool.busy) return;
    if (tool.hoverSnap && this.settings.snap && !this.snapSuspended) {
      const world = this.cam.toWorld(h.screen);
      const hit = this.snapPoint(world, h.type).hit;
      const r = this.snapRadius(h.type);
      for (const c of snapCandidates(this.doc, world, r * HOVER_CANDIDATES)) {
        if (hit && dist(c.p, hit.p) < 1e-9) continue;
        drawSnapMarker(ctx, this.cam.toScreen(c.p), c.kind, true);
      }
      if (hit) drawSnapMarker(ctx, this.cam.toScreen(hit.p), hit.kind);
    }
    // The mouse has its own cursor; the Pencil gets a dot showing where it would touch.
    if (h.type === 'pen' && tool.id !== 'erase') drawCursorDot(ctx, h.screen, penColor(this.style), PAPER_COLORS[this.theme]);
  }

  private worldPainter(): Painter {
    this.overlayPainter.begin(this.cam, this.dpr, this.cam.visibleBox(this.width, this.height));
    return this.overlayPainter;
  }

  private screenSpace(): void {
    this.overlayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Paint an entity preview onto the overlay (no mirrored copies). */
  paintPreview(e: Entity, alpha = 0.9): void {
    this.worldPainter().draw(e, alpha);
    this.screenSpace();
  }

  /** Paint an entity preview (and its mirrored copies) onto the overlay. */
  paintWorld(e: Entity): void {
    const p = this.worldPainter();
    p.draw(e);
    if (mirrorable(e)) for (const c of this.mirrorCopies(e, true)) p.draw(c, 0.55);
    this.screenSpace();
  }

  /**
   * Dashed construction guide of an entity plus its mirrored copies; `mirrorsOnly`
   * skips the original (when the tool draws it itself).
   */
  paintGuide(e: Entity, mirrorsOnly = false, alpha = 1): void {
    const p = this.worldPainter();
    if (!mirrorsOnly) p.guide(e, ACCENT, alpha);
    for (const c of this.mirrorCopies(e, true)) p.guide(c, ACCENT, alpha * 0.5);
    this.screenSpace();
  }

  /** Coloured halo around entities (selection, delete preview). */
  paintHighlight(entities: Iterable<Entity>, color: string, alpha: number, extraPx = 5): void {
    const p = this.worldPainter();
    for (const e of entities) p.highlight(e, color, alpha, extraPx);
    this.screenSpace();
  }

  // ---- persistence ------------------------------------------------------------

  private scheduleSave(): void {
    if (!this.loaded) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 600);
  }

  async saveNow(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    if (!this.loaded) return;
    const ok = await idbSet(AUTOSAVE_KEY, this.doc.toFile(this.cam.state));
    if (!ok) console.warn('Automatisches Speichern fehlgeschlagen');
  }

  newDrawing(): void {
    this.tool.reset();
    this.selection.clear();
    this.doc.reset();
    this.resetView();
  }

  /**
   * Replace the drawing with the server's state of a live drawing: the view, the
   * active layer and the layers' display flags of this device stay.
   */
  applyLiveSnapshot(data: unknown): void {
    this.tool.reset();
    const flags = new Map(this.doc.layers.map((l) => [l.id, l]));
    const active = this.doc.activeLayerId;
    const view = this.cam.state;
    this.doc.loadFile(data);
    for (const l of this.doc.layers) {
      const f = flags.get(l.id);
      if (f) this.doc.patchLayerView(l.id, { visible: f.visible, locked: f.locked, dimmed: f.dimmed }, false);
    }
    if (this.doc.layer(active)) this.doc.setActiveLayer(active);
    this.cam.state = view;
    this.selection = new Set([...this.selection].filter((id) => this.doc.get(id)));
    this.viewChanged();
  }

  /** Steps made on another device. */
  applyRemoteOps(ops: SyncOp[]): void {
    // A gesture in progress keeps going on its own copy; drop it if its entity vanished.
    this.doc.applyRemote(ops);
    for (const id of [...this.selection]) if (!this.doc.get(id)) this.selection.delete(id);
    this.emit();
  }

  loadDrawing(data: unknown): void {
    this.tool.reset();
    this.selection.clear();
    const view = this.doc.loadFile(data).view;
    if (view) {
      this.cam.state = view;
      this.viewChanged();
    } else {
      this.fitAll();
    }
  }
}
