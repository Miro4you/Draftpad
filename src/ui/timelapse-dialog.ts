import type { App } from '../app';
import { planTimelapse, TimelapseRenderer, videoMime } from '../export/timelapse';
import { loadPref, savePref } from '../storage/idb';
import { baseDialog, finish } from './dialogs';
import { h } from './dom';
import { saveBlob } from './export-dialog';

type Shape = 'wide' | 'tall' | 'square';

interface TimelapsePrefs {
  seconds: number;
  shape?: Shape;
}

const SHAPES: { id: Shape; label: string; w: number; h: number }[] = [
  { id: 'wide', label: 'Quer 16:9', w: 1920, h: 1080 },
  { id: 'tall', label: 'Hoch 9:16', w: 1080, h: 1920 },
  { id: 'square', label: 'Quadrat', w: 1440, h: 1440 },
];
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
  const plan = planTimelapse(app.doc);
  if (!plan.items.length) {
    app.toast('Noch nichts gezeichnet');
    return;
  }
  const prefs = loadPref<TimelapsePrefs>('timelapse', { seconds: 20 });
  const bw = plan.box.maxX - plan.box.minX;
  const bh = plan.box.maxY - plan.box.minY;
  let shape: Shape = prefs.shape ?? (bw >= bh * 1.2 ? 'wide' : bh >= bw * 1.2 ? 'tall' : 'square');
  const mime = videoMime();

  const { dlg, body, actions } = baseDialog('Zeitraffer-Video');
  dlg.classList.add('timelapse-dlg');
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
  const durSeg = seg(DURATIONS.map((s) => ({ id: s, label: `${s} s` })), () => prefs.seconds, (v) => (prefs.seconds = v));

  body.append(
    h('div', { class: 'tl-stage' }, [canvas]),
    bar,
    h('div', { class: 'exp-field' }, [h('span', { text: 'Format' }), shapeSeg.row]),
    h('div', { class: 'exp-field' }, [h('span', { text: 'Länge' }), durSeg.row]),
    status,
  );

  const close = h('button', { class: 'dlg-btn', text: 'Schließen' });
  const preview = h('button', { class: 'dlg-btn', text: 'Vorschau' });
  const record = h('button', { class: 'dlg-btn primary', text: 'Aufnehmen' });
  actions.append(close, preview, record);

  let renderer: TimelapseRenderer;
  let raf = 0;
  let busy = false;
  let recorder: MediaRecorder | null = null;

  function setup(): void {
    const s = SHAPES.find((x) => x.id === shape)!;
    canvas.width = s.w;
    canvas.height = s.h;
    renderer = new TimelapseRenderer(plan, canvas);
    renderer.frame(1);
  }

  function sync(): void {
    shapeSeg.sync();
    durSeg.sync();
    preview.textContent = busy && !recorder ? 'Stopp' : 'Vorschau';
    record.textContent = recorder ? 'Stopp' : 'Aufnehmen';
    preview.disabled = !!recorder;
    record.disabled = !mime || (busy && !recorder);
    if (!busy) {
      status.textContent = mime
        ? `${canvas.width} × ${canvas.height} px, ${mime.includes('mp4') ? 'MP4' : 'WebM'} – die Aufnahme läuft in Echtzeit.`
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
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
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
    const mb = (blob.size / 1e6).toFixed(1).replace('.', ',');
    status.textContent = `Fertig: ${name} (${mb} MB)`;
    const file = new File([blob], name, { type: blob.type });
    const row = h('div', { class: 'tl-result' });
    const save = h('button', { class: 'dlg-btn primary', text: 'Speichern' });
    save.addEventListener('click', () => saveBlob(blob, name));
    row.append(save);
    if (navigator.canShare?.({ files: [file] })) {
      const share = h('button', { class: 'dlg-btn', text: 'Teilen …' });
      share.addEventListener('click', () => void navigator.share({ files: [file], title: 'Draftpad-Zeitraffer' }).catch(() => {}));
      row.append(share);
    }
    body.querySelector('.tl-result')?.remove();
    body.append(row);
  }

  const done = () => {
    stop(false);
    savePref('timelapse', { seconds: prefs.seconds, shape });
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
