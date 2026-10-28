import { describe, expect, it } from 'vitest';
import { layoutAnno, splitLabel } from '../src/core/annotations';
import { geomBox } from '../src/core/curves';
import { validateFile } from '../src/core/document';
import { reflection, transformEntity } from '../src/core/transform';
import type { Entity, ForceEntity, LineLoadEntity, MomentEntity, SupportEntity } from '../src/core/types';
import { nextMechLabel } from '../src/tools/mech';

const style = { pen: 'ink' as const, width: 0.5, lineType: 'solid' as const, color: null };
const base = { layerId: 'l', z: 0, style };
const force = (label: string, at = { x: 0, y: 0 }, p = { x: 0, y: -15 }): ForceEntity => ({ ...base, id: label, kind: 'force', at, p, label });

describe('mechanics labels', () => {
  it('splits name, subscript and rest', () => {
    expect(splitLabel('F_1')).toEqual({ main: 'F', sub: '1', rest: '' });
    expect(splitLabel('F_AY = 500 N')).toEqual({ main: 'F', sub: 'AY', rest: ' = 500 N' });
    expect(splitLabel('M=20 Nm')).toEqual({ main: 'M=20 Nm', sub: '', rest: '' });
  });

  it('numbers new labels after the ones in the drawing', () => {
    expect(nextMechLabel('F', [])).toBe('F_1');
    expect(nextMechLabel('F', [force('F_1'), force('F_3 = 2 kN'), force('q_2')])).toBe('F_2');
  });
});

describe('mechanics layouts', () => {
  it('point load: tip on the point of application, label near the tail', () => {
    const l = layoutAnno(force('F_1'));
    const tip = l.fills[0][0];
    expect(tip.x).toBeCloseTo(0);
    expect(tip.y).toBeCloseTo(0);
    expect(l.texts.map((t) => t.text)).toEqual(['F', '1']);
    // Subscript is smaller and lower than the main letter.
    expect(l.texts[1].size).toBeLessThan(l.texts[0].size);
    expect(l.texts[1].p.y).toBeGreaterThan(l.texts[0].p.y);
    // Label sits at the tail end, not at the tip.
    expect(l.texts[0].p.y).toBeLessThan(-8);
  });

  it('supports hang below the point; a hinge is just a circle', () => {
    const s: SupportEntity = { ...base, id: 's', kind: 'support', type: 'fixed', at: { x: 10, y: 0 }, angle: Math.PI / 2 };
    const b = geomBox(s);
    expect(b.minY).toBeGreaterThan(-1.5);
    expect(b.maxY).toBeGreaterThan(4);
    const roller = geomBox({ ...s, type: 'roller' });
    expect(roller.maxY).toBeGreaterThan(b.maxY);
    const hinge = layoutAnno({ ...s, type: 'hinge' });
    expect(hinge.lines).toHaveLength(0);
    expect(hinge.arcs).toHaveLength(1);
  });

  it('line load: arrows from the offset line onto the feature', () => {
    const q: LineLoadEntity = { ...base, id: 'q', kind: 'lineload', a: { x: 0, y: 0 }, b: { x: 40, y: 0 }, h: -8, label: 'q_1' };
    const l = layoutAnno(q);
    expect(l.fills.length).toBeGreaterThanOrEqual(3);
    for (const f of l.fills) expect(f[0].y).toBeCloseTo(0);
    expect(geomBox(q).minY).toBeLessThan(-8);
  });

  it('moment: arrowhead at the end of the arc', () => {
    const m: MomentEntity = { ...base, id: 'm', kind: 'moment', c: { x: 0, y: 0 }, r: 6, start: 0, sweep: -Math.PI * 1.5, label: 'M_1' };
    const tip = layoutAnno(m).fills[0][0];
    expect(Math.hypot(tip.x, tip.y)).toBeCloseTo(6);
    expect(tip.x).toBeCloseTo(0);
    expect(tip.y).toBeCloseTo(6);
  });
});

describe('mechanics transforms and files', () => {
  it('mirroring flips the turning direction of moments and keeps loads on their side', () => {
    const mx = reflection({ x: 0, y: -10 }, { x: 0, y: 10 });
    const m: MomentEntity = { ...base, id: 'm', kind: 'moment', c: { x: 5, y: 0 }, r: 6, start: 0, sweep: -4, label: 'M_1' };
    const mm = transformEntity(m, mx);
    expect(mm.sweep).toBe(4);
    expect(mm.c.x).toBeCloseTo(-5);
    const q: LineLoadEntity = { ...base, id: 'q', kind: 'lineload', a: { x: 0, y: 0 }, b: { x: 40, y: 0 }, h: -8, label: '' };
    const qm = transformEntity(q, mx);
    // Same world side (above the beam) after mirroring.
    expect(geomBox(qm).minY).toBeCloseTo(-8);
    expect(geomBox(qm).maxY).toBeCloseTo(0);
  });

  it('survives saving and loading', () => {
    const entities: Entity[] = [
      force('F_1'),
      { ...base, id: 's', kind: 'support', type: 'roller', at: { x: 0, y: 0 }, angle: 1.57 },
      { ...base, id: 'm', kind: 'moment', c: { x: 0, y: 0 }, r: 6, start: 0, sweep: -4, label: 'M_1' },
      { ...base, id: 'q', kind: 'lineload', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, h: 3, label: 'q' },
      { ...base, id: 'bad', kind: 'support', type: 'nope', at: { x: 0, y: 0 }, angle: 0 } as unknown as Entity,
    ];
    const f = validateFile({ format: 'skizzen-cad', version: 1, layers: [{ id: 'l', name: 'E', visible: true, locked: false, dimmed: false }], activeLayerId: 'l', entities, nextZ: 1 });
    expect(f.entities.map((e) => e.id)).toEqual(['F_1', 's', 'm', 'q']);
  });
});
