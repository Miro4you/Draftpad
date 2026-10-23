import type { App, ToolId } from '../app';
import { formatWidth, HARDNESSES, INK_WIDTHS, LINE_TYPES, PEN_NAMES, PENCIL_WIDTHS } from '../core/pens';
import type { Hardness, HatchPattern, LineType, PenKind } from '../core/types';
import { HATCH_NAMES } from '../render/annotations';
import { HATCH_GAPS } from '../tools/hatch';
import { PART_ANGLES, partLabel } from '../core/parts';
import { askPart } from './part-dialog';
import { loadPref, savePref } from '../storage/idb';
import { icons, lineTypeIcon } from './icons';
import { h } from './dom';
import { Flyout } from './flyout';
import { ColorPopover } from './colors';
import { penColor } from '../core/pens';

type Orient = 'h' | 'v';
interface PalettePrefs {
  x: number | null;
  y: number | null;
  orient: Orient;
  collapsed: boolean;
}

/** Index 0–8 across both pen sets (keyboard Shift + 1–9). */
export const ALL_PENS: { pen: PenKind; width: number }[] = [
  ...PENCIL_WIDTHS.map((width) => ({ pen: 'pencil' as const, width })),
  ...INK_WIDTHS.map((width) => ({ pen: 'ink' as const, width })),
];

const LINE_DASH: Record<LineType, string> = {
  solid: '',
  dashed: '3.2 4.2',
  dashdot: '7 3.6 0.01 3.6',
  dashdotdot: '5.5 3 0.01 3 0.01 3',
  freehand: '',
};


/** Tiny preview of a hatch pattern. */
function hatchIcon(p: HatchPattern): string {
  const lines: Record<HatchPattern, string> = {
    diag: '<path d="M3 13 13 3M3 21 21 3M11 21l10-10"/>',
    diag2: '<path d="M3 11l10 10M3 3l18 18M11 3l10 10"/>',
    cross: '<path d="M3 13 13 3M3 21 21 3M11 21l10-10M3 11l10 10M3 3l18 18M11 3l10 10"/>',
    steel: '<path d="M3 11 11 3M3 13.5 13.5 3M3 21 21 3M5.5 21 21 5.5"/>',
    plastic: '<path d="M3 13 13 3M11 21l10-10"/><path d="M3 21 21 3" stroke-dasharray="3 2"/>',
    dots: '<g fill="currentColor" stroke="none"><circle cx="7" cy="7" r="1.1"/><circle cx="17" cy="7" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="7" cy="17" r="1.1"/><circle cx="17" cy="17" r="1.1"/></g>',
  };
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1.5" stroke-width="1.1" opacity=".55"/>${lines[p]}</svg>`;
}
/** One tool in a palette group. */
interface GroupItem {
  id: string;
  title: string;
  icon: string;
  pick: (app: App) => void;
  active: (app: App) => boolean;
}

/** Option section of a group's flyout, shown only while `when` holds. */
interface GroupOptions {
  el: HTMLElement;
  when: (app: App) => boolean;
}

const tool = (id: ToolId, title: string, icon: string): GroupItem => ({
  id,
  title,
  icon,
  pick: (app) => app.setTool(id),
  active: (app) => app.toolId === id,
});

const SHAPES: GroupItem[] = [
  tool('circle', 'Kreis: Mittelpunkt, dann Radius (C)', icons.circle),
  tool('rect', 'Rechteck: von Ecke zu Ecke (Q)', icons.rect),
  {
    id: 'arc',
    title: 'Bogen: losziehen in Startrichtung – auf Linien tangential, vor- oder rückwärts (B)',
    icon: icons.arc,
    pick: (app) => {
      app.updateSettings({ arcMode: 'auto' });
      app.setTool('arc');
    },
    active: (app) => app.toolId === 'arc' && app.settings.arcMode !== 'center',
  },
  {
    id: 'arc-center',
    title: 'Bogen um Mittelpunkt',
    icon: icons.arcCenter,
    pick: (app) => {
      app.updateSettings({ arcMode: 'center' });
      app.setTool('arc');
    },
    active: (app) => app.toolId === 'arc' && app.settings.arcMode === 'center',
  },
  tool('cross', 'Achsenkreuz (Mittellinien): Mittelpunkt, dann Armlänge (K)', icons.cross),
  tool('freehand', 'Freihand mit Glättungsschnur (F)', icons.freehand),
];

const gps = (mode: 'datum' | 'gtol', title: string, icon: string): GroupItem => ({
  id: mode,
  title,
  icon,
  pick: (app) => {
    app.updateSettings({ gpsMode: mode });
    app.setTool('gps');
  },
  active: (app) => app.toolId === 'gps' && app.settings.gpsMode === mode,
});

const ANNOS: GroupItem[] = [
  tool('dim', 'Bemaßung: von Punkt zu Punkt ziehen oder Element antippen (D)', icons.dimension),
  gps('datum', 'Bezug (A, B, …): auf Kante drücken und wegziehen (P)', icons.datum),
  gps('gtol', 'Form- und Lagetoleranz: auf Element drücken und Rahmen wegziehen (P)', icons.gtol),
  tool('text', 'Text: Startpunkt antippen, vorhandenen Text antippen zum Ändern (W)', icons.text),
];

const ERASERS: GroupItem[] = [
  tool('delete', 'Objekt löschen: antippen oder drüberwischen (X)', icons.deleteObj),
  tool('trim', 'Trimmen bis zum nächsten Schnittpunkt (T)', icons.trim),
  tool('erase', 'Radierer (E)', icons.eraser),
];

const SPECIALS: GroupItem[] = [
  tool('fillet', 'Ecken verrunden: an die Ecke tippen, oder ziehen für den Radius (U)', icons.fillet),
  tool('trace', 'Nachzeichnen: Linien anderer Ebenen antippen oder überwischen – mit dem aktuellen Stift auf die aktive Ebene (N)', icons.trace),
  {
    id: 'part',
    title: 'Normteile: Bohrungen, Schrauben, Muttern, Kugellager, Sicherungsring-Nuten (I)',
    icon: icons.part,
    pick: (app) => void choosePart(app),
    active: (app) => app.toolId === 'part',
  },
];

/** Pick a standard part, then place it. */
export async function choosePart(app: App): Promise<void> {
  const spec = await askPart(app.settings.part);
  if (!spec) return;
  app.updateSettings({ part: spec });
  app.setTool('part');
}

/**
 * A palette button for a group of tools. Its icon shows the active (or last
 * used) tool; tapping it picks that tool, tapping again – or hovering, or a long
 * press – opens the group with its tools and the options of the active one.
 */
class ToolGroup {
  readonly btn: HTMLButtonElement;
  readonly fly: Flyout;
  private itemBtns = new Map<string, HTMLButtonElement>();
  private last: string;

  constructor(
    private app: App,
    private key: string,
    title: string,
    private list: GroupItem[],
    private options: GroupOptions[],
    side: () => 'above' | 'right',
  ) {
    const saved = loadPref<{ id: string }>(`group.${key}`, { id: list[0].id }).id;
    this.last = list.some((i) => i.id === saved) ? saved : list[0].id;
    this.btn = h('button', { class: 'btn tool', title, 'aria-label': title });
    const content: HTMLElement[] = [];
    if (list.length > 1) {
      const row = h('div', { class: 'fly-tools' });
      for (const it of list) {
        const b = h('button', { class: 'btn fly-item', title: it.title, 'aria-label': it.title, html: it.icon, 'data-item': '1' });
        b.addEventListener('click', () => {
          this.pick(it);
          this.fly.close();
        });
        this.itemBtns.set(it.id, b);
        row.append(b);
      }
      content.push(row);
    }
    for (const o of options) content.push(o.el);
    this.fly = new Flyout(content, side, options.length ? 'fly-wide' : 'fly-row');
    this.fly.attach(this.btn, () => {
      if (this.activeItem()) this.fly.toggle(this.btn);
      else this.pick(this.list.find((i) => i.id === this.last) ?? this.list[0]);
    });
  }

  activeItem(): GroupItem | undefined {
    return this.list.find((i) => i.active(this.app));
  }

  pick(it: GroupItem): void {
    it.pick(this.app);
    this.last = it.id;
    savePref(`group.${this.key}`, { id: it.id });
  }

  update(): void {
    const act = this.activeItem();
    const shown = act ?? this.list.find((i) => i.id === this.last) ?? this.list[0];
    if (this.btn.dataset.icon !== shown.id) {
      this.btn.innerHTML = shown.icon;
      this.btn.dataset.icon = shown.id;
    }
    this.btn.classList.toggle('active', !!act);
    for (const [id, b] of this.itemBtns) b.classList.toggle('active', id === act?.id);
    let changed = false;
    for (const o of this.options) {
      const hide = !o.when(this.app);
      if (o.el.hidden !== hide) {
        o.el.hidden = hide;
        changed = true;
      }
    }
    if (changed) this.fly.reposition();
  }
}

/** Floating, draggable tool palette with pop-out groups. */
export class Palette {
  readonly el: HTMLElement;
  private prefs: PalettePrefs = loadPref<PalettePrefs>('palette', { x: null, y: null, orient: 'h', collapsed: false });
  private selectBtn: HTMLButtonElement;
  private drawLineBtn: HTMLButtonElement;
  private groups: ToolGroup[] = [];
  private radiusItems = new Map<number, HTMLButtonElement>();
  private textSizeItems = new Map<number, HTMLButtonElement>();
  private hatchItems = new Map<string, HTMLButtonElement>();
  private partLabel!: HTMLElement;
  private partAngleItems = new Map<number | null, HTMLButtonElement>();
  private penBtn: HTMLButtonElement;
  private lineBtn: HTMLButtonElement;
  private colorBtn: HTMLButtonElement;
  private snapBtn: HTMLButtonElement;
  private angleBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private colors: ColorPopover;
  private flyouts: Flyout[] = [];
  private penItems: HTMLButtonElement[] = [];
  private hardItems = new Map<Hardness, HTMLButtonElement>();
  private lineItems = new Map<LineType, HTMLButtonElement>();
  private angleItems = new Map<string, HTMLButtonElement>();
  private stabilizer: HTMLInputElement;
  private stabilizerValue: HTMLElement;

  constructor(private app: App) {
    this.colors = new ColorPopover(app);
    const side = () => (this.prefs.orient === 'v' ? 'right' : 'above') as 'above' | 'right';
    const btn = (title: string, html: string, cls = 'btn tool') => h('button', { class: cls, title, 'aria-label': title, html });
    const item = (title: string, html: string, onPick: () => void, fly: () => Flyout, cls = 'btn') => {
      const b = h('button', { class: `${cls} fly-item`, title, 'aria-label': title, html, 'data-item': '1' });
      b.addEventListener('click', () => {
        onPick();
        fly().close();
      });
      return b;
    };

    // Selection and line: always one tap away.
    this.selectBtn = btn('Auswahl (V)', icons.select);
    this.selectBtn.addEventListener('click', () => app.setTool('select'));
    this.drawLineBtn = btn('Linie (L)', icons.line);
    this.drawLineBtn.addEventListener('click', () => app.setTool('line'));

    // Shapes (freehand smoothing shows while freehand is active).
    this.stabilizer = h('input', { type: 'range', min: '0', max: '60', step: '2', id: 'stabilizer', 'aria-label': 'Glättung' });
    this.stabilizerValue = h('span', { class: 'range-value' });
    this.stabilizer.addEventListener('input', () => app.updateSettings({ stabilizer: Number(this.stabilizer.value) }));
    const freeOpts = h('div', { class: 'fly-section' }, [
      h('div', { class: 'fly-title', text: 'Glättung (Schnur)' }),
      h('div', { class: 'range-row' }, [this.stabilizer, this.stabilizerValue]),
      h('div', { class: 'fly-hint', text: 'Die Linie folgt dem Stift an einer Schnur – ruhige Wellen, z. B. für Bruchkanten.' }),
    ]);
    const shapes = new ToolGroup(app, 'shapes', 'Formen: Kreis, Rechteck, Bogen, Achsenkreuz, Freihand', SHAPES, [{ el: freeOpts, when: (a) => a.toolId === 'freehand' }], side);

    // Hatching with its options.
    const patRow = h('div', { class: 'seg seg-icons' });
    for (const p of Object.keys(HATCH_NAMES) as HatchPattern[]) {
      const b = h('button', { class: 'seg-btn', title: HATCH_NAMES[p], 'aria-label': HATCH_NAMES[p], html: hatchIcon(p), 'data-item': '1' });
      b.addEventListener('click', () => {
        app.updateSettings({ hatchPattern: p });
        app.setTool('hatch');
      });
      this.hatchItems.set(`p:${p}`, b);
      patRow.append(b);
    }
    const spaceRow = h('div', { class: 'seg' });
    for (const sp of [1, 2, 3, 5]) {
      const b = h('button', { class: 'seg-btn', text: `${sp} mm`, 'data-item': '1' });
      b.addEventListener('click', () => {
        app.updateSettings({ hatchSpacing: sp });
        app.setTool('hatch');
      });
      this.hatchItems.set(`s:${sp}`, b);
      spaceRow.append(b);
    }
    const gapRow = h('div', { class: 'seg' });
    for (const g of HATCH_GAPS) {
      const b = h('button', { class: 'seg-btn', text: `${String(g).replace('.', ',')} mm`, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ hatchGap: g }));
      this.hatchItems.set(`g:${g}`, b);
      gapRow.append(b);
    }
    const hatchOpts = h('div', { class: 'fly-section' }, [
      h('div', { class: 'fly-title', text: 'Muster' }),
      patRow,
      h('div', { class: 'fly-title', text: 'Abstand' }),
      spaceRow,
      h('div', { class: 'fly-title', text: 'Lücken schließen bis' }),
      gapRow,
      h('div', { class: 'fly-hint', text: 'Antippen einer vorhandenen Schraffur übernimmt Muster und Abstand.' }),
    ]);
    const hatch = new ToolGroup(
      app,
      'hatch',
      'Schraffur: in geschlossene Fläche tippen (H) · nochmal tippen: Muster',
      [tool('hatch', 'Schraffur', icons.hatch)],
      [{ el: hatchOpts, when: () => true }],
      side,
    );

    // Annotations (text size while the text tool is active).
    const sizeRow = h('div', { class: 'seg' });
    for (const sz of [2.5, 3.5, 5, 7, 10]) {
      const b = h('button', { class: 'seg-btn', text: String(sz).replace('.', ','), title: `Schrifthöhe ${String(sz).replace('.', ',')} mm`, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ textSize: sz }));
      this.textSizeItems.set(sz, b);
      sizeRow.append(b);
    }
    const textOpts = h('div', { class: 'fly-section' }, [h('div', { class: 'fly-title', text: 'Schrifthöhe (mm)' }), sizeRow]);
    const annos = new ToolGroup(app, 'annos', 'Beschriften: Bemaßung, Bezug, Toleranzrahmen, Text', ANNOS, [{ el: textOpts, when: (a) => a.toolId === 'text' }], side);

    // Erasing.
    const erasers = new ToolGroup(app, 'erasers', 'Löschen: Objekt, Trimmen, Radierer', ERASERS, [], side);

    // Special tools (fillet radius while filleting).
    const radRow = h('div', { class: 'seg' });
    for (const r of [0, 1, 2, 3, 5, 10]) {
      const b = h('button', { class: 'seg-btn', text: r === 0 ? 'Ecke' : `R${r}`, title: r === 0 ? 'Scharfe Ecke (Linien kürzen/verlängern)' : `Radius ${r} mm`, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ filletRadius: r }));
      this.radiusItems.set(r, b);
      radRow.append(b);
    }
    const filletOpts = h('div', { class: 'fly-section' }, [
      h('div', { class: 'fly-title', text: 'Radius' }),
      radRow,
      h('div', { class: 'fly-hint', text: 'Oder an der Ecke drücken und ziehen – der Radius folgt dem Stift.' }),
    ]);
    this.partLabel = h('div', { class: 'part-current' });
    const partBtn = h('button', { class: 'dlg-btn', text: 'Anderes Teil …', 'data-item': '1' });
    partBtn.addEventListener('click', () => void choosePart(app));
    const angleRow = h('div', { class: 'seg' });
    for (const a of PART_ANGLES) {
      const b = h('button', { class: 'seg-btn', text: a === null ? 'frei' : `${a}°`, title: a === null ? 'Frei: Drücken und Ziehen dreht das Teil' : `Einfügewinkel ${a}°`, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ part: { ...app.settings.part, angle: a } }));
      this.partAngleItems.set(a, b);
      angleRow.append(b);
    }
    const partOpts = h('div', { class: 'fly-section' }, [
      h('div', { class: 'fly-title', text: 'Normteil' }),
      this.partLabel,
      partBtn,
      h('div', { class: 'fly-title', text: 'Einfügewinkel' }),
      angleRow,
      h('div', { class: 'fly-hint', text: 'Antippen setzt das Teil; bei „frei“ dreht Drücken und Ziehen es vorher in die Zugrichtung.' }),
    ]);
    const specials = new ToolGroup(
      app,
      'specials',
      'Sonderwerkzeuge: Ecken verrunden, Nachzeichnen, Normteile',
      SPECIALS,
      [
        { el: filletOpts, when: (a) => a.toolId === 'fillet' },
        { el: partOpts, when: (a) => a.toolId === 'part' },
      ],
      side,
    );
    this.groups = [shapes, hatch, annos, erasers, specials];

    // Pens.
    this.penBtn = h('button', { class: 'chip pen-trigger', title: 'Stift wählen (⇧1–9)', 'aria-label': 'Stift' });
    const pencils = h('div', { class: 'pen-row' }, [h('span', { class: 'row-label', text: 'Bleistift' })]);
    const inks = h('div', { class: 'pen-row' }, [h('span', { class: 'row-label', text: 'Tusche' })]);
    const hardRow = h('div', { class: 'pen-row' }, [h('span', { class: 'row-label', text: 'Härte' })]);
    const hardSeg = h('div', { class: 'seg hard-seg' });
    for (const hd of HARDNESSES) {
      const b = h('button', { class: 'seg-btn', text: hd, title: `Mine ${hd}${hd === '2H' ? ' – hell' : hd === '2B' ? ' – dunkel' : ''}`, 'data-item': '1' });
      b.addEventListener('click', () => app.setStyle({ hardness: hd, pen: 'pencil', ...(app.style.pen === 'pencil' ? {} : { width: 0.5 }) }));
      this.hardItems.set(hd, b);
      hardSeg.append(b);
    }
    hardRow.append(hardSeg);
    const penFly: Flyout = new Flyout([pencils, hardRow, inks], side, 'fly-pens');
    ALL_PENS.forEach((p, i) => {
      const title = `${PEN_NAMES[p.pen]} ${formatWidth(p.width)} mm (⇧${i + 1})`;
      const b = item(title, '', () => this.selectPen(i), () => penFly, `chip ${p.pen}`);
      b.append(this.penDot(p.pen, p.width), h('span', { class: 'cap', text: formatWidth(p.width) }));
      this.penItems.push(b);
      (p.pen === 'pencil' ? pencils : inks).append(b);
    });
    penFly.attach(this.penBtn, () => penFly.toggle(this.penBtn));

    // Line types.
    this.lineBtn = btn('Linienart (1–4)', '', 'btn lt');
    const lineFly: Flyout = new Flyout(
      LINE_TYPES.map((lt) => {
        const b = item(`${lt.name} – ${lt.use} (${LINE_TYPES.indexOf(lt) + 1})`, lineTypeIcon(LINE_DASH[lt.id]), () => app.setStyle({ lineType: lt.id }), () => lineFly, 'btn lt');
        this.lineItems.set(lt.id, b);
        return b;
      }),
      side,
      'fly-row',
    );
    lineFly.attach(this.lineBtn, () => lineFly.toggle(this.lineBtn));

    // Colour.
    this.colorBtn = h('button', { class: 'btn color-btn', title: 'Farbe', 'aria-label': 'Farbe' });
    this.colorBtn.append(h('span', { class: 'swatch' }));
    this.colorBtn.addEventListener('click', () => this.colors.toggle(this.colorBtn));

    // Snapping.
    this.snapBtn = h('button', { class: 'btn toggle', title: 'Fang an Endpunkten, Mitten, Schnittpunkten (S)' });
    this.snapBtn.innerHTML = `${icons.snap}<span class="cap">Fang</span>`;
    this.snapBtn.addEventListener('click', () => app.updateSettings({ snap: !app.settings.snap }));
    this.angleBtn = h('button', { class: 'btn toggle', title: 'Winkelfang und Längenschritte (A)' });
    const modeRow = h('div', { class: 'seg' });
    for (const [mode, label] of [
      ['snap', 'Einrasten'],
      ['show', 'Nur Anzeige'],
      ['off', 'Aus'],
    ] as const) {
      const b = h('button', { class: 'seg-btn', text: label, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ angleMode: mode }));
      this.angleItems.set(mode, b);
      modeRow.append(b);
    }
    const stepRow = h('div', { class: 'seg' });
    for (const step of [5, 10, 15]) {
      const b = h('button', { class: 'seg-btn', text: `${step}°`, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ angleStep: step, angleMode: 'snap' }));
      this.angleItems.set(`s${step}`, b);
      stepRow.append(b);
    }
    const lenRow = h('div', { class: 'seg' });
    for (const [step, label] of [
      [0, 'Frei'],
      [0.1, '0,1'],
      [0.5, '0,5'],
      [1, '1 mm'],
    ] as const) {
      const b = h('button', { class: 'seg-btn', text: label, 'data-item': '1' });
      b.addEventListener('click', () => app.updateSettings({ lengthStep: step }));
      this.angleItems.set(`l${step}`, b);
      lenRow.append(b);
    }
    const angleFly = new Flyout(
      [
        h('div', { class: 'fly-title', text: 'Winkel' }),
        modeRow,
        h('div', { class: 'fly-title', text: 'Schritt' }),
        stepRow,
        h('div', { class: 'fly-title', text: 'Längen in Schritten' }),
        lenRow,
        h('div', { class: 'fly-hint', text: 'Shift halten oder beim Zeichnen einen Finger auflegen: frei.' }),
      ],
      side,
      'fly-wide',
    );
    angleFly.attach(this.angleBtn, () => angleFly.toggle(this.angleBtn));

    this.undoBtn = h('button', { class: 'btn', title: 'Rückgängig (⌘Z · Zwei-Finger-Tipp)', html: icons.undo });
    this.redoBtn = h('button', { class: 'btn', title: 'Wiederholen (⇧⌘Z · Drei-Finger-Tipp)', html: icons.redo });
    this.undoBtn.addEventListener('click', () => app.undo());
    this.redoBtn.addEventListener('click', () => app.redo());

    this.flyouts = [...this.groups.map((g) => g.fly), penFly, lineFly, angleFly];

    const grip = h('div', { class: 'grip', title: 'Ziehen zum Verschieben · Doppeltippen: quer/hoch', html: icons.grip });
    const collapse = h('button', { class: 'btn collapse', title: 'Einklappen' });
    collapse.addEventListener('click', () => {
      this.prefs.collapsed = !this.prefs.collapsed;
      this.applyLayout();
      this.savePrefs();
    });

    const group = (...els: HTMLElement[]) => h('div', { class: 'group' }, els);
    const sep = () => h('div', { class: 'sep' });
    const body = h('div', { class: 'pal-body' }, [
      group(this.selectBtn, this.drawLineBtn, ...this.groups.map((g) => g.btn)),
      sep(),
      group(this.penBtn, this.lineBtn, this.colorBtn),
      sep(),
      group(this.snapBtn, this.angleBtn),
      sep(),
      group(this.undoBtn, this.redoBtn),
    ]);
    this.el = h('div', { class: 'palette panel' }, [grip, body, collapse]);
    this.setupDrag(grip);

    document.addEventListener('app:pen', (e) => this.selectPen((e as CustomEvent<number>).detail));
    app.onUiChange(() => this.update());
    window.addEventListener('resize', () => this.clampIntoView());
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el, this.colors.el);
    this.applyLayout();
    this.update();
  }

  closeFlyouts(): void {
    for (const f of this.flyouts) f.close();
    this.colors.close();
  }

  private penDot(pen: string, width: number): HTMLElement {
    const size = 3.5 + width * 12;
    return h('span', { class: `dot ${pen}`, style: `width:${size}px;height:${size}px` });
  }

  private selectPen(i: number): void {
    const p = ALL_PENS[i];
    if (p) this.app.setStyle({ pen: p.pen, width: p.width });
  }

  update(): void {
    const { style, settings, toolId, doc } = this.app;
    this.selectBtn.classList.toggle('active', toolId === 'select');
    this.drawLineBtn.classList.toggle('active', toolId === 'line');
    for (const g of this.groups) g.update();
    for (const [sz, b] of this.textSizeItems) b.classList.toggle('active', sz === settings.textSize);
    for (const [r, b] of this.radiusItems) b.classList.toggle('active', r === settings.filletRadius);
    this.partLabel.textContent = partLabel(settings.part);
    for (const [a, b] of this.partAngleItems) b.classList.toggle('active', a === (settings.part.angle ?? null));
    for (const [k, b] of this.hatchItems) {
      b.classList.toggle('active', k === `p:${settings.hatchPattern}` || k === `s:${settings.hatchSpacing}` || k === `g:${settings.hatchGap}`);
    }

    this.penBtn.className = `chip pen-trigger ${style.pen}`;
    this.penBtn.replaceChildren(this.penDot(style.pen, style.width), h('span', { class: 'cap', text: formatWidth(style.width) }));
    ALL_PENS.forEach((p, i) => this.penItems[i].classList.toggle('active', p.pen === style.pen && p.width === style.width));
    for (const [hd, b] of this.hardItems) b.classList.toggle('active', style.pen === 'pencil' && (style.hardness ?? 'HB') === hd);
    this.lineBtn.innerHTML = lineTypeIcon(LINE_DASH[style.lineType]);
    for (const [id, b] of this.lineItems) b.classList.toggle('active', id === style.lineType);
    const swatch = this.colorBtn.querySelector('.swatch') as HTMLElement;
    swatch.style.background = penColor(style);
    this.colorBtn.classList.toggle('custom', style.color !== null);

    this.snapBtn.classList.toggle('active', settings.snap);
    this.snapBtn.classList.toggle('paused', settings.snap && this.app.snapSuspended);
    this.angleBtn.dataset.mode = settings.angleMode;
    this.angleBtn.classList.toggle('active', settings.angleMode === 'snap');
    const cap = settings.angleMode === 'snap' ? `${settings.angleStep}°` : settings.angleMode === 'show' ? 'Anz.' : 'Aus';
    this.angleBtn.innerHTML = `${icons.angle}<span class="cap">${cap}</span>`;
    for (const [k, b] of this.angleItems) {
      b.classList.toggle(
        'active',
        k === settings.angleMode || (settings.angleMode === 'snap' && k === `s${settings.angleStep}`) || k === `l${settings.lengthStep}`,
      );
    }
    this.stabilizer.value = String(settings.stabilizer);
    this.stabilizerValue.textContent = settings.stabilizer ? `${settings.stabilizer} px` : 'aus';
    this.undoBtn.disabled = !doc.canUndo;
    this.redoBtn.disabled = !doc.canRedo;
  }

  // ---- layout & dragging ------------------------------------------------------------

  private applyLayout(): void {
    this.el.dataset.orient = this.prefs.orient;
    this.el.classList.toggle('collapsed', this.prefs.collapsed);
    const c = this.el.querySelector('.collapse') as HTMLElement;
    c.innerHTML = this.prefs.collapsed ? icons.expand : icons.collapse;
    c.title = this.prefs.collapsed ? 'Ausklappen' : 'Einklappen';
    if (this.prefs.x === null || this.prefs.y === null) {
      // Default: centred at the bottom.
      requestAnimationFrame(() => {
        const r = this.el.getBoundingClientRect();
        this.setPos((window.innerWidth - r.width) / 2, window.innerHeight - r.height - 18);
      });
    } else {
      requestAnimationFrame(() => this.setPos(this.prefs.x!, this.prefs.y!));
    }
  }

  private setPos(x: number, y: number): void {
    const r = this.el.getBoundingClientRect();
    const m = 8;
    const cx = Math.min(Math.max(m, x), Math.max(m, window.innerWidth - r.width - m));
    const cy = Math.min(Math.max(m, y), Math.max(m, window.innerHeight - r.height - m));
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
    this.prefs.x = cx;
    this.prefs.y = cy;
  }

  private clampIntoView(): void {
    if (this.prefs.x !== null && this.prefs.y !== null) this.setPos(this.prefs.x, this.prefs.y);
    else this.applyLayout();
  }

  private savePrefs(): void {
    savePref('palette', this.prefs);
  }

  /**
   * Switch orientation, keeping the palette attached to the side it was dropped at
   * (`dock`), or centred on its previous centre when toggled by double tap.
   */
  private setOrient(o: Orient, dock: 'left' | 'right' | 'top' | 'bottom' | null): void {
    const before = this.el.getBoundingClientRect();
    if (o !== this.prefs.orient) {
      this.prefs.orient = o;
      this.el.dataset.orient = o;
    }
    const r = this.el.getBoundingClientRect();
    const cx = before.left + before.width / 2;
    const cy = before.top + before.height / 2;
    let x = cx - r.width / 2;
    let y = cy - r.height / 2;
    if (dock === 'left') x = before.left;
    else if (dock === 'right') x = before.right - r.width;
    else if (dock === 'top') y = before.top;
    else if (dock === 'bottom') y = before.bottom - r.height;
    this.setPos(x, y);
  }

  private setupDrag(grip: HTMLElement): void {
    let drag: { id: number; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
    let lastTap = 0;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
      grip.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.moved = true;
      this.setPos(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      this.el.classList.remove('dragging');
      const r = this.el.getBoundingClientRect();
      if (moved) {
        // Docking near a side edge turns the palette upright, near top/bottom flat.
        const edge = 72;
        if (r.left < edge) this.setOrient('v', 'left');
        else if (r.right > window.innerWidth - edge) this.setOrient('v', 'right');
        else if (r.top < edge) this.setOrient('h', 'top');
        else if (r.bottom > window.innerHeight - edge) this.setOrient('h', 'bottom');
      } else {
        const now = performance.now();
        if (now - lastTap < 350) this.setOrient(this.prefs.orient === 'h' ? 'v' : 'h', null);
        lastTap = now;
      }
      this.savePrefs();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
}
