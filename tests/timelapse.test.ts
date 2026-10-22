import { describe, expect, it } from 'vitest';
import { SketchDocument } from '../src/core/document';
import type { CircleEntity, LineEntity, TextEntity } from '../src/core/types';
import { fitCamera, partial, planTimelapse } from '../src/export/timelapse';

const style = { pen: 'ink' as const, width: 0.5, lineType: 'solid' as const, color: null };

describe('timelapse', () => {
  const doc = new SketchDocument();
  const L = doc.activeLayerId;
  const circle: CircleEntity = { kind: 'circle', id: 'c', layerId: L, z: 3, style, c: { x: 50, y: 0 }, r: 10, mark: true };
  const line: LineEntity = { kind: 'line', id: 'l', layerId: L, z: 1, style, a: { x: 0, y: 0 }, b: { x: 40, y: 0 } };
  const text: TextEntity = { kind: 'text', id: 't', layerId: L, z: 2, style, at: { x: 0, y: 20 }, text: 'A', size: 3.5, angle: 0 };
  doc.add(circle);
  doc.add(line);
  doc.add(text);

  it('replays in drawing order and fills the whole time', () => {
    const plan = planTimelapse(doc);
    expect(plan.items.map((i) => i.e.id)).toEqual(['l', 't', 'c']);
    expect(plan.items[0].t0).toBe(0);
    expect(plan.items.at(-1)!.t1).toBeCloseTo(1);
    for (let i = 1; i < plan.items.length; i++) expect(plan.items[i].t0).toBeCloseTo(plan.items[i - 1].t1);
  });

  it('grows lines and circles, fades texts', () => {
    const plan = planTimelapse(doc);
    const [l, t, c] = plan.items;
    const half = partial(l, 0.5)!.e as LineEntity;
    expect(half.b.x).toBeCloseTo(20);
    expect(partial(t, 0.25)!.alpha).toBeCloseTo(0.25);
    const arc = partial(c, 0.5)!.e;
    expect(arc.kind).toBe('arc');
    if (arc.kind === 'arc') {
      expect(Math.abs(arc.sweep)).toBeCloseTo(Math.PI);
      expect(arc.mark).toBe(false);
    }
    expect(partial(c, 1)!.e).toBe(circle);
    expect(partial(c, 0)).toBeNull();
  });

  it('fits the drawing into the frame', () => {
    const cam = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 1920, 1080);
    const a = cam.toScreen({ x: 0, y: 25 });
    const b = cam.toScreen({ x: 100, y: 25 });
    expect(a.x).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(1920);
    expect(a.y).toBeCloseTo(540);
  });
});
