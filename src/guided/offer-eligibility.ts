import { EscrowStatus, JOIN_HOLD_LOCK_GRACE_SECONDS, Role, type EscrowState } from '../escrow-engine/types.js';
import type { GuidedMatchRejectionCode } from './types.js';

export function sameOfferText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
}
/** Missing community provenance is never an invitation to join. */
export function listingCommunityMatches(listingCommunity: string | null | undefined, community: string | null | undefined): boolean {
  return !!listingCommunity?.trim() && (!community || sameOfferText(listingCommunity, community));
}
export interface OfferJoinContext {
  viewerPubkey?: string | null;
  community?: string | null;
  mintUrl?: string | null;
  nowSec: number;
}
/** Shared read-only eligibility, before intent-specific amount/rail ranking. */
export function offerJoinRejection(listing: EscrowState, context: OfferJoinContext, availableUnits?: number): GuidedMatchRejectionCode | null {
  if (listing.status !== EscrowStatus.CREATED) return 'NOT_OPEN';
  if (listing.parent !== undefined) return 'CHILD_ORDER';
  if ((listing.listingExpiresAt ?? listing.expiresAt) <= context.nowSec) return 'EXPIRED';
  const seller = listing.participants?.[Role.SELLER];
  if (!seller) return 'NO_SELLER';
  if (sameOfferText(seller, context.viewerPubkey)) return 'SELF_LISTING';
  if (availableUnits !== undefined && availableUnits <= 0) return 'OUT_OF_STOCK';
  const hold = listing.joinHolds?.[Role.BUYER];
  if (hold && hold.expiresAt + JOIN_HOLD_LOCK_GRACE_SECONDS > context.nowSec && !sameOfferText(hold.pubkey, context.viewerPubkey)) return 'RESERVED';
  if (!listingCommunityMatches(listing.community, context.community)) return 'COMMUNITY_MISMATCH';
  if (listing.escrowMode !== 'onchain' && context.mintUrl && listing.mintUrl !== context.mintUrl) return 'FEDERATION_MISMATCH';
  return null;
}
