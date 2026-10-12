import { recordNativeFundingDiagnostic } from "../notifications/native-push.js";
import { scopedStorageKey } from "../storage/user-scope.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — Payout Destinations (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// Payout destinations are where the user sends sats after a claim or
// recovery. They are NOT counterparty payment handles and must never flow
// into listing/payment-handle reveal surfaces.
//
// Storage format (localStorage["chama_payout_destinations[:pubkey]"] is JSON):
//   [{ id, address, createdAt, lastUsedAt }, ...]

import {
  SAVED_HANDLES_STORAGE_KEY,
  SAVED_HANDLES_BACKUP_STORAGE_KEY,
  LIGHTNING_RAIL,
  type SavedHandle,
} from "./saved-handles.js";
import { randomId } from "../storage/random-id.js";
import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const PAYOUT_DESTINATIONS_STORAGE_KEY = "chama_payout_destinations";
export const PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY = "chama_payout_destinations_backup";

export interface PayoutDestination {
  id: string;
  /** Lightning Address or raw LNURL-pay code, normalized lowercase. */
  address: string;
  /** Optional device-local name; never a payment destination. */
  label?: string;
  /** Unix seconds — first saved. */
  createdAt: number;
  /** Unix seconds — last successful claim/recovery use. */
  lastUsedAt?: number;
}

function isPayoutDestination(x: any): x is PayoutDestination {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.address === "string" &&
    typeof x.createdAt === "number"
  );
}

function isLegacyLightningHandle(x: any): x is SavedHandle {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    x.rail === LIGHTNING_RAIL &&
    typeof x.handle === "string" &&
    typeof x.createdAt === "number"
  );
}

function generateId(): string {
  // SECURITY: payout-destination IDs are opaque storage keys; use
  // crypto randomness so they stay unguessable if ever exposed.
  return `pd_${Date.now().toString(36)}_${randomId(8)}`;
}

function normalizeDestination(destination: PayoutDestination): PayoutDestination {
  return {
    ...destination,
    address: normalizeAddress(destination.address),
    label: typeof destination.label === "string" ? destination.label.trim().slice(0, 64) || undefined : undefined,
  };
}

function dedupeDestinations(destinations: PayoutDestination[]): PayoutDestination[] {
  const seen = new Set<string>();
  const out: PayoutDestination[] = [];
  for (const destination of destinations) {
    const normalized = normalizeDestination(destination);
    const key = normalized.address.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

// Reads once per key/launch and every write, to diagnose the Pixel reproduction.
// Addresses, labels and credentials are deliberately absent.
const tracedStorage = new Set<string>();
function traceStorage(operation: string, baseKey: string): void {
  const key = scopedStorageKey(baseKey), trace = `${operation}:${key}`;
  if (!operation.includes("write") && tracedStorage.has(trace)) return;
  tracedStorage.add(trace);
  console.info("[chama/saved-wallets]", operation, key);
  void recordNativeFundingDiagnostic({ area: "saved-wallets", operation, key });
}

function readStored(key: string): PayoutDestination[] {
  try {
    traceStorage("read", key);
    const raw = getScopedStorageItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeDestinations(parsed.filter(isPayoutDestination));
  } catch {
    return [];
  }
}

function readRaw(): PayoutDestination[] {
  const primary = readStored(PAYOUT_DESTINATIONS_STORAGE_KEY);
  if (primary.length > 0) return primary;

  const backup = readStored(PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY);
  if (backup.length > 0) {
    writeRaw(backup, { allowEmptyOverwrite: true });
    return backup;
  }

  return [];
}

function writeRaw(
  destinations: PayoutDestination[],
  opts: { allowEmptyOverwrite?: boolean } = {},
): void {
  const normalized = dedupeDestinations(destinations);
  try {
    if (normalized.length === 0 && !opts.allowEmptyOverwrite) {
      const existing = readStored(PAYOUT_DESTINATIONS_STORAGE_KEY);
      const backup = readStored(PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY);
      if (existing.length > 0 || backup.length > 0) {
        console.warn("[chama] Refusing to overwrite payout destinations with an empty list");
        return;
      }
    }
    const serialized = JSON.stringify(normalized);
    traceStorage("write", PAYOUT_DESTINATIONS_STORAGE_KEY);
    setScopedStorageItem(PAYOUT_DESTINATIONS_STORAGE_KEY, serialized);
    traceStorage("write", PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY);
    setScopedStorageItem(PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY, serialized);
  } catch {
    // localStorage unavailable / quota exceeded — cosmetic persistence
    // failure. The payout itself has already happened.
  }
}

function normalizeAddress(address: string): string {
  return address.trim().replace(/^lightning:/i, "").toLowerCase();
}

/** Keep long LNURLs recognizable without exposing the full receive code. */
export function displayPayoutDestination(address: string): string {
  const value = normalizeAddress(address);
  return value.startsWith("lnurl1") && value.length > 16
    ? `${value.slice(0, 9)}…${value.slice(-3)}` : value;
}

/** One-time lazy migration from pre-v0.6.3 saved_handles rows where
 *  rail="lightning". After migration, the legacy rows are removed so
 *  trade-time handle reveal cannot accidentally offer a payout address. */
export function migrateLegacyLightningHandles(): number {
  try {
    traceStorage("legacy-read", SAVED_HANDLES_STORAGE_KEY);
    const raw = getScopedStorageItem(SAVED_HANDLES_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;

    const existing = readRaw();
    const seen = new Set(existing.map(d => d.address.toLowerCase()));
    const migrated: PayoutDestination[] = [];
    const keptHandles: unknown[] = [];

    for (const item of parsed) {
      if (!isLegacyLightningHandle(item)) {
        keptHandles.push(item);
        continue;
      }
      const address = normalizeAddress(item.handle);
      if (!address) continue;
      if (!seen.has(address)) {
        seen.add(address);
        migrated.push({
          id: `pd_${item.id}`,
          address,
          createdAt: item.createdAt,
          lastUsedAt: item.lastUsedAt ?? item.createdAt,
        });
      }
    }

    if (migrated.length === 0 && keptHandles.length === parsed.length) return 0;
    writeRaw([...migrated, ...existing]);
    const keptSerialized = JSON.stringify(keptHandles);
    traceStorage("legacy-write", SAVED_HANDLES_STORAGE_KEY);
    setScopedStorageItem(SAVED_HANDLES_STORAGE_KEY, keptSerialized);
    traceStorage("legacy-write", SAVED_HANDLES_BACKUP_STORAGE_KEY);
    setScopedStorageItem(SAVED_HANDLES_BACKUP_STORAGE_KEY, keptSerialized);
    return migrated.length;
  } catch {
    return 0;
  }
}

export function listPayoutDestinations(): PayoutDestination[] {
  migrateLegacyLightningHandles();
  return readRaw().sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

export function deletePayoutDestination(id: string): void {
  migrateLegacyLightningHandles();
  writeRaw(readRaw().filter(d => d.id !== id), { allowEmptyOverwrite: true });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}

/** Idempotent save/touch for a Lightning Address used as a payout
 *  destination. First use creates a row; later uses bump lastUsedAt. */
export function addOrTouchPayoutDestination(address: string): PayoutDestination {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    throw new Error("Payout destination cannot be empty");
  }

  migrateLegacyLightningHandles();
  const destinations = readRaw();
  const nowSec = Math.floor(Date.now() / 1000);
  const idx = destinations.findIndex(d => d.address.toLowerCase() === normalized);
  if (idx !== -1) {
    const next: PayoutDestination = { ...destinations[idx], lastUsedAt: nowSec };
    destinations[idx] = next;
    writeRaw(destinations);
    return next;
  }

  const entry: PayoutDestination = {
    id: generateId(),
    address: normalized,
    createdAt: nowSec,
    lastUsedAt: nowSec,
  };
  writeRaw([entry, ...destinations]);
  return entry;
}

export function renamePayoutDestination(id: string, label: string): void {
  migrateLegacyLightningHandles();
  writeRaw(readRaw().map(destination => destination.id === id
    ? { ...destination, label: label.trim().slice(0, 64) || undefined } : destination));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:saved-wallets"));
}
export function payoutDestinationLabel(destination: PayoutDestination): string {
  return destination.label || displayPayoutDestination(destination.address);
}
