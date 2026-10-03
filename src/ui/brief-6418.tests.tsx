import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EscrowClient } from '../escrow-engine/escrow-client.js';
import { NsecSigner } from '../escrow-engine/nsec-signer.js';
import { parseEscrowEvent } from '../escrow-engine/event-parser.js';
import { replayEventChain } from '../escrow-engine/state-machine.js';
import { EscrowStatus, Role, Outcome, type EscrowState, type NostrEvent, type ChatPayload, type ParsedEscrowEvent } from '../escrow-engine/types.js';
import { marketDelivery, MARKET_DELIVERIES } from '../labels/market-delivery.js';
import { expectedLockerRole } from '../escrow-engine/lock-custody.js';
import { notificationForTransition, chatNotificationFor } from '../notifications/trade-notifications.js';
import { billPayQuote, satsWithPremium } from '../payments/bill-pay-quote.js';
import { LangProvider, translate } from '../i18n/index.js';
import { LiveTradeSurface } from './screens/LiveTradeSurface.js';
import { AssistedCanvas, type AssistedCanvasResume } from './screens/AssistedCanvas.js';

const signer = new NsecSigner('11'.repeat(32));
const seller = await signer.getPublicKey(), buyer = 'b'.repeat(64), arbiter = 'c'.repeat(64);
const client = new EscrowClient(signer, {relays:[]});
(client as any).relayManager.publish = async (_event:NostrEvent) => ({accepted:1,rejected:0,errors:[]});
const names = {[seller]:'Bitcrazy',[buyer]:'Bestie',[arbiter]:'Judge'};
const room = (state:EscrowState, pubkey:string) => renderToStaticMarkup(<LangProvider><LiveTradeSurface
 state={state} pubkey={pubkey} profileNames={names} kind0Enabled onBack={()=>{}} onOpenFullView={()=>{}}
 onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
try {
 for (const delivery of MARKET_DELIVERIES) {
  const state = (await client.createEscrow({description:'Delivery test', category:'marketplace', delivery,
   amountMsats:3_000_000, mintUrl:'test-only', communityArbiters:[arbiter]})).state;
  const replay = replayEventChain(state.eventChain);
  assert.ok(replay.ok);
  assert.equal(replay.state.delivery, delivery, 'signed CREATE retains delivery on cold replay');
  assert.equal(replay.state.fulfillment, delivery === 'ship' || delivery === 'meet' ? 'physical' : delivery);
  assert.equal(expectedLockerRole(state.category), Role.BUYER, 'delivery never changes custody');
  const raw = state.eventChain[0].raw;
  const payload = state.eventChain[0].payload;
  assert.equal(parseEscrowEvent(raw,JSON.stringify({...payload,delivery:'unknown'}),true).ok,false);
  const seated = {...state,participants:{seller,buyer,arbiter}};
  const locked = {...seated,status:EscrowStatus.LOCKED,lock:{...state.lock,notesHash:'a'.repeat(64),lockedAt:Date.now()/1000}};
  assert.ok(notificationForTransition(seated,locked,seller,undefined,undefined,names)?.body.includes(translate('en',`notify.marketAction${delivery}`)));
  assert.ok(room(locked,seller).includes(translate('en',`lts.deed${delivery}`)));
  assert.ok(room(locked,seller).includes(translate('en',`lts.mark${delivery}`)));
  const voted = {...locked,votes:{[Role.SELLER]:Outcome.RELEASE}} as EscrowState;
  assert.ok(room(voted,buyer).includes(translate('en',`lts.receipt${delivery}`)));
  const approved = {...voted,status:EscrowStatus.APPROVED,resolvedOutcome:Outcome.RELEASE};
  assert.match(notificationForTransition(locked,approved,seller,undefined,undefined,names)!.body,/3,000 sats are ready/);
  assert.match(notificationForTransition(locked,approved,buyer,undefined,undefined,names)!.body,/sats go to Bitcrazy/);
  assert.equal(notificationForTransition(locked,approved,arbiter),null);
  assert.match(room(approved,buyer),/Resolved — 3,000 sats go to Bitcrazy/);
  assert.doesNotMatch(room(approved,buyer),/released to the buyer/);
 }
 const defaultListing = (await client.createEscrow({description:'Default shipping',category:'marketplace',amountMsats:3_000_000,mintUrl:'test-only'})).state;
 assert.equal(defaultListing.delivery,'ship');
 for (const fulfillment of ['physical','service','digital'] as const) {
  assert.equal(marketDelivery({fulfillment}),fulfillment === 'physical' ? 'ship' : fulfillment,'old CREATE retains its delivery meaning');
 }
 const chatState = {...defaultListing,status:EscrowStatus.LOCKED,participants:{seller,buyer,arbiter}};
 for (const [attachments,text] of [[undefined,'New message'],[[{url:'test-photo'}],'Sent a photo']] as const) {
  const message = {raw:{id:'photo'},pubkey:buyer,timestamp:Date.now()/1000,
   payload:{type:'escrow:chat',message:'',senderRole:Role.BUYER,attachments}} as unknown as ParsedEscrowEvent<ChatPayload>;
  assert.equal(chatNotificationFor(chatState,message,seller,'on',0)?.message,text,'fallback stays inside the messaging card');
 }
} finally { client.disconnect(); }

// Odd sat amounts expose a floor/ceil mismatch between review and public card.
for (const [base,bps] of [[101,500],[12345,175],[3,5000],[1000,0]]) {
 const quote = billPayQuote(base,bps);
 assert.equal(quote.total,satsWithPremium(base,bps));
 assert.equal(quote.base+quote.bonus,quote.total);
 assert.equal(quote.total,Math.ceil(base*(10000+bps)/10000));
}
const resume:AssistedCanvasResume = {at:Date.now(),surface:'terms',bring:'goods',want:'sats',detail:'A service',detailMax:'',
 terms:'3000',delivery:'service',paymentRails:[],matches:[],goodsMatches:[],matchWhy:null,premiumBps:500,premiumMode:'preset',premiumInput:''};
const canvas = renderToStaticMarkup(<LangProvider><AssistedCanvas listings={[]} browseCommunity="us-usd" viewerPubkey={seller}
 listingsLoading={false} onBrowse={()=>{}} onCreate={()=>{}} onMoreOptions={()=>{}} onOpenTrade={()=>{}}
 resumeRef={{current:resume}} /></LangProvider>);
for (const mode of MARKET_DELIVERIES) assert.ok(canvas.includes(translate('en',`canvas.delivery${mode}`)));
assert.match(canvas,/<button[^>]*aria-pressed="true"[^>]*>Service<\/button>/);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({USD:100000,data:{amount:'100000'},result:{XXBTZUSD:{c:['100000']}}}));
const {subscribeBitcoinPrice} = await import('../markets/bitcoin-price.js');
let unsubscribe:()=>void = ()=>{};
try {
 await new Promise<void>(resolve => { unsubscribe = subscribeBitcoinPrice(price => {if(price.source === 'live') resolve();}); });
 const billReview = renderToStaticMarkup(<LangProvider><AssistedCanvas listings={[]} browseCommunity="us-usd" viewerPubkey={seller}
  listingsLoading={false} onBrowse={()=>{}} onCreate={()=>{}} onMoreOptions={()=>{}} onOpenTrade={()=>{}}
  resumeRef={{current:{...resume,surface:'publish',bring:'bill',detail:'100',terms:'utilities',premiumBps:500}}} /></LangProvider>);
 assert.match(billReview,/100,000 sats bill \+ 5,000 sats bonus = 105,000 sats to you/);
 assert.match(billReview,/≈ 105.00 USD<\/div>/, 'the fiat equivalent includes the volunteer bonus');
} finally { unsubscribe(); globalThis.fetch = originalFetch; }
console.log('PASS 6.4.18: signed delivery replay, custody unchanged, all delivery actions, payout recipients, chat fallback, bill rounding and guided pills');
