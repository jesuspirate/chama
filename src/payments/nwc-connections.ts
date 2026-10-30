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

/** The saved list: the sealed list once read, with any plain list beside it. */
function readRaw(): SavedNwcConnection[] {
  const k = keptFor(getLocalStorageUserScope());
  if (!k) return readRawPlain();
  const plain = readStored(NWC_CONNECTIONS_STORAGE_KEY);
  return dedupeConnections([...(plain.length > 0 ? plain : readStored(NWC_CONNECTIONS_BACKUP_STORAGE_KEY)), ...k.list]);
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
//    once the merged list reads back and the plain one hasn't changed since;
//  - every change is applied again, inside the queue, to the sealed list as
//    stored right then, so a change made in another tab is never written
//    over; other tabs are told to read it again;
//  - while the sealed list can't be read, or doesn't parse, nothing is
//    written over it: the list stays plain, as before, and is merged later;
//  - a sealed write that fails falls back to the plain list, never lost;
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

/** The sealed list as last read or written, for the identity it belongs to.
 *  Null until hydrate has read it: until then the plain list is used. */
let kept: { scope: string; sealer: NwcSealer; list: SavedNwcConnection[] } | null = null;
let sealedOps: Promise<void> = Promise.resolve();

function bounded(op: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The encrypted store did not answer")), 10_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** One at a time in this tab and, where the browser offers it, across tabs. */
function queueSealedNwc(op: () => Promise<void>): Promise<void> {
  const locks = (globalThis as { navigator?: { locks?: { request?: (name: string, cb: () => Promise<void>) => Promise<void> } } })
    .navigator?.locks;
  const run = () => typeof locks?.request === "function" ? locks.request("chama-sealed-nwc", () => bounded(op)) : bounded(op);
  const next = sealedOps.then(run, run);
  sealedOps = next.catch(() => {});
  return next;
}

function keptFor(scope: string | null): typeof kept {
  return scope && kept?.scope === scope ? kept : null;
}

function plainName(base: string, scope: string): string {
  return scopedStorageKey(base, scope);
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
function dropPlain(scope: string, text: string): void {
  if (plainSnapshot(scope).text !== text) return;
  try {
    localStorage.removeItem(plainName(NWC_CONNECTIONS_STORAGE_KEY, scope));
    localStorage.removeItem(plainName(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, scope));
  } catch {}
}

/** Read the sealed list: null when none, "unreadable" when it can't be read
 *  or doesn't parse (left in place either way). */
async function readSealed(sealer: NwcSealer, scope: string): Promise<{ list: SavedNwcConnection[]; raw: string | null } | "unreadable"> {
  let raw: string | null;
  try { raw = await sealer.get(plainName(NWC_SEALED_STORAGE_KEY, scope)); } catch { return "unreadable"; }
  if (raw === null) return { list: [], raw };
  const list = parseKeptList(raw);
  return list ? { list: dedupeConnections(list), raw } : "unreadable";
}

/** Write `list` sealed for `scope` (read back), then drop the plain list if
 *  it is unchanged since `plainText`. */
async function storeSealed(sealer: NwcSealer, scope: string, list: SavedNwcConnection[], prevRaw: string | null, plainText: string): Promise<void> {
  const name = plainName(NWC_SEALED_STORAGE_KEY, scope);
  const serialized = JSON.stringify(dedupeConnections(list));
  if (serialized !== prevRaw) await sealer.set(name, serialized);
  if (await sealer.get(name) !== serialized) throw new Error("Saved wallets did not read back");
  dropPlain(scope, plainText);
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
  if (bc) bc.onmessage = (event: MessageEvent) => {
    const scope = (event.data as { scope?: unknown } | null)?.scope;
    const k = kept;
    if (!k || typeof scope !== "string" || scope !== k.scope) return;
    // Another tab changed this identity's list: read it again.
    void queueSealedNwc(async () => {
      const read = await readSealed(k.sealer, k.scope);
      if (read === "unreadable" || kept !== k) return;
      k.list = dedupeConnections([...plainSnapshot(k.scope).list, ...read.list]);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
    }).catch(() => {});
  };
  return bc;
}

/** Apply `change` to the saved list, and keep the result: sealed when this
 *  identity's sealed list has been read, plainly otherwise. */
function commit(change: (list: SavedNwcConnection[]) => SavedNwcConnection[], opts: { allowEmptyOverwrite?: boolean } = {}): void {
  const scope = getLocalStorageUserScope();
  const k = keptFor(scope);
  if (!k || !scope) {
    writeRaw(change(readRaw()), opts);
    return;
  }
  k.list = dedupeConnections(change(readRaw()));
  void queueSealedNwc(async () => {
    // Applied again to the list as stored right now, so nothing another tab
    // wrote meanwhile is written over.
    const read = await readSealed(k.sealer, k.scope);
    if (read === "unreadable") throw new Error("Saved wallets can't be read right now");
    const plain = plainSnapshot(k.scope);
    const next = dedupeConnections(change(dedupeConnections([...plain.list, ...read.list])));
    await storeSealed(k.sealer, k.scope, next, read.raw, plain.text);
    if (kept === k) k.list = next;
    announce(k.scope);
  }).catch((e) => {
    // Never lost: kept plainly, and merged into the sealed list next time.
    console.warn("[chama] saved wallets: encrypted store not written; kept plainly", e);
    if (kept === k && getLocalStorageUserScope() === k.scope) writeRaw(dedupeConnections([...readRawPlain(), ...k.list]), { allowEmptyOverwrite: true });
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
      const merged = dedupeConnections([...plain.list, ...read.list]);
      if (plain.list.length > 0 || JSON.stringify(merged) !== read.raw) {
        await storeSealed(sealer, scope, merged, read.raw, plain.text);
      }
      if (getLocalStorageUserScope() === scope) {
        kept = { scope, sealer, list: merged };
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

/** A kept sealed list, or null when it doesn't parse (left in place). */
function parseKeptList(raw: string): SavedNwcConnection[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedNwcConnection) : null;
  } catch {
    return null;
  }
}

/** Wait for pending encrypted reads and writes (tests). */
export async function flushSealedNwcWrites(): Promise<void> {
  let seen: Promise<void>;
  do { seen = sealedOps; await seen; } while (seen !== sealedOps);
}

/** Test hook. */
export function resetSealedNwcForTests(): void {
  sealedOps = Promise.resolve();
  kept = null;
}

export function listSavedNwcConnections(): SavedNwcConnection[] {
  return readRaw().sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

export function deleteSavedNwcConnection(id: string): void {
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
