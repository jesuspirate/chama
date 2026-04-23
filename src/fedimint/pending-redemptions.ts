// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending Redemption Stash
// ══════════════════════════════════════════════════════════════════════════
//
// Protects against the class of money-loss bug documented in the
// sm_moadjfkb_9ue9pd5p incident (v0.1.67 and earlier):
//
//   1. User clicks Claim on a won escrow.
//   2. Bridge reconstructs oobNotes from SSS shares.
//   3. Bridge publishes CLAIM to Nostr → chain advances to COMPLETED.
//   4. Bridge calls fedimint.redeemWithRetry(oobNotes).
//   5. App closes (crash, refresh, background kill) between (3) and (4)
//      completing.
//
// In that narrow window, oobNotes exists only on the JavaScript stack.
// The chain says the winner claimed, but the bearer token is gone —
// no way to redeem the sats.
//
// This module stashes oobNotes to localStorage *after* CLAIM publishes
// and *before* redeem attempts. A boot-time drain (fired from
// useEscrow.initFedimint) retries any stashed entries until the
// federation either accepts them or reports a terminal error.
//
// ── Storage strategy ──────────────────────────────────────────────────────
//
// We use localStorage (not IndexedDB) for consistency with the existing
// getSavedEscrowIds() pattern in useEscrow.ts. This is a deliberate
// trade-off for v0.1.68:
//
//   Pros:
//     - Synchronous API, no awaits in critical claim path
//     - Matches existing code conventions, no new dependency
//     - localStorage is durable across crashes / refreshes / app-kills
//     - Well under the ~5MB localStorage quota for realistic queue sizes
//       (each entry is ~1-2KB; quota supports thousands of pending claims)
//
//   Cons:
//     - Synchronous access can block main thread on large writes;
//       not a concern until the queue gets pathologically large
//     - Per-origin quota is shared with other localStorage keys
//
// If the queue ever grows beyond trivial size, migrate to IndexedDB with
// an idb wrapper. The public API of this module is designed so the
// migration is a drop-in replacement — callers don't need to change.
//
// ── Reset semantics ───────────────────────────────────────────────────────
//
// The stash is deliberately NOT cleared by resetLocalWallet(). Ecash is
// a bearer token — a wallet reset should never discard unredeemed notes
// that the federation will still honor. If we ever add an advanced-
// settings "forget pending redemptions" option, it should be an
// explicit user action with a delayed-execution safety window, not a
// side-effect of wallet reset.

import type { FedimintClient } from "./fedimint-client.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so we can migrate the payload shape later. */
export const PENDING_REDEMPTIONS_KEY = "chama_pending_redemptions_v1";

/**
 * After this many failed drain attempts we stop retrying automatically.
 * The entry stays in the stash with `lastError` set so it's visible for
 * forensics / manual recovery. Does NOT apply to hard-failures, which
 * are poisoned on the very first attempt.
 */
export const MAX_DRAIN_ATTEMPTS = 12;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PendingRedemption {
  /** Escrow ID this redemption belongs to (stash key) */
  escrowId: string;
  /** The OOB ecash notes string, reconstructed from SSS shares */
  oobNotes: string;
  /** Hash the notes must match (from LOCK event on the chain) */
  notesHash: string;
  /** Amount these notes represent, in msats. Used for "unsettled claims" UI. */
  amountMsats: number;
  /** When the entry was first stashed (Unix ms) */
  createdAt: number;
  /** Number of drain attempts (including the inline one in claimAndRedeem) */
  attempts: number;
  /** Last error message, if drain has failed. Presence = entry is poisoned. */
  lastError?: string;
  /** When the entry was first poisoned (Unix ms) */
  poisonedAt?: number;
}

export interface DrainSummary {
  attempted: number;
  succeeded: number;
  stillPending: number;
  poisoned: number;
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Stash = Record<string, PendingRedemption>;

function loadStash(): Stash {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(PENDING_REDEMPTIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Stash;
  } catch (e) {
    console.warn("[chama] pending-redemptions: loadStash failed:", e);
    return {};
  }
}

function saveStash(stash: Stash): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PENDING_REDEMPTIONS_KEY, JSON.stringify(stash));
  } catch (e) {
    // QuotaExceededError is the main concern here. We surface it loudly
    // because failing to persist oobNotes defeats the whole point of
    // this module.
    console.error(
      "[chama] pending-redemptions: saveStash failed — stash may be lost:",
      e
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Stash an oobNotes bearer token to localStorage. Called by the bridge
 * AFTER publishing CLAIM and BEFORE calling redeemWithRetry.
 *
 * Idempotent: re-stashing the same escrowId updates the entry but does
 * not bump attempts (attempts is incremented only by drain).
 */
export function stashPendingRedemption(input: {
  escrowId: string;
  oobNotes: string;
  notesHash: string;
  amountMsats: number;
}): void {
  const stash = loadStash();
  const existing = stash[input.escrowId];
  stash[input.escrowId] = {
    escrowId: input.escrowId,
    oobNotes: input.oobNotes,
    notesHash: input.notesHash,
    amountMsats: input.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: existing?.attempts ?? 0,
    // Preserve poisoned state across re-stashes (shouldn't happen in
    // practice, but defensive)
    lastError: existing?.lastError,
    poisonedAt: existing?.poisonedAt,
  };
  saveStash(stash);
}

/**
 * Remove an entry from the stash. Called after redeemWithRetry
 * resolves successfully (or returns via the "already spent" branch,
 * which redeemWithRetry internally treats as success).
 */
export function clearPendingRedemption(escrowId: string): void {
  const stash = loadStash();
  if (stash[escrowId]) {
    delete stash[escrowId];
    saveStash(stash);
  }
}

/** Snapshot of all current entries. For UI / debug / tests. */
export function listPendingRedemptions(): PendingRedemption[] {
  return Object.values(loadStash());
}

/**
 * Mark an entry as poisoned (permanent failure). The entry stays in
 * the stash for forensics but will be skipped by future drain calls.
 *
 * Called by drainPendingRedemptions() when it hits a hard-failure
 * error from redeemWithRetry (malformed notes, invalid federation,
 * not joined, parse error). These conditions can't be healed by
 * retrying, so we stop trying and preserve context for debugging.
 */
export function markPoisoned(escrowId: string, reason: string): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry) return;
  entry.lastError = reason.slice(0, 500);
  entry.poisonedAt = entry.poisonedAt ?? Date.now();
  saveStash(stash);
}

/**
 * Attempt to redeem every stashed entry that isn't poisoned and hasn't
 * exceeded MAX_DRAIN_ATTEMPTS. Returns a summary for logging / UI.
 *
 * Fire-and-forget from useEscrow.initFedimint. Does NOT block the UI —
 * balance updates arrive via the FedimintClient's onBalanceUpdate
 * callback (already wired in useEscrow).
 *
 * ── Federation mismatch is expected to poison, not crash ──────────────────
 * If the user has switched federations since stashing, redeemWithRetry
 * will throw "not joined" or similar. That's the correct outcome — the
 * notes are bound to the federation they were minted in. We poison the
 * entry (not retry forever) and move on. The user's current wallet is
 * unaffected, and the oobNotes remains stashed for manual recovery if
 * they rejoin the original federation.
 */
export async function drainPendingRedemptions(
  fedimint: FedimintClient
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    attempted: 0,
    succeeded: 0,
    stillPending: 0,
    poisoned: 0,
  };

  const stash = loadStash();
  const entries = Object.values(stash);

  for (const entry of entries) {
    // Skip poisoned entries — they've been diagnosed as unrecoverable.
    if (entry.lastError && entry.poisonedAt) {
      summary.poisoned++;
      continue;
    }

    // Skip entries that have burned through too many drain attempts.
    // They'll sit in the stash with attempts >= MAX_DRAIN_ATTEMPTS until
    // manually recovered or explicitly poisoned.
    if (entry.attempts >= MAX_DRAIN_ATTEMPTS) {
      summary.stillPending++;
      continue;
    }

    summary.attempted++;

    // Bump attempts BEFORE the try — we want to count attempts that
    // crash the browser too, not just ones that return cleanly.
    entry.attempts += 1;
    saveStash({ ...loadStash(), [entry.escrowId]: entry });

    try {
      await fedimint.redeemWithRetry(entry.oobNotes);
      // Success — or "already spent" which redeemWithRetry treats as
      // success. Either way the federation has the notes and balance
      // will reflect shortly. Remove from stash.
      clearPendingRedemption(entry.escrowId);
      summary.succeeded++;
      console.info(
        `[chama] drained pending redemption for ${entry.escrowId} ` +
        `(${entry.amountMsats / 1000} sats)`
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();

      // Match the same hard-failure taxonomy as redeemWithRetry itself.
      // If redeemWithRetry already threw past its 3 internal retries on
      // one of these strings, retrying across boots won't help — poison.
      const isHardFailure =
        msg.includes("malformed") ||
        msg.includes("invalid federation") ||
        msg.includes("not joined") ||
        msg.includes("parse error") ||
        msg.includes("invalid note format");

      if (isHardFailure) {
        markPoisoned(
          entry.escrowId,
          e instanceof Error ? e.message : String(e)
        );
        summary.poisoned++;
        console.error(
          `[chama] pending redemption for ${entry.escrowId} poisoned ` +
          `(hard failure): ${msg}`
        );
      } else {
        // Transient — leave the entry in the stash for the next drain.
        summary.stillPending++;
        console.warn(
          `[chama] pending redemption for ${entry.escrowId} still ` +
          `pending after attempt ${entry.attempts}: ${msg}`
        );
      }
    }
  }

  if (summary.attempted > 0) {
    console.info("[chama] pending-redemption drain:", summary);
  }

  return summary;
}

// ── Debug helper (not called in production paths) ──────────────────────────

/**
 * Clear the entire stash. Useful for tests and for a future
 * advanced-settings "forget all pending redemptions" action.
 *
 * NOT called from resetLocalWallet — see file header for rationale.
 */
export function clearAllPendingRedemptions(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(PENDING_REDEMPTIONS_KEY);
  } catch (e) {
    console.warn("[chama] pending-redemptions: clearAll failed:", e);
  }
}
