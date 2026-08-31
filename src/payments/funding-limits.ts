// Chama funding guardrails

/** Direct bearer-ecash locks can remain tiny for interop testing. */
export const MIN_REAL_ATOMIC_FUNDING_SATS = 1;
export const MIN_REAL_ATOMIC_FUNDING_MSATS = MIN_REAL_ATOMIC_FUNDING_SATS * 1000;

/**
 * Fedimint/BLF does not impose a 1,000-sat Lightning receive minimum. Fedi can
 * legitimately settle tiny BOLT11 payments, including same-federation internal
 * payments that still appear as Lightning activity. Chama's earlier 1,000-sat
 * rule was only a conservative reaction to claim_rejected; it did not prevent
 * federation claim rejection and could merely increase the amount at risk.
 * Keep the product floor at one whole sat. Fresh-client wallet recovery is a
 * separate safety issue handled at the wallet lifecycle boundary.
 */
export const MIN_REAL_LIGHTNING_FUNDING_SATS = 1;
export const MIN_REAL_LIGHTNING_FUNDING_MSATS =
  MIN_REAL_LIGHTNING_FUNDING_SATS * 1000;

export type FundingMethod = "lightning" | "onchain" | "nwc" | "ecash";

export function minimumRealFundingMsatsForMethod(
  method: FundingMethod | undefined,
): number {
  return method === "ecash" || method === "onchain"
    ? MIN_REAL_ATOMIC_FUNDING_MSATS
    : MIN_REAL_LIGHTNING_FUNDING_MSATS;
}

export function minimumAtomicFundingMessage(): string {
  const unit = MIN_REAL_ATOMIC_FUNDING_SATS === 1 ? "sat" : "sats";
  return `Minimum real escrow is ${MIN_REAL_ATOMIC_FUNDING_SATS.toLocaleString()} ${unit}.`;
}

export function minimumLightningFundingMessage(): string {
  const unit = MIN_REAL_LIGHTNING_FUNDING_SATS === 1 ? "sat" : "sats";
  return `Minimum real Lightning escrow is ${MIN_REAL_LIGHTNING_FUNDING_SATS.toLocaleString()} ${unit}.`;
}
