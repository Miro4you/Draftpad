import type { App } from '../app';
import { paperSize, scaleText, SHEET_FORMATS, sheetBox } from '../core/annotations';
import { newId } from '../core/document';
import { drawingScale } from '../core/scale';
import { INK_WIDTHS, PENCIL_WIDTHS } from '../core/pens';
import type { Layer, SheetEntity, SheetFormat, TitleFields } from '../core/types';
import { loadPref, savePref } from '../storage/idb';
import { baseDialog, finish } from './dialogs';
import { h } from './dom';

export interface SheetSpec {
  format: SheetFormat;
  landscape: boolean;
  scale: number;
  fields: TitleFields;
}

/** Scales offered (world mm per paper mm); the sheet scale is the drawing scale. */
const SCALES = [0.5, 1, 2, 5, 10, 20, 50];

const FIELD_LABELS: [keyof TitleFields, string][] = [
  ['title', 'Benennung'],
  ['number', 'Zeichnungsnummer'],
  ['material', 'Werkstoff'],
  ['drawnBy', 'Gezeichnet'],
  ['date', 'Datum'],
  ['company', 'Firma'],
];

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Format, orientation, scale and title block fields. */
export function askSheet(initial: SheetSpec, title: string, confirm: string, onRemove?: () => void): Promise<SheetSpec | null> {
  return new Promise((resolve) => {
    const { dlg, body, actions } = baseDialog(title);
    dlg.classList.add('sheet-dlg');
    const spec: SheetSpec = { ...initial, fields: { ...initial.fields } };
    const seg = <T>(items: { id: T; label: string }[], get: () => T, set: (v: T) => void) => {
      const row = h('div', { class: 'seg' });
      const btns = items.map((it) => {
        const b = h('button', { class: 'seg-btn', text: it.label });
        b.addEventListener('click', () => {
          set(it.id);
          sync();
        });
        row.append(b);
        return [it.id, b] as const;
      });
      const upd = () => btns.forEach(([id, b]) => b.classList.toggle('active', id === get()));
      syncers.push(upd);
      return row;
    };
    const syncers: (() => void)[] = [];
    const size = h('p', { class: 'exp-hint' });
    const sync = () => {
      syncers.forEach((f) => f());
      const [w, hh] = paperSize(spec.format, spec.landscape);
      size.textContent = `${w} × ${hh} mm Papier · auf der Zeichenfläche ${Math.round(w * spec.scale)} × ${Math.round(hh * spec.scale)} mm`;
    };
    const fmt = seg(SHEET_FORMATS.map((f) => ({ id: f, label: f })), () => spec.format, (v) => (spec.format = v));
    const orient = seg(
      [
        { id: false, label: 'Hoch' },
        { id: true, label: 'Quer' },
      ],
      () => spec.landscape,
      (v) => (spec.landscape = v),
    );
    const offered = SCALES.includes(spec.scale) ? SCALES : [...SCALES, spec.scale].sort((a, b) => a - b);
    const scale = seg(offered.map((k) => ({ id: k, label: scaleText(k) })), () => spec.scale, (v) => (spec.scale = v));
    const grid = h('div', { class: 'sheet-fields' });
    for (const [key, label] of FIELD_LABELS) {
      const input = h('input', { class: 'dlg-input', type: 'text', autocomplete: 'off', 'data-key': key });
      input.value = spec.fields[key];
      input.addEventListener('input', () => (spec.fields[key] = input.value));
      grid.append(h('label', { class: `exp-field${key === 'title' ? ' wide' : ''}` }, [h('span', { text: label }), input]));
    }
    body.append(
      h('div', { class: 'exp-field' }, [h('span', { text: 'Format' }), fmt]),
      h('div', { class: 'sheet-row' }, [
        h('div', { class: 'exp-field' }, [h('span', { text: 'Lage' }), orient]),
        h('div', { class: 'exp-field grow' }, [h('span', { text: 'Maßstab' }), scale]),
      ]),
      size,
      grid,
    );
    sync();
    if (onRemove) {
      const rm = h('button', { class: 'dlg-btn danger-text', text: 'Blatt entfernen' });
      rm.addEventListener('click', () => {
        finish(dlg, resolve, null);
        onRemove();
      });
      actions.append(rm, h('div', { class: 'grow' }));
    }
    const cancel = h('button', { class: 'dlg-btn', text: 'Abbrechen' });
    const ok = h('button', { class: 'dlg-btn primary', text: confirm });
    actions.append(cancel, ok);
    cancel.addEventListener('click', () => finish(dlg, resolve, null));
    ok.addEventListener('click', () => finish(dlg, resolve, spec));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(dlg, resolve, null);
    });
    dlg.showModal();
    ok.focus();
  });
}

/** The (first) sheet in the drawing. */
export function findSheet(app: App): SheetEntity | null {
  for (const e of app.doc.all()) if (e.kind === 'sheet') return e;
  return null;
}

function sheetStyle(app: App, scale: number): SheetEntity['style'] {
  // Thin lines in the frame: 0.35 mm on paper.
  const base = app.style.pen === 'pencil' ? PENCIL_WIDTHS[0] : INK_WIDTHS[2];
  return { ...app.style, width: base * scale, lineType: 'solid', color: null };
}

/** The sheet at scale `scale`, kept centred where `old` was. */
function resized(app: App, e: SheetEntity, old: SheetEntity, scale: number): SheetEntity {
  const b = sheetBox(old);
  const [w, hh] = paperSize(e.format, e.landscape);
  const at = { x: (b.minX + b.maxX) / 2 - (w * scale) / 2, y: (b.minY + b.maxY) / 2 - (hh * scale) / 2 };
  return { ...e, scale, at, style: sheetStyle(app, scale) };
}

/** The sheet follows a new drawing scale (call inside the step that sets it). */
export function sheetFollowScale(app: App, scale: number): void {
  const cur = findSheet(app);
  if (cur && cur.scale !== scale) app.doc.update(resized(app, cur, cur, scale));
}

/** Insert a sheet on its own bottom layer, or edit the existing one. */
export async function editSheet(app: App): Promise<void> {
  const cur = findSheet(app);
  if (cur) {
    const spec = await askSheet(cur, 'Blatt & Schriftfeld', 'Übernehmen', () => {
      app.doc.remove(cur.id);
      app.toast('Blatt entfernt');
    });
    if (!spec) return;
    const before = app.doc.get(cur.id);
    if (before) {
      app.doc.begin();
      app.doc.update(resized(app, { ...cur, ...spec }, cur, spec.scale), before);
      app.doc.setScale(spec.scale);
      app.doc.commit();
    }
    savePref('sheetFields', { drawnBy: spec.fields.drawnBy, company: spec.fields.company });
    return;
  }
  const remembered = loadPref<Partial<TitleFields>>('sheetFields', {});
  const initial: SheetSpec = {
    format: 'A4',
    landscape: true,
    scale: drawingScale(),
    fields: { title: '', number: '', material: '', drawnBy: remembered.drawnBy ?? '', date: today(), company: remembered.company ?? '' },
  };
  const spec = await askSheet(initial, 'Blatt einfügen', 'Einfügen');
  if (!spec) return;
  savePref('sheetFields', { drawnBy: spec.fields.drawnBy, company: spec.fields.company });
  const doc = app.doc;
  doc.begin();
  let layer: Layer | undefined = doc.layers.find((l) => l.name === 'Blatt');
  if (!layer) {
    layer = { id: newId('L'), name: 'Blatt', visible: true, locked: false, dimmed: false };
    doc.setLayers([layer, ...doc.layers], doc.activeLayerId);
  }
  // Centre the sheet on the drawing (or the view when empty).
  const [w, hh] = paperSize(spec.format, spec.landscape);
  const view = app.cam.visibleBox(app.width, app.height);
  const c = { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 };
  const e: SheetEntity = {
    kind: 'sheet',
    id: newId('S'),
    layerId: layer.id,
    z: doc.allocZ(),
    style: sheetStyle(app, spec.scale),
    at: { x: c.x - (w * spec.scale) / 2, y: c.y - (hh * spec.scale) / 2 },
    ...spec,
  };
  doc.add(e);
  doc.setScale(spec.scale);
  doc.commit();
  app.fitBox(sheetBox(e));
}
