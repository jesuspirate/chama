import { getEffectiveParticipantsAt, type EscrowState } from '../escrow-engine/types.js';
/** Connection-time policy, independent of React mounting and relay arrival time.
 * During initial catch-up only a newer signed moment for a committed party is
 * eligible. The caller still owns transition detection and persistent dedup.
 */
export function notificationWindowAllows(input: {
  connectedAt: number; now: number; signedAt: number;
  state: EscrowState; viewer?: string | null; quietSeconds?: number;
}): boolean {
  if (!Number.isFinite(input.connectedAt) || input.signedAt <= input.connectedAt) return false;
  if (input.now >= input.connectedAt + (input.quietSeconds ?? 10)) return true;
  if (!input.viewer) return false;
  const viewer = input.viewer.toLowerCase();
  return Object.values(getEffectiveParticipantsAt(input.state, input.now))
    .some(pk => pk?.toLowerCase() === viewer)
    || input.state.actingArbiter?.toLowerCase() === viewer;
}
