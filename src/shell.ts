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
import { setCloudCurrent, cloudCurrent, saveCloudDrawing, loadCloudDrawing, loadCloudMeta, newCloudId, femUrl, setFemUrl, femOpenUrl } from './storage/cloud';
import { thumbnail, defaultName } from './ui/cloud-dialog';
import { askText } from './ui/dialogs';
import { LiveSession } from './storage/live';
import type { DocFile } from './core/types';

/** Options for running inside another app (e.g. MathPad) instead of on its own. */
export interface EmbedOptions {
  /** The host's drawing to start with (null = empty). */
  drawing: unknown | null;
  /**
   * Reduced tool set for quick sketches: ink only (thin/thick), no layers,
   * timelapse, online storage or drawing sheet.
   */
  compact: boolean;
  /** Called (debounced) with the drawing after every change. */
  onChange: (file: DocFile) => void;
  /** Shows a "done" button in the top bar. */
  onDone?: () => void;
  doneLabel?: string;
}

/** Build the whole user interface into `root` and start the app. */
export function startShell(root: HTMLElement, embed?: EmbedOptions): App {
  const sceneCanvas = h('canvas', { class: 'scene' });
  const overlayCanvas = h('canvas', { class: 'overlay' });
  const ui = h('div', { class: embed?.compact ? 'ui compact' : 'ui' });
  root.append(sceneCanvas, overlayCanvas, ui);

  const app = new App(sceneCanvas, overlayCanvas);
  if (!embed) app.live = new LiveSession(app);
  else {
    app.persist = embed.onChange;
    if (embed.compact) app.useCompactStyle();
  }
  new InputController(app, overlayCanvas);

  // ---- file actions -----------------------------------------------------------------

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
  if (!embed) {
    document.addEventListener('app:cloud', () => showCloudDialog(app));
    document.addEventListener('app:timelapse', () => showTimelapseDialog(app));
  }
  document.addEventListener('app:open', open);

  // ---- FEM-Nachweis: Zeichnung in die Online-Ablage legen und in Projekt-FEM öffnen ---------------

  async function sendToFem(): Promise<void> {
    if (app.doc.size === 0) return app.toast('Die Zeichnung ist leer.');
    // Fenster gleich öffnen (Safari erlaubt Pop-ups nur direkt nach dem Tippen), Adresse danach setzen
    let base = femUrl();
    if (!base) {
      const u = await askText(
        'Projekt-FEM-Adresse',
        'http://',
        'Speichern',
        'Wo läuft Projekt-FEM? z. B. http://nas:8790 (mit Zugangsschlüssel: http://nas:8790/#k=…)',
      );
      if (!u || u.trim() === 'http://') return;
      setFemUrl(u);
      base = femUrl();
    }
    const win = window.open('about:blank', '_blank');
    try {
      const cur = cloudCurrent();
      const name = cur?.name ?? defaultName(app);
      const id = cur?.id ?? newCloudId(name);
      await saveCloudDrawing(id, name, app.doc.toFile(app.cam.state), await thumbnail(app));
      setCloudCurrent({ id, name });
      const target = femOpenUrl(base, id);
      if (win) win.location.href = target;
      else window.location.href = target;
      app.toast(`„${name}“ gespeichert und in Projekt-FEM geöffnet`);
    } catch (err) {
      win?.close();
      app.toast(`Nicht gespeichert: ${err instanceof Error ? err.message : String(err)} – Online-Ablage prüfen`);
    }
  }
  async function changeFemUrl(): Promise<void> {
    const u = await askText('Projekt-FEM-Adresse', femUrl() || 'http://', 'Speichern', 'z. B. http://nas:8790 (mit Zugangsschlüssel: http://nas:8790/#k=…); leer = zurücksetzen', true);
    if (u !== null) setFemUrl(u === 'http://' ? '' : u);
  }

  // ---- UI ---------------------------------------------------------------------------

  const toast = new Toast();
  app.setToast((m) => toast.show(m));
  const help = helpDialog();
  const layers = new LayersPanel(app);
  app.onScaleChange = (v) => sheetFollowScale(app, v);
  const menu = new Menu(
    app,
    {
      newDrawing: () => void newDrawing(),
      open,
      download,
      exportFile: () => showExportDialog(app),
      timelapse: () => showTimelapseDialog(app),
      sheet: () => void editSheet(app),
      cloud: () => void showCloudDialog(app),
      fem: () => void sendToFem(),
      femUrl: () => void changeFemUrl(),
      help: () => help.showModal(),
    },
  );
  const viewBar = new ViewBar(app, layers, menu, embed?.onDone ? { label: embed.doneLabel ?? 'Fertig', onClick: embed.onDone } : undefined);
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

  // ---- lifecycle --------------------------------------------------------------------

  app.resize();
  window.addEventListener('resize', () => app.resize());
  window.visualViewport?.addEventListener('resize', () => app.resize());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void app.saveNow();
  });
  window.addEventListener('pagehide', () => void app.saveNow());
  if (embed) app.loadEmbedded(embed.drawing);
  // Restore the autosaved drawing, then reconnect a live drawing if one was open.
  else {
    // ?open=<id>: Zeichnung aus der Online-Ablage öffnen (z. B. „In Draftpad bearbeiten“ aus Projekt-FEM)
    const openId = new URLSearchParams(location.search).get('open');
    if (openId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(openId)) {
      history.replaceState(null, '', location.pathname + location.hash);
      void Promise.all([loadCloudDrawing(openId), loadCloudMeta(openId).catch(() => null)])
        .then(([data, meta]) => {
          app.live?.stop();
          app.loadDrawing(data);
          setCloudCurrent({ id: openId, name: meta?.name || openId });
          app.toast('Zeichnung aus der Online-Ablage geöffnet');
        })
        .catch(() => void app.load().then(() => app.toast('Zeichnung nicht gefunden – Online-Ablage prüfen')));
    } else void app.load().then(() => app.live?.resume());
  }

  // Handy for debugging and automated tests.
  (window as unknown as { __app: App }).__app = app;
  return app;
}
