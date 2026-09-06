// ══════════════════════════════════════════════════════════════════════════
// Chama — proof that a claim's sats actually landed
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ WHY THIS EXISTS. Everything else the app persists about a claim records
// what was PUBLISHED, not what ARRIVED. v5.4 proved the difference in the
// field: three completed trades whose CLAIM published and whose sats never
// credited. So "COMPLETED" is a statement about a Nostr chain, and the tranche
// gate (escrow-engine/tranche.ts) must not treat it as money.
//
// The claim orchestrator already computes the only honest proof there is:
// `settledBy === "growth"` — the wallet balance GREW by the expected amount
// after redeeming. That is the moment the sats demonstrably landed in this
// user's wallet. Until now it was used transiently (clear the stash, log a
// line) and then forgotten. This module makes it durable.
//
// ⚠ "growth" ONLY. The orchestrator has a second settlement path, `cover`: the
// balance was already large enough to fund the payout, so the claim proceeded.
// That is CIRCUMSTANTIAL — the funds may predate this claim entirely, which is
// exactly why the orchestrator deliberately keeps the redemption stash on that
// path. Recording `cover` here would launder "I had enough money anyway" into
// "this trade paid me", and a tranche gate reading it would advance a victim
// straight into the next tranche of a theft. Never widen this.
//
// User-scoped, bounded, best-effort. A write failure loses a proof and the gate
// falls back to "unknown", which fails closed — the safe direction.

import { getScopedStorageItem, setScopedStorageItem } from "../storage/user-scope.js";
import { listPendingRedemptions } from "../fedimint/pending-redemptions.js";
import { getPayoutRecord } from "./payout-journal.js";

export const CLAIM_CREDIT_KEY = "chama_claim_credits_v1";

/** Bounded like every other local ledger. Ample for real trade volume; the
 *  oldest entries are the least likely to gate a live tranche plan. */
export const MAX_CLAIM_CREDITS = 500;

export interface ClaimCredit {
  escrowId: string;
  /** Msats the balance actually grew by expectation at claim time. */
  amountMsats: number;
  /** When the growth was observed (Unix ms). */
  creditedAt: number;
}

type Ledger = Record<string, ClaimCredit>;

function load(): Ledger {
  try {
    const raw = getScopedStorageItem(CLAIM_CREDIT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Ledger) : {};
  } catch {
    return {};
  }
}

function save(ledger: Ledger): void {
  try {
    setScopedStorageItem(CLAIM_CREDIT_KEY, JSON.stringify(ledger));
  } catch (e) {
    // Best-effort by design: losing a proof makes the gate MORE conservative,
    // never less. Deliberately not fail-closed like the payout journal, whose
    // absence would instead permit a double-pay.
    console.warn("[chama] claim-credit-ledger: save failed:", e);
  }
}

/**
 * Record that a claim's sats were observed landing in this wallet.
 *
 * Call ONLY from the growth path. Idempotent — the first observation wins, so a
 * later re-entry cannot restate when the money arrived.
 */
export function recordClaimCredit(escrowId: string, amountMsats: number, nowMs = Date.now()): void {
  if (!escrowId) return;
  const ledger = load();
  if (ledger[escrowId]) return;
  ledger[escrowId] = { escrowId, amountMsats, creditedAt: nowMs };
  const ids = Object.keys(ledger);
  if (ids.length > MAX_CLAIM_CREDITS) {
    const oldest = ids
      .sort((a, b) => ledger[a].creditedAt - ledger[b].creditedAt)
      .slice(0, ids.length - MAX_CLAIM_CREDITS);
    for (const id of oldest) delete ledger[id];
  }
  save(ledger);
}

/** The recorded proof for an escrow, or null when there is none. */
/** Every recorded credit. Read-only snapshot for callers that need the full
 *  set of already-paid escrow ids (e.g. silencing zombie "claim" summonses for
 *  trades whose sats demonstrably landed). */
export function listClaimCredits(): ClaimCredit[] {
  return Object.values(load());
}

export function getClaimCredit(escrowId: string): ClaimCredit | null {
  return load()[escrowId] ?? null;
}

export function clearAllClaimCredits(): void {
  try {
    setScopedStorageItem(CLAIM_CREDIT_KEY, JSON.stringify({}));
  } catch { /* nothing to do */ }
}

// ── The verdict the tranche gate consumes ──────────────────────────────────

export type CreditVerdict =
  /** Positive proof: the balance grew, or the money later left to an external
   *  destination (which it could not do without having arrived). */
  | "credited"
  /** Positive proof of the OPPOSITE: notes unresolved, poisoned, or still
   *  waiting to redeem. */
  | "not-credited"
  /** No evidence either way. Fails closed at the gate. */
  | "unknown";

/** Just the fields this decision needs, so it can be reasoned about — and
 *  tested — without touching storage or the wallet. */
export interface CreditEvidence {
  /** This escrow's proof-of-growth record, if one was written. */
  credit: { amountMsats: number } | null;
  /** A live pending-redemption stash entry for this escrow, if any. Its mere
   *  presence means the notes have not demonstrably landed. */
  redemption: {
    unresolvedCredit?: boolean;
    resolvedAt?: number;
    lastError?: string;
    creditedAt?: number;
  } | null;
  /** The payout journal record, if any. */
  payout: { status: "intent" | "submitted" | "settled" } | null;
}

/**
 * ⭐ Did this claim's sats actually reach the claimant?
 *
 * ORDER MATTERS, and negative evidence is checked FIRST. An escrow can hold
 * both a settled payout record and an unresolved-credit stash entry — the
 * v5.4 shape, where something looks finished and the money did not land. In
 * that conflict the alarm must win; reading the reassuring record first would
 * make the gate blind to exactly the failure it exists to catch.
 */
export function judgeCredit(evidence: CreditEvidence): CreditVerdict {
  const r = evidence.redemption;
  if (r) {
    // Unresolved credit that nobody has reconciled: the federation called the
    // notes spent and no credit to this wallet could be confirmed.
    if (r.unresolvedCredit && !r.resolvedAt) return "not-credited";
    if (r.lastError) return "not-credited";
    // A completed deterministic reissue is positive wallet-credit proof.
    // The stash remains only to reserve those sats until outbound payout.
    if (r.creditedAt) return "credited";
    // A plain live entry means the notes are still waiting to redeem.
    return "not-credited";
  }
  if (evidence.credit) return "credited";
  // Money cannot leave a wallet it never entered, so a settled payout is proof
  // the claim credited — for claims that predate this ledger, this is the only
  // proof available.
  if (evidence.payout?.status === "settled") return "credited";
  return "unknown";
}

/** The boolean the tranche gate wants. `unknown` fails CLOSED: the cost of a
 *  wrong stop is a user who checks their trade; the cost of a wrong proceed is
 *  the loss tranching exists to bound. */
export function creditObserved(evidence: CreditEvidence): boolean {
  return judgeCredit(evidence) === "credited";
}

// ── Storage-backed binding ─────────────────────────────────────────────────
//
// Deliberately separate from the decision above so the rules stay testable
// without localStorage, a wallet, or a federation. Injectable readers rather
// than direct imports, so the tranche gate can be exercised against synthetic
// evidence and so this module never pulls the redemption stash into a pure
// escrow-engine import path.

export interface CreditReaders {
  getRedemption: (escrowId: string) => CreditEvidence["redemption"];
  getPayout: (escrowId: string) => CreditEvidence["payout"];
}

/** Gather the evidence for one escrow from the live stores. */
export function readCreditEvidence(escrowId: string, readers: CreditReaders): CreditEvidence {
  return {
    credit: getClaimCredit(escrowId),
    redemption: readers.getRedemption(escrowId),
    payout: readers.getPayout(escrowId),
  };
}

/** A `creditObserved` predicate bound to the live stores, shaped exactly as
 *  `trancheGate` expects. Fail-soft: if a store throws, the verdict is
 *  `unknown`, which blocks — a broken read must never open the gate. */
export function makeCreditObserver(
  readers: CreditReaders,
): (state: { id: string }) => boolean {
  return (state) => {
    try {
      return creditObserved(readCreditEvidence(state.id, readers));
    } catch (e) {
      console.warn("[chama] credit evidence unreadable; treating as unproven:", e);
      return false;
    }
  };
}

/** The default observer, wired to Chama's real stores. This is what the tranche
 *  gate should be handed in the app. */
export function defaultCreditObserver(): (state: { id: string }) => boolean {
  return makeCreditObserver({
    getRedemption: (escrowId) =>
      listPendingRedemptions().find((r) => r.escrowId === escrowId) ?? null,
    getPayout: (escrowId) => getPayoutRecord(escrowId),
  });
}
