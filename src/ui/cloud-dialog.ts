import type { App } from '../app';
import { exportDrawing, exportSize } from '../export/export';
import {
  CloudError,
  cloudConfig,
  cloudCurrent,
  cloudHealth,
  deleteCloudDrawing,
  listDrawings,
  loadCloudDrawing,
  newCloudId,
  saveCloudDrawing,
  setCloudConfig,
  setCloudCurrent,
  type CloudEntry,
} from '../storage/cloud';
import { ask, baseDialog } from './dialogs';
import { h, releaseTextFocus } from './dom';

/** Small PNG preview of the drawing as a data URL (about 320 px wide). */
async function thumbnail(app: App): Promise<string | undefined> {
  const size = exportSize(app.doc, { margin: 4 });
  if (!size) return undefined;
  const dpi = Math.min(150, (320 / Math.max(size.w, size.h)) * 25.4);
  try {
    const blob = await exportDrawing(app.doc, { format: 'png', dpi, background: '#ffffff', margin: 4 });
    if (!blob) return undefined;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

function defaultName(app: App): string {
  for (const e of app.doc.all()) if (e.kind === 'sheet' && e.fields.title) return e.fields.title;
  const d = new Date();
  return `Skizze ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Save to and open from the Draftpad server (e.g. on the Raspberry Pi). */
export function showCloudDialog(app: App): void {
  const { dlg, body, actions } = baseDialog('Online-Ablage');
  dlg.classList.add('cloud-dlg');
  const status = h('p', { class: 'cloud-status' });
  const list = h('div', { class: 'cloud-list' });
  const cfg = cloudConfig();
  const url = h('input', { class: 'dlg-input', type: 'text', placeholder: 'leer = dieser Server, z. B. 192.168.1.20:8080', autocomplete: 'off' });
  url.value = cfg.url;
  const token = h('input', { class: 'dlg-input', type: 'password', placeholder: 'nur falls auf dem Server gesetzt', autocomplete: 'off' });
  token.value = cfg.token;
  const connect = h('button', { class: 'dlg-btn', text: 'Verbinden' });
  const conn = h('details', { class: 'cloud-conn' }, [
    h('summary', { text: 'Verbindung' }),
    h('label', { class: 'exp-field' }, [h('span', { text: 'Server' }), url]),
    h('label', { class: 'exp-field' }, [h('span', { text: 'Passwort' }), token]),
    h('div', { class: 'cloud-row' }, [connect]),
  ]);
  const current = cloudCurrent();
  const name = h('input', { class: 'dlg-input', type: 'text', autocomplete: 'off' });
  name.value = current?.name ?? defaultName(app);
  const saveBtn = h('button', { class: 'dlg-btn primary', text: 'Speichern' });
  const saveHint = h('p', { class: 'exp-hint' });
  const updateHint = () => {
    const cur = cloudCurrent();
    const over = !!cur && cur.name === name.value.trim();
    if (over && app.live?.id === cur.id) {
      saveBtn.textContent = 'Live';
      saveBtn.disabled = true;
      saveHint.textContent = 'Wird live laufend gespeichert. Neuen Namen eingeben, um eine Kopie abzulegen.';
      return;
    }
    saveBtn.disabled = false;
    saveBtn.textContent = over ? 'Überschreiben' : 'Speichern';
    saveHint.textContent = over ? `Ersetzt „${cur!.name}“ auf dem Server.` : 'Wird als neue Zeichnung abgelegt.';
  };
  name.addEventListener('input', updateHint);
  const liveBar = h('div', { class: 'cloud-live' });
  if (app.live && app.live.status !== 'off') {
    const stop = h('button', { class: 'dlg-btn', text: 'Live beenden' });
    stop.addEventListener('click', () => {
      app.live?.stop();
      liveBar.remove();
      updateHint();
      void refresh();
    });
    const devices = app.live.devices > 1 ? ` mit ${app.live.devices} Geräten` : '';
    liveBar.append(h('span', { text: `„${app.live.name}“ wird live bearbeitet${devices} und laufend gespeichert.` }), stop);
  }
  body.append(
    liveBar,
    status,
    h('div', { class: 'cloud-save' }, [h('label', { class: 'exp-field grow' }, [h('span', { text: 'Aktuelle Zeichnung speichern als' }), name]), saveBtn]),
    saveHint,
    h('div', { class: 'fly-title cloud-head', text: 'Auf dem Server' }),
    list,
    conn,
  );
  updateHint();
  const close = h('button', { class: 'dlg-btn', text: 'Schließen' });
  actions.append(close);
  const done = () => {
    releaseTextFocus();
    dlg.close();
    dlg.remove();
  };
  close.addEventListener('click', done);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    done();
  });

  const setStatus = (text: string, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
  };

  const fail = (err: unknown) => {
    const msg = err instanceof CloudError ? err.message : String(err);
    if (err instanceof CloudError && err.status === 401) {
      setStatus('Passwort nötig – unter „Verbindung“ eintragen.', true);
      conn.open = true;
    } else if (err instanceof CloudError && err.status === 0) {
      setStatus(`${msg}. Auf dem Pi „npm run serve“ starten und die App über den Server öffnen – oder die Adresse unter „Verbindung“ eintragen.`, true);
      conn.open = true;
    } else setStatus(msg, true);
    saveBtn.disabled = true;
  };

  const row = (e: CloudEntry): HTMLElement => {
    const img = e.thumb ? h('img', { class: 'cloud-thumb', src: e.thumb, alt: '' }) : h('div', { class: 'cloud-thumb' });
    const open = h('button', { class: 'dlg-btn', text: 'Öffnen' });
    const liveOn = app.live?.id === e.id;
    const liveBtn = h('button', { class: `dlg-btn${liveOn ? ' primary' : ''}`, text: liveOn ? 'Live ✓' : 'Live', title: 'Live bearbeiten: mit anderen Geräten gleichzeitig' });
    liveBtn.disabled = liveOn;
    liveBtn.addEventListener('click', async () => {
      if (
        app.doc.size > 0 &&
        cloudCurrent()?.id !== e.id &&
        !(await ask({ title: 'Zeichnung ersetzen?', message: `„${e.name}“ ersetzt die aktuelle Zeichnung und wird live bearbeitet.`, confirm: 'Live öffnen', danger: true }))
      ) {
        return;
      }
      app.live?.start(e.id, e.name);
      done();
      app.toast(`„${e.name}“ live – auf weiteren Geräten ebenfalls „Live“ wählen`);
    });
    const del = h('button', { class: 'btn danger', title: 'Löschen', 'aria-label': 'Löschen', text: '✕' });
    open.addEventListener('click', async () => {
      if (
        app.doc.size > 0 &&
        !(await ask({ title: 'Zeichnung ersetzen?', message: `„${e.name}“ ersetzt die aktuelle Zeichnung.`, confirm: 'Öffnen', danger: true }))
      ) {
        return;
      }
      try {
        const data = await loadCloudDrawing(e.id);
        app.live?.stop();
        app.loadDrawing(data);
        setCloudCurrent({ id: e.id, name: e.name });
        done();
        app.toast(`„${e.name}“ geöffnet`);
      } catch (err) {
        fail(err);
      }
    });
    del.addEventListener('click', async () => {
      if (!(await ask({ title: 'Vom Server löschen?', message: `„${e.name}“ wird endgültig gelöscht.`, confirm: 'Löschen', danger: true }))) return;
      try {
        await deleteCloudDrawing(e.id);
        if (cloudCurrent()?.id === e.id) setCloudCurrent(null);
        updateHint();
        await refresh();
      } catch (err) {
        fail(err);
      }
    });
    return h('div', { class: 'cloud-item' }, [
      img,
      h('div', { class: 'cloud-meta' }, [h('div', { class: 'cloud-name', text: e.name }), h('div', { class: 'cloud-date', text: when(e.updated) })]),
      open,
      liveBtn,
      del,
    ]);
  };

  async function refresh(): Promise<void> {
    setStatus('Verbinde …');
    try {
      await cloudHealth();
      const items = await listDrawings();
      saveBtn.disabled = false;
      setStatus(items.length ? `${items.length} Zeichnung${items.length === 1 ? '' : 'en'} auf dem Server` : 'Verbunden – noch keine Zeichnungen gespeichert.');
      list.replaceChildren(...items.map(row));
    } catch (err) {
      list.replaceChildren();
      fail(err);
    }
  }

  connect.addEventListener('click', () => {
    setCloudConfig({ url: url.value.trim(), token: token.value });
    void refresh();
  });

  saveBtn.addEventListener('click', async () => {
    const n = name.value.trim() || defaultName(app);
    if (app.doc.size === 0) {
      setStatus('Die Zeichnung ist leer.', true);
      return;
    }
    const cur = cloudCurrent();
    const id = cur && cur.name === n ? cur.id : newCloudId(n);
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere …';
    try {
      const thumb = await thumbnail(app);
      await saveCloudDrawing(id, n, app.doc.toFile(app.cam.state), thumb);
      setCloudCurrent({ id, name: n });
      app.toast(`„${n}“ auf dem Server gespeichert`);
      updateHint();
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      saveBtn.disabled = false;
      updateHint();
    }
  });

  dlg.showModal();
  void refresh();
}
