import { describe, expect, it } from 'vitest';
import { dimText, dimTextAnchor, dimValue, dragDimText, formatMeasure, layoutAnno } from '../src/core/annotations';
import type { DimEntity } from '../src/core/types';
import { linearDim } from '../src/tools/dim';
import { drawHatch, isSolidFill, type DrawCtx } from '../src/render/annotations';
import { textWidthMm, toPdf, toSvg, VectorRecorder } from '../src/export/vector';

const style = { pen: 'ink' as const, width: 0.25, lineType: 'solid' as const, color: null };
const dim = (d: Partial<DimEntity>): DimEntity => ({ kind: 'dim', id: 'd', layerId: 'l', z: 0, style, type: 'lin', p1: { x: 0, y: 0 }, p2: { x: 30, y: 40 }, off: 5, ...d });

describe('dimensions', () => {
  it('measures along the chosen direction', () => {
    expect(dimValue(dim({ dir: 0 }))).toBeCloseTo(30);
    expect(dimValue(dim({ dir: Math.PI / 2 }))).toBeCloseTo(40);
    expect(dimValue(dim({ dir: Math.atan2(40, 30) }))).toBeCloseTo(50);
    expect(dimText(dim({ type: 'dia', p2: { x: 12.5, y: 0 } }))).toBe('Ø25');
    expect(dimText(dim({ type: 'ang', p2: { x: 10, y: 0 }, p3: { x: 0, y: 10 } }))).toBe('90°');
    expect(formatMeasure(42.54)).toBe('42,5');
  });

  it('picks horizontal, vertical or aligned from the pointer', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 30, y: 40 };
    expect(linearDim(a, b, { x: 15, y: -10 }).dir).toBe(0);
    expect(linearDim(a, b, { x: 50, y: 20 }).dir).toBeCloseTo(Math.PI / 2);
    expect(linearDim(a, b, { x: -20, y: 50 }).dir).toBeCloseTo(Math.atan2(40, 30));
    // Offset is the signed distance of the pointer from p1 across the direction.
    expect(linearDim(a, b, { x: 15, y: -10 }).off).toBeCloseTo(-10);
  });
});

describe('vector export', () => {
  it('turns arcs into cubic Béziers on the circle', () => {
    const r = new VectorRecorder();
    r.beginPath();
    r.arc(0, 0, 10, 0, Math.PI * 2);
    r.stroke();
    const it = r.items[0];
    expect(it.kind).toBe('path');
    if (it.kind !== 'path') return;
    const cs = it.segs.filter((s) => s[0] === 'C');
    expect(cs.length).toBe(4);
    for (const s of cs) expect(Math.hypot(s[5] as number, s[6] as number)).toBeCloseTo(10);
  });

  it('applies transforms to paths and texts', () => {
    const r = new VectorRecorder();
    r.save();
    r.translate(10, 5);
    r.rotate(Math.PI / 2);
    r.font = '3.5px Helvetica';
    r.textAlign = 'center';
    r.fillText('A', 0, 0);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(1, 0);
    r.stroke();
    r.restore();
    const t = r.items[0];
    expect(t.kind === 'text' && [t.x, t.y, t.size]).toEqual([10, 5, 3.5]);
    const p = r.items[1];
    expect(p.kind === 'path' && p.segs[1][1]).toBeCloseTo(10);
    expect(p.kind === 'path' && p.segs[1][2]).toBeCloseTo(6);
  });

  it('writes SVG in mm and a well-formed PDF', () => {
    const r = new VectorRecorder();
    r.strokeStyle = '#123456';
    r.lineWidth = 0.5;
    r.setLineDash([1, 2]);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(20, 10);
    r.stroke();
    r.fillStyle = '#000';
    r.font = '3.5px x';
    r.textAlign = 'center';
    r.fillText('Ø12 (A)', 5, 5);
    const page = { minX: -5, minY: -5, width: 30, height: 20, background: '#ffffff' };
    const svg = toSvg(r, page);
    expect(svg).toContain('width="30mm"');
    expect(svg).toContain('stroke-dasharray="1 2"');
    expect(svg).toContain('Ø12 (A)');
    const pdf = new TextDecoder('latin1').decode(toPdf(r, page));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('\\330');
    expect(pdf).toContain('\\(A\\)');
    // xref offsets point at the objects.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offs = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(pdf.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });

  it('exports a solid fill as an even-odd area and a rotated hatch as lines', () => {
    const loops = [
      [0, 0, 20, 0, 20, 20, 0, 20],
      [5, 5, 15, 5, 15, 15, 5, 15],
    ];
    const base = { kind: 'hatch' as const, id: 'h', layerId: 'l', z: 0, style, loops, spacing: 2, angle: 0 };
    const solid = { ...base, pattern: 'solid' as const };
    expect(isSolidFill(solid)).toBe(true);
    const r = new VectorRecorder();
    drawHatch(r as unknown as DrawCtx, solid, '#123456', 0.25, 1);
    const page = { minX: 0, minY: 0, width: 20, height: 20, background: '#ffffff' };
    expect(toSvg(r, page)).toContain('fill-rule="evenodd"');
    const r2 = new VectorRecorder();
    drawHatch(r2 as unknown as DrawCtx, { ...base, pattern: 'diag', angle: 30 }, '#123456', 0.25, 1);
    expect(r2.items.some((i) => i.kind === 'path' && i.stroke)).toBe(true);
  });

  it('measures Helvetica text', () => {
    expect(textWidthMm('10', 10)).toBeCloseTo(11.12);
  });
});

describe('moving dimension figures', () => {
  it('slides a linear figure along and away; feature points stay', () => {
    const d = dim({ p1: { x: 0, y: 0 }, p2: { x: 40, y: 0 }, dir: 0, off: -10 });
    const anchor = dimTextAnchor(d);
    expect(anchor).toEqual({ x: 20, y: -10 });
    const moved = dragDimText(d, { x: 50, y: -15 });
    expect(moved.p1).toEqual(d.p1);
    expect(moved.p2).toEqual(d.p2);
    expect(moved.off).toBeCloseTo(-15);
    expect(moved.tpos).toBeCloseTo(30);
    // Outside the extension lines the dimension line runs on under the figure.
    const l = layoutAnno(moved);
    const far = Math.max(...l.lines.flat().map((p) => p.x));
    expect(far).toBeGreaterThan(50);
    expect(dimTextAnchor(moved)).toEqual({ x: 50, y: -15 });
  });

  it('turns diameters and slides their figure outside', () => {
    const d = dim({ type: 'dia', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, off: 0 });
    const moved = dragDimText(d, { x: 0, y: -25 }, 15);
    expect(moved.p2.x).toBeCloseTo(0);
    expect(moved.p2.y).toBeCloseTo(-10);
    expect(moved.tpos).toBeCloseTo(25);
    expect(dimText(moved)).toBe('Ø20');
  });

  it('changes the radius and position of angle figures', () => {
    const d = dim({ type: 'ang', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, p3: { x: 0, y: 10 }, off: 8 });
    const q = { x: Math.cos(Math.PI / 8) * 15, y: Math.sin(Math.PI / 8) * 15 };
    const moved = dragDimText(d, q);
    expect(moved.off).toBeCloseTo(15);
    expect(moved.tpos).toBeCloseTo(-Math.PI / 8);
    expect(dimValue(moved)).toBeCloseTo(90);
  });
});
