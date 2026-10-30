"use client";
/** A tiny promise wrapper over IndexedDB: one database, key-value stores. */

const DB_NAME = "leaf-sync";
const STORES = ["records", "queue"] as const;
type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | null = null;
/** No IndexedDB call may hold up its caller (the save loop awaits them): give up after this. */
const TIMEOUT_MS = 5_000;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      const d = req.result;
      // Another tab is deleting the database (logout), or the browser closed it: let go,
      // and open again on the next call.
      d.onversionchange = () => {
        d.close();
        opening = null;
      };
      d.onclose = () => (opening = null);
      resolve(d);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

/** One request in its own transaction; `fallback` on any failure: error, abort, closed connection, timeout. */
function run<T>(store: Store, mode: IDBTransactionMode, fallback: T, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // The timer covers opening too: an open can wait forever behind another tab's pending delete.
    const timer = setTimeout(() => {
      opening = null;
      done(fallback);
    }, TIMEOUT_MS);
    void db().then((d) => {
      if (!d || settled) return done(fallback);
      try {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => done(req ? (req.result as T) : fallback);
        t.onerror = t.onabort = () => done(fallback);
      } catch {
        opening = null;
        done(fallback);
      }
    });
  });
}

export function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", undefined, (s) => s.get(key));
}

export function idbSet(store: Store, key: string, value: unknown): Promise<void> {
  return run<void>(store, "readwrite", undefined, (s) => void s.put(value, key));
}

export async function idbKeys(store: Store): Promise<string[]> {
  const keys = await run<IDBValidKey[]>(store, "readonly", [], (s) => s.getAllKeys());
  return keys.map(String);
}

export function idbDelete(store: Store, key: string): Promise<void> {
  return run<void>(store, "readwrite", undefined, (s) => void s.delete(key));
}

/** Delete everything this device keeps (logout). */
export async function idbClear(): Promise<void> {
  const d = await Promise.race([db(), new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS))]);
  d?.close();
  opening = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
