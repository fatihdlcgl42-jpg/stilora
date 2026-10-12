// IndexedDB: kıyafetler, kombinler, giyim geçmişi ve ayarlar bu cihazda saklanır
let db;

export function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('stilora', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('outfits')) d.createObjectStore('outfits', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('wear')) d.createObjectStore('wear', { keyPath: 'id' });
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Kayıt iptal edildi (depolama dolu olabilir)'));
  });
}

export const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
export const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const getMeta = (k) => tx('meta', 'readonly', (s) => s.get(k));
export const setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));
