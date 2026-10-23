import { PART_ANGLES, partGeometry, PARTS, partLabel, type PartKind, type PartSpec, type PartView } from '../core/parts';
import { baseDialog, finish } from './dialogs';
import { h } from './dom';

const VIEW_NAMES: Record<PartView, string> = { side: 'Seitenansicht / Schnitt', top: 'Draufsicht' };

/** Little drawing of the part (fits the canvas, thick and thin lines). */
function drawPreview(canvas: HTMLCanvasElement, spec: PartSpec): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const prims = partGeometry(spec);
  // Turned like it will be placed (y points down on the canvas, angles count counter-clockwise).
  const a = ((spec.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (px: number, py: number) => {
    const x = ca * px + sa * py;
    const y = -sa * px + ca * py;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const p of prims) {
    if (p.t === 'line') add(p.a.x, p.a.y), add(p.b.x, p.b.y);
    else add(p.c.x - p.r, p.c.y - p.r), add(p.c.x + p.r, p.c.y + p.r);
  }
  const k = Math.min((W - 24) / (maxX - minX || 1), (H - 24) / (maxY - minY || 1));
  ctx.translate(W / 2 - ((minX + maxX) / 2) * k, H / 2 - ((minY + maxY) / 2) * k);
  ctx.scale(k, k);
  ctx.rotate(-a);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#222';
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (const p of prims) {
    ctx.lineWidth = (p.s === 'thick' ? 1.8 : 0.9) / k;
    ctx.setLineDash(p.s === 'center' ? [10 / k, 3 / k, 1 / k, 3 / k] : []);
    ctx.beginPath();
    if (p.t === 'line') {
      ctx.moveTo(p.a.x, p.a.y);
      ctx.lineTo(p.b.x, p.b.y);
    } else if (p.t === 'circle') {
      ctx.arc(p.c.x, p.c.y, p.r, 0, Math.PI * 2);
    } else {
      ctx.arc(p.c.x, p.c.y, p.r, p.start, p.start + p.sweep, p.sweep < 0);
    }
    ctx.stroke();
  }
}

/** Choose a standard part: type, size, view and length. */
export function askPart(initial: PartSpec): Promise<PartSpec | null> {
  return new Promise((resolve) => {
    const { dlg, body, actions } = baseDialog('Normteil einfügen');
    dlg.classList.add('part-dlg');
    const spec: PartSpec = { ...initial };
    const kinds = h('div', { class: 'part-kinds' });
    const sizes = h('div', { class: 'seg seg-wrap' });
    const views = h('div', { class: 'seg' });
    const angles = h('div', { class: 'seg' });
    const lengths = h('div', { class: 'seg seg-wrap' });
    const lenField = h('div', { class: 'exp-field' }, [h('span', { class: 'len-label' }), lengths]);
    const sizeField = h('div', { class: 'exp-field' }, [h('span', { class: 'size-label' }), sizes]);
    const canvas = h('canvas', { class: 'part-preview' });
    const label = h('p', { class: 'exp-hint part-label' });
    body.append(kinds, sizeField, h('div', { class: 'exp-field' }, [h('span', { text: 'Ansicht' }), views]), lenField, h('div', { class: 'exp-field' }, [h('span', { text: 'Einfügewinkel' }), angles]), canvas, label);

    const kindBtns = new Map<PartKind, HTMLButtonElement>();
    for (const k of Object.keys(PARTS) as PartKind[]) {
      const b = h('button', { class: 'part-kind', text: PARTS[k].name });
      b.addEventListener('click', () => {
        spec.kind = k;
        const info = PARTS[k];
        if (!info.sizes.includes(spec.size)) spec.size = info.sizes[Math.min(3, info.sizes.length - 1)];
        if (!info.views.includes(spec.view)) spec.view = info.views[0];
        if (info.length) spec.length = info.length.def(spec.size);
        render();
      });
      kindBtns.set(k, b);
      kinds.append(b);
    }

    const segButtons = (row: HTMLElement, items: { id: string; label: string }[], cur: string, pick: (id: string) => void) => {
      row.replaceChildren(
        ...items.map((it) => {
          const b = h('button', { class: `seg-btn${it.id === cur ? ' active' : ''}`, text: it.label });
          b.addEventListener('click', () => {
            pick(it.id);
            render();
          });
          return b;
        }),
      );
    };

    function render(): void {
      const info = PARTS[spec.kind];
      for (const [k, b] of kindBtns) b.classList.toggle('active', k === spec.kind);
      (sizeField.querySelector('.size-label') as HTMLElement).textContent = info.sizeLabel;
      segButtons(sizes, info.sizes.map((s) => ({ id: s, label: s })), spec.size, (id) => {
        spec.size = id;
        if (info.length && !info.length.values.includes(spec.length)) spec.length = info.length.def(id);
      });
      segButtons(views, info.views.map((v) => ({ id: v, label: VIEW_NAMES[v] })), spec.view, (id) => (spec.view = id as PartView));
      lenField.hidden = !info.length || (spec.view === 'top' && spec.kind !== 'socketScrew' && spec.kind !== 'hexScrew');
      if (info.length) {
        (lenField.querySelector('.len-label') as HTMLElement).textContent = `${info.length.label} (mm)`;
        segButtons(lengths, info.length.values.map((v) => ({ id: String(v), label: String(v) })), String(spec.length), (id) => (spec.length = Number(id)));
      }
      segButtons(angles, PART_ANGLES.map((a) => ({ id: String(a), label: a === null ? 'frei' : `${a}°` })), String(spec.angle ?? null), (id) => {
        spec.angle = id === 'null' ? null : Number(id);
      });
      label.textContent = partLabel(spec);
      requestAnimationFrame(() => drawPreview(canvas, spec));
    }

    const cancel = h('button', { class: 'dlg-btn', text: 'Abbrechen' });
    const ok = h('button', { class: 'dlg-btn primary', text: 'Platzieren' });
    actions.append(cancel, ok);
    cancel.addEventListener('click', () => finish(dlg, resolve, null));
    ok.addEventListener('click', () => finish(dlg, resolve, { ...spec }));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(dlg, resolve, null);
    });
    dlg.showModal();
    render();
    ok.focus();
  });
}
