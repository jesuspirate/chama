// ══════════════════════════════════════════════════════════════════════════
// Chama — Durable escrow-event cache (IndexedDB)
// ══════════════════════════════════════════════════════════════════════════
//
// WHY: escrow chains are rebuilt by `loadEscrow` from RELAY events + an
// IN-MEMORY event cache (escrow-client `rawEvents`, lost on every reload). So
// a trade whose events aged off the relays can't be rebuilt at all —
// `loadEscrow` returns null and the trade is only a summary row (the durable
// trade-index) with no openable detail. This persists the raw escrow events
// on-device so `loadEscrow` can rebuild a FULL chain offline / relay-down —
// the completion of the trade-index (list-durable → trade-durable).
//
// Escrow events are public Nostr events (kinds 38100-38105), so this is a
// cache of already-public data keyed by escrow id — no private material, no
// user-scoping needed. IndexedDB-backed (larger quota than localStorage,
// right tool for a growing event store); every op degrades to a NO-OP when
// IndexedDB is unavailable (Node tests, private mode) so it never blocks a
// load. The merge + eviction LOGIC is pure and separately tested.

import { type NostrEvent, EscrowStatus, TERMINAL_STATES } from "./types.js";

export const EVENT_CACHE_DB = "chama_escrow_events_v1";
export const EVENT_CACHE_STORE = "events";
/** Cap on distinct escrows cached. Generous — a chain is ~5-15 small events;
 *  1000 trades ≈ a few MB. Over cap → evict oldest TERMINAL trades first. */
export const EVENT_CACHE_MAX_ESCROWS = 1000;

interface CacheRecord {
  escrowId: string;
  events: NostrEvent[];
  /** UI-terminal (COMPLETED/EXPIRED/CANCELLED) ⇒ safe to evict first. */
  terminal: boolean;
  /** Last write (Unix ms) — eviction tiebreak (oldest first). */
  updatedAt: number;
}

// ── Pure logic (testable without IndexedDB) ─────────────────────────────────

/** Dedup events by id, preserving order (first occurrence wins). */
export function dedupEventsById(events: readonly NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const e of events) {
    if (!e || typeof e.id !== "string" || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Whether a status is UI-terminal (safe to evict before a live trade). */
export function isEvictableTerminal(status: EscrowStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** Given the metadata of all cached escrows, which ids to evict to get back
 *  to `max`. Evicts OLDEST TERMINAL trades first (they're done — least likely
 *  to be re-opened), and only touches live trades if terminals don't free
 *  enough. Returns [] when under cap. */
export function selectEvictions(
  metas: readonly { escrowId: string; terminal: boolean; updatedAt: number }[],
  max: number,
): string[] {
  if (metas.length <= max) return [];
  const need = metas.length - max;
  const ordered = [...metas].sort((a, b) => {
    // Terminal before live; within a group, oldest-updated first.
    if (a.terminal !== b.terminal) return a.terminal ? -1 : 1;
    return a.updatedAt - b.updatedAt;
  });
  return ordered.slice(0, need).map((m) => m.escrowId);
}

// ── IndexedDB layer (guarded — no-op when unavailable) ──────────────────────

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Hard caps so IndexedDB can NEVER deadlock the load path. WKWebView (Tauri
 *  on macOS/iOS) can stall `indexedDB.open` on first launch with NO event ever
 *  firing; a memoized never-resolving open would then hang EVERY getCachedEvents
 *  — and thus every launch `loadEscrow` in the discovery flood → the whole app
 *  freezes on launch. Bounded: unavailable ⇒ cache off for the session, loads
 *  proceed relay-only (original behaviour). */
export const OPEN_DB_TIMEOUT_MS = 3_000;
export const TXN_TIMEOUT_MS = 3_000;

/** Resolve `p`, or `fallback` if it doesn't settle within `ms`. Never rejects. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  const raw = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(EVENT_CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(EVENT_CACHE_STORE)) {
          db.createObjectStore(EVENT_CACHE_STORE, { keyPath: "escrowId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn("[chama] event-cache: openDb failed:", req.error);
        resolve(null);
      };
      // A version-change blocked by another connection would otherwise hang.
      (req as IDBOpenDBRequest).onblocked = () => {
        console.warn("[chama] event-cache: openDb blocked — disabling cache");
        resolve(null);
      };
    } catch (e) {
      console.warn("[chama] event-cache: openDb threw:", e);
      resolve(null);
    }
  });
  // Memoize the TIMED result: a hung open resolves null after the cap, so every
  // subsequent call gets null immediately (cache off) instead of re-hanging.
  dbPromise = withTimeout(raw, OPEN_DB_TIMEOUT_MS, null);
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Session-scoped stand-in for the durable store when IndexedDB is off
 *  (private mode, a stalled WKWebView open, Node). Without it those runtimes
 *  get NO chain repair at all; with it they at least keep repairing within
 *  the session. Same cap + eviction rule as the durable store. */
const memoryFallback: Map<string, CacheRecord> = new Map();

function evictMemoryFallback(): void {
  const victims = selectEvictions(
    [...memoryFallback.values()].map((r) => ({
      escrowId: r.escrowId, terminal: r.terminal, updatedAt: r.updatedAt,
    })),
    EVENT_CACHE_MAX_ESCROWS,
  );
  for (const id of victims) memoryFallback.delete(id);
}

/** The persisted raw events for an escrow, or [] when absent/unavailable.
 *  Fully time-bounded (openDb + the read) so a stalled IndexedDB can never
 *  block `loadEscrow` — it just falls back to the in-memory store. */
export async function getCachedEvents(escrowId: string): Promise<NostrEvent[]> {
  const db = await openDb();
  if (!db) return memoryFallback.get(escrowId)?.events ?? [];
  return withTimeout((async () => {
    const tx = db.transaction(EVENT_CACHE_STORE, "readonly");
    const rec = await reqToPromise(tx.objectStore(EVENT_CACHE_STORE).get(escrowId));
    return (rec as CacheRecord | undefined)?.events ?? [];
  })(), TXN_TIMEOUT_MS, []);
}

/** Persist an escrow's full (deduped) event chain durably. terminal drives
 *  eviction priority. Fire-and-forget from the caller; never throws. */
export async function putCachedEvents(
  escrowId: string,
  events: readonly NostrEvent[],
  status: EscrowStatus,
): Promise<void> {
  if (events.length === 0) return;
  const db = await openDb();
  const record: CacheRecord = {
    escrowId,
    events: dedupEventsById(events),
    terminal: isEvictableTerminal(status),
    updatedAt: Date.now(),
  };
  if (!db) {
    memoryFallback.set(escrowId, record);
    evictMemoryFallback();
    return;
  }
  try {
    const tx = db.transaction(EVENT_CACHE_STORE, "readwrite");
    tx.objectStore(EVENT_CACHE_STORE).put(record);
    await txDone(tx);
    await maybeEvict(db);
  } catch (e) {
    console.debug("[chama] event-cache: put failed:", e);
  }
}

/** Merge `events` INTO an escrow's cached chain, read and write inside ONE
 *  readwrite transaction.
 *
 *  Unlike `putCachedEvents` (whole-record replace) this can never truncate what
 *  is already stored, which is what the LIVE event path needs: the caller there
 *  holds only the state-chain raws (the hot cache is deliberately CHAT-free), so
 *  a replace would delete every cached chat message for the trade. Two
 *  properties make that impossible here:
 *
 *   1. **No read-then-write window.** A separate `getCachedEvents` +
 *      `putCachedEvents` pair can lose a concurrent write, and its empty result
 *      is ambiguous — `[]` means both "nothing cached" and "the bounded read
 *      timed out", so the caller cannot tell a fresh trade from a stalled disk.
 *      Sharing one transaction removes the question.
 *   2. **Existing raws win on an id collision** (`dedupEventsById` keeps the
 *      first occurrence, and stored events are passed first). A copy whose
 *      ciphertext was stripped for display can therefore never overwrite the
 *      good one already on disk.
 *
 *  Fire-and-forget from the caller; never throws. */
export async function appendCachedEvents(
  escrowId: string,
  events: readonly NostrEvent[],
  status: EscrowStatus,
): Promise<void> {
  if (events.length === 0) return;
  const db = await openDb();
  if (!db) {
    const prev = memoryFallback.get(escrowId);
    memoryFallback.set(escrowId, {
      escrowId,
      events: dedupEventsById([...(prev?.events ?? []), ...events]),
      terminal: isEvictableTerminal(status),
      updatedAt: Date.now(),
    });
    evictMemoryFallback();
    return;
  }
  await withTimeout((async () => {
    const tx = db.transaction(EVENT_CACHE_STORE, "readwrite");
    const store = tx.objectStore(EVENT_CACHE_STORE);
    // `reqToPromise` settles from the request's own success handler, so the
    // continuation runs as a microtask and the transaction stays alive. Do not
    // await anything else in here — a macrotask turn would auto-close it.
    const prev = (await reqToPromise(store.get(escrowId))) as CacheRecord | undefined;
    const record: CacheRecord = {
      escrowId,
      events: dedupEventsById([...(prev?.events ?? []), ...events]),
      terminal: isEvictableTerminal(status),
      updatedAt: Date.now(),
    };
    store.put(record);
    await txDone(tx);
  })(), TXN_TIMEOUT_MS, undefined);
  await maybeEvict(db);
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Evict oldest-terminal-first when over the escrow cap. Only scans when the
 *  count actually exceeds the cap (cheap keyed count otherwise). */
async function maybeEvict(db: IDBDatabase): Promise<void> {
  try {
    const countTx = db.transaction(EVENT_CACHE_STORE, "readonly");
    const store = countTx.objectStore(EVENT_CACHE_STORE);
    const count = await reqToPromise(store.count());
    if (count <= EVENT_CACHE_MAX_ESCROWS) return;

    // Scan metadata only (drop the heavy events array from each record).
    const scanTx = db.transaction(EVENT_CACHE_STORE, "readonly");
    const all = await reqToPromise(scanTx.objectStore(EVENT_CACHE_STORE).getAll());
    const metas = (all as CacheRecord[]).map((r) => ({
      escrowId: r.escrowId, terminal: r.terminal, updatedAt: r.updatedAt,
    }));
    const victims = selectEvictions(metas, EVENT_CACHE_MAX_ESCROWS);
    if (victims.length === 0) return;
    const delTx = db.transaction(EVENT_CACHE_STORE, "readwrite");
    const delStore = delTx.objectStore(EVENT_CACHE_STORE);
    for (const id of victims) delStore.delete(id);
    await txDone(delTx);
  } catch (e) {
    console.debug("[chama] event-cache: evict failed:", e);
  }
}

/** Wipe the whole event cache. Called on a local-wallet reset. */
export async function clearEventCache(): Promise<void> {
  memoryFallback.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(EVENT_CACHE_STORE, "readwrite");
    tx.objectStore(EVENT_CACHE_STORE).clear();
    await txDone(tx);
  } catch (e) {
    console.debug("[chama] event-cache: clear failed:", e);
  }
}
