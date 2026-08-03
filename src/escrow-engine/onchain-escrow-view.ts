// ══════════════════════════════════════════════════════════════════════════
// Chama — what an on-chain escrow shows the user (Tier 2.1 UI, pure core)
// ══════════════════════════════════════════════════════════════════════════
//
// The panel renders this; it decides nothing itself. Keeping the decisions here
// means the honesty rules below are TESTABLE rather than a matter of whoever
// last edited a component.
//
// Three rules this module exists to enforce:
//
//   1. NEVER SHOW AN ADDRESS WE DID NOT RECOMPUTE. Funding is irreversible, so
//      an address that arrived over the wire is a payment to whoever tampered
//      with it. The view carries the locally-derived address or no address.
//   2. NAME THE BLOCKER. "Not ready" with no reason makes a user either wait
//      forever or fund something they shouldn't.
//   3. NEVER OFFER A SIGN BUTTON WITHOUT A PASSED CHECKLIST. The checklist is
//      the security of the settlement path (onchain-escrow-settle.ts); a UI that
//      lets someone sign first has thrown it away.

import { EscrowStatus, Role, type EscrowState } from "./types.js";

export type OnchainStage =
  /** Waiting for every party's escrow key before an address can exist. */
  | "awaiting-keys"
  /** Address known; waiting for the funder to send and for confirmation. */
  | "awaiting-funding"
  /** Funded and locked. The trade is live. */
  | "locked"
  /** Both sides agreed; a settlement transaction can be built. */
  | "settling"
  /** Settled on-chain. */
  | "done";

export interface OnchainEscrowView {
  stage: OnchainStage;
  /** ONLY ever the locally recomputed address. Null while unknown. */
  address: string | null;
  /** Sats the escrow should hold. */
  expectedSats: bigint | null;
  /** Blockers, in the user's terms. Empty unless the stage is awaiting-keys. */
  blockers: string[];
  /** True when the viewer is the party expected to fund. */
  viewerFunds: boolean;
  /** Explorer link for the funding transaction, once known. */
  fundingTxid: string | null;
  /** Whether the appeal window still blocks arbitration, and for how long. */
  appealWindow: { open: boolean; blocksRemaining: number } | null;
  /** ⚠ Advisory only. A UI must gate its sign button on a PASSED CHECKLIST, not
   *  on this — it says a settlement is possible, never that one is safe. */
  canSettle: boolean;
  /** ⭐ The viewer is the arbiter this trade is waiting on.
   *
   *  Without this the arbiter's own screen shows the same "waiting for the
   *  arbiter" line everyone else sees — a deadlock that reads as patience, on
   *  the one screen that could end it. The party who must act has to be told
   *  they are that party. */
  viewerMustPublishKey: boolean;
}

/** Which role funds this category, mirroring the reducer's `expectedLocker`. */
function funderRole(category: string): Role | null {
  if (category === "marketplace") return Role.BUYER;
  if (category === "lending") return Role.SELLER;
  if (category === "p2p-trade" || category === "bill-pay") return Role.SELLER;
  return null;
}

/**
 * Derive everything the on-chain panel shows.
 *
 * `recomputedAddress` is supplied by the caller, which must have built it from
 * the escrow terms itself. It is a parameter rather than something read off
 * `state.lock.onchain.address` precisely so this module cannot accidentally
 * surface a wire-supplied address — the type system makes the caller do the
 * derivation.
 */
export function deriveOnchainView(params: {
  state: EscrowState;
  viewerRole: Role | null;
  /** The address THIS client recomputed, or null when it could not. */
  recomputedAddress: string | null;
  /** Missing inputs, from `resolveFundingPlan`. */
  blockers?: readonly string[];
  appealWindow?: { open: boolean; blocksRemaining: number } | null;
  /** True when the viewer is this trade's arbiter — seated OR the deterministic
   *  pick who has not published a key yet. Both count: the pick is who everyone
   *  else is waiting on, whether or not they have taken the seat. */
  viewerIsPendingArbiter?: boolean;
}): OnchainEscrowView {
  const { state, viewerRole, recomputedAddress } = params;
  const terms = state.lock.onchain ?? null;
  const funder = funderRole(state.category);

  const blockers = [...(params.blockers ?? [])].map(blockerLabel);
  const settled = state.status === EscrowStatus.COMPLETED;
  const approved = state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED;
  const locked = state.lock.lockedAt !== null;

  const stage: OnchainStage =
    settled ? "done"
      : approved ? "settling"
        : locked ? "locked"
          : recomputedAddress ? "awaiting-funding"
            : "awaiting-keys";

  return {
    stage,
    // ⚠ Deliberately NOT `terms.address`. The wire's address is advisory; if we
    // could not recompute it ourselves we show none and the user funds nothing.
    address: recomputedAddress,
    expectedSats: terms ? BigInt(terms.amountSats) : BigInt(Math.floor(state.amountMsats / 1000)),
    blockers: stage === "awaiting-keys" ? blockers : [],
    viewerFunds: funder !== null && viewerRole === funder,
    fundingTxid: terms?.fundingTxid ?? null,
    appealWindow: params.appealWindow ?? null,
    canSettle: stage === "settling",
    // Only while the arbiter's key is the thing actually missing. Prompting an
    // arbiter to publish a key that is already published would have them chase
    // a blocker that belongs to someone else.
    viewerMustPublishKey:
      stage === "awaiting-keys"
      && !!params.viewerIsPendingArbiter
      && blockers.includes("waiting-for-arbiter"),
  };
}

/** Blocker codes → something a person can act on. */
function blockerLabel(code: string): string {
  switch (code) {
    case "missing-arbiter-key": return "waiting-for-arbiter";
    case "missing-buyer-key": return "waiting-for-buyer";
    case "missing-seller-key": return "waiting-for-seller";
    case "invalid-key": return "bad-key";
    case "keys-not-distinct": return "duplicate-keys";
    case "bad-refund-height": return "bad-terms";
    default: return "not-ready";
  }
}

/** ⭐ May a sign button be enabled?
 *
 *  Takes the checklist result, not a boolean the caller computed elsewhere, so
 *  the only way to render an enabled button is to have actually run
 *  `verifySettlementPsbt` and passed. A `false` here always means "do not sign",
 *  never "we could not check".
 */
export function mayEnableSignButton(check: { ok: boolean } | null | undefined): boolean {
  return check?.ok === true;
}
