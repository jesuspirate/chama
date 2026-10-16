import type { EscrowState } from '../escrow-engine/types.js';
import { getSavedHandle, listSavedHandles, type SavedHandle } from './saved-handles.js';
import { toRailKey } from './rail-registry.js';

export function needsTradePaymentDetails(state: EscrowState): boolean {
  return state.category === 'p2p-trade' || state.category === 'bill-pay' || state.category === 'lending';
}
export function matchingTradeHandles(state: EscrowState): SavedHandle[] {
  const rails = new Set((state.paymentMethods ?? []).map(toRailKey));
  return listSavedHandles().filter(h => rails.has(toRailKey(h.rail)) || h.networks?.some(n => rails.has(toRailKey(n))));
}
export function assertTradePaymentDetails(state: EscrowState, opts: { savedHandleId?: string; paymentDetailsInChat?: boolean }): void {
  if (!needsTradePaymentDetails(state)) return;
  if (opts.savedHandleId) {
    const saved = getSavedHandle(opts.savedHandleId);
    if (!saved || !matchingTradeHandles(state).some(h => h.id === saved.id)) {
      throw new Error('Choose payment details for one of this trade’s agreed methods before funding.');
    }
    return;
  }
  if (opts.paymentDetailsInChat !== true) throw new Error('Add payment details or choose to send them in chat before funding.');
}
