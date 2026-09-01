// Tiny promise-based IndexedDB wrapper (no dependencies). Used to persist the
// draft autosave: layers are stored as PNG Blobs (no base64 inflation) under a
// stable key, in a much larger quota than localStorage. All ops reject on
// open/upgrade/transaction errors so callers can keep `dirtyRef` true and
// surface an honest "couldn't save" status instead of silently losing artwork.
//
// Request errors REJECT (via the `fail` callback runTransaction hands to the
// work function) — they must never `throw`. A request's onerror fires long
// after runTransaction's try/catch has returned, so a throw there escapes as an
// uncaught page error even though the promise itself is handled. WebKit hits
// this on every draft autosave it can't serialise ("Error preparing Blob/File
// data to be stored in object store").

const DB_NAME = "happypaint";
// v2 adds the generic "kv" store used by the gallery and Paint Space locker so
// large base64 dataURLs no longer ride in the ~5MB localStorage budget (and a
// quota overflow can't silently drop a save). The existing "drafts" store is
// left untouched so the W3 autosave migration keeps working.
const DB_VERSION = 2;
const STORE_NAME = "drafts";
// Generic key/value store. The gallery and Paint Space each persist their full
// array under a single stable key here.
const KV_STORE_NAME = "kv";

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
      // Added in v2 — adding a new store leaves the existing drafts store intact.
      if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
        db.createObjectStore(KV_STORE_NAME);
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

function runTransaction(mode, work, storeName = STORE_NAME) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(storeName, mode);
        } catch (error) {
          reject(error);
          return;
        }
        const store = tx.objectStore(storeName);
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
          work(
            store,
            (value) => {
              result = value;
            },
            fail,
          );
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
  return runTransaction("readonly", (store, setResult, fail) => {
    const request = store.get(key);
    request.onsuccess = () => setResult(request.result ?? null);
    request.onerror = () => fail(request.error || new Error("IndexedDB get failed"));
  });
}

export function idbSet(key, value) {
  return runTransaction("readwrite", (store, setResult, fail) => {
    const request = store.put(value, key);
    request.onerror = () => fail(request.error || new Error("IndexedDB put failed"));
  });
}

export function idbDelete(key) {
  return runTransaction("readwrite", (store, setResult, fail) => {
    const request = store.delete(key);
    request.onerror = () => fail(request.error || new Error("IndexedDB delete failed"));
  });
}

// Clear the ENTIRE drafts store. Drafts are now keyed per room (draft:v4:<ROOM>),
// so account deletion clears the whole store rather than a single key — otherwise
// per-room autosaves would survive a "delete my data" request.
export function idbClearDrafts() {
  return runTransaction("readwrite", (store, setResult, fail) => {
    const request = store.clear();
    request.onerror = () => fail(request.error || new Error("IndexedDB clear failed"));
  });
}

// ---- Generic key/value store (gallery, Paint Space) ----
// Same honest semantics as the draft helpers: every op rejects on error so the
// caller can surface a real "couldn't save" status instead of swallowing it.

export function idbGetKV(key) {
  return runTransaction(
    "readonly",
    (store, setResult, fail) => {
      const request = store.get(key);
      request.onsuccess = () => setResult(request.result ?? null);
      request.onerror = () => fail(request.error || new Error("IndexedDB get failed"));
    },
    KV_STORE_NAME,
  );
}

export function idbSetKV(key, value) {
  return runTransaction(
    "readwrite",
    (store, setResult, fail) => {
      const request = store.put(value, key);
      request.onerror = () => fail(request.error || new Error("IndexedDB put failed"));
    },
    KV_STORE_NAME,
  );
}

export function idbDeleteKV(key) {
  return runTransaction(
    "readwrite",
    (store, setResult, fail) => {
      const request = store.delete(key);
      request.onerror = () => fail(request.error || new Error("IndexedDB delete failed"));
    },
    KV_STORE_NAME,
  );
}
