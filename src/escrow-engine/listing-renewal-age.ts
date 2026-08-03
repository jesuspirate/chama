// ══════════════════════════════════════════════════════════════════════════
// Chama — Auto-renew age-out (#82): stop keeping ABANDONED listings alive
// ══════════════════════════════════════════════════════════════════════════
//
// Store-permanence auto-renew (listing-renewal.ts + the App effect) keeps a
// bonded seller's UNFUNDED listings alive by re-publishing a fresh CREATE each
// time they lapse. The dedupe ledger (listing-renewal-ledger.ts) stopped the
// DUPLICATION, but auto-renew still kept EVERY distinct unfunded offer alive
// FOREVER while the seller was online — so a bonded seller accumulated a wall
// of stale/abandoned/test listings (a real 'v0.1.30' test offer kept alive).
//
// This module is the age-out: a device-local per-OFFER auto-renewal counter,
// keyed by the offer's LINEAGE (listingIdentityKey — stable across renewals, so
// re-publishing a fresh CREATE doesn't reset the count). After the offer has
// been AUTO-renewed MAX_AUTO_RENEW_CYCLES times with no buyer interest, the
// auto-renew effect stops renewing it and it lapses naturally (~a week at the
// 24h cycle). A MANUAL renew (the user deliberately tapping Renew) marks the
// lineage "manually kept" — clearing the count AND exempting it from the cap —
// so a store the seller still wants stays alive.
//
// Pure logic + tiny localStorage helpers; no relays / money / reducer touch.
// Only meaningful for the LOCAL user's OWN listings, so it never changes what
// other users see. Storage degrades to a no-op when localStorage is unavailable.

import type { EscrowState } from "./types.js";
import { listingIdentityKey } from "./listing-renewal-ledger.js";
import { Role } from "./types.js";

const AGE_KEY = "chama_listing_autorenew_age_v1";
/** Bounded — evict the oldest-touched entries when exceeded. */
const MAX_AGE_ENTRIES = 1000;

/** How many times an offer is auto-renewed before it ages out. ≈ one week at
 *  the 24h cycle: after 7 no-interest auto-renews the offer lapses naturally. A
 *  manual renew resets/exempts it. */
export const MAX_AUTO_RENEW_CYCLES = 7;

interface AgeRecord {
  /** How many times this lineage has been AUTO-renewed. */
  count: number;
  /** True once the seller MANUALLY renewed — exempts it from the cap. */
  manuallyKept?: boolean;
  /** Last touch (for eviction ordering). */
  updatedAt: number;
}

type AgeStore = Record<string, AgeRecord>;

/** Read the whole store. Fail-soft to {}. */
function readStore(): AgeStore {
  try {
    const raw = localStorage.getItem(AGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AgeStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as AgeRecord).count === "number") {
        const r = v as AgeRecord;
        out[k] = {
          count: r.count,
          ...(r.manuallyKept ? { manuallyKept: true } : {}),
          updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: AgeStore): void {
  try {
    // Evict oldest-touched beyond the cap.
    const keys = Object.keys(store);
    if (keys.length > MAX_AGE_ENTRIES) {
      const sorted = keys.sort((a, b) => (store[a].updatedAt ?? 0) - (store[b].updatedAt ?? 0));
      for (const k of sorted.slice(0, keys.length - MAX_AGE_ENTRIES)) delete store[k];
    }
    localStorage.setItem(AGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
}

/** How many times this lineage has been AUTO-renewed on this device. */
export function getAutoRenewCount(key: string): number {
  return readStore()[key]?.count ?? 0;
}

/** True once the seller manually renewed this lineage (cap-exempt). */
export function isManuallyKept(key: string): boolean {
  return readStore()[key]?.manuallyKept === true;
}

/** Record one AUTO-renew of a lineage (increments the counter). */
export function bumpAutoRenewCount(key: string): void {
  if (!key) return;
  const store = readStore();
  const prev = store[key];
  store[key] = {
    count: (prev?.count ?? 0) + 1,
    ...(prev?.manuallyKept ? { manuallyKept: true } : {}),
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/** Mark a lineage MANUALLY KEPT — resets its auto-renew count to 0 and exempts
 *  it from the age-out cap, so a store the seller deliberately renews stays
 *  alive. Idempotent. */
export function markManuallyKept(key: string): void {
  if (!key) return;
  const store = readStore();
  store[key] = { count: 0, manuallyKept: true, updatedAt: Date.now() };
  writeStore(store);
}

/** Pure age-out predicate: an offer has aged out once it's been auto-renewed at
 *  or beyond the cap AND was never manually kept. */
export function hasAgedOut(
  count: number,
  manuallyKept: boolean,
  /** A2: the lane's own cap. Defaults to the Stores-era value, so every
   *  existing caller is byte-identical. A 30-day lane renewing a 24h listing
   *  needs ~30 cycles; capping it at 7 would have quietly killed every Work
   *  offer after a week — the age-out backstop turning into a time bomb. */
  cap: number = MAX_AUTO_RENEW_CYCLES,
): boolean {
  return !manuallyKept && count >= cap;
}

/** True when a listing shows any BUYER INTEREST — a JOIN/hold ever landed on it.
 *  A hold means a real buyer engaged, so the offer is an active store and must
 *  never age out. joinHolds persists the reservation record even after a hold
 *  lapses, so this captures historical interest, not just a live hold. */
export function listingHasBuyerInterest(state: EscrowState): boolean {
  const holds = state.joinHolds;
  if (!holds) return false;
  return Boolean(holds[Role.BUYER] || Object.keys(holds).length > 0);
}

/** Should the auto-renew effect SKIP this listing on age-out grounds? Skips a
 *  no-interest lineage that has hit the cap (and wasn't manually kept). An offer
 *  with buyer interest is never skipped. Pure — the effect reads the counter +
 *  interest and passes them in. */
export function shouldAgeOutListing(opts: {
  autoRenewCount: number;
  manuallyKept: boolean;
  hasBuyerInterest: boolean;
  /** A2: the renewal lane's cycle cap (RenewalPolicy.maxAutoRenewCycles). */
  cap?: number;
}): boolean {
  if (opts.hasBuyerInterest) return false;
  return hasAgedOut(opts.autoRenewCount, opts.manuallyKept, opts.cap);
}
