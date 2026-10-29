import { EscrowEventKind, EscrowStatus, type EscrowState } from "./types.js";
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

/** True once this device holds a LOCK for the trade. A funder must never
 *  sign a second LOCK for one deposit: an entitled author's repeat LOCK made
 *  a mainnet trade unloadable (Oct 28). */
export function onchainLockAlreadySent(trade: EscrowState): boolean {
  return !!trade.lock.onchain || trade.lock.lockedAt != null
    || trade.eventChain.some(event => event.kind === EscrowEventKind.LOCK);
}
