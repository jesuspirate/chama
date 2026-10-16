// ══════════════════════════════════════════════════════════════════════════
// Chama — Claim Payout Journal (double-pay guard)
// ══════════════════════════════════════════════════════════════════════════
//
// The companion to pending-redemptions.ts on the OUTBOUND side of a claim.
// Pending-redemptions protects the bearer notes between CLAIM-publish and
// redeem; this journal protects against paying the winner's destination
// invoice TWICE.
//
// ── The bug this exists for (3.5.1 device pass, round 2) ──────────────────
//
//   1. Claim settles, balance covers the payout.
//   2. runClaimAndPayout pays the winner's Lightning invoice via the
//      federation gateway. The adapter submits, gets an operationId, then
//      watches subscribeLnPay for `success{preimage}`.
//   3. The HTLC is slow. The 60s watch window (PAY_WATCH_TIMEOUT_MS) expires
//      while the payment is STILL IN FLIGHT, so payInvoice throws.
//   4. The payment then settles — sats land in the winner's wallet — but the
//      UI already fell to a retryable terminal.
//   5. RETRY mints a FRESH invoice (different payment hash, so the gateway
//      cannot dedupe) and pays AGAIN. The winner is paid twice.
//
// Lightning's own payment-hash idempotency cannot save us here precisely
// because each retry resolves a new invoice. The guard therefore keys on the
// ESCROW, not the invoice: once a payout for an escrow has been SUBMITTED
// (an operationId exists ⇒ the gateway accepted it), no second payout is ever
// dispatched for that escrow. The true outcome is resolved by re-attaching to
// the operationId, never by paying again.
//
// ── unknown ⇒ refuse ──────────────────────────────────────────────────────
//
// Mirrors the fund-loss-guard stance used elsewhere in Chama: an
// indeterminate payout outcome (timed-out watch, stream error, unexpected
// state) is recorded as `submitted`, NOT cleared. A `submitted` record blocks
// re-pay. Only a CONFIRMED refund clears the record (the bridge does that by
// calling clearPayoutRecord), making the escrow freshly payable again.
//
// Storage mirrors pending-redemptions.ts exactly: synchronous, user-scoped
// localStorage, versioned key, durable across crashes / refreshes.

import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so we can migrate the payload shape later. */
export const PAYOUT_JOURNAL_KEY = "chama_payout_journal_v1";

/** V7 reconcile-by-escrow scan bound: look back to the journal record's
 *  createdAt minus this margin. The payment (if any) was dispatched AFTER
 *  the record was written, so a scan reaching past that point proves a
 *  "none" verdict is complete — with an hour of slack for clock skew
 *  between the JS clock and the fedimint op-log's creation_time. */
export const PAY_RECONCILE_SINCE_MARGIN_MS = 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * intent    — V7: the orchestrator is ABOUT to dispatch a payout (written
 *   pre-send, after the writability probe). If the app dies mid-pay, this
 *   record survives where the old journal had nothing — the retry then
 *   reconciles BY ESCROW (the payment itself carries `chama_escrow_id` in
 *   fedimint's operation log) instead of blindly re-paying. An intent is
 *   NOT evidence a payment exists: readers must never render it as
 *   "payout sent" (TradeDetail keeps RETRY CLAIM live; the pending-payout
 *   summary treats it like no record).
 * submitted — the gateway accepted a payout for this escrow (an operationId
 *   exists) but settlement is not yet CONFIRMED. Blocks re-pay. The true
 *   outcome is resolved by re-attaching to `operationId`.
 * settled   — the payout reached a `success{preimage}` terminal. Blocks
 *   re-pay permanently; a retry is a no-op that just completes the claim.
 */
export type PayoutStatus = "intent" | "submitted" | "settled";

export interface PayoutRecord {
  /** Escrow ID this payout belongs to (journal key). */
  escrowId: string;
  /** Current lifecycle status. */
  status: PayoutStatus;
  /** Fedimint LN-pay operation id — the durable handle for re-attach.
   *  Present whenever the gateway accepted the payment. */
  operationId?: string;
  /** Payout amount in msats, for forensics / "already paid" UI. */
  amountMsats?: number;
  /** When the payout was first submitted (Unix ms). */
  createdAt: number;
  /** When it reached `settled` (Unix ms). */
  settledAt?: number;
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Journal = Record<string, PayoutRecord>;

/** Parse the stored journal. THROWS when a value exists but is not a journal:
 *  a corrupt journal may be hiding a submitted or settled record, so reading
 *  it as empty would re-open the double-pay window, and writing over it would
 *  destroy the evidence. Writers and the pre-send probe use this. */
function loadJournalStrict(): Journal {
  const raw = getScopedStorageItem(PAYOUT_JOURNAL_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "This device's payout record can't be read, so Chama can't check whether this trade was already paid. No payment was sent.",
    );
  }
  return parsed as Journal;
}

/** Display reads. A corrupt journal reads as empty here, but the corrupt value
 *  is never overwritten (writers use loadJournalStrict) and no payout is sent
 *  while it stands (assertPayoutJournalWritable refuses). */
function loadJournal(): Journal {
  try {
    return loadJournalStrict();
  } catch (e) {
    console.warn("[chama] payout-journal: loadJournal failed:", e);
    return {};
  }
}

function saveJournal(journal: Journal): void {
  // FAIL-CLOSED (v4.0.0): a write failure (quota / private mode / disabled
  // storage — common on mobile WebViews) means the double-pay guard did NOT
  // persist. We MUST surface it rather than swallow: the claim orchestrator
  // refuses to end in a re-payable state when the guard can't be saved, so a
  // payout is never dispatched (or left retry-able) without a working guard.
  // Swallowing here silently re-opened the double-pay window.
  setScopedStorageItem(PAYOUT_JOURNAL_KEY, JSON.stringify(journal));
}

/**
 * Probe that the payout journal can actually be PERSISTED right now. Throws if
 * storage is unavailable (quota exceeded, private mode, disabled). The claim
 * orchestrator calls this BEFORE sending a payout and refuses to send when it
 * throws — so a payout is never dispatched without a working anti-double-pay
 * guard. Uses a tiny sentinel write+remove so it never disturbs the real
 * journal, and exercises the same storage path the guard relies on.
 */
export function assertPayoutJournalWritable(): void {
  // A journal that exists but cannot be parsed would be read as "no payout
  // yet" and then overwritten by the intent write. Refuse instead.
  loadJournalStrict();
  const probeKey = `${PAYOUT_JOURNAL_KEY}_probe`;
  setScopedStorageItem(probeKey, "1");
  try {
    removeScopedStorageItem(probeKey);
  } catch {
    // Cleanup is best-effort; the write above is the load-bearing probe.
  }
}

/** Throws when the journal exists but cannot be parsed. The claim
 *  orchestrator calls this before its double-pay guard so an unreadable
 *  journal refuses every payout kind instead of reading as "never paid". */
export function assertPayoutJournalReadable(): void {
  loadJournalStrict();
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/** The payout record for an escrow, or null if none has been submitted. */
export function getPayoutRecord(escrowId: string): PayoutRecord | null {
  return loadJournal()[escrowId] ?? null;
}

/**
 * V7 pre-send intent: record that a payout dispatch is IMMINENT for this
 * escrow, BEFORE payInvoice is called. Success/inflight/definite-failure
 * paths upgrade or clear it; a crash in between leaves it for the
 * reconcile-by-escrow guard. Never downgrades submitted/settled (a retry's
 * pre-send write must not erase a prior attempt's evidence).
 */
export function recordPayoutIntent(input: {
  escrowId: string;
  amountMsats?: number;
}): void {
  const journal = loadJournalStrict();
  const existing = journal[input.escrowId];
  if (existing?.status === "settled" || existing?.status === "submitted") return;
  journal[input.escrowId] = {
    escrowId: input.escrowId,
    status: "intent",
    amountMsats: input.amountMsats ?? existing?.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveJournal(journal);
  console.info(`[claim-trace] payout-intent escrowId=${input.escrowId}`);
}

/**
 * Record that a payout has been SUBMITTED for this escrow (the gateway
 * accepted it; an operationId exists) but settlement is not yet confirmed.
 * Called by the claim orchestrator the moment payInvoice yields an
 * operationId OR throws an in-flight (unknown-outcome) error carrying one.
 *
 * Idempotent: never downgrades a `settled` record back to `submitted`.
 */
export function recordPayoutSubmitted(input: {
  escrowId: string;
  operationId?: string;
  amountMsats?: number;
}): void {
  const journal = loadJournalStrict();
  const existing = journal[input.escrowId];
  if (existing?.status === "settled") return; // never un-settle
  journal[input.escrowId] = {
    escrowId: input.escrowId,
    status: "submitted",
    operationId: input.operationId ?? existing?.operationId,
    amountMsats: input.amountMsats ?? existing?.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveJournal(journal);
  console.info(
    `[claim-trace] payout-submitted escrowId=${input.escrowId} ` +
      `op=${(input.operationId ?? existing?.operationId ?? "?").slice(0, 16)}`,
  );
}

/**
 * Mark the payout for an escrow as CONFIRMED settled (success{preimage}).
 * After this, any re-tap of Claim is a no-op that just re-publishes COMPLETE.
 */
export function markPayoutSettled(escrowId: string, operationId?: string): void {
  const journal = loadJournalStrict();
  const existing = journal[escrowId];
  journal[escrowId] = {
    escrowId,
    status: "settled",
    operationId: operationId ?? existing?.operationId,
    amountMsats: existing?.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
    settledAt: Date.now(),
  };
  saveJournal(journal);
  console.info(`[claim-trace] payout-settled escrowId=${escrowId}`);
}

/**
 * Remove the payout record for an escrow. Called ONLY when a payout is
 * CONFIRMED refunded/canceled — the sats came back, so the escrow is freshly
 * payable and a retry is correct. Never call this on an unknown outcome.
 */
export function clearPayoutRecord(escrowId: string): void {
  let journal: Journal;
  try {
    journal = loadJournalStrict();
  } catch (e) {
    // Unreadable journal: leave it untouched. Keeping a record only ever
    // blocks a re-pay.
    console.warn("[chama] payout-journal: clearPayoutRecord skipped (journal unreadable):", e);
    return;
  }
  if (journal[escrowId]) {
    delete journal[escrowId];
    try {
      saveJournal(journal);
    } catch (e) {
      // A failed CLEAR leaves the record in place, which only ever BLOCKS a
      // re-pay — fund-safe. (Unlike a failed submit/settle write, which must
      // fail loudly because it would re-open the double-pay window.)
      console.warn(
        "[chama] payout-journal: clearPayoutRecord persist failed (record kept; fund-safe):",
        e,
      );
      return;
    }
    console.info(`[claim-trace] payout-clear escrowId=${escrowId}`);
  }
}

/** Snapshot of all current records. For UI / debug / tests. */
export function listPayoutRecords(): PayoutRecord[] {
  return Object.values(loadJournal());
}

/** Wipe the whole journal. Tests + a future advanced-settings action only. */
export function clearAllPayoutRecords(): void {
  try {
    removeScopedStorageItem(PAYOUT_JOURNAL_KEY);
  } catch (e) {
    console.warn("[chama] payout-journal: clearAll failed:", e);
  }
}
