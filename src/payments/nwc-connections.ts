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

function readRaw(): SavedNwcConnection[] {
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

// M9, step 2 (6.4.32): the reader. The plain list is still the one kept and
// written, so 6.4.29-6.4.31 still see the wallets if they run again here.
// What this release adds, once per sign-in:
//  - with no plain list, a list kept sealed under the new name (by the
//    release that stops writing plain lists) is the list: it is written back
//    plainly and, once that reads back, the sealed copy is removed. One that
//    can't be opened stays where it is;
//  - the copy 6.4.29-6.4.31 wrote is no longer written. A copy equal to the
//    plain list is deleted; any other is archived first, never deleted unread.
export interface NwcSealer {
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
  /** Copy the stored record, unread, to an archive name (sealedArchive). */
  archive(name: string): Promise<string | null>;
}

/** Where a release that stops keeping plain lists keeps them, sealed; a name
 *  6.4.29-6.4.31 never touch. */
export const NWC_SEALED_STORAGE_KEY = "chama_nwc_connections_sealed_v2";

let sealedReads: Promise<void> = Promise.resolve();

function bounded(op: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The encrypted store did not answer")), 10_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Read this identity's sealed list when there is no plain one, and clear
 *  the old encrypted copy. Call after the user scope is set. */
export async function hydrateSavedNwcConnections(sealer: NwcSealer): Promise<void> {
  const scope = getLocalStorageUserScope();
  if (!scope) return;
  const run = async () => {
    if (getLocalStorageUserScope() !== scope) return;
    const plain = getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY);
    const sealedName = scopedStorageKey(NWC_SEALED_STORAGE_KEY, scope);
    if (plain === null && getScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY) === null) {
      let sealed: string | null = null;
      try { sealed = await sealer.get(sealedName); } catch (e) {
        console.warn("[chama] saved wallets kept encrypted can't be opened right now; left in place", e);
      }
      const list = sealed === null ? [] : parseKeptList(sealed);
      if (list && list.length > 0 && getLocalStorageUserScope() === scope) {
        const serialized = JSON.stringify(dedupeConnections(list));
        setScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY, serialized);
        setScopedStorageItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY, serialized);
        if (getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY) === serialized && await sealer.get(sealedName) === sealed) {
          await sealer.delete(sealedName);
        }
        if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
      }
    }
    // The old copy (6.4.29-6.4.31) is never read again.
    const oldName = scopedStorageKey(NWC_CONNECTIONS_STORAGE_KEY, scope);
    let old: string | null = null;
    let unreadable = false;
    try { old = await sealer.get(oldName); } catch { unreadable = true; }
    if (!unreadable && old === null) return;
    const now = getScopedStorageItem(NWC_CONNECTIONS_STORAGE_KEY);
    if (unreadable || old !== now) await sealer.archive(oldName);
    await sealer.delete(oldName);
  };
  const next = sealedReads.then(() => bounded(run), () => bounded(run));
  sealedReads = next.catch((e) => console.warn("[chama] saved wallets: encrypted store not read", e));
  await sealedReads;
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

/** Wait for pending encrypted reads (tests). */
export function flushSealedNwcWrites(): Promise<void> {
  return sealedReads;
}

/** Test hook. */
export function resetSealedNwcForTests(): void {
  sealedReads = Promise.resolve();
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
