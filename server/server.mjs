#!/usr/bin/env node
/**
 * Draftpad server for a home network (e.g. a Raspberry Pi): serves the built
 * app from ../dist and keeps drawings as JSON files in a data folder.
 *
 *   node server/server.mjs            → http://0.0.0.0:8080
 *
 * Environment:
 *   PORT      port (default 8080)
 *   HOST      interface (default 0.0.0.0)
 *   DATA_DIR  where drawings are stored (default ./data)
 *   TOKEN     optional password; clients then send "Authorization: Bearer <TOKEN>"
 *
 * Live editing: devices that open the same drawing live see each other's changes
 * (see the live section below).
 *
 * No dependencies besides Node.js 18+.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(here, '..', 'data'));
const DIST = resolve(join(here, '..', 'dist'));
const TOKEN = process.env.TOKEN || '';
const MAX_BODY = 25 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  });
  res.end(data);
}

function authorized(req) {
  if (!TOKEN) return true;
  // EventSource can't send headers, so the live stream passes the token in the URL.
  const query = new URL(req.url || '/', 'http://x').searchParams.get('token');
  const given = Buffer.from(query ?? (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Zeichnung zu groß'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const docPath = (id) => join(DATA_DIR, `${id}.json`);
const metaPath = (id) => join(DATA_DIR, `${id}.meta.json`);

/** Write via a temp file so a crash never leaves half a drawing behind. */
async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

// ---- live editing -----------------------------------------------------------------------
//
// Devices editing the same drawing receive each other's changes: a device listens
// on GET /api/live/<id>/events (server-sent events; the first message is the whole
// drawing) and posts its changes to POST /api/live/<id>/ops. Changes are sync ops –
// put an entity, delete one, or the list of layers – applied here to the stored
// drawing (saved shortly after) and passed on to the other devices.

/** id → { doc, rev, clients: Map<res, clientId>, saveTimer } */
const live = new Map();
const SAVE_MS = 600;

async function liveSession(id) {
  let s = live.get(id);
  if (s) return s;
  const doc = JSON.parse(await readFile(docPath(id), 'utf8'));
  s = live.get(id) ?? { doc, rev: 0, clients: new Map(), saveTimer: null, dirty: false };
  live.set(id, s);
  return s;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function applyOps(doc, ops) {
  const byId = new Map((doc.entities || []).map((e) => [e.id, e]));
  for (const op of ops) {
    if (op.t === 'put' && op.e && typeof op.e.id === 'string') {
      byId.set(op.e.id, op.e);
      if (typeof op.e.z === 'number' && op.e.z >= (doc.nextZ || 0)) doc.nextZ = op.e.z + 1;
    } else if (op.t === 'del' && typeof op.id === 'string') {
      byId.delete(op.id);
    } else if (op.t === 'layers' && Array.isArray(op.layers) && op.layers.length) {
      doc.layers = op.layers;
      if (!op.layers.some((l) => l.id === doc.activeLayerId)) doc.activeLayerId = op.layers[0].id;
    } else if (op.t === 'scale' && typeof op.scale === 'number' && op.scale > 0) {
      doc.scale = op.scale;
    }
  }
  doc.entities = [...byId.values()].sort((a, b) => (a.z || 0) - (b.z || 0));
  // History for the timelapse (same format as the app keeps).
  if (!Array.isArray(doc.journal)) doc.journal = [];
  doc.journal.push({ t: Date.now(), ops });
  if (doc.journal.length > MAX_JOURNAL) {
    const n = doc.journal.length - MAX_JOURNAL / 2;
    doc.journal = [foldJournal(doc.journal, n), ...doc.journal.slice(n)];
  }
}

const MAX_JOURNAL = 20_000;

/** The first n journal steps folded into one base step (like the app does). */
function foldJournal(entries, n) {
  const ents = new Map();
  let layers = [];
  for (const en of entries.slice(0, n)) {
    for (const op of en.ops || []) {
      if (op.t === 'put' && op.e) ents.set(op.e.id, op.e);
      else if (op.t === 'del') ents.delete(op.id);
      else if (op.t === 'layers' && Array.isArray(op.layers)) {
        const flags = new Map(layers.map((l) => [l.id, l]));
        layers = op.layers.map((l) => {
          const cur = en.base ? undefined : flags.get(l.id);
          return cur ? { ...l, visible: cur.visible, dimmed: cur.dimmed } : { ...l };
        });
      } else if (op.t === 'vis') {
        layers = layers.map((l) => (l.id === op.id ? { ...l, visible: !!op.visible, dimmed: !!op.dimmed } : l));
      }
    }
  }
  const ops = [];
  if (layers.length) ops.push({ t: 'layers', layers });
  for (const e of [...ents.values()].sort((a, b) => (a.z || 0) - (b.z || 0))) ops.push({ t: 'put', e });
  return { t: entries[Math.max(0, n - 1)]?.t ?? Date.now(), ops, base: true };
}

/** Save at most SAVE_MS after the first unsaved change (a steady stream of changes can't hold it off). */
function scheduleSave(id, s) {
  s.dirty = true;
  if (s.saveTimer) return;
  s.saveTimer = setTimeout(async () => {
    s.saveTimer = null;
    s.dirty = false;
    try {
      const text = JSON.stringify(s.doc);
      await writeAtomic(docPath(id), text);
      let meta = {};
      try {
        meta = JSON.parse(await readFile(metaPath(id), 'utf8'));
      } catch {
        /* no meta yet */
      }
      await writeAtomic(metaPath(id), JSON.stringify({ ...meta, updated: new Date().toISOString(), size: Buffer.byteLength(text) }));
    } catch (err) {
      console.error('Speichern fehlgeschlagen', id, err);
    }
    if (s.dirty) scheduleSave(id, s);
    else if (!s.clients.size) live.delete(id);
  }, SAVE_MS);
}

/** On shutdown, write live drawings that have unsaved changes. */
function saveAllNow() {
  for (const [id, s] of live) {
    if (!s.dirty && !s.saveTimer) continue;
    try {
      writeFileSync(docPath(id), JSON.stringify(s.doc));
    } catch (err) {
      console.error('Speichern fehlgeschlagen', id, err);
    }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveAllNow();
    process.exit(0);
  });
}

async function liveApi(req, res, id, action) {
  let s;
  try {
    s = await liveSession(id);
  } catch {
    return send(res, 404, { error: 'Zeichnung nicht gefunden' });
  }
  const url = new URL(req.url || '/', 'http://x');
  if (action === 'events' && req.method === 'GET') {
    const client = String(url.searchParams.get('client') || '').slice(0, 64);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    // A device reconnecting (e.g. after a reload) replaces its old connection.
    for (const [r, c] of s.clients) if (client && c === client) (s.clients.delete(r), r.end());
    s.clients.set(res, client);
    sse(res, 'snapshot', { rev: s.rev, doc: s.doc, devices: s.clients.size });
    for (const [r, c] of s.clients) if (r !== res && c !== client) sse(r, 'devices', { devices: s.clients.size });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      s.clients.delete(res);
      for (const r of s.clients.keys()) sse(r, 'devices', { devices: s.clients.size });
      if (!s.clients.size && !s.saveTimer) live.delete(id);
    });
    return;
  }
  if (action === 'ops' && req.method === 'POST') {
    const body = await readBody(req);
    const ops = Array.isArray(body?.ops) ? body.ops : null;
    if (!ops) return send(res, 400, { error: 'Keine Änderungen' });
    const client = String(body.client || '').slice(0, 64);
    applyOps(s.doc, ops);
    s.rev++;
    for (const [r, c] of s.clients) if (c !== client) sse(r, 'ops', { rev: s.rev, client, ops });
    scheduleSave(id, s);
    return send(res, 200, { rev: s.rev });
  }
  return send(res, 405, { error: 'Methode nicht erlaubt' });
}

async function api(req, res, path) {
  if (path === '/api/health') return send(res, 200, { ok: true, app: 'skizzen-cad', auth: !!TOKEN });
  if (!authorized(req)) return send(res, 401, { error: 'Passwort fehlt oder ist falsch' });
  if (path === '/api/drawings' && req.method === 'GET') {
    const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.meta.json'));
    const list = [];
    for (const f of files) {
      try {
        list.push({ id: f.slice(0, -'.meta.json'.length), ...JSON.parse(await readFile(join(DATA_DIR, f), 'utf8')) });
      } catch {
        /* skip broken entries */
      }
    }
    list.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return send(res, 200, list);
  }
  const lm = /^\/api\/live\/([^/]+)\/(events|ops)$/.exec(path);
  if (lm) return ID.test(lm[1]) ? liveApi(req, res, lm[1], lm[2]) : send(res, 404, { error: 'Nicht gefunden' });
  const m = /^\/api\/drawings\/([^/]+)$/.exec(path);
  if (!m || !ID.test(m[1])) return send(res, 404, { error: 'Nicht gefunden' });
  const id = m[1];
  if (req.method === 'GET') {
    const s = live.get(id);
    if (s) return send(res, 200, s.doc);
    try {
      return send(res, 200, await readFile(docPath(id), 'utf8'));
    } catch {
      return send(res, 404, { error: 'Zeichnung nicht gefunden' });
    }
  }
  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !body.doc || body.doc.format !== 'skizzen-cad') {
      return send(res, 400, { error: 'Keine Draftpad-Zeichnung' });
    }
    const name = String(body.name || 'Skizze').slice(0, 120);
    const thumb = typeof body.thumb === 'string' && body.thumb.startsWith('data:image/') && body.thumb.length < 200_000 ? body.thumb : undefined;
    const updated = new Date().toISOString();
    const text = JSON.stringify(body.doc);
    await writeAtomic(docPath(id), text);
    await writeAtomic(metaPath(id), JSON.stringify({ name, updated, size: Buffer.byteLength(text), thumb }));
    const s = live.get(id);
    if (s) {
      // Saved over from somewhere: live devices get the new state.
      s.doc = body.doc;
      s.rev++;
      for (const r of s.clients.keys()) sse(r, 'snapshot', { rev: s.rev, doc: s.doc, devices: s.clients.size });
    }
    return send(res, 200, { id, name, updated });
  }
  if (req.method === 'DELETE') {
    const s = live.get(id);
    if (s) {
      clearTimeout(s.saveTimer);
      for (const r of s.clients.keys()) r.end();
      live.delete(id);
    }
    await rm(docPath(id), { force: true });
    await rm(metaPath(id), { force: true });
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'Methode nicht erlaubt' });
}

async function serveStatic(res, path) {
  let file = normalize(join(DIST, decodeURIComponent(path)));
  if (file !== DIST && !file.startsWith(DIST + sep)) return send(res, 403, 'Verboten', 'text/plain');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Unknown paths fall back to the app.
    file = join(DIST, 'index.html');
  }
  try {
    const data = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      // Hashed assets can be cached for good, the rest must stay fresh.
      'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Nicht gefunden – erst „npm run build“ ausführen.', 'text/plain; charset=utf-8');
  }
}

await mkdir(DATA_DIR, { recursive: true });

createServer(async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://x').pathname;
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Methode nicht erlaubt' });
    return await serveStatic(res, path);
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : 'Serverfehler' });
    if (!err.status) console.error(err);
  }
}).listen(PORT, HOST, () => {
  console.log(`Draftpad läuft auf http://${HOST}:${PORT} (Zeichnungen in ${DATA_DIR})${TOKEN ? ' – mit Passwort' : ''}`);
});
