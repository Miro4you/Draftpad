import { describe, expect, it } from 'vitest';
import { SketchDocument, type SyncOp } from '../src/core/document';
import type { LineEntity } from '../src/core/types';

const style = { pen: 'ink' as const, width: 0.5, lineType: 'solid' as const, color: null };

function line(doc: SketchDocument, id: string, x: number): LineEntity {
  return { kind: 'line', id, layerId: doc.activeLayerId, z: doc.allocZ(), style, a: { x, y: 0 }, b: { x: x + 10, y: 0 } };
}

describe('live sync ops', () => {
  it('emits ops for steps, undo and redo', () => {
    const doc = new SketchDocument();
    const seen: SyncOp[][] = [];
    doc.onOps((ops) => seen.push(ops));
    const l = line(doc, 'a', 0);
    doc.add(l);
    doc.update({ ...l, b: { x: 5, y: 5 } });
    doc.undo();
    doc.redo();
    expect(seen.map((s) => s.map((o) => o.t))).toEqual([['put'], ['put'], ['put'], ['put']]);
    expect((seen[2][0] as { e: LineEntity }).e.b).toEqual({ x: 10, y: 0 });
    doc.undo();
    doc.undo();
    expect(seen.at(-1)).toEqual([{ t: 'del', id: 'a' }]);
  });

  it('applies remote ops without history and keeps local layer flags', () => {
    const a = new SketchDocument();
    const b = new SketchDocument();
    b.loadFile(a.toFile());
    const forward: SyncOp[][] = [];
    a.onOps((ops) => forward.push(ops));
    let echoed = 0;
    b.onOps(() => echoed++);
    b.patchLayerView(b.layers[1].id, { visible: false });
    // Hiding a layer is sent along (for the journal), applying remote ops is not echoed.
    expect(echoed).toBe(1);
    echoed = 0;
    a.begin();
    a.add(line(a, 'x', 0));
    a.setLayers([...a.layers].reverse().map((l, i) => (i === 0 ? { ...l, name: 'Oben' } : l)));
    a.commit();
    for (const ops of forward) b.applyRemote(ops);
    expect(b.get('x')).toBeDefined();
    expect(b.canUndo).toBe(false);
    expect(echoed).toBe(0);
    const hidden = b.layers.find((l) => l.id === a.layers[0].id)!;
    expect(hidden.name).toBe('Oben');
    expect(hidden.visible).toBe(false);
  });
});
