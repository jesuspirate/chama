import type { EscrowState } from '../escrow-engine/types.js';
import { getCommunityBySlug } from '../communities/registry.js';

/** Currency belongs to the offer; widening community scope never converts it. */
export function listingMatchesCurrency(listing: EscrowState, viewerCurrency: string): boolean {
  const currency = listing.fiatCurrency || getCommunityBySlug(listing.community ?? '')?.currency;
  // Bitcoin-only and legacy offers with no currency are currency independent.
  return !currency || currency.toUpperCase() === 'BTC' || currency.toUpperCase() === viewerCurrency.toUpperCase();
}

export function filterListingsByCurrency(listings: readonly EscrowState[], viewerCurrency: string, otherCurrencies = false): EscrowState[] {
  return listings.filter(listing => listingMatchesCurrency(listing, viewerCurrency) !== otherCurrencies);
}
