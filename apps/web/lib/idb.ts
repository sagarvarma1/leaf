"use client";
/** A tiny promise wrapper over IndexedDB: one database, key-value stores. */

const DB_NAME = "leaf-sync";
const STORES = ["records", "queue"] as const;
type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const req = d.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function idbSet(store: Store, key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  return new Promise((resolve) => {
    const t = d.transaction(store, "readwrite");
    t.objectStore(store).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
  });
}

/** Delete everything this device keeps (logout). */
export async function idbClear(): Promise<void> {
  const d = await db();
  d?.close();
  opening = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
