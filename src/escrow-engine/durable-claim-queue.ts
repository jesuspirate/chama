// ══════════════════════════════════════════════════════════════════════════
// Chama — Durable CLAIM publication (v6.4 runway item 1)
// ══════════════════════════════════════════════════════════════════════════
//
// Field failures: the 30/100-sat zombie claims — CLAIM redeemed but never
// landed on a relay, so every fresh device re-summoned the corpse. 6.3.3
// shipped the transport half (zombie-socket cycling, the in-memory
// preferred-relay republish queue). This module is the missing DURABLE half:
// the signed CLAIM event is persisted BEFORE the first publish attempt and
// re-offered on boot and on a steady heartbeat until the PREFERRED relay
// explicitly accepts it. The in-memory queue caps at 24h and dies with the
// tab; a weekly-circle claim published from a phone that sleeps mid-publish
// needs to survive both. Weekly circles = weekly claims; the zombie factory
// scales with the flagship feature unless this holds.
//
// Storage: localStorage via the strict per-npub scope — the same deliberate
// trade-off as fedimint/pending-redemptions.ts (synchronous in the claim
// path, durable across crash/refresh/app-kill, entries ~1-2KB). Entries
// exist only while UN-acked: acceptance by the preferred relay removes them.
// A 30-day ceiling stops a claim for a dead relay from queueing forever —
// far beyond it, the RECOVERY story is trade-index rehydration, not this
// queue.

import type { NostrEvent } from "./types.js";
import {
  getStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";

export interface DurableClaimEntry {
  /** The SIGNED claim event, verbatim — resend must be byte-identical so
   *  relays dedupe by id and the chain never forks. */
  event: NostrEvent;
  escrowId: string;
  /** Unix seconds when first enqueued. */
  enqueuedAt: number;
}

export interface DurableClaimStore {
  get(): string | null;
  set(value: string): void;
}

export const DURABLE_CLAIMS_KEY = "chama_durable_claims_v1";
export const MAX_DURABLE_CLAIMS = 50;
export const DURABLE_CLAIM_MAX_AGE_SEC = 30 * 86_400;

/** Default binding: strict per-npub localStorage. Fails soft to a no-op
 *  store where storage is unavailable (SSR, tests, private-mode throw). */
export function defaultDurableClaimStore(): DurableClaimStore {
  return {
    get: () => {
      try { return getStrictScopedStorageItem(DURABLE_CLAIMS_KEY); } catch { return null; }
    },
    set: (value: string) => {
      try { setStrictScopedStorageItem(DURABLE_CLAIMS_KEY, value); } catch { /* fail soft */ }
    },
  };
}

/** Parse + age-filter. Malformed JSON degrades to an empty queue rather than
 *  a crash in the claim path. */
export function readDurableClaims(
  store: DurableClaimStore,
  nowSec: number = Math.floor(Date.now() / 1000),
): DurableClaimEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(store.get() ?? "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is DurableClaimEntry =>
    !!entry && typeof entry === "object"
    && typeof (entry as DurableClaimEntry).escrowId === "string"
    && typeof (entry as DurableClaimEntry).enqueuedAt === "number"
    && nowSec - (entry as DurableClaimEntry).enqueuedAt <= DURABLE_CLAIM_MAX_AGE_SEC
    && typeof (entry as DurableClaimEntry).event?.id === "string",
  );
}

function write(store: DurableClaimStore, entries: DurableClaimEntry[]): void {
  store.set(JSON.stringify(entries));
}

/** Persist a signed CLAIM before its first publish attempt. Idempotent per
 *  event id. The cap drops the OLDEST entry — by 50 pending claims the old
 *  ones are relay-dead anyway, and an unbounded queue is its own bug. */
export function enqueueDurableClaim(
  store: DurableClaimStore,
  event: NostrEvent,
  escrowId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const entries = readDurableClaims(store, nowSec);
  if (entries.some(entry => entry.event.id === event.id)) return;
  entries.push({ event, escrowId, enqueuedAt: nowSec });
  entries.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  write(store, entries.slice(Math.max(0, entries.length - MAX_DURABLE_CLAIMS)));
}

/** The preferred relay accepted this event: the claim is durably published
 *  and leaves the queue. */
export function ackDurableClaim(store: DurableClaimStore, eventId: string): void {
  const entries = readDurableClaims(store);
  const remaining = entries.filter(entry => entry.event.id !== eventId);
  if (remaining.length !== entries.length) write(store, remaining);
}
