import { afterEach, describe, expect, it } from 'vitest';
import { layoutAnno } from '../src/core/annotations';
import { SketchDocument, type SyncOp } from '../src/core/document';
import { drawingScale, formatScale, nearestScale, setDrawingScale, worldWidth } from '../src/core/scale';
import type { LineEntity, TextEntity } from '../src/core/types';

const style = { pen: 'ink' as const, width: 0.5, lineType: 'solid' as const, color: null };

describe('drawing scale', () => {
  afterEach(() => setDrawingScale(1));

  it('names and rounds scales', () => {
    expect(formatScale(10)).toBe('1:10');
    expect(formatScale(1)).toBe('1:1');
    expect(formatScale(0.5)).toBe('2:1');
    expect(nearestScale(7.5)).toBe(10);
    expect(nearestScale(3)).toBe(2);
    expect(nearestScale(0.9)).toBe(1);
  });

  it('is an undoable, synced step stored in the file', () => {
    const doc = new SketchDocument();
    const ops: SyncOp[][] = [];
    doc.onOps((o) => ops.push(o));
    expect(doc.scaleSet).toBe(false);
    doc.setScale(10);
    expect(doc.scale).toBe(10);
    expect(drawingScale()).toBe(10);
    expect(ops.at(-1)).toEqual([{ t: 'scale', scale: 10 }]);
    expect(doc.toFile().scale).toBe(10);
    doc.undo();
    expect(doc.scaleSet).toBe(false);
    expect(drawingScale()).toBe(1);
    doc.redo();
    const b = new SketchDocument();
    b.loadFile(doc.toFile());
    expect(b.scale).toBe(10);
    b.reset();
    b.applyRemote([{ t: 'scale', scale: 5 }]);
    expect(b.scale).toBe(5);
  });

  it('reads older files as 1:1', () => {
    const doc = new SketchDocument();
    const l: LineEntity = { kind: 'line', id: 'a', layerId: doc.activeLayerId, z: 1, style, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    doc.add(l);
    const f = doc.toFile();
    delete f.scale;
    doc.loadFile(f);
    expect(doc.scaleSet).toBe(true);
    expect(doc.scale).toBe(1);
  });

  it('draws widths and lettering larger', () => {
    const t: TextEntity = { kind: 'text', id: 't', layerId: 'L', z: 1, style, at: { x: 0, y: 0 }, text: 'A', size: 3.5, angle: 0 };
    const l: LineEntity = { kind: 'line', id: 'a', layerId: 'L', z: 1, style, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    expect(layoutAnno(t).texts[0].size).toBeCloseTo(3.5);
    setDrawingScale(10);
    expect(worldWidth(l)).toBeCloseTo(5);
    // Cached layouts are refreshed after a scale change.
    expect(layoutAnno(t).texts[0].size).toBeCloseTo(35);
  });
});
