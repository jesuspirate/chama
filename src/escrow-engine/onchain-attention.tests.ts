import { applyEvent } from './state-machine.js';
import { deriveOnchainView } from './onchain-escrow-view.js';
import { payoutUsesTradeKey } from './onchain-settlement-choice.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnchainTradeControls } from '../ui/panels/OnchainTradeControls.js';
import { LangProvider } from '../i18n/index.js';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { EscrowEventKind as Kind, EscrowStatus, Outcome, Role, type EscrowState, type SettlementPayload, type ParsedEscrowEvent } from './types.js';
import { onchainAttention, observeOnchainAttention, type OnchainObservation } from './onchain-attention.js';
import { needsYouReasonFor, selectNeedsYouTrades } from '../ui/decisions.js';
import { notificationForTransition } from '../notifications/trade-notifications.js';
import { latestNotificationActivityAt } from '../notifications/notify-service.js';
const buyer=new Uint8Array(32).fill(11),seller=new Uint8Array(32).fill(12),arbiter=new Uint8Array(32).fill(13);
const f=safetyFixture({buyer:btc.utils.pubSchnorr(buyer),seller:btc.utils.pubSchnorr(seller),arbiter:btc.utils.pubSchnorr(arbiter)},2_000_000);
const created:EscrowState={...f.state,onchainFundingTerms:f.terms,participants:{...f.state.participants,arbiter:f.pks.arbiter}};
const locked:EscrowState={...created,status:EscrowStatus.LOCKED,fiatAmount:25.96,fiatCurrency:'USD',paymentMethods:['Strike'],
 lock:{...f.state.lock,lockedAt:Date.now()/1000,onchain:{...f.terms,amountSats:'100000',fundingTxid:'11'.repeat(32),fundingVout:0}}};
const paid={...locked,votes:{...locked.votes,[Role.BUYER]:Outcome.RELEASE}};
const approved:EscrowState={...paid,status:EscrowStatus.APPROVED,resolvedOutcome:Outcome.RELEASE,resolvedMajority:[Role.BUYER,Role.SELLER]};
function check(state:EscrowState, viewer:string, key:string, observation?:OnchainObservation) {
 assert.equal(onchainAttention(state,viewer,observation)?.key,key);
 assert.equal(selectNeedsYouTrades({escrows:[state],userPubkey:viewer,onchainObservations:new Map([[state.id,observation??{}]])})[0]?.id,state.id);
}
check(created,f.pks.seller,'deposit-check');check(created,f.pks.seller,'deposit',{deposit:'waiting',remainingSats:100000});check(created,f.pks.seller,'lock',{deposit:'confirmed'});
check(locked,f.pks.buyer,'pay',{depositSafe:true});assert.match(onchainAttention(locked,f.pks.buyer,{depositSafe:true})!.text,/25.96 USD via Strike/);
check(paid,f.pks.seller,'confirm-paid');check(approved,f.pks.buyer,'choose');
assert.equal(needsYouReasonFor(approved,f.pks.seller),null,'other signer waits for winner destination');
assert.equal(onchainAttention(approved,'stranger'),null);
for(const [prev,next,viewer] of [[f.state,created,f.pks.seller],[created,locked,f.pks.buyer],[locked,paid,f.pks.seller],[paid,approved,f.pks.buyer]] as const) {
 assert.ok(notificationForTransition(prev,next,viewer));
 assert.equal(notificationForTransition(next,next,viewer),null,'same stage does not buzz again');
}
for(const leaf of ['coop','dispute'] as const) for (const direct of [false, true]) {
 const state:EscrowState={...approved,resolvedMajority:leaf==='coop'?[Role.BUYER,Role.SELLER]:[Role.BUYER,Role.ARBITER]};
 const destination=btc.p2tr(btc.utils.pubSchnorr(direct ? new Uint8Array(32).fill(25) : buyer),undefined,SIGNET).address!;
 const psbt=buildSettlementPsbt({escrow:f.escrow,utxos:[{txid:'11'.repeat(32),index:0,amountSats:100_000n}],destination,feeSats:500n,leaf,fundingHeight:1,tipHeight:1000});
 const event=(role:'buyer'|'seller'|'arbiter',p:string,final=false)=>f.event(Kind.SETTLEMENT,role,{type:'escrow:settlement',psbt:p,role:role as Role,leaf:leaf==='coop'?'coop':'arbiter',payoutAddress:destination,final}) as ParsedEscrowEvent<SettlementPayload>;
 const proposal=event('buyer',psbt),offered={...state,settlements:[proposal]};
 const other=leaf==='coop'?'seller':'arbiter';
 const action=onchainAttention(offered,f.pks[other])!;
 check(offered,f.pks[other],action.key);assert.match(action.key,/sign:/);
 assert.ok(notificationForTransition(state,offered,f.pks[other]),'proposal arrival buzzes even though status stays APPROVED');
 assert.ok(latestNotificationActivityAt(offered)>=proposal.timestamp,'settlement transport is fresh activity');
 const unsignedClaim=event(other,psbt);
 assert.ok(onchainAttention({...offered,settlements:[proposal,unsignedClaim]},f.pks[other]),'claimed role without real signature cannot suppress alert');
 const signedBuyer=coSignSettlement(psbt,buyer),signedOther=coSignSettlement(psbt,leaf==='coop'?seller:arbiter);
 const partial={...offered,settlements:[proposal,event(other,signedOther)]};
 assert.equal(onchainAttention(partial,f.pks[other]),null);assert.ok(onchainAttention(partial,f.pks.buyer));
 const readyToSend={...partial,settlements:[...partial.settlements,event('buyer',signedBuyer)]};
 for (const pk of [f.pks.buyer,f.pks[other]]) assert.match(onchainAttention(readyToSend,pk)!.key,/^send:/,'both signed but not broadcast remains actionable after a crash');
 const final=event('buyer',base64.encode(btc.PSBTCombine([base64.decode(signedBuyer),base64.decode(signedOther)])),true);
 const beforeComplete={...offered,settlements:[proposal,final]};
 const complete=f.event(Kind.COMPLETE,'buyer',{type:'escrow:complete',completedAt:Date.now()/1000},[['settlement',final.raw.id]]);
 const replay=applyEvent(beforeComplete,complete);
 assert.ok(replay.ok);
 const done=replay.state;
 assert.equal(done.onchainPayoutAddress,destination);
 assert.equal(payoutUsesTradeKey(done),!direct);
 const legacy={...done,onchainPayoutTxid:undefined,onchainPayoutAddress:undefined,onchainPayoutSats:undefined};
 const legacyView=deriveOnchainView({state:legacy,viewerRole:Role.BUYER,recomputedAddress:null});
 assert.equal(legacyView.payoutTxid,null);
 assert.equal(legacyView.fundingTxid,'11'.repeat(32));
 const legacyHtml=renderToStaticMarkup(createElement(LangProvider,null,createElement(OnchainTradeControls,{state:legacy,pubkey:f.pks.buyer})));
 assert.match(legacyHtml,/Deposit/);
 assert.doesNotMatch(legacyHtml,/See it on-chain/);

 const txid=btc.Transaction.fromPSBT(base64.decode(psbt),{allowUnknown:true,allowUnknownOutputs:true}).id;
 assert.equal(done.onchainPayoutTxid,txid);
 const view=deriveOnchainView({state:done,viewerRole:Role.BUYER,recomputedAddress:null});
 assert.equal(view.payoutTxid,txid);
 for (const confirmed of [false,true]) {
  const obs=await observeOnchainAttention(done,async path=>{assert.equal(path,`/tx/${txid}/status`);return {confirmed};});
  const html=renderToStaticMarkup(createElement(LangProvider, null, createElement(OnchainTradeControls,{state:done,pubkey:f.pks.buyer,onchainObservation:obs})));
  assert.match(html,confirmed ? /Payout confirmed · 99,500 sats/ : /Payout sent · waiting for confirmation/);
  assert.ok(html.includes(`/tx/${txid}`));
  const recoveryHtml=renderToStaticMarkup(createElement(LangProvider,null,createElement(OnchainTradeControls,{state:done,pubkey:f.pks.buyer,onchainObservation:obs,onScanMyOnchainPayouts:async()=>({payouts:[],balanceSats:0n}),onSweepOnchainPayout:async()=>{throw Error('not used');}})));
  assert.equal(recoveryHtml.includes('YOUR ON-CHAIN PAYOUT'),!direct);
  assert.equal(obs.payout?.sats,'99500');assert.equal(obs.payout?.destination,destination);
  for(const pk of [f.pks.buyer,f.pks.seller]) {
   assert.equal(onchainAttention(done,pk,obs)?.actionable,false);
   assert.equal(onchainAttention(done,pk,obs)?.key,`${confirmed?'confirmed':'broadcast'}:${txid}`);
  }
 }
 assert.equal(notificationForTransition(offered,done,f.pks.buyer),null,'COMPLETE is not chain confirmation');
}
check(locked,f.pks.seller,'refund',{refundAvailable:true});
assert.equal(onchainAttention(locked,f.pks.buyer,{refundAvailable:true}),null);
const refunded={refundSpent:true};assert.equal(onchainAttention(locked,f.pks.seller,refunded),null);
const observation=await observeOnchainAttention(created,async path=>path==='/blocks/tip/height'?2_000_001:[{value:100000,status:{confirmed:true}}]);
assert.equal(observation.refundAvailable,true);
console.log('PASS on-chain attention: deposit, lock, pay, confirm, choose, real coop/dispute signatures, verified broadcast/confirmation, refund, outsiders, freshness and duplicate transitions');

const partialDeposit=await observeOnchainAttention(created,async path=>path==='/blocks/tip/height'?1_999_000:[{value:40000,status:{confirmed:true}}]);
assert.equal(partialDeposit.remainingSats,60000);
assert.match(onchainAttention(created,f.pks.seller,partialDeposit)!.text,/Send 60,000 more sats/);
check(created,f.pks.seller,'top-up:60000',partialDeposit);
assert.equal(selectNeedsYouTrades({escrows:[created],userPubkey:f.pks.seller,onchainObservations:new Map([[created.id,{deposit:'seen',remainingSats:0}]])}).length,0,'pending full deposit never asks for a second payment');
