import { selectWakeNotifications, wakeNotification } from '../notifications/wake-replay.js';
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
 assert.equal(wakeNotification(offered, state, f.pks[other], {[f.pks.buyer]:'Bestie'})?.body, 'Sign the payout to Bestie');
 assert.equal(wakeNotification(offered, state, 'stranger'), null);
 const snapshot={pubkey:f.pks[other],events:[],relays:[],names:{[f.pks.buyer]:'Bestie'}};
 const wake=selectWakeNotifications([offered],new Map([[state.id,state]]),snapshot,proposal.timestamp*1000,[]);
 assert.equal(wake[0]?.body,'Sign the payout to Bestie','auxiliary settlement in the last-wake second is fresh');
 assert.equal(selectWakeNotifications([offered],new Map(),snapshot,proposal.timestamp*1000,[wake[0].tag]).length,0,'repeated wake stays silent');
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

// Brief 03: empty lapsed rooms are ordinary history, not forever attention.
const { preLockDeadline, getEffectiveParticipantsAt, isLateOnchainDeposit } = await import('./types.js');
const { shouldShowOnBrowse } = await import('../ui/decisions.js');
const now = Math.floor(Date.now()/1000);
const lapsed: EscrowState = {...created, joinHolds:{...created.joinHolds,
  buyer:{...created.joinHolds!.buyer!, pubkey:f.pks.buyer, expiresAt:now-1000}}, expiresAt:now+3600};
const deadline = preLockDeadline(lapsed,now)!;
assert.ok(deadline.lapsed);
for (const observation of [undefined, {deposit:'waiting' as const,receivedSats:0}]) {
  for (const viewer of [f.pks.buyer,f.pks.seller,f.pks.arbiter]) {
    assert.equal(needsYouReasonFor(lapsed,viewer,now,undefined,observation),null);
    assert.equal(selectNeedsYouTrades({escrows:[lapsed],userPubkey:viewer,nowSec:now,onchainObservations:new Map([[lapsed.id,observation??{}]])}).length,0);
  }
  assert.equal(getEffectiveParticipantsAt(lapsed,now,observation).buyer,null);
}
assert.ok(shouldShowOnBrowse({escrow:lapsed,browseCategory:'p2p-trade',nowSec:now}));
for (const deposit of ['seen','confirmed','waiting'] as const) {
  const observation:OnchainObservation={deposit,receivedSats:deposit==='waiting'?1:100000,depositSeenAt:now};
  assert.equal(onchainAttention(lapsed,f.pks.seller,observation,now)?.key,'lapsed-deposit');
  assert.equal(onchainAttention(lapsed,f.pks.buyer,observation,now),null);
  assert.equal(needsYouReasonFor(lapsed,f.pks.seller,now,undefined,observation),'onchain');
  assert.equal(getEffectiveParticipantsAt(lapsed,now,observation).buyer,f.pks.buyer);
  assert.ok(isLateOnchainDeposit(lapsed,observation,now));
  const html=renderToStaticMarkup(createElement(LangProvider,null,createElement(OnchainTradeControls,{state:lapsed,pubkey:f.pks.seller,onchainObservation:observation})));
  assert.match(html,/A deposit reached a lapsed trade/);
  assert.doesNotMatch(html,/bitcoin:|Check deposit|Send.*to this address/);
}
const timely:OnchainObservation={deposit:'seen',receivedSats:100000,depositSeenAt:deadline.at-1};
assert.equal(isLateOnchainDeposit(lapsed,timely,now),false);
assert.equal(onchainAttention(lapsed,f.pks.seller,timely,now),null);
assert.equal(onchainAttention(lapsed,f.pks.seller,{...timely,deposit:'confirmed'},now)?.key,'lock');
assert.equal(getEffectiveParticipantsAt(lapsed,now,timely).buyer,f.pks.buyer);
const emptyHtml=renderToStaticMarkup(createElement(LangProvider,null,createElement(OnchainTradeControls,{state:lapsed,pubkey:f.pks.seller,onchainObservation:{deposit:'waiting',receivedSats:0}})));
assert.match(emptyHtml,/address is retired/);assert.doesNotMatch(emptyHtml,/bitcoin:/);
const observedPartial=await observeOnchainAttention(lapsed,async path=>path==='/blocks/tip/height'?1_999_000:[{value:1,status:{confirmed:false}}]);
assert.equal(observedPartial.receivedSats,1);
assert.ok(isLateOnchainDeposit(lapsed,observedPartial,now+1));
const preserved=await observeOnchainAttention(lapsed,async path=>path==='/blocks/tip/height'?1_999_000:[{value:100000,status:{confirmed:true,block_time:now}}],timely);
assert.equal(preserved.depositSeenAt,timely.depositSeenAt,'confirmation does not forget an on-time mempool observation');
const ecashLapsed={...lapsed,escrowMode:'ecash' as const,onchainFundingTerms:undefined};
assert.equal(needsYouReasonFor(ecashLapsed,f.pks.buyer,now),null);
assert.equal(needsYouReasonFor(ecashLapsed,f.pks.seller,now),null);
console.log('PASS lapsed locks: empty quiet/browsable/released, late partial and full deposits recoverable, timely deposits frozen, retired address never offered');

const expiredUnfunded={...lapsed,status:EscrowStatus.EXPIRED};
assert.equal(onchainAttention(expiredUnfunded,f.pks.seller,{deposit:'waiting'},now),null);
assert.equal(onchainAttention(expiredUnfunded,f.pks.seller,{deposit:'seen',depositSeenAt:now},now)?.key,'lapsed-deposit');
const { LiveTradeSurface } = await import('../ui/screens/LiveTradeSurface.js');
const room = (observation?:OnchainObservation) => renderToStaticMarkup(createElement(LangProvider,null,createElement(LiveTradeSurface,{
 state:lapsed,pubkey:f.pks.seller,onBack:()=>{},onOpenFullView:()=>{},onRepost:async()=>{},onVote:async()=>{},onSendChat:async()=>{},
 onchainActions:{onchainObservation:observation},
})));
assert.match(room({deposit:'waiting',receivedSats:0}),/Nothing was taken/);
assert.match(room({deposit:'seen',receivedSats:100000,depositSeenAt:now}),/A deposit reached a lapsed trade/);
assert.doesNotMatch(room({deposit:'seen',receivedSats:100000,depositSeenAt:now}),/Nothing was taken/);
assert.doesNotMatch(room(timely),/Nothing was taken|lock window ended/i);
