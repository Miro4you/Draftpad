import { loadPref, savePref } from './idb';

/** Connection to the Draftpad server (server/server.mjs), e.g. on a Raspberry Pi. */
export interface CloudConfig {
  /** Server address; empty = the server this app was loaded from. */
  url: string;
  token: string;
}

export interface CloudEntry {
  id: string;
  name: string;
  updated: string;
  size?: number;
  thumb?: string;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export function cloudConfig(): CloudConfig {
  return loadPref<CloudConfig>('cloud', { url: '', token: '' });
}

export function setCloudConfig(c: CloudConfig): void {
  savePref('cloud', c);
}

/** Base URL of the server API (no trailing slash). */
export function apiBase(c: CloudConfig = cloudConfig()): string {
  return base(c);
}

function base(c: CloudConfig): string {
  const u = c.url.trim().replace(/\/+$/, '');
  if (!u) return '/api';
  return `${/^https?:\/\//.test(u) ? u : `http://${u}`}/api`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const c = cloudConfig();
  let res: Response;
  try {
    res = await fetch(`${base(c)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}), ...(init.headers ?? {}) },
    });
  } catch {
    throw new CloudError('Server nicht erreichbar');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new CloudError('Keine Antwort vom Draftpad-Server', res.status);
  }
  if (!res.ok) throw new CloudError((data as { error?: string })?.error ?? `Fehler ${res.status}`, res.status);
  return data as T;
}

export async function cloudHealth(): Promise<{ ok: boolean; auth: boolean }> {
  const h = await call<{ ok: boolean; app?: string; auth: boolean }>('/health');
  if (h?.app !== 'skizzen-cad') throw new CloudError('Kein Draftpad-Server');
  return h;
}

export const listDrawings = () => call<CloudEntry[]>('/drawings');
export const loadCloudDrawing = (id: string) => call<unknown>(`/drawings/${encodeURIComponent(id)}`);
export const deleteCloudDrawing = (id: string) => call<{ ok: boolean }>(`/drawings/${encodeURIComponent(id)}`, { method: 'DELETE' });

export function saveCloudDrawing(id: string, name: string, doc: unknown, thumb?: string): Promise<CloudEntry> {
  return call<CloudEntry>(`/drawings/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, doc, thumb }) });
}

/** URL-safe id from a name plus a random suffix. */
export function newCloudId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'skizze'}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The server drawing the current one was opened from or last saved to. */
export interface CloudCurrent {
  id: string;
  name: string;
}

export function cloudCurrent(): CloudCurrent | null {
  const c = loadPref<{ id: string; name: string }>('cloudCurrent', { id: '', name: '' });
  return c.id ? c : null;
}

export function setCloudCurrent(c: CloudCurrent | null): void {
  savePref('cloudCurrent', c ?? { id: '', name: '' });
}
