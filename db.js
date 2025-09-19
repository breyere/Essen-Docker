// Simple IndexedDB-based key-value store for the Essen app
// Falls back to localStorage if IndexedDB is unavailable.
(function () {
  const DB_NAME = 'essen-db';
  const STORE = 'kv';

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return undefined; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  if (!('indexedDB' in window)) {
    window.kv = {
      init: async () => true,
      get: async (k) => lsGet(k),
      set: async (k, v) => { lsSet(k, v); return true; },
      del: async (k) => { lsDel(k); return true; },
      getMany: async (keys) => {
        const out = {}; keys.forEach(k => { out[k] = lsGet(k); }); return out;
      }
    };
    return;
  }

  let dbp = null;
  function init() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function get(key) {
    return init().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      const rq = st.get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    }));
  }

  function set(key, value) {
    return init().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const rq = st.put(value, key);
      rq.onsuccess = () => resolve(true);
      rq.onerror = () => reject(rq.error);
    }));
  }

  function del(key) {
    return init().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const rq = st.delete(key);
      rq.onsuccess = () => resolve(true);
      rq.onerror = () => reject(rq.error);
    }));
  }

  function getMany(keys) {
    return Promise.all(keys.map(get)).then(values => {
      const out = {}; keys.forEach((k, i) => out[k] = values[i]); return out;
    });
  }

  window.kv = { init, get, set, del, getMany };
})();

