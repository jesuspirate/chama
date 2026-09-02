// ══════════════════════════════════════════════════════════════════════════
// Chama — bonded-pool cache (the CREATE-time bondedArbiters stamp hardening)
// ══════════════════════════════════════════════════════════════════════════
//
// CreateForm stamps the community's chain-verified bonded arbiters into the
// CREATE event (2B prefer-bonded + the E1 premium's bonded-only payable
// gate). That fetch is fail-soft by design, so a relay flap or esplora
// hiccup at publish time used to drop the stamp SILENTLY — the trade then
// never pays its arbiter a premium (the flaky-stamp revenue loss the
// 2026-07-13 relay scan surfaced: several unstamped CREATEs). This cache
// keeps the last successfully chain-verified bonded set per community so a
// bad network moment falls back to recent truth instead of nothing.
//
// Plain localStorage, NOT user-scoped: bonds are public chain data — the
// same for every npub on the device.
//
// Staleness tradeoff (deliberate): within the TTL a reclaimed/expired bond
// can still be stamped. The stamp is preference-only (the reducer accepts
// bonded-preferred OR the legacy pick — never a fork) and the premium is a
// few sats, so a bounded mis-payment beats silent zero-revenue. The TTL is
// 12h — half the 144-block (~1-day) minimum bond term.

import {
  DEFAULT_BOND_ROLES,
  type BondLineage,
  type BondRole,
  type VerifiedBond,
} from "../bond-multisig/bond-announcement.js";

export const BONDED_POOL_CACHE_KEY = "chama_bonded_pool_cache_v1";
export const BONDED_COUNT_SNAPSHOT_KEY = "chama_bonded_count_snapshot_v1";
export const BONDED_POOL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Bounded: communities a device actually creates in are few. */
export const BONDED_POOL_CACHE_MAX_COMMUNITIES = 50;

/** VerifiedBond with the bigint sats fields as decimal strings. */
interface SerializedBond {
  npub: string;
  community: string;
  address: string;
  lockUntil: number;
  actualSats: string;
  claimedSats: string;
  funded: boolean;
  active: boolean;
  // A0: these four were previously DROPPED on the round-trip, so a cache-served
  // bond lost its tenure start, its explorer link, and (once A0 landed) would
  // have lost its declared roles — silently re-conscripting a merchant into the
  // arbiter pool on any cache hit. All optional: an entry written before A0
  // deserializes with them absent, which every reader already tolerates.
  fundedAtHeight?: number;
  fundingTxid?: string;
  roles?: BondRole[];
  lineage?: BondLineage;
  tenureFromHeight?: number;
  lineageProven?: { provenHops: number; claimedHops: number };
  announcedAt?: number;
  ownerXonly?: string;
}

interface CacheEntry {
  verifiedAt: number; // ms
  bonds: SerializedBond[];
}

type CacheStore = Record<string, CacheEntry>;

function loadCache(): CacheStore {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(BONDED_POOL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as CacheStore;
  } catch {
    return {};
  }
}

function saveCache(store: CacheStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    const slugs = Object.keys(store);
    if (slugs.length > BONDED_POOL_CACHE_MAX_COMMUNITIES) {
      const byOldest = slugs.sort((a, b) => store[a].verifiedAt - store[b].verifiedAt);
      for (const slug of byOldest.slice(0, slugs.length - BONDED_POOL_CACHE_MAX_COMMUNITIES)) {
        delete store[slug];
      }
    }
    localStorage.setItem(BONDED_POOL_CACHE_KEY, JSON.stringify(store));
  } catch (e) {
    // Best-effort cache — never let it block a fetch (let alone a publish).
    console.warn("[chama] bonded-pool-cache: save failed:", e);
  }
}

function serializeBond(b: VerifiedBond): SerializedBond {
  return {
    npub: b.npub,
    community: b.community,
    address: b.address,
    lockUntil: b.lockUntil,
    actualSats: b.actualSats.toString(),
    claimedSats: b.claimedSats.toString(),
    funded: b.funded,
    active: b.active,
    ...(typeof b.fundedAtHeight === "number" ? { fundedAtHeight: b.fundedAtHeight } : {}),
    ...(b.fundingTxid ? { fundingTxid: b.fundingTxid } : {}),
    ...(b.roles && b.roles.length ? { roles: [...b.roles] } : {}),
    ...(b.lineage ? { lineage: { ...b.lineage } } : {}),
    // Caching the RESOLVED tenure is the point of caching at all here: the walk
    // costs on-chain reads, and a cache that dropped it would silently reset
    // every renewing arbiter's age on every cache hit — the exact bug A1 exists
    // to fix, reintroduced through the back door.
    ...(typeof b.tenureFromHeight === "number" ? { tenureFromHeight: b.tenureFromHeight } : {}),
    ...(b.lineageProven ? { lineageProven: { ...b.lineageProven } } : {}),
    ...(typeof b.announcedAt === "number" ? { announcedAt: b.announcedAt } : {}),
    ...(b.ownerXonly ? { ownerXonly: b.ownerXonly } : {}),
  };
}

function deserializeBond(s: SerializedBond): VerifiedBond | null {
  try {
    if (typeof s?.npub !== "string" || typeof s.community !== "string") return null;
    if (typeof s.address !== "string" || !Number.isFinite(s.lockUntil)) return null;
    return {
      npub: s.npub,
      community: s.community,
      address: s.address,
      lockUntil: s.lockUntil,
      actualSats: BigInt(s.actualSats),
      claimedSats: BigInt(s.claimedSats),
      funded: !!s.funded,
      active: !!s.active,
      // Absent (pre-A0 entry) ⇒ the arbiter default, matching how an
      // announcement without `roles` parses. Never infer `merchant` from
      // missing data: opting out of the pool must always be explicit.
      roles: Array.isArray(s.roles) && s.roles.length ? [...s.roles] : [...DEFAULT_BOND_ROLES],
      ...(typeof s.fundedAtHeight === "number" ? { fundedAtHeight: s.fundedAtHeight } : {}),
      ...(s.fundingTxid ? { fundingTxid: s.fundingTxid } : {}),
      ...(s.lineage ? { lineage: { ...s.lineage } } : {}),
      ...(typeof s.tenureFromHeight === "number" ? { tenureFromHeight: s.tenureFromHeight } : {}),
      ...(s.lineageProven ? { lineageProven: { ...s.lineageProven } } : {}),
      ...(typeof s.announcedAt === "number" ? { announcedAt: s.announcedAt } : {}),
      ...(s.ownerXonly ? { ownerXonly: s.ownerXonly } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Record a successful chain-verified fetch. An EMPTY result is never
 * written: empty is indistinguishable from a relay flap, and must not
 * clobber a known-good set (a genuinely de-bonded community simply ages
 * out at the TTL).
 */
export function writeCachedCommunityBonds(
  community: string,
  bonds: readonly VerifiedBond[],
  nowMs = Date.now(),
): void {
  if (!community || bonds.length === 0) return;
  const store = loadCache();
  store[community] = { verifiedAt: nowMs, bonds: bonds.map(serializeBond) };
  saveCache(store);
}

/**
 * The last chain-verified bonded set for `community`, or null when absent,
 * stale (past BONDED_POOL_CACHE_TTL_MS), or unreadable. Callers keep their
 * own funded/active filtering — the cache returns what was verified.
 */
export function readCachedCommunityBonds(
  community: string,
  nowMs = Date.now(),
): VerifiedBond[] | null {
  const entry = loadCache()[community];
  if (!entry || !Number.isFinite(entry.verifiedAt)) return null;
  if (nowMs - entry.verifiedAt > BONDED_POOL_CACHE_TTL_MS) return null;
  if (!Array.isArray(entry.bonds)) return null;
  const bonds: VerifiedBond[] = [];
  for (const s of entry.bonds) {
    const b = deserializeBond(s);
    if (!b) return null; // one bad record ⇒ distrust the whole entry
    bonds.push(b);
  }
  return bonds.length > 0 ? bonds : null;
}

/**
 * The worldwide picker count is a distinct cache entry, rather than an
 * inference from whichever individual communities happen to have been opened
 * on this device. That distinction prevents one partial detail-view cache hit
 * from masquerading as a complete country-list snapshot.
 */
export function writeCachedBondedArbiterCounts(
  counts: Readonly<Record<string, number>>,
  nowMs = Date.now(),
): void {
  const clean: Record<string, number> = {};
  for (const [community, raw] of Object.entries(counts)) {
    const count = Math.max(0, Math.floor(raw));
    if (community && Number.isFinite(count) && count > 0) clean[community] = count;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(BONDED_COUNT_SNAPSHOT_KEY, JSON.stringify({ verifiedAt: nowMs, counts: clean }));
    }
  } catch { /* best-effort public-data cache */ }
}

export function readCachedBondedArbiterCounts(
  nowMs = Date.now(),
): Record<string, number> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const parsed = JSON.parse(localStorage.getItem(BONDED_COUNT_SNAPSHOT_KEY) ?? "null") as {
      verifiedAt?: unknown;
      counts?: unknown;
    } | null;
    if (!parsed || typeof parsed.verifiedAt !== "number" || !Number.isFinite(parsed.verifiedAt)) return null;
    if (nowMs - parsed.verifiedAt > BONDED_POOL_CACHE_TTL_MS) return null;
    if (!parsed.counts || typeof parsed.counts !== "object") return null;
    const clean: Record<string, number> = {};
    for (const [community, raw] of Object.entries(parsed.counts as Record<string, unknown>)) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
      clean[community] = raw;
    }
    return Object.keys(clean).length > 0 ? clean : null;
  } catch {
    return null;
  }
}

/** Tests only. */
export function clearBondedPoolCache(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(BONDED_POOL_CACHE_KEY);
      localStorage.removeItem(BONDED_COUNT_SNAPSHOT_KEY);
    }
  } catch {
    /* best-effort */
  }
}
