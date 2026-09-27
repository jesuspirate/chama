import { Role, type EscrowState } from '../escrow-engine/types.js';
import { pickPreferredArbiter } from './pool.js';
/** The displayed assignment is the same deterministic pick as the record card. */
export function displayedTradeArbiter(state: EscrowState): string | null {
  return state.participants[Role.ARBITER] ?? pickPreferredArbiter(state.communityArbiters, state.bondedArbiters, state.id,
    [state.participants[Role.BUYER], state.participants[Role.SELLER]].filter((key): key is string => !!key)) ?? null;
}
