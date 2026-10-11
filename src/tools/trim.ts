import type { App } from '../app';
import { cutParams, entityLength, intersectSegment, pointAt, project, removeRanges, subEntity, trimRange } from '../core/curves';
import { applyAffine } from '../core/transform';
import { newId } from '../core/document';
import { dist, type Vec } from '../core/geom';
import { isAnnotation, type Entity } from '../core/types';
import { DANGER, drawFence } from '../render/overlay';
import type { Tool, ToolEvent } from './tool';

interface Piece {
  e: Entity;
  range: [number, number];
}

type State = { k: 'idle' } | { k: 'drag'; last: Vec; path: Vec[]; marks: Map<string, Piece[]> };

/**
 * Trim: removes the piece of an object between its nearest intersections with
 * other objects. Tap a piece, or swipe across several pieces to trim them all.
 * Circles become arcs; an object without intersections is removed completely.
 * With mirroring on, the mirror images of the pieces are trimmed as well.
 */
export class TrimTool implements Tool {
  readonly id = 'trim';
  private state: State = { k: 'idle' };
  private hoverPiece: Piece | null = null;
  private cutCache: { version: number; scale: number; map: Map<string, number[]> } | null = null;

  constructor(private app: App) {}

  get busy(): boolean {
    return this.state.k !== 'idle';
  }

  /** Where other visible objects cross e (cached until the drawing changes). */
  private cuts(e: Entity): number[] {
    const v = this.app.doc.version;
    if (!this.cutCache || this.cutCache.version !== v || this.cutCache.scale !== this.app.cam.scale)
      this.cutCache = { version: v, scale: this.app.cam.scale, map: new Map() };
    let c = this.cutCache.map.get(e.id);
    if (!c) {
      c = cutParams(e, this.app.doc.visibleEntities(), this.app.cam.px(3));
      this.cutCache.map.set(e.id, c);
    }
    return c;
  }

  private pieceAt(e: Entity, s: number): Piece {
    return { e, range: trimRange(e, this.cuts(e), s) };
  }

  private pieceUnder(world: Vec, ev: ToolEvent): Piece | null {
    const hit = this.app.hitEntity(world, ev.pointerType);
    return hit && !isAnnotation(hit.e) ? this.pieceAt(hit.e, hit.s) : null;
  }

  /**
   * The pieces plus their mirror images at the active symmetry axes: the twin of
   * each object is trimmed where the mirror image of the piece's middle lies.
   */
  private withMirrors(marks: Map<string, Piece[]>): Map<string, Piece[]> {
    if (!this.app.mirrors().length) return marks;
    const out = new Map<string, Piece[]>();
    for (const list of marks.values()) {
      for (const p of list) {
        this.mark(out, p);
        const mid = pointAt(p.e, (p.range[0] + p.range[1]) / 2);
        for (const { twin, m } of this.app.mirrorTwins(p.e)) {
          this.mark(out, this.pieceAt(twin, project(twin, applyAffine(m, mid)).s));
        }
      }
    }
    return out;
  }

  private mark(marks: Map<string, Piece[]>, p: Piece): void {
    const list = marks.get(p.e.id) ?? [];
    if (list.some((q) => Math.abs(q.range[0] - p.range[0]) < 1e-9 && Math.abs(q.range[1] - p.range[1]) < 1e-9)) return;
    list.push(p);
    marks.set(p.e.id, list);
  }

  down(ev: ToolEvent): void {
    this.hoverPiece = null;
    const marks = new Map<string, Piece[]>();
    const p = this.pieceUnder(ev.world, ev);
    if (p) this.mark(marks, p);
    this.state = { k: 'drag', last: ev.world, path: [ev.screen], marks };
    this.app.requestOverlay();
  }

  move(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'drag') return;
    if (dist(st.last, ev.world) < 1e-9) return;
    // Every piece the swipe crosses gets trimmed.
    for (const e of this.app.doc.visibleEntities(false)) {
      if (isAnnotation(e)) continue;
      for (const x of intersectSegment(e, st.last, ev.world)) this.mark(st.marks, this.pieceAt(e, project(e, x).s));
    }
    st.last = ev.world;
    st.path.push(ev.screen);
    this.app.requestOverlay();
  }

  up(ev: ToolEvent): void {
    const st = this.state;
    if (st.k !== 'drag') return;
    this.move(ev);
    this.state = { k: 'idle' };
    const marks = this.withMirrors(st.marks);
    if (marks.size) {
      const doc = this.app.doc;
      doc.begin();
      for (const pieces of marks.values()) {
        const e = pieces[0].e;
        if (!doc.get(e.id)) continue;
        const rest = removeRanges(
          e,
          pieces.map((p) => p.range),
          () => newId('E'),
        );
        doc.remove(e.id);
        for (const r of rest) doc.add(r);
      }
      doc.commit();
    }
    this.app.requestOverlay();
  }

  cancel(): void {
    this.state = { k: 'idle' };
    this.app.requestOverlay();
  }

  hover(ev: ToolEvent | null): void {
    if (this.state.k !== 'idle') return;
    const p = ev ? this.pieceUnder(ev.world, ev) : null;
    const same =
      p && this.hoverPiece && p.e === this.hoverPiece.e && p.range[0] === this.hoverPiece.range[0] && p.range[1] === this.hoverPiece.range[1];
    if (!same) {
      this.hoverPiece = p;
      this.app.requestOverlay();
    }
  }

  reset(): void {
    this.cancel();
    this.hoverPiece = null;
  }

  /** The piece as its own entity, for highlighting. */
  private pieceEntity(p: Piece): Entity {
    const L = entityLength(p.e);
    if (p.range[0] <= 1e-9 && p.range[1] >= L - 1e-9) return p.e;
    return subEntity(p.e, p.range[0], p.range[1], `${p.e.id}#trim`);
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const st = this.state;
    if (st.k === 'drag') {
      const pieces: Entity[] = [];
      for (const list of this.withMirrors(st.marks).values()) for (const p of list) pieces.push(this.pieceEntity(p));
      this.app.paintHighlight(pieces, DANGER, 0.6);
      drawFence(ctx, st.path);
    } else if (this.hoverPiece && this.app.doc.get(this.hoverPiece.e.id) === this.hoverPiece.e) {
      const pieces: Entity[] = [];
      for (const list of this.withMirrors(new Map([[this.hoverPiece.e.id, [this.hoverPiece]]])).values()) {
        for (const p of list) pieces.push(this.pieceEntity(p));
      }
      this.app.paintHighlight(pieces, DANGER, 0.35);
    }
  }
}
