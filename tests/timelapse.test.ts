import { describe, expect, it } from 'vitest';
import { SketchDocument } from '../src/core/document';
import type { CircleEntity, LineEntity, TextEntity } from '../src/core/types';
import { fitCamera, hasProcess, partial, planTimelapse } from '../src/export/timelapse';

const style = { pen: 'ink' as const, width: 0.5, lineType: 'solid' as const, color: null };

function sample() {
  const doc = new SketchDocument();
  const L = doc.activeLayerId;
  const circle: CircleEntity = { kind: 'circle', id: 'c', layerId: L, z: 3, style, c: { x: 50, y: 0 }, r: 10, mark: true };
  const line: LineEntity = { kind: 'line', id: 'l', layerId: L, z: 1, style, a: { x: 0, y: 0 }, b: { x: 40, y: 0 } };
  const text: TextEntity = { kind: 'text', id: 't', layerId: L, z: 2, style, at: { x: 0, y: 20 }, text: 'A', size: 3.5, angle: 0 };
  doc.add(circle);
  doc.add(line);
  doc.add(text);
  return { doc, circle, line, text };
}

describe('timelapse', () => {
  it('builds the result up in drawing order and fills the whole time', () => {
    const { doc } = sample();
    const plan = planTimelapse(doc, 'result');
    const added = plan.steps.flatMap((s) => s.adds.map((e) => e.id));
    expect(added).toEqual(['l', 't', 'c']);
    expect(plan.steps[0].t0).toBe(0);
    expect(plan.steps.at(-1)!.t1).toBeCloseTo(1);
    for (let i = 1; i < plan.steps.length; i++) expect(plan.steps[i].t0).toBeCloseTo(plan.steps[i - 1].t1);
  });

  it('grows lines and circles, fades texts', () => {
    const { line, text, circle } = sample();
    const half = partial(line, 1, 0.5)!.e as LineEntity;
    expect(half.b.x).toBeCloseTo(20);
    expect(partial(text, 1, 0.25)!.alpha).toBeCloseTo(0.25);
    const arc = partial(circle, 1, 0.5)!.e;
    expect(arc.kind).toBe('arc');
    if (arc.kind === 'arc') {
      expect(Math.abs(arc.sweep)).toBeCloseTo(Math.PI);
      expect(arc.mark).toBe(false);
    }
    expect(partial(circle, 1, 1)!.e).toBe(circle);
    expect(partial(circle, 1, 0)).toBeNull();
  });

  it('replays the whole process: trims, deletions and layer visibility', () => {
    const { doc, line, circle } = sample();
    expect(hasProcess(doc)).toBe(true);
    doc.update({ ...line, b: { x: 20, y: 0 } });
    doc.remove(circle.id);
    doc.patchLayerView(doc.activeLayerId, { visible: false });
    const steps = planTimelapse(doc, 'process').steps;
    expect(steps.length).toBe(6);
    expect(steps[3].upds.map((u) => [u.before.id, (u.after as LineEntity).b.x])).toEqual([['l', 20]]);
    expect(steps[4].dels.map((e) => e.id)).toEqual(['c']);
    expect(steps[5].vis).toEqual([{ id: doc.activeLayerId, from: 1, to: 0 }]);
    // The fade-out takes time, so it can be seen in the video.
    expect(steps[5].t1 - steps[5].t0).toBeGreaterThan(0.05);
  });

  it('shows what is left after trimming at once instead of growing it', () => {
    const { doc, line } = sample();
    doc.begin();
    doc.remove(line.id);
    doc.add({ ...line, id: 'l2', b: { x: 25, y: 0 } });
    doc.add({ ...line, id: 'x', a: { x: 0, y: 5 }, b: { x: 10, y: 5 } });
    doc.commit();
    const s = planTimelapse(doc, 'process').steps.at(-1)!;
    expect(s.rests.map((e) => e.id)).toEqual(['l2']);
    expect(s.adds.map((e) => e.id)).toEqual(['x']);
    expect(s.dels.map((e) => e.id)).toEqual(['l']);
  });

  it('keeps the journal in the file', () => {
    const { doc } = sample();
    doc.patchLayerView(doc.activeLayerId, { dimmed: true });
    const b = new SketchDocument();
    b.loadFile(JSON.parse(JSON.stringify(doc.toFile())));
    expect(b.history.length).toBe(4);
    expect(b.history[3].ops[0]).toMatchObject({ t: 'vis', dimmed: true });
  });

  it('treats older drawings as drawn before the history began', () => {
    const { doc } = sample();
    const f = doc.toFile();
    delete f.journal;
    const b = new SketchDocument();
    b.loadFile(f);
    expect(hasProcess(b)).toBe(false);
    expect(b.history[0].base).toBe(true);
    expect(planTimelapse(b, 'process').steps.flatMap((s) => s.adds.map((e) => e.id))).toEqual(['l', 't', 'c']);
  });

  it('fades hidden layers out at the end of the result', () => {
    const { doc } = sample();
    doc.patchLayerView(doc.activeLayerId, { visible: false });
    const steps = planTimelapse(doc, 'result').steps;
    expect(steps.flatMap((s) => s.adds.map((e) => e.id))).toEqual(['l', 't', 'c']);
    expect(steps.at(-1)!.vis).toEqual([{ id: doc.activeLayerId, from: 1, to: 0 }]);
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
