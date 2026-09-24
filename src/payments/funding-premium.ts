import { isSimModeOn } from '../sim/simMode.js';
import { isTestnetMode } from '../fedimint/mock-wallet.js';

/** Match the settlement sweep: simulated wallets never pay insurance. */
export function fundingPremiumMsats(premium = 0, simulated = isSimModeOn(), testnet = isTestnetMode()): number {
  return simulated || testnet ? 0 : Math.max(0, Math.floor(premium));
}
