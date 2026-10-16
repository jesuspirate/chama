import type { EscrowState } from './types.js';
/** Preserve the actual rejected decision; callers may style it as informational. */
export function suppressedVoteError(originalMessage: string, currentState: EscrowState | null | undefined) {
  if (!/already voted|Cannot vote|TERMINAL|not LOCKED/i.test(originalMessage)) return null;
  return Object.assign(new Error(originalMessage), {
    voteSuppressed: true as const, code: 'VOTE_SUPPRESSED', originalMessage, currentState,
  });
}
