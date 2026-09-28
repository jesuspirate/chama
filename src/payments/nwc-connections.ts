// ══════════════════════════════════════════════════════════════════════════
// Chama — Saved NWC Connections (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// NWC connection strings are local bearer credentials. They are never
// published to Nostr events or revealed to trade counterparties. Chama uses
// them only when the local user explicitly chooses NWC for payout/recovery
// invoice creation or funding auto-pay.

import {
  getScopedStorageItem,
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
