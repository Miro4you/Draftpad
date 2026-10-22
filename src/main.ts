import './styles.css';
import { App } from './app';
import { InputController } from './input/input';
import { helpDialog, LayersPanel, Menu, Toast, ViewBar } from './ui/chrome';
import { h } from './ui/dom';
import { ask } from './ui/dialogs';
import { choosePart, Palette } from './ui/palette';
import { SelectionBar } from './ui/selectionbar';
import { showExportDialog } from './ui/export-dialog';
import { editSheet, sheetFollowScale } from './ui/sheet-dialog';
import { showTimelapseDialog } from './ui/timelapse-dialog';
import { showCloudDialog } from './ui/cloud-dialog';
import { setCloudCurrent } from './storage/cloud';
import { LiveSession } from './storage/live';

const root = document.getElementById('app')!;
const sceneCanvas = h('canvas', { class: 'scene' });
const overlayCanvas = h('canvas', { class: 'overlay' });
const ui = h('div', { class: 'ui' });
root.append(sceneCanvas, overlayCanvas, ui);

const app = new App(sceneCanvas, overlayCanvas);
app.live = new LiveSession(app);
new InputController(app, overlayCanvas);

// ---- file actions -------------------------------------------------------------------

function download(): void {
  const data = JSON.stringify(app.doc.toFile(app.cam.state));
  const blob = new Blob([data], { type: 'application/json' });
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `draftpad-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.draftpad.json`;
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  app.toast('Datei heruntergeladen');
}

const fileInput = h('input', { type: 'file', accept: '.json,.draftpad,.skizze,application/json', style: 'display:none' });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const data: unknown = JSON.parse(await file.text());
    // Ask after picking (the file picker itself must open straight from the tap on iOS).
    if (
      app.doc.size > 0 &&
      !(await ask({
        title: 'Zeichnung ersetzen?',
        message: `„${file.name}“ ersetzt die aktuelle Zeichnung. Lade sie vorher herunter, wenn du sie behalten willst.`,
        confirm: 'Ersetzen',
        danger: true,
      }))
    ) {
      return;
    }
    app.live?.stop();
    app.loadDrawing(data);
    setCloudCurrent(null);
    app.toast(`„${file.name}“ geöffnet`);
  } catch (err) {
    app.toast(`Öffnen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
});

function open(): void {
  fileInput.click();
}

async function newDrawing(): Promise<void> {
  if (
    app.doc.size > 0 &&
    !(await ask({
      title: 'Neue Zeichnung?',
      message: 'Die aktuelle Zeichnung wird verworfen. Lade sie vorher herunter, wenn du sie behalten willst.',
      confirm: 'Neue Zeichnung',
      danger: true,
    }))
  ) {
    return;
  }
  app.live?.stop();
  app.newDrawing();
  setCloudCurrent(null);
}

document.addEventListener('app:download', download);
document.addEventListener('app:export', () => showExportDialog(app));
document.addEventListener('app:part', () => void choosePart(app));
document.addEventListener('app:cloud', () => showCloudDialog(app));
document.addEventListener('app:open', open);

// ---- UI -------------------------------------------------------------------------------

const toast = new Toast();
app.setToast((m) => toast.show(m));
const help = helpDialog();
const layers = new LayersPanel(app);
app.onScaleChange = (v) => sheetFollowScale(app, v);
const menu = new Menu(app, { newDrawing: () => void newDrawing(), open, download, exportFile: () => showExportDialog(app), timelapse: () => showTimelapseDialog(app), sheet: () => void editSheet(app), cloud: () => void showCloudDialog(app), help: () => help.showModal() });
const viewBar = new ViewBar(app, layers, menu);
const palette = new Palette(app);
const selectionBar = new SelectionBar(app);
const snapHint = h('div', { class: 'snap-hint', text: 'Fang pausiert' });

ui.append(viewBar.el, layers.el, menu.el, selectionBar.el, toast.el, snapHint, help, fileInput);
palette.mount(ui);
app.onUiChange(() => snapHint.classList.toggle('show', app.snapSuspended && app.settings.snap));

// Buttons shouldn't keep keyboard focus (Space would re-trigger them instead of panning).
ui.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn && !btn.closest('dialog')) btn.blur();
});

// Close popovers when drawing starts.
overlayCanvas.addEventListener('pointerdown', () => {
  menu.close();
  palette.closeFlyouts();
  if (window.matchMedia('(max-width: 700px)').matches) layers.close();
});
window.addEventListener('keydown', (e) => {
  if (e.key === '?' && !(e.target instanceof HTMLInputElement)) help.showModal();
  if (e.key === 'Escape') {
    menu.close();
    layers.close();
  }
});

// ---- lifecycle ----------------------------------------------------------------------

app.resize();
window.addEventListener('resize', () => app.resize());
window.visualViewport?.addEventListener('resize', () => app.resize());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void app.saveNow();
});
window.addEventListener('pagehide', () => void app.saveNow());
// Restore the autosaved drawing, then reconnect a live drawing if one was open.
void app.load().then(() => app.live?.resume());

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker', err));
  });
}

// Handy for debugging and automated tests.
(window as unknown as { __app: App }).__app = app;
