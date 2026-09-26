import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { publicConductTags, replayPublicConduct, readConductSpend, publicConductRecord } from './public-conduct.js';
import { applyEvent } from './state-machine.js';
import { parseEscrowEvent } from './event-parser.js';
import { EscrowEventKind as Kind, Outcome, Role, type EscrowPayload, type EscrowState, type NostrEvent } from './types.js';
const keys={buyer:new Uint8Array(32).fill(11),seller:new Uint8Array(32).fill(12),arbiter:new Uint8Array(32).fill(13)};
const identities={buyer:new Uint8Array(32).fill(31),seller:new Uint8Array(32).fill(32),arbiter:new Uint8Array(32).fill(33)};
const f=safetyFixture({buyer:btc.utils.pubSchnorr(keys.buyer),seller:btc.utils.pubSchnorr(keys.seller),arbiter:btc.utils.pubSchnorr(keys.arbiter)},2_000_000,'public-conduct-test');
let state:EscrowState|null=null, clock=Math.floor(Date.now()/1000);
const events:NostrEvent[]=[];
function emit(kind:Kind,role:Role,payload:EscrowPayload) {
 const tags=[['d',f.state.id],['t',payload.type],...(state?.eventChain.at(-1)?[['e',state.eventChain.at(-1)!.raw.id,'','reply']]:[])];
 const disclosure=state?publicConductTags(state,payload):[];
 const raw=finalizeEvent({kind,created_at:clock++,tags:[...tags,...disclosure],content:disclosure.length?JSON.stringify({encryptedFor:{private:'ciphertext'}}):JSON.stringify(payload)},identities[role]);
 const parsed=parseEscrowEvent(raw,JSON.stringify(payload));assert.ok(parsed.ok);
 const next=applyEvent(state,parsed.event);assert.ok(next.ok,next.ok?'':next.error.message);state=next.state;events.push(raw);return raw;
}
emit(Kind.CREATE,Role.SELLER,{...f.state.eventChain[0].payload,onchainPublicConduct:true} as EscrowPayload);
emit(Kind.JOIN,Role.BUYER,{type:'escrow:join',role:Role.BUYER,joinedAt:clock,escrowXonly:bytesToHex(btc.utils.pubSchnorr(keys.buyer))});
emit(Kind.JOIN,Role.SELLER,{type:'escrow:join',role:Role.SELLER,joinedAt:clock,fundingTerms:f.terms});
const fundingTxid='11'.repeat(32);
emit(Kind.LOCK,Role.SELLER,{type:'escrow:lock',notesHash:'',shares:[],onchain:{...f.terms,amountSats:'100000',fundingTxid,fundingVout:0},buyerPubkey:f.pks.buyer,arbiterPubkey:f.pks.arbiter,sellerReceivesMsats:100000000,arbiterFeeMsats:0,lockedAt:clock});
emit(Kind.VOTE,Role.BUYER,{type:'escrow:vote',outcome:Outcome.RELEASE,role:Role.BUYER,votedAt:clock});
emit(Kind.VOTE,Role.SELLER,{type:'escrow:vote',outcome:Outcome.RELEASE,role:Role.SELLER,votedAt:clock});
emit(Kind.RESOLVE,Role.BUYER,{type:'escrow:resolve',outcome:Outcome.RELEASE,majority:[Role.BUYER,Role.SELLER],arbiterInvolved:false,resolvedAt:clock});
const destination=btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(25)),undefined,SIGNET).address!;
const utxos=[{txid:fundingTxid,index:0,amountSats:100000n}];
const coop=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n});
const proposal=emit(Kind.SETTLEMENT,Role.BUYER,{type:'escrow:settlement',psbt:coop,role:Role.BUYER,leaf:'coop',payoutAddress:destination});
clock+=86400;
const dispute=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n,leaf:'dispute',fundingHeight:1,tipHeight:1000});
const payout={type:'escrow:settlement' as const,psbt:dispute,role:Role.BUYER,leaf:'arbiter' as const,payoutAddress:destination};
emit(Kind.SETTLEMENT_STALLED,Role.BUYER,{type:'escrow:settlement_stalled',proposalId:proposal.id,payout});
const signed=base64.encode(btc.PSBTCombine([base64.decode(coSignSettlement(dispute,keys.buyer)),base64.decode(coSignSettlement(dispute,keys.arbiter))]));
emit(Kind.SETTLEMENT,Role.BUYER,{...payout,psbt:signed,final:true});
const txid=btc.Transaction.fromPSBT(base64.decode(dispute),{allowUnknown:true,allowUnknownOutputs:true}).id;
for(const ordering of [events,[...events].reverse()]) {
 const replay=replayPublicConduct(ordering);assert.ok(replay,'outsider replays public evidence without decrypting');
 const spend=await readConductSpend(replay,async path=>path.includes('outspend')?{spent:true,txid}:{txid,status:{confirmed:true},vin:[{txid:fundingTxid,vout:0,witness:['sig',bytesToHex(f.escrow.leaves.dispute),'control']}]});
 assert.equal(spend?.leaf,'dispute');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend}],true).marks,1);
 assert.equal(publicConductRecord(f.pks.buyer,[{state:replay,spend}],true).marks,0);
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:null}],true).complete,false,'missing chain read is unknown');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:{...spend!,leaf:'coop'}}],true).marks,0,'signed dispute PSBT alone is not a chain mark');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:{...spend!,confirmed:false}}],true).marks,0,'mempool is not permanent conduct');
}
assert.equal(replayPublicConduct(events.map(e=>({...e,sig:'00'.repeat(64)}))),null,'forged evidence rejected');
assert.deepEqual(publicConductTags({...state!,onchainPublicConduct:undefined},{type:'escrow:vote',role:Role.SELLER,outcome:Outcome.RELEASE,votedAt:clock}),[],'legacy private history is never disclosed');
assert.deepEqual(publicConductTags(state!,{type:'escrow:chat',message:'secret',sentAt:clock} as EscrowPayload),[]);
console.log('PASS public conduct: signed outsider replay, both orderings, actual confirmed leaf, no forged/self-reported facts, unknown reads, legacy privacy');

// Standing: every sample is bounded by a signed counterparty reference.
const { conductStanding } = await import('./conduct-standing.js');
const completedState=state! as EscrowState;
const paid=completedState.eventChain.find(e=>e.kind===Kind.VOTE && e.pubkey===f.pks.buyer)!;
const records=[60,120,360].map((delay,index)=>{
 const response=f.event(Kind.SETTLEMENT,'seller',{type:'escrow:settlement',psbt:coSignSettlement(coop,keys.seller),leaf:'coop',role:Role.SELLER});
 response.timestamp=paid.timestamp+delay;response.prevEventId=paid.raw.id;
 return {state:{...completedState,id:`sample-${index}`,settlementStalled:undefined,settlements:[response as any]},spend:{txid,confirmed:true,leaf:'coop' as const}};
});
for(const ordering of [records,[...records].reverse()]) {
 const record=publicConductRecord(f.pks.seller,ordering,true);
 const standing=conductStanding(f.pks.seller,record,[],true);
 assert.deepEqual(standing.sellerSpeed,{medianSeconds:120,samples:3});
 assert.equal(standing.settledTrades,3);
 assert.equal(conductStanding(f.pks.seller,publicConductRecord(f.pks.seller,ordering.slice(0,2),true),[],true).sellerSpeed,null,'requires three samples');
 assert.equal(conductStanding(f.pks.seller,{...record,complete:false},[],true).settledTrades,null,'partial history is unknown, not zero');
 const unbound=ordering.map(row=>({...row,state:{...row.state,settlements:row.state.settlements!.map(e=>({...e,prevEventId:null}))}}));
 assert.equal(conductStanding(f.pks.seller,publicConductRecord(f.pks.seller,unbound,true),[],true).sellerSpeed,null,'no timing without a signed reference');
}
const empty=publicConductRecord(f.pks.seller,[],true);
assert.equal(conductStanding(f.pks.seller,empty,[],true).newHere,true);
assert.equal(conductStanding(f.pks.seller,{...empty,complete:false},[],true).newHere,false);
const bond={npub:f.pks.seller,address:'verified-address',funded:true,active:true,actualSats:100000n} as import('../bond-multisig/bond-announcement.js').VerifiedBond;
const bondProof={bond,fundedAtTime:100,tipTime:100+12*86400};
assert.deepEqual(conductStanding(f.pks.seller,empty,[bondProof,bondProof],true).bonded,{sats:'100000',days:12},'same bond advertised twice counts once');
assert.equal(conductStanding(f.pks.seller,empty,[{...bondProof,fundedAtTime:null}],true).bonded,null,'unknown funding time is not zero days');
console.log('PASS public standing: bounded signed speed, median minimum, ordering, unknown history, dated and deduplicated bonds, new-key distinction');
const arbitration=[30,180,300].map((delay,index)=>{
 const bv=f.event(Kind.VOTE,'buyer',{type:'escrow:vote',role:Role.BUYER,outcome:Outcome.RELEASE,votedAt:1});
 const sv=f.event(Kind.VOTE,'seller',{type:'escrow:vote',role:Role.SELLER,outcome:Outcome.REFUND,votedAt:1});
 const av=f.event(Kind.VOTE,'arbiter',{type:'escrow:vote',role:Role.ARBITER,outcome:Outcome.RELEASE,votedAt:1});
 av.timestamp=sv.timestamp+delay;av.prevEventId=sv.raw.id;
 return {state:{...completedState,id:`arb-${index}`,eventChain:[av,bv,sv]},spend:{txid,confirmed:true,leaf:'dispute' as const}};
});
assert.deepEqual(conductStanding(f.pks.arbiter,publicConductRecord(f.pks.arbiter,arbitration,true),[],true).arbiterSpeed,{medianSeconds:180,samples:3});
assert.deepEqual(conductStanding(f.pks.arbiter,publicConductRecord(f.pks.arbiter,[...arbitration].reverse(),true),[],true).arbiterSpeed,{medianSeconds:180,samples:3});
