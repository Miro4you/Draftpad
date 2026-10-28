import { MM_PX, type App } from '../app';
import { newId } from '../core/document';
import { drawingScale, formatScale, SCALES } from '../core/scale';
import type { Layer } from '../core/types';
import { ask, askText } from './dialogs';
import { h } from './dom';
import { icons } from './icons';

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

// ---- toast -------------------------------------------------------------------------

export class Toast {
  readonly el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private timer: number | undefined;

  show(msg: string): void {
    this.el.textContent = msg;
    this.el.classList.add('show');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), 1800);
  }
}

// ---- view bar (top right) ----------------------------------------------------------

export class ViewBar {
  readonly el: HTMLElement;
  private compass: HTMLButtonElement;
  private zoom: HTMLButtonElement;
  private layerBtn: HTMLButtonElement;
  private layerName: HTMLElement;
  private liveBtn: HTMLButtonElement;
  private scaleBtn: HTMLElement;
  private scaleText: HTMLElement;
  private scaleSel: HTMLSelectElement;

  constructor(
    private app: App,
    private layersPanel: LayersPanel,
    menu: Menu,
    done?: { label: string; onClick: () => void },
  ) {
    const layers = layersPanel;
    this.compass = h('button', { class: 'btn', title: 'Ansicht gerade stellen (R)' });
    this.compass.addEventListener('click', () => app.resetRotation());
    this.zoom = h('button', { class: 'btn zoom', title: 'Alles zeigen (0)' });
    this.zoom.addEventListener('click', () => app.fitAll());
    // Drawing scale: a native picker over the button (wheel on the iPad).
    this.scaleText = h('span');
    this.scaleSel = h('select', { 'aria-label': 'Zeichnungsmaßstab' }) as HTMLSelectElement;
    for (const v of SCALES) this.scaleSel.append(h('option', { value: String(v), text: formatScale(v) }));
    this.scaleSel.addEventListener('change', () => {
      app.setScale(Number(this.scaleSel.value));
      this.scaleSel.blur();
    });
    this.scaleBtn = h('label', { class: 'btn scale' }, [this.scaleText, this.scaleSel]);
    this.layerName = h('span', { class: 'layer-name' });
    this.layerBtn = h('button', { class: 'btn wide', title: 'Ebenen', html: icons.layers });
    this.layerBtn.append(this.layerName);
    this.layerBtn.addEventListener('click', () => {
      menu.close();
      layers.toggle();
      this.update();
    });
    const menuBtn = h('button', { class: 'btn', title: 'Menü', html: icons.more });
    menuBtn.addEventListener('click', () => {
      layers.close();
      menu.toggle();
    });
    const recordBtn = h('button', { class: 'btn', title: 'Zeitraffer-Video aufnehmen', html: icons.record });
    recordBtn.addEventListener('click', () => {
      menu.close();
      layers.close();
      document.dispatchEvent(new CustomEvent('app:timelapse'));
    });
    this.liveBtn = h('button', { class: 'btn wide live-badge', title: 'Live-Bearbeitung (Online-Ablage)' });
    this.liveBtn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('app:cloud')));
    // The compact tool set (inside a host app) has no layers and no timelapse.
    const items = app.compact ? [this.compass, this.zoom, this.scaleBtn, menuBtn] : [this.liveBtn, this.compass, this.zoom, this.scaleBtn, this.layerBtn, recordBtn, menuBtn];
    if (done) {
      const doneBtn = h('button', { class: 'btn done-btn', text: done.label, title: `${done.label} – zurück` });
      doneBtn.addEventListener('click', () => {
        menu.close();
        done.onClick();
      });
      items.push(doneBtn);
    }
    this.el = h('div', { class: 'viewbar panel' }, items);
    app.live?.onChange(() => this.update());
    app.onUiChange(() => this.update());
    app.onViewChange(() => this.update());
    layers.onToggle = () => this.update();
  }

  private lastDeg = NaN;

  update(): void {
    const deg = (this.app.cam.rot * 180) / Math.PI;
    if (deg !== this.lastDeg) {
      this.lastDeg = deg;
      this.compass.innerHTML = icons.compass(deg);
    }
    setText(this.zoom, `${Math.round((this.app.cam.scale / MM_PX) * 100)} %`);
    const k = drawingScale();
    const auto = !this.app.doc.scaleSet;
    setText(this.scaleText, formatScale(k));
    this.scaleBtn.classList.toggle('auto', auto);
    this.scaleBtn.title = auto
      ? 'Maßstab – folgt noch dem Zoom, der erste Strich legt ihn fest'
      : 'Zeichnungsmaßstab: Strichstärken, Maßzahlen, Pfeile und Texte wie auf dem Papier';
    if (this.scaleSel.value !== String(k)) this.scaleSel.value = String(k);
    setText(this.layerName, this.app.doc.activeLayer.name);
    this.layerBtn.classList.toggle('active', this.layersPanel.isOpen);
    const live = this.app.live;
    const on = !!live && live.status !== 'off';
    this.liveBtn.hidden = !on;
    if (on && live) {
      this.liveBtn.dataset.health = live.health;
      setText(this.liveBtn, live.label);
      this.liveBtn.title = `Live: „${live.name}“`;
    }
  }
}

// ---- layers panel ------------------------------------------------------------------------

export class LayersPanel {
  readonly el = h('div', { class: 'layers panel popover', role: 'dialog', 'aria-label': 'Ebenen' });
  private list = h('div', { class: 'layer-list' });
  isOpen = false;
  onToggle: () => void = () => {};

  constructor(private app: App) {
    const add = h('button', { class: 'btn', title: 'Neue Ebene', html: icons.plus });
    add.addEventListener('click', () => this.addLayer());
    const up = h('button', { class: 'btn', title: 'Ebene nach oben', html: icons.up });
    up.addEventListener('click', () => this.move(1));
    const down = h('button', { class: 'btn', title: 'Ebene nach unten', html: icons.down });
    down.addEventListener('click', () => this.move(-1));
    const rename = h('button', { class: 'btn', title: 'Umbenennen', html: icons.rename });
    rename.addEventListener('click', () => void this.rename(app.doc.activeLayerId));
    const del = h('button', { class: 'btn danger', title: 'Ebene löschen', html: icons.trash });
    del.addEventListener('click', () => void this.remove());
    this.el.append(
      h('div', { class: 'popover-head' }, [h('span', { text: 'Ebenen' })]),
      this.list,
      h('div', { class: 'layer-actions' }, [add, up, down, rename, del]),
    );
    app.onUiChange(() => this.isOpen && this.render());
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.el.classList.add('open');
    this.render();
    this.onToggle();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    this.onToggle();
  }

  private renderedKey = '';

  private render(): void {
    const doc = this.app.doc;
    const counts = new Map<string, number>();
    for (const [id, arr] of doc.byLayer()) counts.set(id, arr.length);
    // Skip rebuilding the rows when nothing visible changed (e.g. while dragging).
    const key = JSON.stringify([doc.activeLayerId, doc.layers, [...counts]]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.list.replaceChildren(
      ...[...doc.layers].reverse().map((l) => {
        const row = h('div', { class: `layer-row${l.id === doc.activeLayerId ? ' active' : ''}${l.visible ? '' : ' hidden'}` });
        const vis = h('button', { class: 'icon-btn', title: l.visible ? 'Ausblenden' : 'Einblenden', html: l.visible ? icons.eye : icons.eyeOff });
        vis.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.patchLayerView(l.id, { visible: !l.visible });
        });
        const name = h('div', { class: 'layer-label' }, [
          h('span', { class: 'n', text: l.name }),
          h('span', { class: 'c', text: `${counts.get(l.id) ?? 0} ${counts.get(l.id) === 1 ? 'Objekt' : 'Objekte'}` }),
        ]);
        const dim = h('button', { class: `icon-btn${l.dimmed ? ' on' : ''}`, title: l.dimmed ? 'Normal anzeigen' : 'Blass anzeigen', html: icons.dim });
        dim.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.patchLayerView(l.id, { dimmed: !l.dimmed });
        });
        const lock = h('button', { class: `icon-btn${l.locked ? ' on' : ''}`, title: l.locked ? 'Entsperren' : 'Sperren', html: l.locked ? icons.lock : icons.unlock });
        lock.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.patchLayerView(l.id, { locked: !l.locked });
        });
        row.append(vis, name, dim, lock);
        row.addEventListener('click', () => doc.setActiveLayer(l.id));
        row.addEventListener('dblclick', () => void this.rename(l.id));
        return row;
      }),
    );
  }

  private addLayer(): void {
    const doc = this.app.doc;
    const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
    const n = doc.layers.length + 1;
    const layer: Layer = { id: newId('L'), name: `Ebene ${n}`, visible: true, locked: false, dimmed: false };
    const layers = [...doc.layers];
    layers.splice(idx + 1, 0, layer);
    doc.setLayers(layers, layer.id);
  }

  private move(dir: 1 | -1): void {
    const doc = this.app.doc;
    const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= doc.layers.length) return;
    const layers = [...doc.layers];
    [layers[idx], layers[j]] = [layers[j], layers[idx]];
    doc.setLayers(layers);
  }

  private async rename(id: string): Promise<void> {
    const doc = this.app.doc;
    const l = doc.layer(id);
    if (!l) return;
    const name = await askText('Ebene umbenennen', l.name, 'Umbenennen');
    if (!name || name === l.name || !doc.layer(id)) return;
    doc.setLayers(doc.layers.map((x) => (x.id === id ? { ...x, name } : x)));
  }

  private async remove(): Promise<void> {
    const doc = this.app.doc;
    if (doc.layers.length <= 1) {
      this.app.toast('Die letzte Ebene kann nicht gelöscht werden');
      return;
    }
    const l = doc.activeLayer;
    const count = doc.byLayer().get(l.id)?.length ?? 0;
    if (
      count > 0 &&
      !(await ask({
        title: 'Ebene löschen?',
        message: `„${l.name}“ enthält ${count} ${count === 1 ? 'Objekt' : 'Objekte'}. Du kannst das Löschen rückgängig machen.`,
        confirm: 'Löschen',
        danger: true,
      }))
    ) {
      return;
    }
    doc.deleteLayer(l.id);
  }
}

// ---- menu --------------------------------------------------------------------------------

export class Menu {
  readonly el = h('div', { class: 'menu panel popover', role: 'menu' });
  private toggles = new Map<string, HTMLButtonElement>();
  private themeRow: HTMLElement | null = null;
  isOpen = false;

  constructor(
    private app: App,
    actions: { newDrawing: () => void; open: () => void; download: () => void; exportFile: () => void; timelapse: () => void; sheet: () => void; cloud: () => void; help: () => void },
  ) {
    const item = (label: string, fn: () => void, hint = '') => {
      const b = h('button', { class: 'menu-item', role: 'menuitem' }, [h('span', { text: label }), h('kbd', { text: hint })]);
      b.addEventListener('click', () => {
        this.close();
        fn();
      });
      return b;
    };
    const toggle = (key: 'grid' | 'handles' | 'fingerDraws' | 'rotate' | 'centerMarks', label: string) => {
      const b = h('button', { class: 'menu-item toggle-item', role: 'menuitemcheckbox' }, [h('span', { text: label }), h('span', { class: 'switch' })]);
      b.addEventListener('click', () => app.updateSettings({ [key]: !app.settings[key] }));
      this.toggles.set(key, b);
      return b;
    };
    const themeRow = h('div', { class: 'seg menu-seg' });
    for (const [t, label] of [
      ['light', 'Hell'],
      ['dark', 'Dunkel'],
      ['system', 'System'],
    ] as const) {
      const b = h('button', { class: 'seg-btn', text: label });
      b.dataset.theme = t;
      b.addEventListener('click', () => app.updateSettings({ theme: t }));
      themeRow.append(b);
    }
    this.themeRow = themeRow;
    // Inside a host app the host keeps the drawing and sets the theme.
    const fileItems = app.compact
      ? [item('Exportieren (PDF, SVG, PNG, JPEG) …', actions.exportFile, '⇧⌘E')]
      : [
          item('Neue Zeichnung', actions.newDrawing),
          item('Datei öffnen …', actions.open, '⌘O'),
          item('Datei herunterladen', actions.download, '⌘S'),
          item('Exportieren (PDF, SVG, PNG, JPEG) …', actions.exportFile, '⇧⌘E'),
          item('Zeitraffer-Video …', actions.timelapse),
          item('Online-Ablage …', actions.cloud),
          item('Blatt & Schriftfeld …', actions.sheet),
        ];
    this.el.append(
      ...fileItems,
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label', text: 'Darstellung' }),
      ...(app.compact ? [] : [themeRow]),
      toggle('grid', 'Raster'),
      toggle('handles', 'Korrekturgriffe nach dem Zeichnen'),
      toggle('centerMarks', 'Mittellinien bei neuen Kreisen'),
      toggle('rotate', 'Drehen mit zwei Fingern'),
      toggle('fingerDraws', 'Mit dem Finger zeichnen'),
      h('div', { class: 'menu-sep' }),
      item('Bedienung & Kurzbefehle', actions.help, '?'),
    );
    app.onUiChange(() => this.update());
    this.update();
  }

  private update(): void {
    for (const b of this.themeRow?.querySelectorAll<HTMLElement>('.seg-btn') ?? []) {
      b.classList.toggle('active', b.dataset.theme === this.app.settings.theme);
    }
    for (const [key, b] of this.toggles) {
      const on = this.app.settings[key as 'grid' | 'handles' | 'fingerDraws' | 'rotate' | 'centerMarks'];
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else {
      this.isOpen = true;
      this.el.classList.add('open');
    }
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.remove('open');
  }
}

// ---- help --------------------------------------------------------------------------------

export function helpDialog(): HTMLDialogElement {
  const rows: [string, string][] = [
    ['Apple Pencil / Maus', 'Zeichnen mit dem aktiven Werkzeug'],
    ['Ein Finger ziehen', 'Ansicht verschieben'],
    ['Zwei Finger', 'Verschieben, zoomen, drehen (rastet bei 0°/45°/90° ein)'],
    ['Zwei-Finger-Tipp', 'Rückgängig'],
    ['Drei-Finger-Tipp', 'Wiederholen'],
    ['Finger halten beim Zeichnen', 'Fang kurz aussetzen'],
    ['Mausrad', 'Zoomen'],
    ['Leertaste + Ziehen, mittlere/rechte Maustaste', 'Ansicht verschieben'],
    ['Alt halten', 'Fang kurz aussetzen'],
    ['Shift halten', 'Längen frei statt in 0,5-mm-Schritten (Schrittweite im Winkel-Menü)'],
    ['V · F · L · C · B · K', 'Auswahl · Freihand · Linie · Kreis · Bogen · Achsenkreuz'],
    ['Werkzeuggruppe: nochmal tippen, lange drücken oder mit dem Pencil darüber schweben', 'Auswahl der Gruppe öffnen'],
    ['Strich-Punkt-Linie', 'Wird automatisch Symmetrieachse (Knopf am Ende schaltet Spiegeln)'],
    ['X · T · E', 'Objekt löschen · Trimmen · Radierer'],
    ['Q · U · W', 'Rechteck · Ecken verrunden (antippen oder Radius ziehen) · Text'],
    ['I', 'Normteil einfügen: Teil wählen, dann antippen (oder drücken und ziehen zum Drehen)'],
    ['N', 'Nachzeichnen: Linien anderer Ebenen antippen oder überwischen → mit dem aktuellen Stift auf die aktive Ebene'],
    ['H', 'Schraffur: in eine geschlossene Fläche tippen (kleine Lücken werden überbrückt)'],
    ['D', 'Bemaßung: Punkt zu Punkt ziehen, dann Maßlinie platzieren · Linie/Kreis/Bogen antippen · zwei Linien = Winkel'],
    ['P', 'GPS: Bezug oder Toleranzrahmen – auf Element drücken und wegziehen'],
    ['M', 'Technik: Festlager, Loslager, Einspannung, Gelenk, Einzelkraft, Moment, Streckenlast – rasten an der Geometrie ein'],
    ['Bogen', 'Am Startpunkt in die Startrichtung losziehen: auf Linien, Bögen und Kreisen tangential (vor- oder rückwärts), sonst in Zugrichtung; zurück zum Start = neu wählen'],
    ['Auswahl: antippen / Schlinge', 'Objekte hinzufügen oder entfernen / einkreisen'],
    ['Auswahl ziehen · Drehknopf', 'Verschieben mit Fang · Drehen'],
    ['Entf · ⌘D · ⌘A · Pfeile', 'Löschen · Duplizieren · Alles wählen · Verschieben 1 mm (⇧ 10 mm)'],
    ['Symmetrieachse', 'Linie auswählen → Achse; Knopf an der Achse schaltet Spiegeln'],
    ['1 · 2 · 3 · 4', 'Linienart: Voll · Strich · Strich-Punkt · Strich-Zweipunkt'],
    ['⇧1–⇧4 · ⇧5–⇧9', 'Bleistift 0,3–0,9 · Tusche 0,18–0,7'],
    ['S · A · G', 'Fang · Winkelmodus · Raster'],
    ['0 · R', 'Alles zeigen · Ansicht gerade'],
    ['⌘Z · ⇧⌘Z', 'Rückgängig · Wiederholen'],
    ['⌘S · ⌘O · ⇧⌘E', 'Herunterladen · Öffnen · Exportieren'],
    ['Esc', 'Aktion abbrechen'],
  ];
  const close = h('button', { class: 'btn', title: 'Schließen', html: icons.close });
  const dlg = h('dialog', { class: 'help panel' }, [
    h('div', { class: 'popover-head' }, [h('span', { text: 'Bedienung & Kurzbefehle' }), close]),
    h(
      'table',
      {},
      rows.map(([k, v]) => h('tr', {}, [h('th', { text: k }), h('td', { text: v })])),
    ),
  ]);
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  return dlg;
}
