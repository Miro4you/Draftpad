import type { App } from '../app';
import type { DocFile } from '../core/types';
import type { SyncOp } from '../core/document';
import { apiBase, cloudConfig, setCloudCurrent } from './cloud';
import { loadPref, savePref } from './idb';

export type LiveStatus = 'off' | 'connecting' | 'live' | 'offline';

interface LivePrefs {
  id: string;
  name: string;
  /** Changes not yet confirmed by the server (survive a reload while offline). */
  pending: SyncOp[][];
}

const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

function tabId(): string {
  try {
    let id = sessionStorage.getItem('draftpad.tab');
    if (!id) sessionStorage.setItem('draftpad.tab', (id = Math.random().toString(36).slice(2, 10)));
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/**
 * Live editing of a drawing on the Draftpad server: every finished step goes to
 * the server, which passes it on to the other devices that have the drawing open;
 * their steps arrive the same way. The view, tool and layer visibility stay per
 * device. Changes made while the connection is down are sent when it is back.
 */
export class LiveSession {
  status: LiveStatus = 'off';
  id: string | null = null;
  name = '';
  /** Devices connected to the drawing (including this one). */
  devices = 1;
  private es: EventSource | null = null;
  private pending: SyncOp[][] = [];
  private sending = false;
  private sendFailed = false;
  private retry = 0;
  private retryTimer: number | undefined;
  /** This device (tab); kept across reloads so the server replaces the old connection. */
  private readonly client = tabId();
  private listeners = new Set<() => void>();

  constructor(private app: App) {
    app.doc.onOps((ops) => this.local(ops));
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  /** Reconnect to the drawing that was live before the page was reloaded. */
  resume(): void {
    const p = loadPref<LivePrefs>('live', { id: '', name: '', pending: [] });
    if (!p.id) return;
    this.pending = Array.isArray(p.pending) ? p.pending : [];
    this.start(p.id, p.name, true);
  }

  /** Start editing a server drawing live; the server's state replaces the local drawing. */
  start(id: string, name: string, resumed = false): void {
    this.stop(resumed);
    this.id = id;
    this.name = name;
    this.devices = 1;
    setCloudCurrent({ id, name });
    this.persist();
    this.setStatus('connecting');
    this.connect();
  }

  /** Stop live editing (the drawing stays as it is). */
  stop(keepPending = false): void {
    this.es?.close();
    this.es = null;
    window.clearTimeout(this.retryTimer);
    if (!keepPending) this.pending = [];
    this.id = null;
    savePref('live', { id: '', name: '', pending: [] });
    this.setStatus('off');
  }

  private persist(): void {
    if (this.id) savePref('live', { id: this.id, name: this.name, pending: this.pending });
  }

  private connect(): void {
    if (!this.id) return;
    const c = cloudConfig();
    const q = new URLSearchParams({ client: this.client, ...(c.token ? { token: c.token } : {}) });
    const es = new EventSource(`${apiBase(c)}/live/${encodeURIComponent(this.id)}/events?${q}`);
    this.es = es;
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { doc: DocFile; devices: number };
      this.devices = data.devices ?? 1;
      this.app.applyLiveSnapshot(data.doc);
      // Own changes the server hasn't got yet go on top again.
      for (const ops of this.pending) this.app.doc.applyRemote(ops);
      this.retry = 0;
      this.setStatus('live');
      this.emit();
      void this.flush();
    });
    es.addEventListener('ops', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { client: string; ops: SyncOp[] };
      if (data.client === this.client) return;
      this.app.applyRemoteOps(data.ops);
    });
    es.addEventListener('devices', (ev) => {
      this.devices = (JSON.parse((ev as MessageEvent).data) as { devices: number }).devices;
      this.emit();
    });
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up (e.g. server restarted): try again ourselves.
        es.close();
        this.es = null;
        this.setStatus('offline');
        this.retryTimer = window.setTimeout(() => this.connect(), RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)]);
      } else this.setStatus('offline');
    };
  }

  /** A local step: queue it for the server. */
  private local(ops: SyncOp[]): void {
    if (!this.id) return;
    this.pending.push(ops);
    this.persist();
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.id || !this.pending.length || this.status !== 'live') return;
    this.sending = true;
    const id = this.id;
    const batch = this.pending[0];
    let ok = false;
    try {
      const c = cloudConfig();
      const res = await fetch(`${apiBase(c)}/live/${encodeURIComponent(id)}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
        body: JSON.stringify({ client: this.client, ops: batch }),
      });
      ok = res.ok;
      if (res.status === 404) {
        this.app.toast('Die Live-Zeichnung gibt es auf dem Server nicht mehr');
        this.stop();
        return;
      }
    } catch {
      ok = false;
    } finally {
      this.sending = false;
    }
    if (this.id !== id) return;
    if (ok) {
      if (this.pending[0] === batch) this.pending.shift();
      this.persist();
      void this.flush();
    } else {
      // Sending failed (e.g. network gone for a moment): keep the step and try again.
      this.sendFailed = true;
      this.emit();
      window.setTimeout(() => void this.flush(), 3000);
      return;
    }
    if (this.sendFailed) {
      this.sendFailed = false;
      this.emit();
    }
  }

  /** Connection state for the indicator: ok, waiting or broken. */
  get health(): 'ok' | 'wait' | 'bad' {
    if (this.status === 'live' && !this.sendFailed) return 'ok';
    return this.status === 'connecting' ? 'wait' : 'bad';
  }

  /** Short state text for the view bar. */
  get label(): string {
    switch (this.status) {
      case 'connecting':
        return 'Verbinde …';
      case 'live':
        if (this.sendFailed) return 'Offline – wird nachgeholt';
        return this.devices > 1 ? `Live · ${this.devices} Geräte` : 'Live';
      case 'offline':
        return this.pending.length ? 'Offline – wird nachgeholt' : 'Offline';
      default:
        return '';
    }
  }
}
