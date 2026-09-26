import { EscrowStatus, type EscrowState } from "./types.js";
import { onchainFunder } from "./onchain-funding-terms.js";

/** Only the signer who committed the terms may publish the observed LOCK. */
export function pendingOnchainLockRecoveries(
  trades: Iterable<EscrowState>,
  pubkey: string,
): string[] {
  const ids: string[] = [];
  for (const trade of trades) {
    if (trade.escrowMode !== "onchain" || trade.status !== EscrowStatus.CREATED
      || !trade.onchainFundingTerms || trade.lock.onchain || trade.lock.lockedAt != null) continue;
    const funder = onchainFunder(trade);
    if (trade.onchainFundingTerms.funder !== funder
      || trade.participants[funder]?.toLowerCase() !== pubkey.toLowerCase()) continue;
    ids.push(trade.id);
  }
  return ids;
}
