import { GPS_NAMES, GPS_NEEDS_DATUM, symbolLayout } from '../core/annotations';
import type { GpsSymbol } from '../core/types';
import { drawLayout } from '../render/annotations';
import { h, releaseTextFocus } from './dom';

/**
 * In-app replacements for confirm()/prompt(): styled like the rest of the UI and
 * available in embedded contexts where the native dialogs are blocked.
 */

interface AskOptions {
  title: string;
  message?: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

export function baseDialog(title: string): { dlg: HTMLDialogElement; body: HTMLElement; actions: HTMLElement } {
  const body = h('div', { class: 'dlg-body' });
  const actions = h('div', { class: 'dlg-actions' });
  const dlg = h('dialog', { class: 'panel ask' }, [h('h2', { class: 'dlg-title', text: title }), body, actions]);
  document.body.append(dlg);
  return { dlg, body, actions };
}

export function finish<T>(dlg: HTMLDialogElement, resolve: (v: T) => void, value: T): void {
  releaseTextFocus();
  dlg.close();
  dlg.remove();
  resolve(value);
}

export function ask(opts: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { dlg, body, actions } = baseDialog(opts.title);
    if (opts.message) body.append(h('p', { text: opts.message }));
    const cancel = h('button', { class: 'dlg-btn', text: opts.cancel ?? 'Abbrechen' });
    const ok = h('button', { class: `dlg-btn primary${opts.danger ? ' danger' : ''}`, text: opts.confirm });
    actions.append(cancel, ok);
    cancel.addEventListener('click', () => finish(dlg, resolve, false));
    ok.addEventListener('click', () => finish(dlg, resolve, true));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(dlg, resolve, false);
    });
    dlg.showModal();
    ok.focus();
  });
}

/**
 * Text input; resolves null on cancel. Empty input gives null too unless
 * `allowEmpty`. `multiline` uses a text area (Return = new line).
 */
export function askText(
  title: string,
  value: string,
  confirm = 'Übernehmen',
  hint?: string,
  allowEmpty = false,
  multiline = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    const { dlg, body, actions } = baseDialog(title);
    if (hint) body.append(h('p', { text: hint }));
    const input = multiline
      ? h('textarea', { class: 'dlg-input dlg-area', id: 'dlg-text', rows: '3', autocomplete: 'off' })
      : h('input', { class: 'dlg-input', type: 'text', id: 'dlg-text', autocomplete: 'off' });
    input.value = value;
    const form = h('form', { method: 'dialog' }, [input]);
    body.append(form);
    const cancel = h('button', { class: 'dlg-btn', text: 'Abbrechen' });
    const ok = h('button', { class: 'dlg-btn primary', text: confirm });
    actions.append(cancel, ok);
    const submit = () => {
      const v = multiline ? input.value.replace(/\s+$/, '') : input.value.trim();
      finish(dlg, resolve, v || allowEmpty ? v : null);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    // ⌘/Ctrl+Return confirms a text area.
    input.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (multiline && ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
        ke.preventDefault();
        submit();
      }
    });
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => finish(dlg, resolve, null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(dlg, resolve, null);
    });
    dlg.showModal();
    input.focus();
    input.select();
  });
}

export interface GtolSpec {
  sym: GpsSymbol;
  value: string;
  dia: boolean;
  datums: string[];
}

const GPS_ORDER: GpsSymbol[] = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
  'profileLine',
  'profileSurface',
  'parallelism',
  'perpendicularity',
  'angularity',
  'position',
  'concentricity',
  'symmetry',
  'runout',
  'totalRunout',
];

/** Small canvas showing a characteristic symbol (drawn like on the drawing). */
export function symbolCanvas(sym: GpsSymbol, size = 28): HTMLCanvasElement {
  const c = h('canvas', { class: 'sym-canvas', 'aria-hidden': 'true' });
  const dpr = window.devicePixelRatio || 1;
  c.width = size * dpr;
  c.height = size * dpr;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext('2d');
  if (ctx) {
    const k = (size * dpr) / 5.2;
    ctx.setTransform(k, 0, 0, k, (size * dpr) / 2, (size * dpr) / 2);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#222';
    drawLayout(ctx, symbolLayout(sym), color, 0.28, 1);
  }
  return c;
}

/** Tolerance frame editor: characteristic, value, Ø and datums. */
export function askGtol(initial: GtolSpec, confirm = 'Einfügen'): Promise<GtolSpec | null> {
  return new Promise((resolve) => {
    const { dlg, body, actions } = baseDialog('Form- und Lagetoleranz');
    dlg.classList.add('gtol-dlg');
    let sym = initial.sym;
    const grid = h('div', { class: 'sym-grid', role: 'radiogroup' });
    const name = h('div', { class: 'sym-name' });
    const buttons = new Map<GpsSymbol, HTMLButtonElement>();
    const refresh = () => {
      for (const [s, b] of buttons) b.setAttribute('aria-checked', String(s === sym));
      name.textContent = GPS_NAMES[sym];
      datumRow.classList.toggle('muted', !GPS_NEEDS_DATUM[sym]);
    };
    for (const s of GPS_ORDER) {
      const b = h('button', { class: 'sym-btn', role: 'radio', title: GPS_NAMES[s], 'aria-label': GPS_NAMES[s] }, [symbolCanvas(s)]);
      b.addEventListener('click', () => {
        sym = s;
        if (!GPS_NEEDS_DATUM[s]) datums.value = '';
        refresh();
      });
      buttons.set(s, b);
      grid.append(b);
    }
    const dia = h('input', { type: 'checkbox', id: 'gtol-dia' });
    dia.checked = initial.dia;
    const value = h('input', { class: 'dlg-input', type: 'text', id: 'gtol-value', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,05' });
    value.value = initial.value;
    const datums = h('input', { class: 'dlg-input', type: 'text', id: 'gtol-datums', autocomplete: 'off', placeholder: 'z. B. A B' });
    datums.value = initial.datums.join(' ');
    const datumRow = h('label', { class: 'gtol-field gtol-datums' }, [h('span', { text: 'Bezüge' }), datums]);
    const valueRow = h('div', { class: 'gtol-row' }, [
      h('label', { class: 'gtol-dia', for: 'gtol-dia', title: 'Toleranzzone ist ein Durchmesser' }, [dia, 'Ø']),
      h('label', { class: 'gtol-field' }, [h('span', { text: 'Toleranz' }), value]),
      datumRow,
    ]);
    const form = h('form', { method: 'dialog' }, [valueRow]);
    body.append(grid, name, form);
    refresh();
    const cancel = h('button', { class: 'dlg-btn', text: 'Abbrechen' });
    const ok = h('button', { class: 'dlg-btn primary', text: confirm });
    actions.append(cancel, ok);
    const submit = () => {
      const v = value.value.trim().replace('.', ',');
      const ds = datums.value
        .toUpperCase()
        .split(/[\s,;|/-]+/)
        .filter(Boolean)
        .slice(0, 3);
      finish(dlg, resolve, { sym, value: v || '0,1', dia: dia.checked, datums: ds });
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => finish(dlg, resolve, null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(dlg, resolve, null);
    });
    dlg.showModal();
    // On touch devices don't pop up the keyboard right away (it would cover the dialog).
    if (window.matchMedia?.('(pointer: fine)').matches) {
      value.focus();
      value.select();
    } else ok.focus();
  });
}
