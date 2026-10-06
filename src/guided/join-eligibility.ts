import { EscrowStatus, getEffectiveParticipantAt, Role, type EscrowState } from '../escrow-engine/types.js';
import type { GuidedRejectedListing } from './types.js';

export function sameCommunity(listingCommunity: string | null | undefined, community: string | null | undefined): boolean {
  return !!listingCommunity?.trim() && !!community?.trim()
    && listingCommunity.trim().toLowerCase() === community.trim().toLowerCase();
}

/** Shared availability gate. Untagged offers remain discoverable, but cannot
 * be offered as an in-community match. All times are injected Unix seconds. */
export function joinRejection(listing: EscrowState, ctx: {
  viewerPubkey?: string | null; community?: string | null; mintUrl?: string | null;
  nowSec: number; availableUnits?: number;
}): GuidedRejectedListing['code'] | null {
  const sameKey = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (listing.status !== EscrowStatus.CREATED) return 'NOT_OPEN';
  if (listing.parent !== undefined) return 'CHILD_ORDER';
  if ((listing.listingExpiresAt ?? listing.expiresAt) <= ctx.nowSec) return 'EXPIRED';
  if (!listing.participants[Role.SELLER]) return 'NO_SELLER';
  if (sameKey(listing.participants[Role.SELLER], ctx.viewerPubkey)) return 'SELF_LISTING';
  if (ctx.availableUnits !== undefined && ctx.availableUnits <= 0) return 'OUT_OF_STOCK';
  const buyer = getEffectiveParticipantAt(listing, Role.BUYER, ctx.nowSec, { includeLockGrace: true });
  if (buyer && !sameKey(buyer, ctx.viewerPubkey)) return 'RESERVED';
  if (!sameCommunity(listing.community, ctx.community)) return 'COMMUNITY_MISMATCH';
  if (listing.escrowMode !== 'onchain' && ctx.mintUrl && listing.mintUrl !== ctx.mintUrl) return 'FEDERATION_MISMATCH';
  return null;
}
