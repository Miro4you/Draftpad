import type { App } from '../app';
import { dist, type Vec } from '../core/geom';
import type { PointerKind, ToolEvent } from '../tools/tool';
import { deleteSelection, duplicateSelection, nudgeSelection } from '../tools/selection-actions';
import { releaseTextFocus } from '../ui/dom';
import { LINE_TYPES } from '../core/pens';

/** Touches wider than this (CSS px) are treated as a resting palm, not a finger. */
const PALM_WIDTH_PX = 120;
const TAP_MAX_MS = 320;
const TAP_MAX_MOVE_PX = 12;

interface TouchInfo {
  p: Vec;
  start: Vec;
  small: boolean;
}

type Gesture =
  | { k: 'pan'; id: number; w: Vec }
  | { k: 'pinch'; ids: [number, number]; w1: Vec; w2: Vec; baseRot: number };

/**
 * Routes pointer input:
 * - Apple Pencil and mouse (left button) drive the active tool.
 * - Fingers navigate: one finger pans, two fingers pan/zoom/rotate.
 *   Two-finger tap = undo, three-finger tap = redo.
 * - A finger held down while drawing with the pencil suspends snapping.
 * - Mouse: wheel zooms, middle/right button or Space + drag pans.
 */
export class InputController {
  private draw: { id: number; type: PointerKind; last: ToolEvent } | null = null;
  private mousePan: { id: number; last: Vec } | null = null;
  private touches = new Map<number, TouchInfo>();
  private gesture: Gesture | null = null;
  /** Touches present when the pen went down are ignored for navigation until lifted. */
  private touchesIgnored = false;
  private tap: { t0: number; max: number; moved: boolean } | null = null;
  private spaceDown = false;
  /** Pointer whose press went to an on-canvas control; its moves and release are ignored. */
  private consumed: number | null = null;
  private altDown = false;

  constructor(
    private app: App,
    private el: HTMLElement,
  ) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari: stop scrolling, the magnifier loupe and double-tap zoom on the canvas.
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    document.addEventListener('gesturestart', stop);
    document.addEventListener('gesturechange', stop);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.setAlt(false);
      this.setShift(false);
    });
  }

  private toolEvent(e: PointerEvent, type: PointerKind): ToolEvent {
    const rect = this.el.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return {
      screen,
      world: this.app.cam.toWorld(screen),
      pressure: e.pressure || (type === 'mouse' ? 0.5 : 0),
      pointerType: type,
    };
  }

  private screenPos(e: PointerEvent): Vec {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private kind(e: PointerEvent): PointerKind {
    return e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
  }

  // ---- pointer handlers ---------------------------------------------------------

  private onDown = (e: PointerEvent): void => {
    const type = this.kind(e);
    // Drawing never needs a text field: drop a leftover focus (and with it the keyboard),
    // and keep this press from moving the focus anywhere.
    releaseTextFocus();
    if (type !== 'mouse') e.preventDefault();
    this.setAlt(e.altKey);
    if (type !== 'touch') this.setShift(e.shiftKey);
    if (type === 'touch') {
      this.touchDown(e);
      return;
    }
    if (type === 'mouse' && (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown))) {
      e.preventDefault();
      this.mousePan = { id: e.pointerId, last: this.screenPos(e) };
      this.capture(e);
      this.el.style.cursor = 'grabbing';
      return;
    }
    if (type === 'mouse' && e.button !== 0) return;
    if (this.draw) return; // already drawing with another pointer
    // Pen wins over any navigation gesture in progress (e.g. a resting palm).
    if (type === 'pen') {
      this.gesture = null;
      this.tap = null;
      this.touchesIgnored = this.touches.size > 0;
    }
    this.startDraw(e, type);
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.consumed) return;
    const type = this.kind(e);
    if (type === 'touch') {
      this.touchMove(e);
      return;
    }
    this.setAlt(e.altKey);
    this.setShift(e.shiftKey);
    if (this.mousePan && e.pointerId === this.mousePan.id) {
      const p = this.screenPos(e);
      this.app.cam.panBy(p.x - this.mousePan.last.x, p.y - this.mousePan.last.y);
      this.mousePan.last = p;
      this.app.viewChanged();
      return;
    }
    if (this.draw && e.pointerId === this.draw.id) {
      this.moveDraw(e);
      return;
    }
    if (!this.draw && e.buttons === 0) {
      const ev = this.toolEvent(e, type);
      this.app.setHover(ev.screen, type);
      this.app.tool.hover(ev);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.consumed) {
      this.consumed = null;
      return;
    }
    const type = this.kind(e);
    if (type === 'touch') {
      this.touchUp(e, false);
      return;
    }
    if (this.mousePan && e.pointerId === this.mousePan.id) {
      this.mousePan = null;
      this.el.style.cursor = this.spaceDown ? 'grab' : '';
      return;
    }
    if (this.draw && e.pointerId === this.draw.id) this.endDraw(e, false);
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.consumed) {
      this.consumed = null;
      return;
    }
    if (this.kind(e) === 'touch') {
      this.touchUp(e, true);
      return;
    }
    if (this.mousePan && e.pointerId === this.mousePan.id) this.mousePan = null;
    if (this.draw && e.pointerId === this.draw.id) this.endDraw(e, true);
  };

  private onLeave = (e: PointerEvent): void => {
    if (!this.draw && this.kind(e) !== 'touch') {
      this.app.setHover(null);
      this.app.tool.hover(null);
    }
  };

  private capture(e: PointerEvent): void {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  // ---- drawing ------------------------------------------------------------------------

  private startDraw(e: PointerEvent, type: PointerKind): void {
    if (this.app.tapWidget(this.screenPos(e))) {
      this.consumed = e.pointerId;
      return;
    }
    this.capture(e);
    const ev = this.toolEvent(e, type);
    this.app.setHover(null);
    this.draw = { id: e.pointerId, type, last: ev };
    this.updateSuspension();
    this.app.tool.down(ev);
  }

  private moveDraw(e: PointerEvent): void {
    if (!this.draw) return;
    const type = this.draw.type;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) {
      const ev = this.toolEvent(ce, type);
      this.draw.last = ev;
      this.app.tool.move(ev);
    }
  }

  private endDraw(e: PointerEvent, cancelled: boolean): void {
    if (!this.draw) return;
    const type = this.draw.type;
    this.draw = null;
    if (cancelled) this.app.tool.cancel();
    else this.app.tool.up(this.toolEvent(e, type));
    this.updateSuspension();
  }

  /** Re-run the tool with the last position (e.g. after the snap modifier changed). */
  private refreshDraw(): void {
    if (this.draw) this.app.tool.move(this.draw.last);
  }

  private updateSuspension(): void {
    let fingerModifier = false;
    if (this.draw && this.draw.type !== 'touch') {
      for (const t of this.touches.values()) if (t.small) fingerModifier = true;
    }
    const suspended = this.altDown || fingerModifier;
    if (suspended !== this.app.snapSuspended) {
      this.app.snapSuspended = suspended;
      this.refreshDraw();
      this.app.requestOverlay();
      this.app.emit();
    }
  }

  private setAlt(v: boolean): void {
    if (v === this.altDown) return;
    this.altDown = v;
    this.updateSuspension();
  }

  /** Shift held: free lengths instead of length steps. */
  private setShift(v: boolean): void {
    if (v === this.app.lengthFree) return;
    this.app.lengthFree = v;
    this.refreshDraw();
    this.app.requestOverlay();
  }

  // ---- touch / gestures ---------------------------------------------------------------

  private touchDown(e: PointerEvent): void {
    const p = this.screenPos(e);
    const small = !(e.width > PALM_WIDTH_PX || e.height > PALM_WIDTH_PX);
    if (!this.draw && this.touches.size === 0 && this.app.tapWidget(p)) return;
    this.touches.set(e.pointerId, { p, start: p, small });
    this.capture(e);

    // While the pencil or mouse draws, fingers are only modifiers.
    if (this.draw && this.draw.type !== 'touch') {
      this.updateSuspension();
      return;
    }
    if (this.touchesIgnored) return;

    if (this.touches.size === 1) this.tap = { t0: performance.now(), max: 1, moved: false };
    else if (this.tap) this.tap.max = Math.max(this.tap.max, this.touches.size);

    // A second finger turns a finger stroke into navigation.
    if (this.draw && this.draw.type === 'touch') {
      this.draw = null;
      this.app.tool.cancel();
    }
    if (this.app.settings.fingerDraws && this.touches.size === 1) {
      this.startDraw(e, 'touch');
      return;
    }
    this.startGesture();
  }

  private touchMove(e: PointerEvent): void {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.p = this.screenPos(e);
    if (this.tap && dist(t.p, t.start) > TAP_MAX_MOVE_PX) this.tap.moved = true;
    if (this.draw && this.draw.id === e.pointerId) {
      this.moveDraw(e);
      return;
    }
    if (this.draw || this.touchesIgnored) return;
    this.applyGesture();
  }

  private touchUp(e: PointerEvent, cancelled: boolean): void {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.draw && this.draw.id === e.pointerId) {
      this.endDraw(e, cancelled);
    } else if (this.draw) {
      this.updateSuspension();
    }
    if (this.touches.size === 0) {
      this.touchesIgnored = false;
      this.gesture = null;
      const tap = this.tap;
      this.tap = null;
      if (tap && !cancelled && !tap.moved && performance.now() - tap.t0 < TAP_MAX_MS) {
        if (tap.max === 2) this.app.undo();
        else if (tap.max === 3) this.app.redo();
      }
      return;
    }
    if (!this.draw && !this.touchesIgnored) this.startGesture();
  }

  /** (Re)start navigation from the current finger positions. */
  private startGesture(): void {
    const ids = [...this.touches.keys()];
    const cam = this.app.cam;
    if (ids.length >= 2) {
      const a = this.touches.get(ids[0])!;
      const b = this.touches.get(ids[1])!;
      this.gesture = { k: 'pinch', ids: [ids[0], ids[1]], w1: cam.toWorld(a.p), w2: cam.toWorld(b.p), baseRot: cam.rot };
    } else if (ids.length === 1) {
      this.gesture = { k: 'pan', id: ids[0], w: cam.toWorld(this.touches.get(ids[0])!.p) };
    } else {
      this.gesture = null;
    }
  }

  private applyGesture(): void {
    const g = this.gesture;
    if (!g) return;
    const cam = this.app.cam;
    if (g.k === 'pan') {
      const t = this.touches.get(g.id);
      if (!t) return;
      cam.anchor(g.w, t.p);
    } else {
      const a = this.touches.get(g.ids[0]);
      const b = this.touches.get(g.ids[1]);
      if (!a || !b) return;
      cam.gesture(g.w1, g.w2, a.p, b.p, this.app.settings.rotate, g.baseRot);
    }
    this.app.viewChanged();
  }

  // ---- wheel & keyboard -----------------------------------------------------------------

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0018; // ctrl = trackpad pinch
    const factor = Math.exp(-e.deltaY * unit * k);
    this.app.cam.zoomAt(p, factor);
    this.app.viewChanged();
    this.app.tool.hover(null);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.setAlt(e.altKey);
    this.setShift(e.shiftKey);
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (target?.closest?.('dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    const app = this.app;

    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) app.redo();
        else app.undo();
      } else if (k === 'y') {
        e.preventDefault();
        app.redo();
      } else if (k === 's') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('app:download'));
      } else if (k === 'e' && e.shiftKey) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('app:export'));
      } else if (k === 'o') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('app:open'));
      } else if (k === 'a') {
        e.preventDefault();
        app.selectAll();
      } else if (k === 'd') {
        e.preventDefault();
        if (app.toolId === 'select') duplicateSelection(app);
      }
      return;
    }
    if (e.altKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        if (!this.mousePan) this.el.style.cursor = 'grab';
      }
      return;
    }
    if (e.repeat) return;
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit) {
      const n = Number(digit[1]);
      // 1–4 line types (switched most often), Shift + 1–9 pens, 0 shows everything.
      if (e.shiftKey) {
        if (n >= 1 && n <= 9) document.dispatchEvent(new CustomEvent('app:pen', { detail: n - 1 }));
      } else if (n >= 1 && n <= LINE_TYPES.length) {
        app.setStyle({ lineType: LINE_TYPES[n - 1].id });
      } else if (n === 0) {
        app.fitAll();
      }
      return;
    }
    if (app.toolId === 'select' && app.selection.size) {
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key]) {
        e.preventDefault();
        nudgeSelection(app, arrows[e.key][0] * step, arrows[e.key][1] * step);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection(app);
        return;
      }
    }
    switch (e.key.toLowerCase()) {
      case 'v':
        app.setTool('select');
        break;
      case 'c':
        app.setTool('circle');
        break;
      case 'b':
        app.setTool('arc');
        break;
      case 'k':
        app.setTool('cross');
        break;
      case 'x':
        app.setTool('delete');
        break;
      case 't':
        app.setTool('trim');
        break;
      case 'e':
        app.setTool('erase');
        break;
      case 'f':
        app.setTool('freehand');
        break;
      case 'l':
        app.setTool('line');
        break;
      case 'h':
        app.setTool('hatch');
        break;
      case 'q':
        app.setTool('rect');
        break;
      case 'u':
        app.setTool('fillet');
        break;
      case 'w':
        app.setTool('text');
        break;
      case 'n':
        app.setTool('trace');
        break;
      case 'i':
        document.dispatchEvent(new CustomEvent('app:part'));
        break;
      case 'd':
        app.setTool('dim');
        break;
      case 'p':
        app.setTool('gps');
        break;
      case 's':
        app.updateSettings({ snap: !app.settings.snap });
        app.toast(app.settings.snap ? 'Fang an' : 'Fang aus');
        break;
      case 'a': {
        const next = { snap: 'show', show: 'off', off: 'snap' } as const;
        app.updateSettings({ angleMode: next[app.settings.angleMode] });
        break;
      }
      case 'g':
        app.updateSettings({ grid: !app.settings.grid });
        break;
      case 'r':
        app.resetRotation();
        break;
      case 'escape':
        app.tool.reset();
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.setAlt(e.altKey);
    this.setShift(e.shiftKey);
    if (e.code === 'Space') {
      this.spaceDown = false;
      if (!this.mousePan) this.el.style.cursor = '';
    }
  };
}
