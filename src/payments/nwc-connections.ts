// ══════════════════════════════════════════════════════════════════════════
// Chama — Saved NWC Connections (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// NWC connection strings are local bearer credentials. They are never
// published to Nostr events or revealed to trade counterparties. Chama uses
// them only when the local user explicitly chooses NWC for payout/recovery
// invoice creation or funding auto-pay.

import {
  getLocalStorageUserScope,
  getScopedStorageItem,
  scopedStorageKey,
  setScopedStorageItem,
} from "../storage/user-scope.js";
import { randomId } from "../storage/random-id.js";
import { parseNwcConnectionString } from "./nwc.js";

export const NWC_CONNECTIONS_STORAGE_KEY = "chama_nwc_connections";
export const NWC_CONNECTIONS_BACKUP_STORAGE_KEY = "chama_nwc_connections_backup";

export interface SavedNwcConnection {
  id: string;
  /** Full nostr+walletconnect:// URI. Stored locally only. */
  connectionString: string;
  /** Human-readable label derived from lud16 or wallet pubkey. */
  label: string;
  walletPubkey: string;
  relayCount: number;
  createdAt: number;
  lastUsedAt?: number;
}

function generateId(): string {
  // SECURITY: NWC connection records are local bearer credentials. The
  // ID itself is opaque, but cryptographic randomness ensures it stays
  // unguessable if a future code path surfaces it.
  return `nwc_${Date.now().toString(36)}_${randomId(8)}`;
}

function labelForConnection(connectionString: string): string {
  const parsed = parseNwcConnectionString(connectionString);
  return parsed.lud16 || `NWC ${parsed.walletPubkey.slice(0, 8)}`;
}

function normalizeConnectionString(connectionString: string): string {
  return connectionString.trim();
}

function isSavedNwcConnection(x: any): x is SavedNwcConnection {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.connectionString === "string" &&
    typeof x.label === "string" &&
    typeof x.walletPubkey === "string" &&
    typeof x.relayCount === "number" &&
    typeof x.createdAt === "number"
  );
}

function normalizeEntry(entry: SavedNwcConnection): SavedNwcConnection | null {
  try {
    const connectionString = normalizeConnectionString(entry.connectionString);
    const parsed = parseNwcConnectionString(connectionString);
    return {
      ...entry,
      connectionString,
      label: entry.label.trim().slice(0, 64) || labelForConnection(connectionString),
      walletPubkey: parsed.walletPubkey,
      relayCount: parsed.relays.length,
    };
  } catch {
    return null;
  }
}

function connectionKey(connectionString: string): string {
  const parsed = parseNwcConnectionString(connectionString);
  return `${parsed.walletPubkey}:${parsed.secret}`;
}

function dedupeConnections(connections: SavedNwcConnection[]): SavedNwcConnection[] {
  const seen = new Set<string>();
  const out: SavedNwcConnection[] = [];
  for (const connection of connections) {
    const normalized = normalizeEntry(connection);
    if (!normalized) continue;
    const key = connectionKey(normalized.connectionString);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function readStored(key: string): SavedNwcConnection[] {
  try {
    const raw = getScopedStorageItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeConnections(parsed.filter(isSavedNwcConnection));
  } catch {
    return [];
  }
}

/** The saved list: the sealed list once read, with any plain list beside it,
 *  less wallets removed here whose removal isn't sealed yet. */
function readRaw(): SavedNwcConnection[] {
  const scope = getLocalStorageUserScope();
  const k = keptFor(scope);
  if (!k || !scope) return readRawPlain();
  const plain = readStored(NWC_CONNECTIONS_STORAGE_KEY);
  return withoutRemoved(scope, [...(plain.length > 0 ? plain : readStored(NWC_CONNECTIONS_BACKUP_STORAGE_KEY)), ...k.list]);
}

function readRawPlain(): SavedNwcConnection[] {
  const primary = readStored(NWC_CONNECTIONS_STORAGE_KEY);
  if (primary.length > 0) return primary;

  const backup = readStored(NWC_CONNECTIONS_BACKUP_STORAGE_KEY);
  if (backup.length > 0) {
    writeRaw(backup, { allowEmptyOverwrite: true });
    return backup;
  }

  return [];
}

function writeRaw(
  connections: SavedNwcConnection[],
  opts: { allowEmptyOverwrite?: boolean } = {},
): void {
  const normalized = dedupeConnections(connections);
  try {
    if (normalized.length === 0 && !opts.allowEmptyOverwrite) {
      const existing = readStored(NWC_CONNECTIONS_STORAGE_KEY);
      const backup = readStored(NWC_CONNECTIONS_BACKUP_STORAGE_KEY);
      if (existing.length > 0 || backup.length > 0) {
        console.warn("[chama] Refusing to overwrite NWC connections with an empty list");
        return;
      }
    }
    const serialized = JSON.stringify(normalized);
    setScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY, serialized);
    setScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, serialized);
  } catch {
    // localStorage unavailable / quota exceeded. NWC can still be used once.
  }
}

// M9. Step 2 (6.4.32) was the reader; the last step (6.4.33) keeps the list
// sealed only, once this identity's list has been read (hydrate, at sign-in):
//  - a plain list (older version, or written before hydrate, or while the
//    store couldn't be read) is merged into the sealed list, and dropped only
//    once the merged list reads back and the plain one hasn't changed since.
//    When the sealed list already held it (nothing written by this pass) the
//    drop waits a moment and checks again: a 6.4.32 tab that just wrote the
//    plain list back is about to delete the sealed one. After any drop, a
//    later check writes the list back plainly if the sealed one has gone;
//  - every change is applied again, inside the queue, to the sealed list as
//    stored right then, so a change made in another tab is never written
//    over; other tabs are told to read it again, and keep changes of their
//    own that aren't stored yet;
//  - a wallet removed here is remembered (by its id, never its secret) until
//    the sealed list without it is stored, so a merge can't bring it back;
//  - while the sealed list can't be read, or doesn't parse, nothing is
//    written over it: the list stays plain, as before, and is merged later.
//    A rewrite that would drop an entry this version can't read archives
//    the stored list first;
//  - a sealed write that fails, or doesn't answer in time, keeps the change
//    plainly, never lost. Sealed work runs one at a time (across tabs, with
//    Web Locks where the browser has them) for as long as it really takes:
//    only the caller's wait is bounded, so a late write can't land after a
//    newer one;
//  - the copy 6.4.29-6.4.31 wrote is never written. A copy equal to the
//    plain list is deleted; any other is archived first, never deleted unread.
// 6.4.32 still reads the sealed list; 6.4.29-6.4.31 can't, and show no saved
// wallets (they are still here, under a name they never touch).
export interface NwcSealer {
  get(name: string): Promise<string | null>;
  /** Store, then read back; throws unless it reads back (sealedSet). */
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Copy the stored record, unread, to an archive name (sealedArchive). */
  archive(name: string): Promise<string | null>;
}

/** Where saved wallets are kept, sealed; a name 6.4.29-6.4.31 never touch. */
export const NWC_SEALED_STORAGE_KEY = "chama_nwc_connections_sealed_v2";
/** Ids of wallets removed here whose removal isn't sealed yet (plain; ids
 *  only, never a connection secret). */
export const NWC_REMOVED_STORAGE_KEY = "chama_nwc_removed";

type Change = (list: SavedNwcConnection[]) => SavedNwcConnection[];
/** The sealed list as last read or written, for the identity it belongs to,
 *  and this tab's changes not yet stored. Null until hydrate has read it:
 *  until then the plain list is used. */
let kept: { scope: string; sealer: NwcSealer; list: SavedNwcConnection[]; pending: Change[] } | null = null;
let sealedOps: Promise<void> = Promise.resolve();
/** Checks scheduled for later (tests wait for them too). */
const settling = new Set<Promise<void>>();
let settleDelayMs = 3_000;
let sealedWaitMs = 10_000;

/** Bound how long a caller waits; the operation itself runs on. */
function bounded<T>(run: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The encrypted store did not answer")), sealedWaitMs);
    run.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** One at a time in this tab and, where the browser offers it, across tabs,
 *  for as long as each really takes. */
function queueSealedNwc(op: () => Promise<void>): Promise<void> {
  const locks = (globalThis as { navigator?: { locks?: { request?: (name: string, cb: () => Promise<void>) => Promise<void> } } })
    .navigator?.locks;
  const run = () => typeof locks?.request === "function" ? locks.request("chama-sealed-nwc", op) : op();
  const next = sealedOps.then(run, run);
  sealedOps = next.catch(() => {});
  return bounded(next);
}

/** Run `op` in the queue after the settle delay. */
function later(op: () => Promise<void>): void {
  const done: Promise<void> = new Promise<void>((resolve) => {
    setTimeout(resolve, settleDelayMs);
  }).then(() => queueSealedNwc(op)).catch(() => {}).finally(() => { settling.delete(done); });
  settling.add(done);
}

function keptFor(scope: string | null): typeof kept {
  return scope && kept?.scope === scope ? kept : null;
}

function plainName(base: string, scope: string): string {
  return scopedStorageKey(base, scope);
}

function readRemoved(scope: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(plainName(NWC_REMOVED_STORAGE_KEY, scope)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeRemoved(scope: string, ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(plainName(NWC_REMOVED_STORAGE_KEY, scope));
    else localStorage.setItem(plainName(NWC_REMOVED_STORAGE_KEY, scope), JSON.stringify([...new Set(ids)]));
  } catch {}
}

function withoutRemoved(scope: string, list: SavedNwcConnection[]): SavedNwcConnection[] {
  const removed = new Set(readRemoved(scope));
  return dedupeConnections(list).filter(c => !removed.has(c.id));
}

/** This identity's plain list as stored right now (primary, else backup),
 *  and its exact stored text, so a later drop can check nothing changed. */
function plainSnapshot(scope: string): { list: SavedNwcConnection[]; text: string } {
  if (getLocalStorageUserScope() === scope) readRawPlain(); // legacy key moves under the scope
  let primary: string | null = null;
  let backup: string | null = null;
  try {
    primary = localStorage.getItem(plainName(NWC_CONNECTIONS_STORAGE_KEY, scope));
    backup = localStorage.getItem(plainName(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, scope));
  } catch {}
  const list = parsePlain(primary);
  return { list: list.length > 0 ? list : parsePlain(backup), text: `${primary}\u0000${backup}` };
}

function parsePlain(raw: string | null): SavedNwcConnection[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? dedupeConnections(parsed.filter(isSavedNwcConnection)) : [];
  } catch {
    return [];
  }
}

/** Drop the plain list, only if it is still exactly `text`. */
function dropPlain(scope: string, text: string): boolean {
  if (plainSnapshot(scope).text !== text) return false;
  try {
    localStorage.removeItem(plainName(NWC_CONNECTIONS_STORAGE_KEY, scope));
    localStorage.removeItem(plainName(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, scope));
  } catch { return false; }
  return true;
}

function writePlain(scope: string, list: SavedNwcConnection[]): void {
  try {
    const serialized = JSON.stringify(dedupeConnections(list));
    localStorage.setItem(plainName(NWC_CONNECTIONS_STORAGE_KEY, scope), serialized);
    localStorage.setItem(plainName(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, scope), serialized);
  } catch {}
}

type SealedRead = { list: SavedNwcConnection[]; raw: string | null; lossy: boolean };

/** Read the sealed list: "unreadable" when it can't be read or doesn't
 *  parse (left in place either way). `lossy`: it holds an entry this
 *  version can't read, which a rewrite would drop. */
async function readSealed(sealer: NwcSealer, scope: string): Promise<SealedRead | "unreadable"> {
  let raw: string | null;
  try { raw = await sealer.get(plainName(NWC_SEALED_STORAGE_KEY, scope)); } catch { return "unreadable"; }
  if (raw === null) return { list: [], raw, lossy: false };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return "unreadable"; }
  if (!Array.isArray(parsed)) return "unreadable";
  const list = dedupeConnections(parsed.filter(isSavedNwcConnection));
  const valid = parsed.filter(isSavedNwcConnection).filter(c => normalizeEntry(c) !== null).length;
  return { list, raw, lossy: valid < parsed.length };
}

/** Store `list` sealed for `scope`, then drop the plain list if it is
 *  unchanged since `plainText`. */
async function storeSealed(sealer: NwcSealer, scope: string, list: SavedNwcConnection[], read: SealedRead, plainText: string): Promise<void> {
  const name = plainName(NWC_SEALED_STORAGE_KEY, scope);
  const serialized = JSON.stringify(dedupeConnections(list));
  const wrote = serialized !== read.raw;
  if (wrote) {
    // Written over only as it was read; an entry this version can't read is
    // archived with the list first.
    if (await sealer.get(name) !== read.raw) throw new Error("Saved wallets changed while being written");
    if (read.lossy && !await sealer.archive(name)) throw new Error("Saved wallets not archived");
    await sealer.set(name, serialized);
  }
  if (await sealer.get(name) !== serialized) throw new Error("Saved wallets did not read back");
  if (wrote) {
    if (dropPlain(scope, plainText)) watchSealed(sealer, scope);
    return;
  }
  // This pass wrote nothing: a tab of 6.4.32 may have just written the list
  // back plainly and be about to delete the sealed copy. Drop later, after
  // checking again.
  if (plainSnapshot(scope).list.length === 0) return;
  later(async () => {
    if (await sealer.get(name) !== serialized) return;
    if (dropPlain(scope, plainText)) watchSealed(sealer, scope);
  });
}

/** After the plain list is dropped: if the sealed list is gone a moment
 *  later (another version deleted it), write the list back plainly. */
function watchSealed(sealer: NwcSealer, scope: string): void {
  later(async () => {
    const k = keptFor(scope);
    if (!k || k.sealer !== sealer || plainSnapshot(scope).list.length > 0) return;
    if (await sealer.get(plainName(NWC_SEALED_STORAGE_KEY, scope)) !== null) return;
    if (keptFor(scope) === k && k.list.length > 0) writePlain(scope, k.list);
  });
}

function announce(scope: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
  try { channel()?.postMessage({ scope }); } catch {}
}

let bc: BroadcastChannel | null | undefined;
function channel(): BroadcastChannel | null {
  if (bc !== undefined) return bc;
  bc = typeof BroadcastChannel === "function" ? new BroadcastChannel("chama-saved-wallets") : null;
  (bc as unknown as { unref?: () => void } | null)?.unref?.(); // never keeps a Node test alive
  if (bc) bc.onmessage = (event: MessageEvent) => refreshFromStore((event.data as { scope?: unknown } | null)?.scope);
  return bc;
}

/** Another tab changed this identity's list: read it again, keeping this
 *  tab's own changes that aren't stored yet. */
function refreshFromStore(scope: unknown): void {
  const k = kept;
  if (!k || typeof scope !== "string" || scope !== k.scope) return;
  void queueSealedNwc(async () => {
    const read = await readSealed(k.sealer, k.scope);
    if (read === "unreadable" || kept !== k) return;
    k.list = withoutRemoved(k.scope, k.pending.reduce((list, change) => change(list),
      dedupeConnections([...plainSnapshot(k.scope).list, ...read.list])));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
  }).catch(() => {});
}

/** Apply `change` to the saved list, and keep the result: sealed when this
 *  identity's sealed list has been read, plainly otherwise. */
function commit(change: Change, opts: { allowEmptyOverwrite?: boolean } = {}): void {
  const scope = getLocalStorageUserScope();
  const k = keptFor(scope);
  if (!k || !scope) {
    writeRaw(change(readRaw()), opts);
    return;
  }
  k.list = withoutRemoved(scope, change(readRaw()));
  k.pending.push(change);
  const forget = () => { const i = k.pending.indexOf(change); if (i !== -1) k.pending.splice(i, 1); };
  void queueSealedNwc(async () => {
    // Applied again to the list as stored right now, so nothing another tab
    // wrote meanwhile is written over.
    const read = await readSealed(k.sealer, k.scope);
    if (read === "unreadable") throw new Error("Saved wallets can't be read right now");
    const plain = plainSnapshot(k.scope);
    const removed = readRemoved(k.scope);
    const next = withoutRemoved(k.scope, change(dedupeConnections([...plain.list, ...read.list])));
    await storeSealed(k.sealer, k.scope, next, read, plain.text);
    // Removals now stored are no longer remembered.
    writeRemoved(k.scope, readRemoved(k.scope).filter(id => !removed.includes(id)));
    forget();
    if (kept === k) k.list = withoutRemoved(k.scope, k.pending.reduce((list, c) => c(list), next));
    announce(k.scope);
  }).catch((e) => {
    // Never lost: this change is kept plainly, and merged into the sealed
    // list next time.
    console.warn("[chama] saved wallets: encrypted store not written in time; kept plainly", e);
    forget();
    if (kept === k && getLocalStorageUserScope() === k.scope) {
      writeRaw(withoutRemoved(k.scope, change(dedupeConnections([...readRawPlain(), ...k.list]))), { allowEmptyOverwrite: true });
    }
  });
}

/** At sign-in: read this identity's sealed list, merge any plain list into
 *  it, and keep it sealed from then on. Clears the old encrypted copy. Call
 *  after the user scope is set. */
export async function hydrateSavedNwcConnections(sealer: NwcSealer): Promise<void> {
  const scope = getLocalStorageUserScope();
  if (!scope) return;
  if (kept && kept.scope !== scope) kept = null;
  channel();
  const run = async () => {
    if (getLocalStorageUserScope() !== scope) return;
    const read = await readSealed(sealer, scope);
    if (read === "unreadable") {
      console.warn("[chama] saved wallets kept encrypted can't be opened right now; left in place, plain list used");
    } else if (getLocalStorageUserScope() === scope) {
      const plain = plainSnapshot(scope);
      const removed = readRemoved(scope);
      const merged = withoutRemoved(scope, [...plain.list, ...read.list]);
      if (plain.list.length > 0 || JSON.stringify(merged) !== read.raw) {
        await storeSealed(sealer, scope, merged, read, plain.text);
        writeRemoved(scope, readRemoved(scope).filter(id => !removed.includes(id)));
      }
      if (getLocalStorageUserScope() === scope) {
        kept = { scope, sealer, list: merged, pending: [] };
        if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
      }
    }
    // The old copy (6.4.29-6.4.31) is never read again.
    const oldName = scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope);
    let old: string | null = null;
    let unreadable = false;
    try { old = await sealer.get(oldName); } catch { unreadable = true; }
    if (!unreadable && old === null) return;
    const keptNow = keptFor(scope);
    const now = keptNow ? JSON.stringify(keptNow.list) : getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY);
    if (unreadable || old !== now) await sealer.archive(oldName);
    await sealer.delete(oldName);
  };
  await queueSealedNwc(run).catch((e) => console.warn("[chama] saved wallets: encrypted store not read; plain list kept", e));
}

/** Wait for pending encrypted reads, writes and later checks (tests). */
export async function flushSealedNwcWrites(): Promise<void> {
  for (;;) {
    const seen = sealedOps;
    await seen;
    if (settling.size > 0) { await Promise.all([...settling]); continue; }
    if (seen === sealedOps) return;
  }
}

/** Test hooks. */
export function resetSealedNwcForTests(): void {
  sealedOps = Promise.resolve();
  settling.clear();
  kept = null;
}
export function setSealedSettleDelayForTests(ms: number): void {
  settleDelayMs = ms;
}
export function setSealedWaitForTests(ms: number): void {
  sealedWaitMs = ms;
}
/** Another tab announced a change (tests; BroadcastChannel in a browser). */
export function refreshSavedNwcForTests(scope: string): void {
  refreshFromStore(scope);
}

export function listSavedNwcConnections(): SavedNwcConnection[] {
  return readRaw().sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

export function deleteSavedNwcConnection(id: string): void {
  const scope = getLocalStorageUserScope();
  if (keptFor(scope) && scope) writeRemoved(scope, [...readRemoved(scope), id]);
  commit(list => list.filter(c => c.id !== id), { allowEmptyOverwrite: true });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}

export function addOrTouchSavedNwcConnection(connectionString: string): SavedNwcConnection {
  const normalized = normalizeConnectionString(connectionString);
  const parsed = parseNwcConnectionString(normalized);
  const key = connectionKey(normalized);
  const nowSec = Math.floor(Date.now() / 1000);
  const entry: SavedNwcConnection = {
    id: generateId(),
    connectionString: normalized,
    label: labelForConnection(normalized),
    walletPubkey: parsed.walletPubkey,
    relayCount: parsed.relays.length,
    createdAt: nowSec,
    lastUsedAt: nowSec,
  };
  // The same change applies to whichever list is current when it is kept.
  const upsert = (connections: SavedNwcConnection[]): SavedNwcConnection[] => {
    const idx = connections.findIndex(c => {
      try {
        return connectionKey(c.connectionString) === key;
      } catch {
        return false;
      }
    });
    if (idx === -1) return [entry, ...connections];
    const next = [...connections];
    next[idx] = {
      ...connections[idx],
      connectionString: normalized,
      label: connections[idx].label || parsed.lud16 || labelForConnection(normalized),
      walletPubkey: parsed.walletPubkey,
      relayCount: parsed.relays.length,
      lastUsedAt: nowSec,
    };
    return next;
  };
  const saved = upsert(readRaw()).find(c => {
    try { return connectionKey(c.connectionString) === key; } catch { return false; }
  })!;
  commit(upsert);
  return saved;
}

export function renameSavedNwcConnection(id: string, label: string): void {
  commit(list => list.map(connection => connection.id === id
    ? { ...connection, label: label.trim().slice(0, 64) || labelForConnection(connection.connectionString) } : connection));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}
/** Identify the connection without printing its bearer secret in a wallet row. */
export function displayNwcConnection(connection: SavedNwcConnection): string {
  return `nostr+walletconnect://${connection.walletPubkey.slice(0, 8)}…${connection.walletPubkey.slice(-8)}`;
}
