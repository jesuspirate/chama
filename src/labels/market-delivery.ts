import type { EscrowState } from '../escrow-engine/types.js';
export type MarketDelivery = 'ship' | 'meet' | 'service' | 'digital';
export const MARKET_DELIVERIES: readonly MarketDelivery[] = ['ship','meet','service','digital'];
export function marketDelivery(state: Pick<EscrowState, 'delivery' | 'fulfillment'>): MarketDelivery {
  return state.delivery ?? (state.fulfillment === 'service' ? 'service' : state.fulfillment === 'digital' ? 'digital' : 'ship');
}
