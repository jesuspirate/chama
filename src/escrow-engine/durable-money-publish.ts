import type { NostrEvent } from "./types.js";
import {
  getStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";

export type MoneyEventType = "lock" | "premium";
export type CustodyDurability = "acknowledged" | "pending" | "expired-unacked";

export interface DurableMoneyPublishEntry {
  event: NostrEvent;
  escrowId: string;
  type: MoneyEventType;
  spentAt: number;
  liveUntil: number;
  status: Exclude<CustodyDurability, "acknowledged">;
  lastError?: string;
  rejectionMessages?: string[];
  amountMsats?: number;
  operationId?: string;
}

export interface DurableMoneyPublishStore {
  get(): string | null;
  set(value: string): void;
}

export interface DurableMoneyDiagnostic {
  eventId: string;
  escrowId: string;
  type: MoneyEventType;
  message: string;
  recordedAt: number;
}

export const DURABLE_MONEY_PUBLISH_KEY = "chama_durable_money_publish_v1";
export const DURABLE_MONEY_DIAGNOSTIC_KEY = "chama_durable_money_diagnostics_v1";

export function isMoneyBearingEvent(event: Pick<NostrEvent, "kind" | "content">): boolean {
  if (event.kind !== 38102 && event.kind !== 38113) return false;
  try {
    const payload = JSON.parse(event.content) as { type?: unknown; shares?: unknown; noteEnvelope?: unknown };
    if (event.kind === 38102) {
      return payload.type === "escrow:lock" && Array.isArray(payload.shares) && payload.shares.length > 0;
    }
    return payload.type === "escrow:premium" && !!payload.noteEnvelope;
  } catch {
    return false;
  }
}

export function defaultDurableMoneyPublishStore(): DurableMoneyPublishStore {
  return {
    get: () => getStrictScopedStorageItem(DURABLE_MONEY_PUBLISH_KEY),
    set: (value: string) => setStrictScopedStorageItem(DURABLE_MONEY_PUBLISH_KEY, value),
  };
}

export function defaultDurableMoneyDiagnosticStore(): DurableMoneyPublishStore {
  return {
    get: () => getStrictScopedStorageItem(DURABLE_MONEY_DIAGNOSTIC_KEY),
    set: (value: string) => setStrictScopedStorageItem(DURABLE_MONEY_DIAGNOSTIC_KEY, value),
  };
}

function validDiagnostic(value: unknown): value is DurableMoneyDiagnostic {
  const diagnostic = value as DurableMoneyDiagnostic;
  return !!diagnostic
    && typeof diagnostic === "object"
    && typeof diagnostic.eventId === "string"
    && typeof diagnostic.escrowId === "string"
    && (diagnostic.type === "lock" || diagnostic.type === "premium")
    && typeof diagnostic.message === "string"
    && Number.isFinite(diagnostic.recordedAt);
}

export function readDurableMoneyDiagnostics(
  store: DurableMoneyPublishStore,
): DurableMoneyDiagnostic[] {
  const raw = store.get();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The money-publish diagnostic journal is corrupt.");
  }
  if (!Array.isArray(parsed) || !parsed.every(validDiagnostic)) {
    throw new Error("The money-publish diagnostic journal is invalid.");
  }
  return parsed;
}

export function recordDurableMoneyDiagnostic(
  store: DurableMoneyPublishStore,
  input: Omit<DurableMoneyDiagnostic, "recordedAt"> & { recordedAt?: number },
): DurableMoneyDiagnostic {
  const diagnostics = readDurableMoneyDiagnostics(store);
  const existing = diagnostics.find(candidate => candidate.eventId === input.eventId);
  if (existing) return existing;
  const diagnostic: DurableMoneyDiagnostic = {
    ...input,
    recordedAt: input.recordedAt ?? Date.now(),
  };
  diagnostics.push(diagnostic);
  store.set(JSON.stringify(diagnostics));
  const persisted = readDurableMoneyDiagnostics(store).find(candidate => candidate.eventId === input.eventId);
  if (!persisted) throw new Error("Money-publish rejection diagnostics could not be persisted.");
  return persisted;
}

export function moneyDiagnosticForEscrow(
  store: DurableMoneyPublishStore,
  escrowId: string,
): DurableMoneyDiagnostic | null {
  const matches = readDurableMoneyDiagnostics(store).filter(entry => entry.escrowId === escrowId);
  matches.sort((a, b) => b.recordedAt - a.recordedAt);
  return matches[0] ?? null;
}

function validEntry(value: unknown): value is DurableMoneyPublishEntry {
  const entry = value as DurableMoneyPublishEntry;
  return !!entry
    && typeof entry === "object"
    && typeof entry.event?.id === "string"
    && typeof entry.escrowId === "string"
    && (entry.type === "lock" || entry.type === "premium")
    && Number.isFinite(entry.spentAt)
    && Number.isFinite(entry.liveUntil)
    && entry.liveUntil > entry.spentAt
    && (entry.status === "pending" || entry.status === "expired-unacked");
}

export function readDurableMoneyPublishes(
  store: DurableMoneyPublishStore,
): DurableMoneyPublishEntry[] {
  const raw = store.get();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The durable money-publish journal is corrupt; refusing to publish money unsafely.");
  }
  if (!Array.isArray(parsed) || !parsed.every(validEntry)) {
    throw new Error("The durable money-publish journal is invalid; refusing to publish money unsafely.");
  }
  return parsed;
}

function writeAndVerify(
  store: DurableMoneyPublishStore,
  entries: DurableMoneyPublishEntry[],
  expectedPresentEventId?: string,
  expectedAbsentEventId?: string,
): void {
  store.set(JSON.stringify(entries));
  const persisted = readDurableMoneyPublishes(store);
  if (expectedPresentEventId && !persisted.some(entry => entry.event.id === expectedPresentEventId)) {
    throw new Error("Durable money-publish storage refused the signed event; no relay publish was attempted.");
  }
  if (expectedAbsentEventId && persisted.some(entry => entry.event.id === expectedAbsentEventId)) {
    throw new Error("Durable money-publish storage refused to retire an acknowledged event.");
  }
}

export function enqueueDurableMoneyPublish(
  store: DurableMoneyPublishStore,
  entry: Omit<DurableMoneyPublishEntry, "status">,
): DurableMoneyPublishEntry {
  const entries = readDurableMoneyPublishes(store);
  const existing = entries.find(candidate => candidate.event.id === entry.event.id);
  if (existing) return existing;
  const next: DurableMoneyPublishEntry = { ...entry, status: "pending" };
  entries.push(next);
  writeAndVerify(store, entries, entry.event.id);
  return next;
}

export function acknowledgeDurableMoneyPublish(
  store: DurableMoneyPublishStore,
  eventId: string,
): DurableMoneyPublishEntry | null {
  const entries = readDurableMoneyPublishes(store);
  const acknowledged = entries.find(entry => entry.event.id === eventId) ?? null;
  if (!acknowledged || acknowledged.status !== "pending") return null;
  writeAndVerify(store, entries.filter(entry => entry.event.id !== eventId), undefined, eventId);
  return acknowledged;
}

export function resolveDurableMoneyPublishesForEscrow(
  store: DurableMoneyPublishStore,
  escrowId: string,
  type: MoneyEventType,
): DurableMoneyPublishEntry[] {
  const entries = readDurableMoneyPublishes(store);
  const resolved = entries.filter(entry => entry.escrowId === escrowId && entry.type === type);
  if (resolved.length === 0) return [];
  writeAndVerify(
    store,
    entries.filter(entry => entry.escrowId !== escrowId || entry.type !== type),
  );
  const persisted = readDurableMoneyPublishes(store);
  if (persisted.some(entry => entry.escrowId === escrowId && entry.type === type)) {
    throw new Error("Durable money-publish storage refused to retire a resolved custody entry.");
  }
  return resolved;
}

export function recordDurableMoneyPublishFailure(
  store: DurableMoneyPublishStore,
  eventId: string,
  message: string,
): DurableMoneyPublishEntry | null {
  const entries = readDurableMoneyPublishes(store);
  const entry = entries.find(candidate => candidate.event.id === eventId);
  if (!entry) return null;
  const clean = message.trim();
  entry.lastError = clean || entry.lastError;
  if (clean) {
    entry.rejectionMessages = [...new Set([...(entry.rejectionMessages ?? []), clean])];
  }
  writeAndVerify(store, entries, eventId);
  return entry;
}

export function quarantineExpiredMoneyPublishes(
  store: DurableMoneyPublishStore,
  nowSec: number = Math.floor(Date.now() / 1000),
): DurableMoneyPublishEntry[] {
  const entries = readDurableMoneyPublishes(store);
  const newlyQuarantined: DurableMoneyPublishEntry[] = [];
  for (const entry of entries) {
    if (entry.status === "pending" && nowSec >= entry.liveUntil) {
      entry.status = "expired-unacked";
      entry.lastError = "The bearer notes reached their refund horizon before any relay acknowledged this event.";
      newlyQuarantined.push(entry);
    }
  }
  if (newlyQuarantined.length > 0) writeAndVerify(store, entries);
  return newlyQuarantined;
}

export function publishableMoneyEntries(
  store: DurableMoneyPublishStore,
  nowSec: number = Math.floor(Date.now() / 1000),
): DurableMoneyPublishEntry[] {
  quarantineExpiredMoneyPublishes(store, nowSec);
  return readDurableMoneyPublishes(store).filter(
    entry => entry.status === "pending" && nowSec < entry.liveUntil,
  );
}

export function moneyEntryForEscrow(
  store: DurableMoneyPublishStore,
  escrowId: string,
  type?: MoneyEventType,
): DurableMoneyPublishEntry | null {
  const matches = readDurableMoneyPublishes(store).filter(
    entry => entry.escrowId === escrowId && (!type || entry.type === type),
  );
  matches.sort((a, b) => b.spentAt - a.spentAt);
  return matches[0] ?? null;
}

export function formatCustodyDiagnostic(entry: DurableMoneyPublishEntry): string {
  if (entry.status === "expired-unacked") {
    return "No relay acknowledged this money event before its refund horizon. Chama stopped rebroadcasting it to avoid publishing dead notes; keep this device and wallet available for recovery.";
  }
  const detail = entry.rejectionMessages?.[0] || entry.lastError;
  return detail
    ? `Your money event is saved on this device and will retry while its notes remain live. Relay response: ${detail}`
    : "Your money event is saved on this device but no relay has acknowledged it yet. Chama will retry automatically.";
}
