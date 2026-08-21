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
import {
  getStrictScopedStorageItem,
  removeStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so we can migrate the payload shape later. */
export const PENDING_REDEMPTIONS_KEY = "chama_pending_redemptions_v1";

/** Legacy FundWalletModal used the claim-recovery queue as durable storage for
 * an OUTGOING bearer note. That note must remain spendable by its recipient;
 * the boot drain must never redeem it back into Chama. New exports use
 * payments/ecash-exports.ts, but keep this guard for already-stored entries. */
export const LEGACY_MANUAL_ECASH_EXPORT_ID = "manual-fund-ecash";

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
  /** The mint reissue completed into this Chama wallet, but the claimant's
   *  requested outbound payout (ecash/LN/onchain) has not necessarily
   *  completed yet. Keep the entry as a reservation until that payout is
   *  explicitly confirmed; the bearer string is spent evidence, not a
   *  recovery note. */
  creditedAt?: number;
  /** Last error message, if drain has failed. Presence = entry is poisoned. */
  lastError?: string;
  /** When the entry was first poisoned (Unix ms) */
  poisonedAt?: number;
  /** C5 (v3.4.0): the federation reported these notes "already spent"
   *  but no credit to this wallet could be confirmed. Possible front-run
   *  — or a credit that landed in an earlier session. Either way the
   *  user must look (C13 surface); retrying can't resolve it. */
  unresolvedCredit?: boolean;
  /** v4.0.0: an unresolved-credit entry that has been RECONCILED — either
   *  the wallet balance was found to cover the amount (the credit plausibly
   *  landed) or the user explicitly acknowledged it. The bearer string is
   *  kept (archive, not delete: forensics + recovery path) but it drops out
   *  of the alarm list. Only ever set on `unresolvedCredit` entries — a
   *  poisoned / retries-exhausted note may still be LIVE money and must
   *  never be silently archived. */
  resolvedAt?: number;
  resolution?: "balance-reconciled" | "user-dismissed";
}

export interface DrainSummary {
  attempted: number;
  succeeded: number;
  stillPending: number;
  poisoned: number;
  /** C5: entries marked unresolved-credit this drain (already spent,
   *  no confirmed wallet credit). Subset semantics like `poisoned`:
   *  they're skipped by future drains and surfaced to the user. */
  unresolved: number;
}

/** A stash entry that automatic retry can no longer help — the C13
 *  "stranded bearer notes" surface renders exactly this list. */
export interface StrandedRedemption extends PendingRedemption {
  stranded: "unresolved-credit" | "poisoned" | "retries-exhausted";
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Stash = Record<string, PendingRedemption>;

/** Terminal reissue failures mean the federation consumed the bearer note but
 * local wallet credit could not be proven. The note is no longer exportable,
 * so this is an unresolved-credit case—not a poisoned/live-note case. */
function isConsumedCreditUnconfirmed(entry: Pick<PendingRedemption, "lastError">): boolean {
  const msg = entry.lastError?.toLowerCase() ?? "";
  return msg.includes("mint reissue operation failed after federation consumed")
    || msg.includes("mint notes were consumed by the federation");
}

function loadStash(): Stash {
  try {
    const raw = getStrictScopedStorageItem(PENDING_REDEMPTIONS_KEY);
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
    setStrictScopedStorageItem(PENDING_REDEMPTIONS_KEY, JSON.stringify(stash));
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
    creditedAt: existing?.creditedAt,
    // Preserve poisoned/unresolved state across re-stashes — a manual
    // claim retry after ALREADY_SPENT_UNCONFIRMED re-stashes the same
    // escrowId, and dropping unresolvedCredit here would silently
    // reclassify the entry as plain-poisoned (wrong C13 card copy).
    lastError: existing?.lastError,
    poisonedAt: existing?.poisonedAt,
    unresolvedCredit: existing?.unresolvedCredit,
  };
  saveStash(stash);
  console.info(
    `[claim-trace] pending-stash escrowId=${input.escrowId} ` +
    `amountMsats=${input.amountMsats} notesHashPrefix=${input.notesHash.slice(0, 16)}`,
  );
}

/**
 * Remove an entry from the stash. Called only after the caller has a
 * successful redeem/balance-confirmed path.
 */
export function clearPendingRedemption(escrowId: string): void {
  const stash = loadStash();
  if (stash[escrowId]) {
    delete stash[escrowId];
    saveStash(stash);
    console.info(`[claim-trace] pending-clear escrowId=${escrowId}`);
  }
}

/** Mark a stashed redemption as credited without releasing the claimant's
 * reservation. Clearing belongs to the confirmed outbound-payout boundary. */
export function markPendingRedemptionCredited(
  escrowId: string,
  nowMs = Date.now(),
): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry) return;
  entry.creditedAt = entry.creditedAt ?? nowMs;
  delete entry.lastError;
  delete entry.poisonedAt;
  delete entry.unresolvedCredit;
  saveStash(stash);
  console.info(`[claim-trace] pending-credited escrowId=${escrowId}`);
}

/** Snapshot of all current entries. For UI / debug / tests. */
export function listPendingRedemptions(): PendingRedemption[] {
  return Object.values(loadStash());
}

/** Remove every recovery record for an exact bearer note. This is only for
 * the explicit "I imported this export" boundary: amount is deliberately not
 * accepted as identity because two independent notes may have the same value. */
export function clearPendingRedemptionsMatchingNotes(oobNotes: string): string[] {
  if (!oobNotes) return [];
  const stash = loadStash();
  const cleared: string[] = [];
  for (const [escrowId, entry] of Object.entries(stash)) {
    if (entry.oobNotes !== oobNotes) continue;
    delete stash[escrowId];
    cleared.push(escrowId);
  }
  if (cleared.length > 0) {
    saveStash(stash);
    console.info(`[claim-trace] pending-clear matching export ids=${cleared.join(",")}`);
  }
  return cleared;
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
 * C5 (v3.4.0): mark an entry as "already spent, credit unconfirmed".
 * Shares poison semantics (skipped by future drains — retrying an
 * already-spent note can never change the outcome) but is flagged
 * separately so the C13 surface can explain it honestly: the balance
 * may already include these sats, or they were claimed elsewhere.
 * Surface, don't assume — in either direction.
 */
export function markUnresolvedCredit(escrowId: string, reason: string): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry) return;
  entry.lastError = reason.slice(0, 500);
  entry.poisonedAt = entry.poisonedAt ?? Date.now();
  entry.unresolvedCredit = true;
  saveStash(stash);
}

/**
 * v4.0.0: archive an unresolved-credit entry out of the alarm list — the
 * note string is KEPT (forensics + recovery), it just stops crying wolf.
 * Two resolutions: "balance-reconciled" (the wallet balance covers the
 * amount, so the credit plausibly landed) or "user-dismissed" (the user
 * acknowledged a balance-short / claimed-elsewhere entry).
 *
 * GUARDRAIL: only ever archives an entry that is actually `unresolvedCredit`.
 * A poisoned / retries-exhausted note may still be LIVE money, so this can
 * never be used to silence one — they keep their loud surface.
 */
export function resolveUnresolvedCredit(
  escrowId: string,
  resolution: "balance-reconciled" | "user-dismissed",
): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry || (!entry.unresolvedCredit && !isConsumedCreditUnconfirmed(entry))) return;
  entry.unresolvedCredit = true;
  entry.resolvedAt = entry.resolvedAt ?? Date.now();
  entry.resolution = resolution;
  saveStash(stash);
  console.info(`[claim-trace] unresolved-credit reconciled escrowId=${escrowId} via=${resolution}`);
}

/** Undo a balance-based archive when the supposed covering value was only an
 * unconfirmed ecash export. This is deliberately narrow: user-dismissed
 * records and genuinely live poisoned notes are never reopened or rewritten. */
export function reopenBalanceReconciledCredit(escrowId: string): boolean {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (
    !entry
    || entry.resolution !== "balance-reconciled"
    || (!entry.unresolvedCredit && !isConsumedCreditUnconfirmed(entry))
  ) return false;
  delete entry.resolvedAt;
  delete entry.resolution;
  entry.unresolvedCredit = true;
  saveStash(stash);
  console.info(`[claim-trace] unresolved-credit reopened escrowId=${escrowId} reason=unconfirmed-export`);
  return true;
}

/**
 * C13 (v3.4.0): the entries automatic retry can no longer help, in the
 * order the UI should show them. INVARIANT(stranded-notes-surfaced):
 * every entry that is poisoned, unresolved-credit, or out of drain
 * attempts appears here with its full oobNotes bearer string, so the
 * UI can offer export-to-safety. An entry still inside its retry
 * budget is NOT stranded — the boot drain owns it.
 */
export function listStrandedRedemptions(): StrandedRedemption[] {
  const stranded: StrandedRedemption[] = [];
  for (const entry of Object.values(loadStash())) {
    // Archived (balance-reconciled / user-dismissed) entries are kept in the
    // stash for forensics but drop out of the alarm list.
    if (entry.resolvedAt) continue;
    if (entry.unresolvedCredit || isConsumedCreditUnconfirmed(entry)) {
      stranded.push({ ...entry, stranded: "unresolved-credit" });
    } else if (entry.lastError && entry.poisonedAt) {
      stranded.push({ ...entry, stranded: "poisoned" });
    } else if (entry.attempts >= MAX_DRAIN_ATTEMPTS) {
      stranded.push({ ...entry, stranded: "retries-exhausted" });
    }
  }
  return stranded.sort((a, b) => a.createdAt - b.createdAt);
}

/** A pending export is already the canonical recovery surface for its exact
 * bearer note. Also defer the legacy manual-export slot while that canonical
 * surface exists: older releases mislabeled that outgoing note as a claim, so
 * rendering it red beside the teal export tells two contradictory stories.
 * The legacy record is NOT deleted; if the canonical export goes away it can
 * surface again. Equal amounts alone are never enough to merge money records. */
export function excludeStrandedRedemptionsOwnedByExport(
  entries: StrandedRedemption[],
  exportedNotes?: string | null,
): StrandedRedemption[] {
  if (!exportedNotes) return entries;
  return entries.filter((entry) =>
    entry.oobNotes !== exportedNotes
    && entry.escrowId !== LEGACY_MANUAL_ECASH_EXPORT_ID
  );
}

/**
 * v4.0.0: split the stranded list into how the UI should treat each entry,
 * reconciling the "unresolved-credit" sliver against the wallet balance
 * instead of asking the user to. The banner copy already invokes the balance
 * ("your balance may already include them") — so check it:
 *
 *   • unresolved-credit, balance covers the unconfirmed total → reconciledIds
 *     (resolve silently; a successful trade should end clean, not in red).
 *   • unresolved-credit, balance is SHORT → `calm` (a real, dismissible nudge:
 *     the user is visibly missing that amount — likely claimed on another
 *     device — and the note is saved as backup).
 *   • poisoned / retries-exhausted → `loud` ALWAYS. Those notes may still be
 *     LIVE money; the balance downgrade must never leak onto them.
 *
 * Pure (no storage writes) so it's render-safe and testable; the caller
 * persists `reconciledIds` via resolveUnresolvedCredit in an effect. The SUM
 * (not per-entry) guards against two entries each being "covered" by the same
 * balance, and an unloaded/zero balance simply yields no reconciliation.
 */
export function partitionStrandedClaims(
  entries: StrandedRedemption[],
  balanceMsats: number,
): { loud: StrandedRedemption[]; calm: StrandedRedemption[]; reconciledIds: string[] } {
  const loud: StrandedRedemption[] = [];
  const unresolved: StrandedRedemption[] = [];
  for (const e of entries) {
    if (e.stranded === "unresolved-credit") unresolved.push(e);
    else loud.push(e);
  }
  const totalUnresolved = unresolved.reduce((sum, e) => sum + e.amountMsats, 0);
  const covered = totalUnresolved > 0 && balanceMsats >= totalUnresolved;
  return {
    loud,
    calm: covered ? [] : unresolved,
    reconciledIds: covered ? unresolved.map((e) => e.escrowId) : [],
  };
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
  fedimint: FedimintClient,
  opts?: { onCredited?: (entry: PendingRedemption) => void | Promise<void> },
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    attempted: 0,
    succeeded: 0,
    stillPending: 0,
    poisoned: 0,
    unresolved: 0,
  };

  const stash = loadStash();
  const entries = Object.values(stash);

  for (const entry of entries) {
    // This is an outgoing payment, not a claim waiting to credit this wallet.
    // Older releases wrote it into this queue; redeeming it here makes the
    // recipient's copy immediately fail as already spent.
    if (entry.escrowId === LEGACY_MANUAL_ECASH_EXPORT_ID) continue;
    // The mint already credited this wallet. The entry now reserves those
    // sats for the claimant's outbound payout; reissuing or exporting its
    // original bearer string would be both pointless and misleading.
    if (entry.creditedAt) continue;
    // Skip poisoned / unresolved entries — they've been diagnosed as
    // unrecoverable-by-retry. The C13 surface owns them now.
    if (entry.lastError && entry.poisonedAt) {
      if (entry.unresolvedCredit) summary.unresolved++;
      else summary.poisoned++;
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
      // Success proves the reissue credited this wallet, but does NOT prove
      // the claimant received their requested outbound payout. Preserve the
      // entry as a reservation until that later boundary confirms.
      markPendingRedemptionCredited(entry.escrowId);
      await opts?.onCredited?.({ ...entry, creditedAt: Date.now() });
      summary.succeeded++;
      console.info(
        `[chama] drained pending redemption for ${entry.escrowId} ` +
        `(${entry.amountMsats / 1000} sats)`
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      const code = typeof (e as { code?: unknown })?.code === "string"
        ? (e as { code: string }).code
        : "";

      // C5 (v3.4.0): "already spent" with no confirmed wallet credit.
      // Retrying across boots can never resolve this — the notes are
      // consumed and either the credit already sits in this balance
      // (earlier session) or another wallet took it (front-run). Mark
      // it unresolved so the drain stops burning attempts and the C13
      // surface puts it in front of the user.
      if (
        code === "ALREADY_SPENT_UNCONFIRMED"
        || code === "MINT_REISSUE_FAILED"
        || code === "MINT_REISSUE_UNKNOWN"
      ) {
        markUnresolvedCredit(
          entry.escrowId,
          e instanceof Error ? e.message : String(e)
        );
        summary.unresolved++;
        console.error(
          `[chama] pending redemption for ${entry.escrowId} needs attention ` +
          `(already spent, credit unconfirmed): ${msg}`
        );
        continue;
      }

      // Match the same hard-failure taxonomy as redeemWithRetry itself.
      // If redeemWithRetry already threw past its 3 internal retries on
      // one of these strings, retrying across boots won't help — poison.
      const isHardFailure =
        msg.includes("malformed") ||
	        msg.includes("invalid federation") ||
	        msg.includes("not joined") ||
	        msg.includes("parse error") ||
	        msg.includes("invalid note format") ||
	        msg.includes("mint reissue operation failed") ||
	        msg.includes("mint notes were consumed");

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
    removeStrictScopedStorageItem(PENDING_REDEMPTIONS_KEY);
  } catch (e) {
    console.warn("[chama] pending-redemptions: clearAll failed:", e);
  }
}
