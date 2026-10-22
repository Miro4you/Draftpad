import { worldWidth } from '../core/scale';
import type { App } from '../app';
import { capsuleRanges, removeRanges } from '../core/curves';
import { newId } from '../core/document';
import type { Vec } from '../core/geom';
import { drawEraserCursor } from '../render/overlay';
import { isAnnotation } from '../core/types';
import type { PointerKind, Tool, ToolEvent } from './tool';

/** Eraser radius in CSS px. */
const RADIUS_PX: Record<PointerKind, number> = { pen: 9, mouse: 9, touch: 16 };

/**
 * Free eraser: removes whatever lies under it and splits lines, circles, arcs and
 * strokes where it cuts through. One stroke of the eraser is one undo step.
 */
export class EraserTool implements Tool {
  readonly id = 'erase';
  private last: Vec | null = null;
  private cursor: { p: Vec; r: number } | null = null;

  constructor(private app: App) {}

  get busy(): boolean {
    return this.last !== null;
  }

  private radius(type: PointerKind): number {
    return RADIUS_PX[type];
  }

  down(ev: ToolEvent): void {
    this.app.doc.begin();
    this.last = ev.world;
    this.erase(ev.world, ev.world, ev.pointerType);
    this.cursor = { p: ev.screen, r: this.radius(ev.pointerType) };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    if (this.last) {
      this.erase(this.last, ev.world, ev.pointerType);
      this.last = ev.world;
    }
    this.cursor = { p: ev.screen, r: this.radius(ev.pointerType) };
    this.app.requestOverlay();
  }

  up(ev: ToolEvent): void {
    if (!this.last) return;
    this.erase(this.last, ev.world, ev.pointerType);
    this.last = null;
    this.app.doc.commit();
    this.app.requestOverlay();
  }

  private erase(p0: Vec, p1: Vec, type: PointerKind): void {
    const doc = this.app.doc;
    const R = this.app.cam.px(this.radius(type));
    const minLen = this.app.cam.px(0.75);
    for (const e of [...doc.visibleEntities(false)]) {
      if (isAnnotation(e)) continue;
      const ranges = capsuleRanges(e, p0, p1, R + worldWidth(e) / 2);
      if (!ranges.length) continue;
      const rest = removeRanges(e, ranges, () => newId('E'), minLen);
      if (rest.length === 1 && rest[0] === e) continue;
      doc.remove(e.id);
      for (const r of rest) doc.add(r);
    }
  }

  cancel(): void {
    if (this.last) this.app.doc.commit();
    this.last = null;
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    this.cursor = ev ? { p: ev.screen, r: this.radius(ev.pointerType) } : null;
    this.app.requestOverlay();
  }

  reset(): void {
    this.cancel();
    this.cursor = null;
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (this.cursor) drawEraserCursor(ctx, this.cursor.p, this.cursor.r);
  }
}
