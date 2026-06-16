// Tiny promise-based IndexedDB wrapper (no dependencies). Used to persist the
// draft autosave: layers are stored as PNG Blobs (no base64 inflation) under a
// stable key, in a much larger quota than localStorage. All ops reject on
// open/upgrade/transaction errors so callers can keep `dirtyRef` true and
// surface an honest "couldn't save" status instead of silently losing artwork.

const DB_NAME = "happypaint";
const DB_VERSION = 1;
const STORE_NAME = "drafts";

// Returns true when IndexedDB is usable in this environment (it is unavailable
// or throws on access in some private-browsing modes).
export function isIdbAvailable() {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  // If opening fails, clear the cached promise so a later call can retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function runTransaction(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(STORE_NAME, mode);
        } catch (error) {
          reject(error);
          return;
        }
        const store = tx.objectStore(STORE_NAME);
        let result;
        let settled = false;
        const fail = (error) => {
          if (!settled) {
            settled = true;
            reject(error || new Error("IndexedDB transaction failed"));
          }
        };
        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
        try {
          work(store, (value) => {
            result = value;
          });
        } catch (error) {
          // Surface synchronous errors (e.g. structured-clone failures) and abort.
          try {
            tx.abort();
          } catch {
            // ignore abort errors
          }
          fail(error);
        }
      }),
  );
}

export function idbGet(key) {
  return runTransaction("readonly", (store, setResult) => {
    const request = store.get(key);
    request.onsuccess = () => setResult(request.result ?? null);
    request.onerror = () => {
      throw request.error || new Error("IndexedDB get failed");
    };
  });
}

export function idbSet(key, value) {
  return runTransaction("readwrite", (store) => {
    const request = store.put(value, key);
    request.onerror = () => {
      throw request.error || new Error("IndexedDB put failed");
    };
  });
}

export function idbDelete(key) {
  return runTransaction("readwrite", (store) => {
    const request = store.delete(key);
    request.onerror = () => {
      throw request.error || new Error("IndexedDB delete failed");
    };
  });
}
