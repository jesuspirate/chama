// Whether the wallet's balance figure is a real reading. A failed read keeps
// the old number (0 on a fresh open), so the UI must not show it as "none".

import type { FedimintState } from "./useEscrow.js";

/** A balance update is a reading unless it says otherwise: any patch that
 *  sets `balanceMsats` clears `balanceReadFailed`, and only an explicit
 *  `balanceReadFailed: true` marks the reading as failed. */
export function withBalanceReadState(partial: Partial<FedimintState>): Partial<FedimintState> {
  if (!("balanceMsats" in partial) || "balanceReadFailed" in partial) return partial;
  return { ...partial, balanceReadFailed: false };
}

/** refreshBalance's body: a failed read keeps the old figure but records
 *  that it is stale, so it is never shown as a real "nothing". */
export async function refreshBalanceInto(
  fedimint: { getBalance(): Promise<number> },
  update: (partial: Partial<FedimintState>) => void,
): Promise<void> {
  try {
    const balanceMsats = await fedimint.getBalance();
    update({ balanceMsats });
  } catch (e) {
    console.debug("[chama] refreshBalance error:", e);
    update({ balanceReadFailed: true });
  }
}
