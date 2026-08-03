// ══════════════════════════════════════════════════════════════════════════
// Chama — Durable local trade-history index (loss-proof "My Trades")
// ══════════════════════════════════════════════════════════════════════════
//
// WHY: the My Trades list is otherwise rebuilt every session from relay
// discovery + `loadEscrow` chain replay. A trade whose full chain can't be
// re-fetched — public-relay eviction, events predating the community relay,
// or a funding that never LOCKED (no chain at all) — silently drops off the
// list. So history quietly shrinks to "whatever the relays can still rebuild
// right now" (Jetty's "I only see 3").
//
// This durable, user-scoped index remembers a COMPACT record of every trade
// the user has been a party to, written from the same `updateEscrow`
// chokepoint that feeds the live list. The Me screen then always shows every
// trade — with its date + last-known status — even when no relay can rebuild
// the chain; tapping a row rehydrates the full chain from the community relay
// when it's available.
//
// Loss-proofing only goes FORWARD: this can't resurrect trades whose events
// were already gone before the index existed. It stops the bleed from here.

import {
  getScopedStorageItem,
  setScopedStorageItem,
  removeScopedStorageItem,
} from "../storage/user-scope.js";
import { type EscrowState, EscrowStatus, Role } from "./types.js";

/** Case-insensitive pubkey compare (hex npub). Local copy — `samePubkey` is a
 *  per-file helper across the codebase, not a shared export. */
function samePubkey(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Versioned, user-scoped localStorage key. */
export const TRADE_INDEX_KEY = "chama_trade_index_v1";

/** Bound growth — evict the oldest-touched entries past this. Generous: a
 *  real user won't approach it; a heavy tester eventually rolls the tail. */
export const TRADE_INDEX_MAX = 500;

export interface TradeIndexEntry {
  id: string;
  category: string;
  amountMsats: number;
  community: string | null;
  fiatCurrency?: string;
  /** The user's role in this trade. Never indexed when null (not a party). */
  role: Role;
  /** The other party (best-effort): counterpart to the user's role. */
  counterparty: string | null;
  description: string;
  /** The most-advanced status durably observed for this trade (never
   *  regressed by a stale partial replay — see statusRank). */
  lastStatus: EscrowStatus;
  /** Trade createdAt (Unix SECONDS) — for display + sort. */
  createdAt: number;
  /** When the index last touched this entry (Unix MS) — for eviction. */
  updatedAt: number;
}

type Index = Record<string, TradeIndexEntry>;

function load(): Index {
  try {
    const raw = getScopedStorageItem(TRADE_INDEX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Index;
  } catch (e) {
    console.warn("[chama] trade-index: load failed:", e);
    return {};
  }
}

function save(idx: Index): void {
  try {
    setScopedStorageItem(TRADE_INDEX_KEY, JSON.stringify(idx));
  } catch (e) {
    // Best-effort history. NEVER block a state update or a money path on it.
    console.warn("[chama] trade-index: save failed:", e);
  }
}

/** Forward progression so a stale/partial replay can't regress a remembered
 *  status. Terminal states outrank live ones and always win (a trade can go
 *  terminal from any earlier point — EXPIRED/CANCELLED from CREATED, etc.). */
function statusRank(s: EscrowStatus): number {
  switch (s) {
    case EscrowStatus.CREATED: return 0;
    case EscrowStatus.LOCKED: return 1;
    case EscrowStatus.APPROVED: return 2;
    case EscrowStatus.CLAIMED: return 3;
    case EscrowStatus.COMPLETED: return 4;
    case EscrowStatus.EXPIRED: return 4;
    case EscrowStatus.CANCELLED: return 4;
    default: return 0;
  }
}

/** The user's role in a trade, or null when they aren't a party (a browsed
 *  listing, someone else's trade). Only parties get indexed. */
export function userRoleInTrade(state: EscrowState, userPubkey: string | null): Role | null {
  if (!userPubkey) return null;
  const p = state.participants;
  if (samePubkey(p.buyer, userPubkey)) return Role.BUYER;
  if (samePubkey(p.seller, userPubkey)) return Role.SELLER;
  if (samePubkey(p.arbiter, userPubkey)) return Role.ARBITER;
  // The initiator is a party even before participants are fully populated
  // (e.g. an open listing the user created).
  if (samePubkey(state.initiator?.pubkey, userPubkey)) return state.initiator.role;
  return null;
}

/** Build the compact index record from a full EscrowState, or null when the
 *  user isn't a party. Pure — testable without storage. */
export function deriveTradeIndexEntry(
  state: EscrowState,
  userPubkey: string | null,
  nowMs: number,
): TradeIndexEntry | null {
  const role = userRoleInTrade(state, userPubkey);
  if (role === null) return null;
  const p = state.participants;
  const counterparty =
    role === Role.BUYER ? (p.seller ?? null)
    : role === Role.SELLER ? (p.buyer ?? null)
    : (p.buyer ?? p.seller ?? null);
  return {
    id: state.id,
    category: state.category,
    amountMsats: state.amountMsats,
    community: state.community ?? null,
    fiatCurrency: state.fiatCurrency,
    role,
    counterparty,
    description: state.description,
    lastStatus: state.status,
    createdAt: state.createdAt,
    updatedAt: nowMs,
  };
}

/** Upsert a trade into the durable index. No-op when the user isn't a party.
 *  Never regresses lastStatus (statusRank), preserves the original createdAt,
 *  and caps total size by evicting the oldest-touched entries. */
export function recordTradeToIndex(
  state: EscrowState,
  userPubkey: string | null,
  nowMs: number = Date.now(),
): void {
  const entry = deriveTradeIndexEntry(state, userPubkey, nowMs);
  if (!entry) return;
  const idx = load();
  const prev = idx[entry.id];
  if (prev) {
    // Keep the most-advanced status; never let a partial replay downgrade it.
    if (statusRank(prev.lastStatus) > statusRank(entry.lastStatus)) {
      entry.lastStatus = prev.lastStatus;
    }
    // Preserve the first-seen createdAt (a later replay may carry 0/stale).
    if (prev.createdAt > 0) entry.createdAt = prev.createdAt;
  }
  idx[entry.id] = entry;

  // Evict oldest-touched past the cap.
  const ids = Object.keys(idx);
  if (ids.length > TRADE_INDEX_MAX) {
    const byOldest = ids.sort((a, b) => idx[a].updatedAt - idx[b].updatedAt);
    for (const id of byOldest.slice(0, ids.length - TRADE_INDEX_MAX)) delete idx[id];
  }
  save(idx);
}

/** All remembered trades, newest-created first. */
export function listTradeIndex(): TradeIndexEntry[] {
  return Object.values(load()).sort((a, b) =>
    b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Index entries the live list ISN'T currently showing — the "archived"
 *  trades whose chain couldn't be rehydrated this session. Newest first. */
export function archivedTradeEntries(
  loadedIds: Iterable<string>,
): TradeIndexEntry[] {
  const loaded = new Set(loadedIds);
  return listTradeIndex().filter((e) => !loaded.has(e.id));
}

/** Drop one entry (e.g. when the user forgets a ghost trade). */
export function removeTradeFromIndex(escrowId: string): void {
  const idx = load();
  if (idx[escrowId]) {
    delete idx[escrowId];
    save(idx);
  }
}

/** Wipe the whole index. Tests + a future advanced-settings action only. */
export function clearTradeIndex(): void {
  try {
    removeScopedStorageItem(TRADE_INDEX_KEY);
  } catch (e) {
    console.warn("[chama] trade-index: clear failed:", e);
  }
}
