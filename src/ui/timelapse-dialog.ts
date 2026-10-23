import type { App } from '../app';
import { sheetBox } from '../core/annotations';
import { entityBox } from '../core/document';
import { boxExpand, boxUnion, emptyBox, isEmptyBox, type Box } from '../core/geom';
import { hasProcess, planTimelapse, TimelapseRenderer, videoMime, type Timeline, type TimelapseMode } from '../export/timelapse';
import { loadPref, savePref } from '../storage/idb';
import { baseDialog, finish } from './dialogs';
import { h } from './dom';
import { saveBlob } from './export-dialog';
import { findSheet } from './sheet-dialog';

type Shape = 'wide' | 'tall' | 'square';
type Area = 'all' | 'view' | 'sel' | 'sheet';

interface TimelapsePrefs {
  seconds: number;
  shape?: Shape;
  mode?: TimelapseMode;
  /** Short side of the video in px. */
  res?: number;
}

const SHAPES: { id: Shape; label: string }[] = [
  { id: 'wide', label: 'Quer 16:9' },
  { id: 'tall', label: 'Hoch 9:16' },
  { id: 'square', label: 'Quadrat' },
];
/** Resolutions (short side in px) with the bitrate used for them. */
const RESOLUTIONS: { id: number; label: string; bits: number }[] = [
  { id: 720, label: '720p', bits: 5_000_000 },
  { id: 1080, label: '1080p', bits: 8_000_000 },
  { id: 1440, label: '1440p', bits: 14_000_000 },
  { id: 2160, label: '4K', bits: 25_000_000 },
];

/** Video size in px for a shape and resolution (16:9 sides rounded to even numbers). */
function videoSize(shape: Shape, res: number): { w: number; h: number } {
  const long = Math.round((res * 16) / 9 / 2) * 2;
  return shape === 'wide' ? { w: long, h: res } : shape === 'tall' ? { w: res, h: long } : { w: res, h: res };
}
const DURATIONS = [10, 20, 30, 60];
/** Empty paper before the first line and the finished drawing at the end (s). */
const LEAD = 0.5;
const HOLD = 2;
const FPS = 30;

function fileName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `draftpad-zeitraffer-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

/** Timelapse dialog: replay the drawing as it was made and record it as a video. */
export function showTimelapseDialog(app: App): void {
  if (!app.doc.size && !hasProcess(app.doc)) {
    app.toast('Noch nichts gezeichnet');
    return;
  }
  const prefs = loadPref<TimelapsePrefs>('timelapse', { seconds: 20 });
  const process = hasProcess(app.doc);
  let mode: TimelapseMode = process ? (prefs.mode ?? 'process') : 'result';
  const plans = new Map<TimelapseMode, Timeline>();
  const planFor = (m: TimelapseMode) => plans.get(m) ?? plans.set(m, planTimelapse(app.doc, m)).get(m)!;
  const first = planFor(mode);
  const bw = first.box.maxX - first.box.minX;
  const bh = first.box.maxY - first.box.minY;
  let shape: Shape = prefs.shape ?? (bw >= bh * 1.2 ? 'wide' : bh >= bw * 1.2 ? 'tall' : 'square');
  const mime = videoMime();
  let res = RESOLUTIONS.some((r) => r.id === prefs.res) ? prefs.res! : 1080;

  // Part of the drawing to show.
  const selection = app.selectedEntities();
  const sheet = findSheet(app);
  const areas: { id: Area; label: string }[] = [
    { id: 'all', label: 'Alles' },
    { id: 'view', label: 'Ansicht' },
  ];
  if (selection.length) areas.push({ id: 'sel', label: 'Auswahl' });
  if (sheet) areas.push({ id: 'sheet', label: 'Blatt' });
  let area: Area = selection.length ? 'sel' : 'all';
  const areaBox = (): Box | undefined => {
    if (area === 'view') return app.cam.visibleBox(app.width, app.height);
    if (area === 'sheet' && sheet) return sheetBox(sheet);
    if (area === 'sel') {
      let b = emptyBox();
      for (const e of selection) b = boxUnion(b, entityBox(e));
      if (!isEmptyBox(b)) return boxExpand(b, Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.04);
    }
    return undefined;
  };

  const { dlg, body, actions } = baseDialog('Zeitraffer-Video');
  dlg.classList.add('timelapse-dlg');
  // Record and preview sit at the top, next to the title (the options can scroll below).
  const head = h('div', { class: 'tl-head' });
  dlg.querySelector('.dlg-title')!.replaceWith(head);
  head.append(h('h2', { class: 'dlg-title', text: 'Zeitraffer-Video' }), actions);
  const canvas = h('canvas', { class: 'tl-canvas' });
  const bar = h('progress', { class: 'tl-progress', max: '1', value: '0' });
  const status = h('p', { class: 'exp-hint' });

  const seg = <T extends string | number>(items: { id: T; label: string }[], get: () => T, set: (v: T) => void) => {
    const row = h('div', { class: 'seg' });
    const btns = items.map((it) => {
      const b = h('button', { class: 'seg-btn', text: it.label });
      b.addEventListener('click', () => {
        if (busy) return;
        set(it.id);
        sync();
      });
      row.append(b);
      return [it.id, b] as const;
    });
    return { row, sync: () => btns.forEach(([id, b]) => b.classList.toggle('active', id === get())) };
  };
  const shapeSeg = seg(SHAPES, () => shape, (v) => {
    shape = v;
    setup();
  });
  const modeSeg = seg(
    [
      { id: 'process' as TimelapseMode, label: 'Ganzer Ablauf' },
      { id: 'result' as TimelapseMode, label: 'Nur Ergebnis' },
    ],
    () => mode,
    (v) => {
      mode = v;
      setup();
    },
  );
  const modeHint = h('p', { class: 'exp-hint' });
  if (!process) {
    for (const b of modeSeg.row.querySelectorAll('button')) if (b.textContent === 'Ganzer Ablauf') b.disabled = true;
  }
  const durSeg = seg(DURATIONS.map((s) => ({ id: s, label: `${s} s` })), () => prefs.seconds, (v) => (prefs.seconds = v));
  const resSeg = seg(RESOLUTIONS, () => res, (v) => {
    res = v;
    setup();
  });
  const areaSeg = seg(areas, () => area, (v) => {
    area = v;
    setup();
  });
  const result = h('div', { class: 'tl-result' });

  body.append(
    h('div', { class: 'tl-stage' }, [canvas]),
    bar,
    status,
    result,
    h('div', { class: 'tl-grid' }, [
      h('div', { class: 'exp-field tl-wide' }, [h('span', { text: 'Ablauf' }), modeSeg.row, modeHint]),
      h('div', { class: 'exp-field' }, [h('span', { text: 'Ausschnitt' }), areaSeg.row]),
      h('div', { class: 'exp-field' }, [h('span', { text: 'Format' }), shapeSeg.row]),
      h('div', { class: 'exp-field' }, [h('span', { text: 'Auflösung' }), resSeg.row]),
      h('div', { class: 'exp-field' }, [h('span', { text: 'Länge' }), durSeg.row]),
    ]),
  );

  const close = h('button', { class: 'dlg-btn', text: 'Schließen' });
  actions.classList.add('tl-actions');
  const preview = h('button', { class: 'dlg-btn', text: 'Vorschau' });
  const record = h('button', { class: 'dlg-btn primary', text: 'Aufnehmen' });
  actions.append(close, preview, record);

  let renderer: TimelapseRenderer;
  let raf = 0;
  let busy = false;
  let recorder: MediaRecorder | null = null;

  function setup(): void {
    const s = videoSize(shape, res);
    canvas.width = s.w;
    canvas.height = s.h;
    renderer = new TimelapseRenderer(planFor(mode), canvas, areaBox());
    renderer.frame(1);
  }

  function sync(): void {
    shapeSeg.sync();
    modeSeg.sync();
    resSeg.sync();
    areaSeg.sync();
    modeHint.textContent = !process
      ? 'Der Ablauf wird ab jetzt mitgeschrieben – diese Zeichnung entstand noch davor.'
      : mode === 'process'
        ? 'Jeder Schritt: Zeichnen, Löschen, Trimmen, Verschieben, Ebenen ein- und ausblenden.'
        : 'Die fertige Zeichnung in Zeichenreihenfolge; ausgeblendete Ebenen verschwinden am Ende.';
    durSeg.sync();
    preview.textContent = busy && !recorder ? 'Stopp' : 'Vorschau';
    record.textContent = recorder ? 'Stopp' : 'Aufnehmen';
    preview.disabled = !!recorder;
    record.disabled = !mime || (busy && !recorder);
    if (!busy) {
      status.textContent = mime
        ? `${canvas.width} × ${canvas.height} px, ${mime.includes('mp4') ? 'MP4' : 'WebM'} – die Aufnahme läuft in Echtzeit.${res >= 2160 ? ' 4K braucht ein schnelles Gerät.' : ''}`
        : 'Dieser Browser kann keine Videos aufnehmen – die Vorschau geht trotzdem.';
    }
  }

  /** Play the replay in real time; resolves when done or stopped. */
  function play(onDone: (finished: boolean) => void): void {
    busy = true;
    renderer.reset();
    const dur = prefs.seconds;
    const total = LEAD + dur + HOLD;
    const start = performance.now();
    const step = () => {
      const el = (performance.now() - start) / 1000;
      renderer.frame(Math.min(1, Math.max(0, (el - LEAD) / dur)));
      bar.value = Math.min(1, el / total);
      if (recorder) status.textContent = `Aufnahme läuft … ${Math.min(Math.ceil(el), Math.ceil(total))} / ${Math.ceil(total)} s`;
      if (el < total) raf = requestAnimationFrame(step);
      else stop(true);
    };
    stopFn = (finished) => {
      cancelAnimationFrame(raf);
      busy = false;
      stopFn = null;
      onDone(finished);
      sync();
    };
    raf = requestAnimationFrame(step);
    sync();
  }
  let stopFn: ((finished: boolean) => void) | null = null;
  const stop = (finished: boolean) => stopFn?.(finished);

  preview.addEventListener('click', () => {
    if (busy) {
      stop(false);
      return;
    }
    play(() => renderer.frame(1));
  });

  record.addEventListener('click', () => {
    if (recorder) {
      stop(false);
      return;
    }
    if (!mime) return;
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(FPS);
    } catch {
      status.textContent = 'Aufnahme nicht möglich (Canvas-Stream fehlt).';
      return;
    }
    const chunks: Blob[] = [];
    const bits = RESOLUTIONS.find((r) => r.id === res)?.bits ?? 8_000_000;
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits });
    recorder = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    let keep = false;
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      sync();
      if (!keep || !chunks.length) {
        status.textContent = 'Aufnahme abgebrochen.';
        return;
      }
      const type = mime.split(';')[0];
      offer(new Blob(chunks, { type }), type.includes('mp4') ? 'mp4' : 'webm');
    };
    rec.start(500);
    play((finished) => {
      keep = finished;
      // Let the last frames reach the recorder before stopping.
      setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150);
    });
  });

  /** Save (or share, on the iPad straight into Photos) the finished video. */
  function offer(blob: Blob, ext: string): void {
    const name = fileName(ext);
    const size = blob.size >= 1e6 ? `${(blob.size / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(blob.size / 1e3))} KB`;
    status.textContent = `Fertig: ${name} (${size})`;
    const file = new File([blob], name, { type: blob.type });
    const row = result;
    row.replaceChildren();
    const save = h('button', { class: 'dlg-btn primary', text: 'Speichern' });
    save.addEventListener('click', () => saveBlob(blob, name));
    row.append(save);
    if (navigator.canShare?.({ files: [file] })) {
      const share = h('button', { class: 'dlg-btn', text: 'Teilen …' });
      share.addEventListener('click', () => void navigator.share({ files: [file], title: 'Draftpad-Zeitraffer' }).catch(() => {}));
      row.append(share);
    }
  }

  const done = () => {
    stop(false);
    savePref('timelapse', { seconds: prefs.seconds, shape, res, mode: process ? mode : prefs.mode });
    finish(dlg, () => {}, null);
  };
  close.addEventListener('click', done);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    done();
  });

  setup();
  sync();
  dlg.showModal();
}
