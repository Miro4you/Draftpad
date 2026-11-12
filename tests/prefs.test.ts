import { beforeEach, describe, expect, it } from 'vitest';
import { loadPref, savePref } from '../src/storage/idb';
import { femOpenUrl, femUrl, setFemUrl } from '../src/storage/cloud';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe('Einstellungen', () => {
  it('Text bleibt Text (Projekt-FEM-Adresse)', () => {
    setFemUrl(' http://nas:8790 ');
    expect(femUrl()).toBe('http://nas:8790');
    expect(femOpenUrl(femUrl(), 'welle-1a2b3c')).toBe('http://nas:8790/#draftpad=welle-1a2b3c');
    expect(femOpenUrl('nas:8790/#k=abc', 'x-1')).toBe('http://nas:8790/#k=abc&draftpad=x-1');
  });
  it('Objekte werden mit den Vorgaben ergänzt', () => {
    savePref('t', { a: 2 });
    expect(loadPref('t', { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
  });
  it('falscher Typ → Vorgabe', () => {
    savePref('t', 'text');
    expect(loadPref('t', { a: 1 })).toEqual({ a: 1 });
    savePref('u', { a: 1 });
    expect(loadPref('u', '')).toBe('');
  });
});
