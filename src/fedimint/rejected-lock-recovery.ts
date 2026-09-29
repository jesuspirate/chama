import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { EscrowState } from '../escrow-engine/types.js';
import type { PendingNativeLock } from './pending-native-locks.js';

/** Exact signed-time refusal plus this device's bearer copy, never relay absence. */
export function rejectedLockRecovery(state: EscrowState, entry: PendingNativeLock | null | undefined, pubkey: string | null | undefined) {
  if (!entry?.oobNotes || !pubkey || state.provenance === 'summary' || state.lock.notesHash || state.claim.claimedAt) return undefined;
  const hash = bytesToHex(sha256(new TextEncoder().encode(entry.oobNotes)));
  const rejected = state.rejectedLocks?.find(row => row.code === 'ORDER_NOT_FINALIZED'
    && row.event.pubkey === pubkey && row.event.payload.notesHash === hash && !row.event.payload.onchain);
  if (!rejected) return undefined;
  return {eventId: rejected.event.raw.id, pubkey, amountMsats: entry.amountMsats};
}
