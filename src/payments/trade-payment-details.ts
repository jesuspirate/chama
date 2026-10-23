import { EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
import { getSavedHandle, listSavedHandles, type SavedHandle } from './saved-handles.js';
import { toRailKey } from './rail-registry.js';

export function needsTradePaymentDetails(state: EscrowState): boolean {
  return state.category === 'p2p-trade' || state.category === 'bill-pay' || state.category === 'lending';
}
/** Where the cash goes stays on screen from the lock until the trade ends,
 *  not only while it waits for votes: an agreed or disputed trade still
 *  needs it. */
export function tradeCashDetailsVisible(state: EscrowState): boolean {
  return state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED;
}
/** Saved payment details the funder may lock with: one of the trade's agreed
 *  methods. A legacy listing that agreed no methods accepts any saved detail,
 *  so it can still be funded with a real address. */
export function matchingTradeHandles(state: EscrowState): SavedHandle[] {
  const rails = new Set((state.paymentMethods ?? []).map(toRailKey));
  const usable = listSavedHandles().filter(h => h.handle.trim().length > 0);
  if (rails.size === 0) return usable;
  return usable.filter(h => rails.has(toRailKey(h.rail)) || h.networks?.some(n => rails.has(toRailKey(n))));
}
/** Jet (6.4.31-rc.1): before any sats move on a cash trade, the funder must
 *  say exactly where the cash goes, for one of the agreed methods. "Send in
 *  chat" no longer counts: a trade must never sit locked with nobody knowing
 *  where to pay. Run only before new funding; a lock whose sats already moved
 *  falls back to the agreed methods plus chat rather than aborting. */
export function assertTradePaymentDetails(state: EscrowState, opts: { savedHandleId?: string; paymentDetailsInChat?: boolean }): void {
  if (!needsTradePaymentDetails(state)) return;
  if (!opts.savedHandleId) {
    throw Object.assign(new Error('Add where the buyer sends the cash, for one of this trade’s agreed methods, before funding. No sats moved.'),
      { code: 'PAYMENT_DETAILS_REQUIRED' });
  }
  const saved = getSavedHandle(opts.savedHandleId);
  if (!saved || !matchingTradeHandles(state).some(h => h.id === saved.id)) {
    throw Object.assign(new Error('Choose payment details for one of this trade’s agreed methods before funding. No sats moved.'),
      { code: 'PAYMENT_DETAILS_REQUIRED' });
  }
}
/** Jet (6.4.31): every new offer with a cash side names how the cash can be
 *  paid before anyone can match it, the way the canvas already matches
 *  methods. Market (paid in sats) and Circles have no cash side. Circle
 *  seats, plan children and later slices keep the terms already signed. App-side only:
 *  old listings without methods still load, and still need a real address
 *  before funding. */
export function assertCreatePaymentMethods(params: {
  category?: string; paymentMethods?: readonly string[]; parent?: string; trancheChild?: unknown; tranche?: { index?: number };
}): void {
  if (params.category !== 'p2p-trade' && params.category !== 'bill-pay' && params.category !== 'lending') return;
  if (params.parent || params.trancheChild || (params.tranche?.index ?? 0) > 0) return;
  if ((params.paymentMethods ?? []).some(method => typeof method === 'string' && method.trim().length > 0)) return;
  throw Object.assign(new Error('Choose at least one way the cash can be paid before posting this offer.'), { code: 'PAYMENT_METHODS_REQUIRED' });
}
/** An older cash offer posted without payment methods can't be matched:
 *  taking its buyer seat is refused before anything is signed, so nobody
 *  enters a trade that never said how the cash is paid. */
export function assertJoinPaymentMethods(state: EscrowState | undefined | null, role: Role): void {
  if (!state || role !== Role.BUYER || !needsTradePaymentDetails(state)) return;
  if ((state.paymentMethods ?? []).some(method => typeof method === 'string' && method.trim().length > 0)) return;
  throw Object.assign(new Error('This offer doesn’t say how the cash is paid, so it can’t be taken. Ask the seller to post it again with payment methods.'), { code: 'PAYMENT_METHODS_REQUIRED' });
}
