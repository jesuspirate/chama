import { defaultEscrowModeForAmount, onchainEscrowAvailable, ONCHAIN_ESCROW_MINIMUM_SATS } from '../bond-multisig/onchain-escrow.js';
/** The maximum controls availability/fees; the minimum controls defaults and validity. */
export function guidedEscrowAmounts(min: number, max: number, choice: 'ecash' | 'onchain' | null) {
  const mode = choice ?? defaultEscrowModeForAmount(BigInt(Math.max(0, Math.floor(min))));
  return {
    mode,
    available: onchainEscrowAvailable(BigInt(Math.max(0, Math.floor(max)))),
    amountSats: max,
    invalidMinimum: mode === 'onchain' && min < Number(ONCHAIN_ESCROW_MINIMUM_SATS),
  };
}
