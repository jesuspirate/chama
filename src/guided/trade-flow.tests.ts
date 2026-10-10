import assert from 'node:assert/strict';
import { EscrowStatus, JOIN_HOLD_LOCK_GRACE_SECONDS as GRACE, Role, type EscrowState } from '../escrow-engine/types.js';
import { countCounterDemand } from './counter-demand.js';
import { matchGuidedListings } from './match-listings.js';
import { listingCommunityMatches } from './offer-eligibility.js';
const now = 1800000000, viewer = 'b'.repeat(64), seller = 'a'.repeat(64);
const intent = {version:1,direction:'buy_sats',amountSats:1000,paymentRails:['strike'],strategy:'available_now',community:'us-usd',mintUrl:'fed1same'} as const;
const listing = (id: string, override: Partial<EscrowState> = {}) => ({id,category:'p2p-trade',status:EscrowStatus.CREATED,community:'us-usd',mintUrl:'fed1same',amountMsats:1000000,paymentMethods:['strike'],expiresAt:now+3600,participants:{seller,buyer:null,arbiter:null},initiator:{pubkey:seller,role:Role.SELLER},fees:{platformMsats:0,arbiterMsats:0},joinHolds:{},...override}) as EscrowState;
const hold = (pubkey: string, expiresAt: number) => ({[Role.BUYER]:{pubkey,expiresAt,joinedAt:now-100,role:Role.BUYER,eventId:'join'}});
const inputs = [
 listing('valid'),listing('untagged',{community:undefined}),listing('other-community',{community:'ke-kes'}),
 listing('own-seller',{participants:{seller:viewer,buyer:null,arbiter:null}}),
 listing('own-author-other-seller',{initiator:{pubkey:viewer,role:Role.BUYER}}),
 listing('foreign',{mintUrl:'fed1other'}),listing('bitcoin',{mintUrl:'fed1other',escrowMode:'onchain'}),
 listing('held',{joinHolds:hold('c'.repeat(64),now+10)}),listing('grace',{joinHolds:hold('c'.repeat(64),now-1)}),
 listing('own-hold',{joinHolds:hold(viewer,now+10)}),listing('lapsed',{joinHolds:hold('c'.repeat(64),now-GRACE)}),
 listing('listing-expired',{listingExpiresAt:now,expiresAt:now+100}),listing('no-seller',{participants:{seller:null,buyer:null,arbiter:null}}),
].map(listing=>({listing}));
const ctx={viewerPubkey:viewer,community:intent.community,mintUrl:intent.mintUrl,nowSec:now};
for (const rows of [inputs,...inputs.map(row=>[row]),[...inputs].reverse()]) {
 const counted=countCounterDemand('cash','sats',rows,ctx);
 const matched=matchGuidedListings({...intent,paymentRails:[...intent.paymentRails]},rows,{viewerPubkey:viewer,nowSec:now,limit:20});
 assert.deepEqual([...counted.listingIds].sort(),matched.candidates.map(c=>c.listing.id).sort());
 assert.equal(counted.count,matched.candidates.length);
}
assert.deepEqual(countCounterDemand('cash','sats',inputs,ctx).listingIds,['valid','own-author-other-seller','bitcoin','own-hold','lapsed']);
assert.equal(listingCommunityMatches(undefined,'us-usd'),false);
assert.equal(listingCommunityMatches('ke-kes','us-usd'),false);
assert.equal(listingCommunityMatches(' US-USD ','us-usd'),true);
console.log('PASS trade flow: count/matcher parity for untagged, seller-vs-author, federations, own/other/grace/lapsed holds, expiry and missing seats; shared community rule');
