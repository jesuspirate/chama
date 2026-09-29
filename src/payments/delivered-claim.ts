import { EscrowStatus } from '../escrow-engine/types.js';
import type { EscrowClient } from '../escrow-engine/escrow-client.js';

/** Called only after confirmed payment or explicit ecash import confirmation.
 * Reuses the committed hash; never reconstructs/redeems/mints another note. */
export async function publishDeliveredClaim(
  client: Pick<EscrowClient, 'getState' | 'claim'>, escrowId: string,
): Promise<void> {
  const state = client.getState(escrowId);
  if (!state) throw new Error('Trade not loaded; reopen it to finish confirming receipt.');
  if (state.status === EscrowStatus.CLAIMED || state.status === EscrowStatus.COMPLETED) return;
  if (state.status !== EscrowStatus.APPROVED || !state.lock.notesHash) {
    throw new Error('The approved claim is not loaded. Reopen this trade to finish confirming receipt.');
  }
  await client.claim(escrowId, state.lock.notesHash);
}
