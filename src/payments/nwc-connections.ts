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
  getStrictScopedStorageItem,
  removeStrictScopedStorageItem,
  scopedStorageKey,
  setScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";
import { randomId } from "../storage/random-id.js";
import { parseNwcConnectionString } from "./nwc.js";

export const NWC_CONNECTIONS_STORAGE_KEY = "chama_nwc_connections";
export const NWC_CONNECTIONS_BACKUP_STORAGE_KEY = "chama_nwc_connections_backup";
/** Set (per identity, plain, not secret) once the saved list lives only in
 *  the encrypted store. Versions before 6.4.32 never write it. */
export const NWC_SEALED_ONLY_MARKER_KEY = "chama_nwc_connections_sealed_only";

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

function parseList(raw: string | null): SavedNwcConnection[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeConnections(parsed.filter(isSavedNwcConnection));
  } catch {
    return [];
  }
}

/** True when this identity's list is kept plainly (by any version: a deleted
 *  last wallet is kept as "[]"). */
function hasPlainList(): boolean {
  return getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY) !== null
    || getScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY) !== null;
}

function sealedOnly(): boolean {
  return !hasPlainList() && getStrictScopedStorageItem(NWC_SEALED_ONLY_MARKER_KEY) === "1";
}

function readRaw(): SavedNwcConnection[] {
  if (sealedOnly()) {
    const cached = sealedCache.get(getLocalStorageUserScope() ?? "");
    return Array.isArray(cached) ? cached : [];
  }
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
  if (sealedOnly()) {
    writeSealedOnly(normalized, opts);
    return;
  }
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
  mirrorSealed();
}

/** Plain copies, used when the encrypted store fails in sealed-only mode or
 *  when a release that keeps plain copies meets a sealed-only list. */
function writePlainList(list: SavedNwcConnection[]): void {
  const serialized = JSON.stringify(list);
  setScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY, serialized);
  setScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, serialized);
  removeStrictScopedStorageItem(NWC_SEALED_ONLY_MARKER_KEY);
}

function writeSealedOnly(list: SavedNwcConnection[], opts: { allowEmptyOverwrite?: boolean }): void {
  const scope = getLocalStorageUserScope();
  if (!scope) return;
  const cached = sealedCache.get(scope);
  if (cached === undefined || cached === "unreadable") {
    // The stored list hasn't been, or can't be, opened: archive it as it
    // is, then keep this change plainly, so nothing unread is replaced.
    const sealer = mirrorSealer;
    if (sealer) queueSealed(async () => { await sealer.archive(scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope)); });
    try { if (list.length > 0) writePlainList(list); } catch {}
    return;
  }
  if (list.length === 0 && !opts.allowEmptyOverwrite && (cached?.length ?? 0) > 0) {
    console.warn("[chama] Refusing to overwrite NWC connections with an empty list");
    return;
  }
  sealedCache.set(scope, list);
  const sealer = mirrorSealer;
  const write = async () => {
    try {
      if (!sealer) throw new Error("No encrypted store");
      await sealer.set(scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope), JSON.stringify(list));
    } catch (e) {
      // Never leave a change only in memory: keep it plainly instead.
      console.warn("[chama] saved wallets not written encrypted; kept plainly", e);
      if (getLocalStorageUserScope() === scope) { try { writePlainList(sealedCache.get(scope) as SavedNwcConnection[]); } catch {} }
    }
  };
  queueSealed(write);
}

// M9 (sealed-store.ts). 6.4.29 wrote an encrypted copy of every saved list
// and read only the plain one. 6.4.32 adds the reader:
//  - a plain list, when there is one, is the list, because every version up
//    to 6.4.32 writes it;
//  - with no plain list, the encrypted list is the list only when the
//    sealed-only marker says a release that removes plain copies put it there;
//  - an encrypted list that can't be opened is never replaced unread: it is
//    archived first, and a sealed-only list that can't be opened keeps new
//    changes plainly beside it.
// The encrypted copy follows the plain one; a failure to write it changes
// nothing, and a deletion here is deleted there too.
export interface NwcSealer {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /** Copy the stored record, unread, to an archive name (sealedArchive). */
  archive(name: string): Promise<string | null>;
}

/** M9 step 2's switch: remove the plain list once the encrypted one reads
 *  back. Off in 6.4.32 (the reader); turned on one release later. */
export let DROP_PLAIN_NWC = false;
/** Test hook for the switch. */
export function setDropPlainNwcForTests(on: boolean): void { DROP_PLAIN_NWC = on; }

let mirrorSealer: NwcSealer | null = null;
let sealedWrites: Promise<void> = Promise.resolve();
/** Per identity: the sealed-only list, or "unreadable" when it is stored but
 *  can't be opened (never read as an empty list). */
const sealedCache = new Map<string, SavedNwcConnection[] | "unreadable">();

function queueSealed(write: () => Promise<void>): void {
  // A store that never answers gives up its turn, so later changes still follow.
  const bounded = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    write().catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
  sealedWrites = sealedWrites.then(bounded, bounded);
}

function mirrorSealed(): void {
  const sealer = mirrorSealer;
  const scope = getLocalStorageUserScope();
  if (!sealer || !scope) return;
  queueSealed(async () => {
    // Copy the plain list as it is when this write runs, so a burst of
    // changes always ends with the latest one.
    if (getLocalStorageUserScope() !== scope) return;
    let raw: string | null = null;
    try { raw = getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY); } catch { return; }
    const name = scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope);
    try {
      let current: string | null = null;
      let unreadable = false;
      try { current = await sealer.get(name); } catch { unreadable = true; }
      // Archive what can't be read, and a list with wallets that no plain
      // list stands behind; the copy of a plain list just follows it.
      if (unreadable || (raw === null && parseList(current).length > 0)) await sealer.archive(name);
      await sealer.set(name, raw ?? "[]");
      if (DROP_PLAIN_NWC && raw !== null && getLocalStorageUserScope() === scope
        && getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY) === raw) {
        // Sealed and read back (sealedSet checks): the plain copies go.
        sealedCache.set(scope, parseList(raw));
        setStrictScopedStorageItem(NWC_SEALED_ONLY_MARKER_KEY, "1");
        removeStrictScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY);
        removeStrictScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY);
      }
    } catch (e) {
      console.warn("[chama] encrypted copy of saved wallets not written; plain copy kept", e);
    }
  });
}

/** Start keeping an encrypted copy of the signed-in user's saved NWC
 *  connections, and read the encrypted list when it is the only one. Call
 *  after the user scope is set. */
export async function hydrateSavedNwcConnections(sealer: NwcSealer): Promise<void> {
  mirrorSealer = sealer;
  const scope = getLocalStorageUserScope();
  if (!scope) return;
  if (sealedOnly()) {
    const name = scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope);
    let list: SavedNwcConnection[] | "unreadable";
    try { list = parseList(await sealer.get(name)); } catch { list = "unreadable"; }
    if (getLocalStorageUserScope() !== scope) return;
    sealedCache.set(scope, list);
    // A release that keeps plain copies writes this list back plainly, so
    // a version that reads only plain lists finds the wallets again.
    if (list !== "unreadable" && !DROP_PLAIN_NWC) { try { writePlainList(list); } catch {} }
    if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
    return;
  }
  mirrorSealed();
  await sealedWrites;
}

/** Wait for pending encrypted writes (tests). */
export async function flushSealedNwcWrites(): Promise<void> {
  let seen: Promise<void>;
  do { seen = sealedWrites; await seen; } while (seen !== sealedWrites);
}

/** Test hook. */
export function resetSealedNwcForTests(): void {
  mirrorSealer = null;
  sealedWrites = Promise.resolve();
  sealedCache.clear();
}

export function listSavedNwcConnections(): SavedNwcConnection[] {
  return readRaw().sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

export function deleteSavedNwcConnection(id: string): void {
  writeRaw(readRaw().filter(c => c.id !== id), { allowEmptyOverwrite: true });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}

export function addOrTouchSavedNwcConnection(connectionString: string): SavedNwcConnection {
  const normalized = normalizeConnectionString(connectionString);
  const parsed = parseNwcConnectionString(normalized);
  const key = connectionKey(normalized);
  const connections = readRaw();
  const nowSec = Math.floor(Date.now() / 1000);
  const idx = connections.findIndex(c => {
    try {
      return connectionKey(c.connectionString) === key;
    } catch {
      return false;
    }
  });
  if (idx !== -1) {
    const next: SavedNwcConnection = {
      ...connections[idx],
      connectionString: normalized,
      label: connections[idx].label || parsed.lud16 || labelForConnection(normalized),
      walletPubkey: parsed.walletPubkey,
      relayCount: parsed.relays.length,
      lastUsedAt: nowSec,
    };
    connections[idx] = next;
    writeRaw(connections);
    return next;
  }

  const entry: SavedNwcConnection = {
    id: generateId(),
    connectionString: normalized,
    label: labelForConnection(normalized),
    walletPubkey: parsed.walletPubkey,
    relayCount: parsed.relays.length,
    createdAt: nowSec,
    lastUsedAt: nowSec,
  };
  writeRaw([entry, ...connections]);
  return entry;
}

export function renameSavedNwcConnection(id: string, label: string): void {
  writeRaw(readRaw().map(connection => connection.id === id
    ? { ...connection, label: label.trim().slice(0, 64) || labelForConnection(connection.connectionString) } : connection));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}
/** Identify the connection without printing its bearer secret in a wallet row. */
export function displayNwcConnection(connection: SavedNwcConnection): string {
  return `nostr+walletconnect://${connection.walletPubkey.slice(0, 8)}…${connection.walletPubkey.slice(-8)}`;
}
