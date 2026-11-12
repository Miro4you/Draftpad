/** Minimal IndexedDB key/value store for autosave. All calls fail soft (resolve undefined / false). */

// Internal names keep the app's first name so saved drawings and settings stay.
const DB_NAME = 'skizzen-cad';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbSet(key: string, value: unknown): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** localStorage helpers for small preferences. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`skizzen-cad.${key}`);
    if (!raw) return fallback;
    const v: unknown = JSON.parse(raw);
    const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
    // Objekte mit den Vorgaben ergänzen; einfache Werte (z. B. eine Adresse) unverändert – nie in ein Objekt mischen
    if (isObj(fallback)) return isObj(v) ? ({ ...fallback, ...(v as object) } as T) : fallback;
    return typeof v === typeof fallback ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`skizzen-cad.${key}`, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}
