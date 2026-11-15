"use client";

// Minimal typed IndexedDB persistence: the last good snapshot per user and
// the pending-mutation outbox. Every call degrades to "no cache" instead of
// throwing (private mode, quota, blocked storage), so the UI never breaks
// because local storage did.
import { clearPageCaches } from "./page-cache";
import type { AlertMutation } from "@/lib/dashboard/alert-mutations";
import type { Snapshot } from "@/lib/dashboard/types";

const DB_NAME = "omni";
const DB_VERSION = 1;
const SNAPSHOTS = "snapshots";
const OUTBOX = "outbox";

interface SnapshotRecord {
  userId: string;
  snapshot: Snapshot;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "userId" });
        if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (db === null) return resolve(null);
        try {
          const req = op(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  return typeof value === "object" && value !== null && "userId" in value && "snapshot" in value;
}

function isMutation(value: unknown): value is AlertMutation {
  return typeof value === "object" && value !== null && "alertId" in value && "action" in value && "baseVersion" in value;
}

export async function readSnapshot(userId: string): Promise<Snapshot | null> {
  const record: unknown = await run(SNAPSHOTS, "readonly", (s) => s.get(userId));
  return isSnapshotRecord(record) ? record.snapshot : null;
}

export async function writeSnapshot(userId: string, snapshot: Snapshot): Promise<void> {
  const record: SnapshotRecord = { userId, snapshot };
  await run(SNAPSHOTS, "readwrite", (s) => s.put(record));
}

export async function readOutbox(): Promise<AlertMutation[]> {
  const all: unknown = await run(OUTBOX, "readonly", (s) => s.getAll());
  if (!Array.isArray(all)) return [];
  return all.filter(isMutation).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveMutation(mutation: AlertMutation): Promise<void> {
  await run(OUTBOX, "readwrite", (s) => s.put(mutation));
}

export async function deleteMutation(id: string): Promise<void> {
  await run(OUTBOX, "readwrite", (s) => s.delete(id));
}

/** Sign-out on a shared tablet: leave no health data behind. */
export async function clearAll(): Promise<void> {
  clearPageCaches();
  await run(SNAPSHOTS, "readwrite", (s) => s.clear());
  await run(OUTBOX, "readwrite", (s) => s.clear());
  try {
    if ("caches" in window) for (const key of await caches.keys()) await caches.delete(key);
  } catch {
    // Cache API unavailable; nothing to clear.
  }
}
