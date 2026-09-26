import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { sortEventChain } from './event-parser.js';
import { applyEvent } from './state-machine.js';
import { stalledPayoutEligibility } from './onchain-stalled.js';
import { winnerSettlementChoice } from './onchain-settlement-choice.js';
import { onchainAttention } from './onchain-attention.js';
import { EscrowEventKind as Kind, EscrowStatus, Outcome, Role, type EscrowState, type ParsedEscrowEvent, type SettlementPayload, type SettlementStalledPayload } from './types.js';
const buyer=new Uint8Array(32).fill(11),seller=new Uint8Array(32).fill(12),arbiter=new Uint8Array(32).fill(13);
const f=safetyFixture({buyer:btc.utils.pubSchnorr(buyer),seller:btc.utils.pubSchnorr(seller),arbiter:btc.utils.pubSchnorr(arbiter)},2_000_000);
const now=Math.floor(Date.now()/1000);
const destination=btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(25)),undefined,SIGNET).address!;
const utxos=[{txid:'11'.repeat(32),index:0,amountSats:100000n}];
const coop=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n});
const proposal=f.event(Kind.SETTLEMENT,'buyer',{type:'escrow:settlement',psbt:coop,role:Role.BUYER,leaf:'coop',payoutAddress:destination}) as ParsedEscrowEvent<SettlementPayload>;
const state:EscrowState={...f.state,status:EscrowStatus.APPROVED,participants:{...f.state.participants,arbiter:f.pks.arbiter},
 lock:{...f.state.lock,lockedAt:now-90000,onchain:{...f.terms,amountSats:'100000',fundingTxid:utxos[0].txid,fundingVout:0}},
 resolvedAt:now-86400,resolvedOutcome:Outcome.RELEASE,resolvedMajority:[Role.BUYER,Role.SELLER],votes:{buyer:Outcome.RELEASE,seller:Outcome.RELEASE},settlements:[proposal]};
assert.equal(stalledPayoutEligibility(state,now-1)?.ready,false);
assert.equal(stalledPayoutEligibility(state,now)?.ready,true);
const dispute=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n,leaf:'dispute',fundingHeight:1,tipHeight:1000});
const payout: SettlementPayload={type:'escrow:settlement',psbt:dispute,role:Role.BUYER,leaf:'arbiter',payoutAddress:destination};
const request=f.event(Kind.SETTLEMENT_STALLED,'buyer',{type:'escrow:settlement_stalled',proposalId:proposal.raw.id,payout}) as ParsedEscrowEvent<SettlementStalledPayload>;
const early={...request,timestamp:now-1};
assert.equal(applyEvent(state,early).ok,false,'24-hour boundary');
assert.equal(applyEvent(state,{...request,pubkey:f.pks.seller}).ok,false,'only winner requests');
assert.equal(applyEvent({...state,votes:{buyer:Outcome.RELEASE}},request).ok,false,'requires other party release');
const signed={...proposal,pubkey:f.pks.seller,payload:{...proposal.payload,psbt:coSignSettlement(coop,seller),role:Role.SELLER}};
assert.equal(applyEvent({...state,settlements:[proposal,signed]},request).ok,false,'counter-signature prevents stall request');
assert.equal(applyEvent(state,{...request,payload:{...request.payload,payout:{...payout,payoutAddress:'wrong'}}}).ok,false,'cannot change destination');
for(const messages of [[proposal],[proposal].reverse()]) {
 const result=applyEvent({...state,settlements:messages},request);assert.ok(result.ok);
 assert.deepEqual(result.state.resolvedMajority,[Role.BUYER,Role.SELLER],'a request is not a ruling');
 assert.equal(winnerSettlementChoice(result.state)?.destination,destination);
 assert.equal(onchainAttention(result.state,f.pks.arbiter)?.actionable,true,'arbiter needs-you');
 const both=base64.encode(btc.PSBTCombine([base64.decode(coSignSettlement(dispute,buyer)),base64.decode(coSignSettlement(dispute,arbiter))]));
 const final=f.event(Kind.SETTLEMENT,'buyer',{...payout,psbt:both,final:true});
 const journal=applyEvent(result.state,final);assert.ok(journal.ok);
 const complete=f.event(Kind.COMPLETE,'buyer',{type:'escrow:complete',completedAt:now},[['settlement',final.raw.id]]);
 const done=applyEvent(journal.state,complete);assert.ok(done.ok);
 assert.equal(done.state.status,EscrowStatus.COMPLETED);
 assert.equal(done.state.onchainPayoutAddress,destination);
}
console.log('PASS stalled payout: 24-hour boundary, authority, release, absent counter-signature, destination pin, arbiter attention, signed completion');

const sameSecondSigned = f.event(Kind.SETTLEMENT, 'seller', {type:'escrow:settlement',psbt:coSignSettlement(coop,seller),role:Role.SELLER,leaf:'coop'});
sameSecondSigned.timestamp = request.timestamp;
for (const ordering of [[proposal, request, sameSecondSigned], [sameSecondSigned, request, proposal]]) {
  const ordered = sortEventChain([...f.state.eventChain, ...ordering]);
  assert.ok(ordered.indexOf(sameSecondSigned) < ordered.indexOf(request));
  assert.ok(ordered.indexOf(proposal) < ordered.indexOf(request));
}
