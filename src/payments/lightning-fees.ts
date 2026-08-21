// ══════════════════════════════════════════════════════════════════════════
// Chama — Lightning outbound fee helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Browser Fedimint pays outbound Lightning fees from the sender's ecash
// balance, in addition to the invoice amount. For claim/recovery payouts
// this means the destination invoice must be slightly smaller than the
// available balance, otherwise tiny payouts fail even though the wallet
// visibly has "enough" sats.

const DEFAULT_LIGHTNING_SEND_BASE_FEE_MSATS = 2_000;
const DEFAULT_LIGHTNING_SEND_PPM = 5_000;
const DEFAULT_LIGHTNING_SEND_BUFFER_MSATS = 500;

export function estimateLightningSendFeeMsats(invoiceAmountMsats: number): number {
  const amount = Math.max(0, Math.floor(invoiceAmountMsats));
  return (
    DEFAULT_LIGHTNING_SEND_BASE_FEE_MSATS
    + Math.ceil((amount * DEFAULT_LIGHTNING_SEND_PPM) / 1_000_000)
    + DEFAULT_LIGHTNING_SEND_BUFFER_MSATS
  );
}

export function maxLightningPayoutSats(balanceMsats: number): number {
  const balance = Math.max(0, Math.floor(balanceMsats));
  let lo = 0;
  let hi = Math.floor(balance / 1000);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const invoiceAmountMsats = mid * 1000;
    const totalCostMsats =
      invoiceAmountMsats + estimateLightningSendFeeMsats(invoiceAmountMsats);
    if (totalCostMsats <= balance) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function hasLightningWithdrawableBalance(balanceMsats: number): boolean {
  return maxLightningPayoutSats(balanceMsats) > 0;
}

/** The dust line (sats) below which a local balance is treated as not worth
 *  recovering. A federation switch silently proceeds and abandons anything
 *  below this; at or above it (and Lightning-withdrawable) the switch surfaces
 *  the destroy-confirm / recovery path. Recovering ~1 sat costs ~2.5 sats in
 *  Lightning fees, so a bare "can withdraw >= 1 sat" check wrongly BLOCKED a
 *  Chama switch over ~1 sat of in-practice-unrecoverable dust. Kept here (the
 *  payments layer) so both the UI decision code and the data-layer switch
 *  guards share ONE dust line — see MAIN_SURFACE_RECOVERY_MIN_SATS. */
export const MATERIAL_RECOVERY_MIN_SATS = 2_000;

/** True only when a balance should BLOCK a federation switch: both material
 *  (>= MATERIAL_RECOVERY_MIN_SATS) AND actually Lightning-withdrawable. Dust
 *  never blocks a switch; a real balance does. The single predicate every
 *  switch surface shares (UI decision, reconcile/switch data guards, modal
 *  render) so they can never disagree about what counts as recoverable. */
export function balanceBlocksFederationSwitch(balanceMsats: number): boolean {
  const sats = Math.floor(Math.max(0, balanceMsats) / 1000);
  return sats >= MATERIAL_RECOVERY_MIN_SATS && hasLightningWithdrawableBalance(balanceMsats);
}

export function lightningPayoutReserveSats(balanceMsats: number): number {
  const payoutSats = maxLightningPayoutSats(balanceMsats);
  return Math.max(0, Math.ceil((Math.max(0, balanceMsats) - payoutSats * 1000) / 1000));
}

/** How a claim's sats LEAVE, for quoting purposes.
 *
 *  - `"lightning"` — the payout is an outbound Lightning send, so the browser
 *    Fedimint client spends a fee ON TOP of the invoice and the quote has to
 *    hold a reserve back.
 *  - `"ecash"` — the sats stay ecash: handed to a host Fedi wallet via
 *    `fediInternal.receiveEcash`, or exported as a bearer note over the native
 *    bridge. No Lightning hop, so no reserve, so the user is owed the whole
 *    amount.
 *
 *  Named for the INSTRUMENT rather than the destination app on purpose. The
 *  old `"fedi-wallet"` spelling read as one specific integration, so the
 *  native-bridge ecash export — the same zero-fee instrument — was never
 *  added, fell through to `"lightning"`, and got quoted 119 sats for a 123
 *  sat note. If a payout is not a Lightning send, it belongs on the `"ecash"`
 *  side of this union. */
export type ClaimPayoutTarget = "lightning" | "ecash";

export function claimPayoutSats(balanceMsats: number, target: ClaimPayoutTarget): number {
  if (target === "ecash") {
    return Math.max(0, Math.floor(balanceMsats / 1000));
  }
  return maxLightningPayoutSats(balanceMsats);
}

export function claimPayoutReserveSats(balanceMsats: number, target: ClaimPayoutTarget): number {
  if (target === "ecash") return 0;
  return lightningPayoutReserveSats(balanceMsats);
}

export function retrySmallerLightningPayoutSats(currentPayoutSats: number): number {
  const current = Math.max(0, Math.floor(currentPayoutSats));
  if (current <= 1) return 0;
  return Math.max(1, Math.floor(current / 2));
}
