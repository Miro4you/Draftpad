import './style.css';
import { cycloidCheck, gearInfo, type CycloidParams, type FormulaParams, type GearParams } from './curves';
import { Sketch, fmt, type Entity, type Tool } from './sketch';
import { View3D } from './view3d';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

// ---- Kern im Hintergrund ----------------------------------------------------------------------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const t0 = performance.now();
let coreReady = false;
let buildId = 0;
let lastShown = 0;
let busy = false;
let pending = false;
const exports = new Map<number, (r: { blob?: Blob; ms?: number; message?: string }) => void>();

const sketch = new Sketch($<HTMLCanvasElement>('#sketch'));
const view = new View3D($('#view'));
const timings: Record<string, string> = {};

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'ready') {
    coreReady = true;
    timings['Kern laden (Download + Start)'] = `${fmt((performance.now() - t0) / 1000)} s`;
    timings['davon Start'] = `${fmt(m.ms)} ms`;
    setCore('bereit', 'ok');
    renderTimings();
    rebuild();
  } else if (m.type === 'result') {
    busy = false;
    if (m.id >= lastShown) {
      lastShown = m.id;
      view.show(m);
      for (const k of Object.keys(timings)) if (!k.startsWith('Kern') && !k.startsWith('davon') && !k.startsWith('Export')) delete timings[k];
      const names: Record<string, string> = { profil_und_extrusion: 'Profil + Extrusion', verrunden: 'Verrunden', volumen: 'Volumen berechnen', koerper_gesamt: 'Körper gesamt', vernetzen: 'Anzeige-Netz' };
      for (const [k, v] of Object.entries(m.times as Record<string, number>)) timings[names[k] ?? k] = `${fmt(v)} ms`;
      timings['Dreiecke'] = (m.triangles.length / 3).toLocaleString('de-DE');
      timings['Flächen (B-Rep)'] = String(m.faces);
      timings['Volumen'] = `${fmt(m.volume / 1000)} cm³`;
      timings['Masse PLA (100 %)'] = `${fmt((m.volume / 1000) * 1.24)} g`;
      renderTimings();
      setCore('bereit', 'ok');
      $('#err').textContent = m.warning ?? '';
    }
    if (pending) {
      pending = false;
      rebuild();
    }
  } else if (m.type === 'error') {
    if (exports.has(m.id)) {
      exports.get(m.id)!({ message: m.message });
      exports.delete(m.id);
      return;
    }
    busy = false;
    setCore('Fehler', 'bad');
    $('#err').textContent = m.message;
    if (pending) {
      pending = false;
      rebuild();
    }
  } else if (m.type === 'exported') {
    exports.get(m.id)?.(m);
    exports.delete(m.id);
  }
};

function setCore(text: string, cls: string) {
  const el = $('#core');
  el.textContent = text;
  el.className = `core ${cls}`;
}

function renderTimings() {
  $('#timings').innerHTML = Object.entries(timings)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

let debounce = 0;
function rebuild() {
  clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    if (!coreReady) return;
    const loops = sketch.loops();
    if (!loops.length) {
      view.clear();
      return;
    }
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    setCore('rechnet …', 'busy');
    worker.postMessage({ type: 'build', id: ++buildId, params: { loops, height: num('#height', 10), fillet: num('#fillet', 0) } });
  }, 150);
}

function num(sel: string, def: number): number {
  const v = parseFloat($<HTMLInputElement>(sel).value.replace(',', '.'));
  return Number.isFinite(v) ? v : def;
}

function exportShape(format: 'step' | 'stl' | '3mf'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = ++buildId;
    exports.set(id, (r) => {
      if (r.blob) {
        timings[`Export ${format.toUpperCase()}`] = `${fmt(r.ms ?? 0)} ms · ${fmt(r.blob.size / 1024)} kB`;
        renderTimings();
        resolve(r.blob);
      } else reject(new Error(r.message));
    });
    worker.postMessage({ type: 'export', id, format, name: partName() });
  });
}

const partName = () => ($<HTMLInputElement>('#name').value.trim() || 'Teil').replace(/[^\wäöüÄÖÜß\- ]/g, '_');

async function download(format: 'step' | 'stl' | '3mf') {
  try {
    const blob = await exportShape(format);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${partName()}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    $('#err').textContent = (e as Error).message;
  }
}

// ---- An Projekt-FEM ---------------------------------------------------------------------------
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* egal */
    }
  },
};
$<HTMLInputElement>('#fem-addr').value = store.get('fem-addr');
$<HTMLInputElement>('#fem-key').value = store.get('fem-key');

async function sendToFem() {
  const addr = $<HTMLInputElement>('#fem-addr').value.trim().replace(/\/$/, '');
  const key = $<HTMLInputElement>('#fem-key').value.trim();
  store.set('fem-addr', addr);
  store.set('fem-key', key);
  const out = $('#fem-msg');
  if (!addr) {
    out.textContent = 'Adresse von Projekt-FEM eintragen (Dialog „CAD“ → Heimnetz), z. B. http://192.168.1.20:8790';
    return;
  }
  if (location.protocol === 'https:' && addr.startsWith('http:')) {
    out.textContent = 'Diese Seite läuft über https, Projekt-FEM über http – der Browser blockiert das. Seite über http (Pi) öffnen.';
    return;
  }
  try {
    const blob = await exportShape('step');
    const url = `${addr}/api/cad/open?name=${encodeURIComponent(partName())}&source=${encodeURIComponent('CAD-Test (iPad)')}&k=${encodeURIComponent(key)}`;
    // ohne CORS-Freigabe in Projekt-FEM ist die Antwort nicht lesbar – Senden klappt trotzdem
    await fetch(url, { method: 'POST', mode: 'no-cors', body: new Blob([await blob.arrayBuffer()]) });
    out.textContent = `Gesendet (${fmt(blob.size / 1024)} kB). In Projekt-FEM erscheint „${partName()}“ – bei gleichem Namen als neue Version.`;
  } catch (e) {
    out.textContent = `Senden fehlgeschlagen: ${(e as Error).message}`;
  }
}

// ---- Werkzeuge --------------------------------------------------------------------------------
function setTool(t: Tool) {
  sketch.tool = t;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
setTool('line');

const defaults = {
  gear: (): GearParams => ({ m: 1, z: 24, alpha: 20, x: 0, backlash: 0.1, bore: 5 }),
  cycloid: (): CycloidParams => ({ R: 30, Rr: 3, E: 1.5, N: 12, bore: 16, holes: 6, holeD: 9, holeR: 17 }),
  formula: (): FormulaParams => ({ ...PRESETS[0].p, vars: { ...PRESETS[0].p.vars } }),
};

const PRESETS: { name: string; p: FormulaParams }[] = [
  { name: 'Rosette (Kurvenscheibe)', p: { x: '(a + b*cos(n*t))*cos(t)', y: '(a + b*cos(n*t))*sin(t)', t0: 0, t1: 2 * Math.PI, vars: { a: 20, b: 4, n: 7 }, samples: 420 } },
  { name: 'Epizykloide', p: { x: '(R + r)*cos(t) - r*cos((R + r)/r*t)', y: '(R + r)*sin(t) - r*sin((R + r)/r*t)', t0: 0, t1: 2 * Math.PI, vars: { R: 20, r: 4 }, samples: 600 } },
  { name: 'Hypozykloide', p: { x: '(R - r)*cos(t) + r*cos((R - r)/r*t)', y: '(R - r)*sin(t) - r*sin((R - r)/r*t)', t0: 0, t1: 2 * Math.PI, vars: { R: 25, r: 5 }, samples: 600 } },
  { name: 'Ellipse', p: { x: 'a*cos(t)', y: 'b*sin(t)', t0: 0, t1: 2 * Math.PI, vars: { a: 30, b: 15 }, samples: 120 } },
  { name: 'Archimedische Spirale (Nocke)', p: { x: '(r0 + h*t/(2*pi))*cos(t)', y: '(r0 + h*t/(2*pi))*sin(t)', t0: 0, t1: 2 * Math.PI, vars: { r0: 15, h: 8 }, samples: 240 } },
];

$('#add-gear').addEventListener('click', () => pick(sketch.addEntity({ kind: 'gear', c: sketch.center(), p: defaults.gear() })));
$('#add-cycloid').addEventListener('click', () => pick(sketch.addEntity({ kind: 'cycloid', c: sketch.center(), p: defaults.cycloid() })));
$('#add-formula').addEventListener('click', () => pick(sketch.addEntity({ kind: 'formula', c: sketch.center(), p: defaults.formula() })));
$('#undo').addEventListener('click', () => sketch.undoLast());
$('#clear').addEventListener('click', () => {
  if (confirm('Skizze leeren?')) sketch.clear();
});
$('#fit').addEventListener('click', () => {
  sketch.fit();
  view.fit();
});
$('#dl-step').addEventListener('click', () => download('step'));
$('#dl-stl').addEventListener('click', () => download('stl'));
$('#dl-3mf').addEventListener('click', () => download('3mf'));
$('#send-fem').addEventListener('click', sendToFem);
for (const id of ['#height', '#fillet']) $(id).addEventListener('input', rebuild);

function pick(e: Entity) {
  view.first = true;
  setTool('select');
  sketch.select(e.id);
  sketch.fit();
}

sketch.onChange = rebuild;
sketch.onStatus = (t) => ($('#live').textContent = t);
sketch.onSelect = (e) => renderProps(e);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 'l') setTool('line');
  else if (k === 'r') setTool('rect');
  else if (k === 'c') setTool('circle');
  else if (k === 'escape') sketch.dropOpen();
  else if ((k === 'z' && (e.metaKey || e.ctrlKey)) || k === 'backspace') {
    if (k === 'backspace' && sketch.selected !== null) sketch.remove(sketch.selected);
    else sketch.undoLast();
  } else if (k === 'delete' && sketch.selected !== null) sketch.remove(sketch.selected);
});

// ---- Eigenschaften des gewählten Profils -------------------------------------------------------
type Field = [key: string, label: string, step?: string];
const FIELDS: Record<string, Field[]> = {
  gear: [['m', 'Modul m', '0.05'], ['z', 'Zähne z', '1'], ['alpha', 'Eingriffswinkel α °', '0.5'], ['x', 'Profilverschiebung x', '0.05'], ['backlash', 'Flankenspiel mm', '0.01'], ['bore', 'Bohrung Ø mm', '0.5']],
  cycloid: [['N', 'Bolzen N', '1'], ['R', 'Bolzenkreis R mm', '0.5'], ['Rr', 'Bolzenradius mm', '0.1'], ['E', 'Exzentrizität E mm', '0.1'], ['bore', 'Lagerbohrung Ø mm', '0.5'], ['holes', 'Abtriebsbohrungen', '1'], ['holeD', 'Ø Abtriebsbohrung mm', '0.1'], ['holeR', 'Lochkreis-Radius mm', '0.5']],
};

function renderProps(e: Entity | null) {
  const box = $('#props');
  if (!e) {
    box.innerHTML = '<p class="hint">Profil antippen (Auswahl), um Maße zu ändern. Geschlossene Profile werden zum Körper, innere Profile zu Löchern.</p>';
    return;
  }
  let html = '';
  const field = (key: string, label: string, value: number, step = '0.5') => `<label>${label}<input data-k="${key}" type="number" inputmode="decimal" step="${step}" value="${value}"></label>`;
  if (e.kind === 'gear' || e.kind === 'cycloid') {
    html += `<h3>${e.kind === 'gear' ? 'Evolventen-Stirnrad' : 'Zykloidenscheibe'}</h3><div class="grid">`;
    for (const [k, l, s] of FIELDS[e.kind]) html += field(k, l, (e.p as unknown as Record<string, number>)[k], s);
    html += '</div><div id="info" class="info"></div>';
  } else if (e.kind === 'formula') {
    html += `<h3>Formelkurve</h3><label>Vorlage<select id="preset"><option value="">–</option>${PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('')}</select></label>`;
    html += `<label>x(t) =<input data-f="x" value="${e.p.x}" spellcheck="false" autocapitalize="off"></label><label>y(t) =<input data-f="y" value="${e.p.y}" spellcheck="false" autocapitalize="off"></label>`;
    html += `<div class="grid">${field('t0', 't von', e.p.t0, '0.1')}${field('t1', 't bis', +e.p.t1.toFixed(4), '0.1')}${field('samples', 'Stützpunkte', e.p.samples, '10')}</div>`;
    html += `<label>Variablen (Name = Wert, je Zeile)<textarea id="vars" rows="3" spellcheck="false" autocapitalize="off">${Object.entries(e.p.vars).map(([k, v]) => `${k} = ${v}`).join('\n')}</textarea></label>`;
    html += '<p class="hint">Funktionen: sin, cos, tan, sqrt, abs, atan2, pow, exp, log, pi, ^. Offene Kurven werden mit einer Geraden geschlossen.</p><div id="info" class="info"></div>';
  } else if (e.kind === 'circle') {
    html += `<h3>Kreis</h3><div class="grid">${field('d', 'Ø mm', +(2 * e.r).toFixed(3))}${field('cx', 'Mitte x', e.c[0])}${field('cy', 'Mitte y', e.c[1])}</div>`;
  } else if (e.kind === 'rect') {
    html += `<h3>Rechteck</h3><div class="grid">${field('w', 'Breite mm', +Math.abs(e.b[0] - e.a[0]).toFixed(3))}${field('h', 'Höhe mm', +Math.abs(e.b[1] - e.a[1]).toFixed(3))}</div>`;
  } else {
    html += `<h3>Linienzug</h3><p class="hint">${e.pts.length} Ecken. Maße ändern kommt mit dem Constraint-Solver (Phase 2).</p>`;
  }
  html += '<button id="del" class="danger">Profil löschen</button>';
  box.innerHTML = html;
  $('#del').addEventListener('click', () => sketch.remove(e.id));
  showInfo(e);
  box.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) =>
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value.replace(',', '.'));
      if (!Number.isFinite(v)) return;
      const k = inp.dataset.k!;
      if (e.kind === 'gear' || e.kind === 'cycloid' || e.kind === 'formula') (e.p as unknown as Record<string, number>)[k] = v;
      else if (e.kind === 'circle') {
        if (k === 'd' && v > 0) e.r = v / 2;
        if (k === 'cx') e.c = [v, e.c[1]];
        if (k === 'cy') e.c = [e.c[0], v];
      } else if (e.kind === 'rect' && v > 0) {
        const sx = Math.sign(e.b[0] - e.a[0]) || 1, sy = Math.sign(e.b[1] - e.a[1]) || 1;
        if (k === 'w') e.b = [e.a[0] + sx * v, e.b[1]];
        if (k === 'h') e.b = [e.b[0], e.a[1] + sy * v];
      }
      sketch.updateEntity(e);
      showInfo(e);
    }),
  );
  if (e.kind === 'formula') {
    const upd = () => {
      box.querySelectorAll<HTMLInputElement>('input[data-f]').forEach((i) => ((e.p as unknown as Record<string, string>)[i.dataset.f!] = i.value));
      const vars: Record<string, number> = {};
      for (const line of $<HTMLTextAreaElement>('#vars').value.split('\n')) {
        const m = line.match(/^\s*([a-zA-Z_]\w*)\s*=\s*(-?[\d.,]+)\s*$/);
        if (m) vars[m[1]] = parseFloat(m[2].replace(',', '.'));
      }
      e.p.vars = vars;
      sketch.updateEntity(e);
      showInfo(e);
    };
    box.querySelectorAll('input[data-f], #vars').forEach((i) => i.addEventListener('input', upd));
    $<HTMLSelectElement>('#preset').addEventListener('change', (ev) => {
      const i = (ev.target as HTMLSelectElement).value;
      if (i === '') return;
      const p = PRESETS[+i].p;
      e.p = { ...p, vars: { ...p.vars } };
      sketch.updateEntity(e);
      renderProps(e);
      sketch.fit();
    });
  }
}

function showInfo(e: Entity) {
  const el = document.querySelector('#info');
  if (!el) return;
  try {
    if (e.kind === 'gear') {
      const i = gearInfo(e.p);
      el.innerHTML = `Teilkreis Ø ${fmt(i.d)} · Kopfkreis Ø ${fmt(i.da)} · Fußkreis Ø ${fmt(i.df)} · Grundkreis Ø ${fmt(i.db)}<br>Zahndicke am Kopf ${fmt(i.sa)} mm${i.undercut ? '<br><b>Unterschnitt:</b> z zu klein für x – Profilverschiebung erhöhen (Fuß wird hier vereinfacht radial gezeichnet)' : ''}<br>Achsabstand zu Gegenrad z₂: a = m·(z + z₂)/2`;
    } else if (e.kind === 'cycloid') {
      const w = cycloidCheck(e.p);
      el.innerHTML = `Untersetzung ${e.p.N - 1} : 1 · ${e.p.N - 1} Höcker<br>Abtriebsbohrung = Abtriebsbolzen-Ø + 2·E = Bolzen + ${fmt(2 * e.p.E)} mm${w.length ? `<br><b>${w.join('<br>')}</b>` : ''}`;
    } else if (e.kind === 'formula') {
      el.innerHTML = '';
    }
  } catch (err) {
    el.innerHTML = `<b>${(err as Error).message}</b>`;
  }
}

renderProps(null);
setCore('Kern lädt …', 'busy');

// Startbeispiel: Zahnrad, damit gleich etwas zu sehen ist
pick(sketch.addEntity({ kind: 'gear', c: [0, 0], p: defaults.gear() }));
setTool('line');
const dark = window.matchMedia('(prefers-color-scheme: dark)');
view.setDark(dark.matches);
dark.addEventListener('change', () => {
  view.setDark(dark.matches);
  sketch.redraw();
});
