import { tradeDetailReturnsHome } from "./decisions.js";
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveTradeSurface } from './screens/LiveTradeSurface.js';
import { EscrowStatus, Role, Outcome, type EscrowState } from '../escrow-engine/types.js';
import { payoutRecipientFor } from '../escrow-engine/recipients.js';
import { LangProvider } from '../i18n/index.js';
import { readKind0Toggle, writeKind0Toggle, generatedNameFor } from './nostr-profiles.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { listSavedHandles, SAVED_HANDLES_STORAGE_KEY } from '../payments/saved-handles.js';
import { readPreferredRails, savePreferredRails } from '../payments/preferred-rails.js';
const values=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
const buyer='b'.repeat(64),seller='a'.repeat(64),arbiter='c'.repeat(64);
const profiles={[buyer]:'Bestie',[seller]:'Jetty',[arbiter]:'Judge'};
const onchainCreated={provenance:'chain',id:'onchain-created',category:'p2p-trade',status:EscrowStatus.CREATED,escrowMode:'onchain',amountMsats:30_000_000,description:'Bitcoin offer',createdAt:Date.now()/1000,expiresAt:Date.now()/1000+86400,
 participants:{buyer,seller,arbiter},initiator:{pubkey:seller},lock:{notesHash:null,lockedAt:null},votes:{},eventChain:[],chatMessages:[],communityArbiters:[arbiter]} as unknown as EscrowState;
const onchainSellerHtml=renderToStaticMarkup(<LangProvider><LiveTradeSurface state={onchainCreated} pubkey={seller} onBack={()=>{}} onOpenFullView={()=>{}} onLock={async()=>{ throw new Error('ecash funding must not open'); }} onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
assert.match(onchainSellerHtml,/Open on-chain funding/);
assert.doesNotMatch(onchainSellerHtml,/Fund &amp; lock|Fund & lock|insurance/,'on-chain simple view never offers the ecash funding action');
const onchainBuyerHtml=renderToStaticMarkup(<LangProvider><LiveTradeSurface state={{...onchainCreated,onchainFundingTerms:{}} as EscrowState} pubkey={buyer} profileNames={profiles} kind0Enabled onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
assert.match(onchainBuyerHtml,/Waiting for Jetty&#x27;s deposit on Bitcoin/);
for(const category of ['p2p-trade','bill-pay','marketplace','lending']) {
 const trade={provenance:'chain',id:'test',category,status:EscrowStatus.LOCKED,amountMsats:1000000,description:'Test',createdAt:Date.now()/1000,expiresAt:Date.now()/1000+86400,
 participants:{buyer,seller,arbiter},lock:{notesHash:'locked',lockedAt:Date.now()/1000,handle:{rail:'strike',value:'PRIVATE-HANDLE',networks:['strike']}},votes:{},eventChain:[],chatMessages:[],communityArbiters:[arbiter]} as unknown as EscrowState;
 const recipient=payoutRecipientFor(trade,Outcome.RELEASE)!;
 for(const viewer of [buyer,seller]){
  const first=viewer===recipient.pubkey;
  const state=first?trade:{...trade,votes:{[recipient.role]:{outcome:Outcome.RELEASE,timestamp:Date.now()/1000,pubkey:recipient.pubkey}}} as EscrowState;
  const html=renderToStaticMarkup(<LangProvider><LiveTradeSurface state={state} pubkey={viewer} profileNames={profiles} kind0Enabled onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
  assert.ok(html.includes(first?'come to you.':`release to ${profiles[recipient.pubkey]}.`),`${category} ${viewer}: correct release direction`);
  assert.ok(html.includes('How to pay') && html.includes('PRIVATE-HANDLE'));
 }
 const unchecked = { ...trade, escrowMode: 'onchain', lock: { ...trade.lock, onchain: { address: 'untrusted' } } } as unknown as EscrowState;
 const uncheckedHtml=renderToStaticMarkup(<LangProvider><LiveTradeSurface state={unchecked} pubkey={buyer} onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
 assert.ok(uncheckedHtml.includes('Checking the deposit on the blockchain'));
 assert.ok(!uncheckedHtml.includes('How to pay') && !uncheckedHtml.includes('PRIVATE-HANDLE'), 'On-chain guided room withholds payment instructions before independent verification');
 const publicHtml=renderToStaticMarkup(<LangProvider><LiveTradeSurface state={trade} pubkey={'d'.repeat(64)} onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} /></LangProvider>);
 assert.ok(!publicHtml.includes('PRIVATE-HANDLE'),'Unseated viewers never receive handle markup');
}
assert.equal(readKind0Toggle(buyer),true);writeKind0Toggle(buyer,false);assert.equal(readKind0Toggle(buyer),false);assert.equal(readKind0Toggle(seller),true);
assert.equal(generatedNameFor(buyer),generatedNameFor(buyer.toUpperCase()));
values.set(SAVED_HANDLES_STORAGE_KEY,JSON.stringify([{id:'legacy',rail:'strike',handle:'legacy-name',visibility:'private',createdAt:1}]));
setLocalStorageUserScope(buyer);assert.equal(listSavedHandles()[0].handle,'legacy-name');
assert.equal(values.has(SAVED_HANDLES_STORAGE_KEY),false,'Legacy handles migrate once');
savePreferredRails(['strike','cash-app']);
setLocalStorageUserScope(seller);assert.deepEqual(listSavedHandles(),[]);assert.deepEqual(readPreferredRails(),[]);
setLocalStorageUserScope(buyer);assert.equal(listSavedHandles()[0].handle,'legacy-name');assert.deepEqual(readPreferredRails(),['strike','cash-app']);
console.log('PASS brief 11: eight voter directions, participant-only payment details, names default/opt-out, scoped handle migration and method preferences');

for (const status of [EscrowStatus.CREATED, EscrowStatus.LOCKED, EscrowStatus.APPROVED, EscrowStatus.CLAIMED]) {
 const state = { status, resolvedOutcome: Outcome.REFUND } as EscrowState;
 assert.equal(tradeDetailReturnsHome(state,false),false,`${status} keeps Offers before settlement`);
 assert.equal(tradeDetailReturnsHome(state,true),true,'Home-opened trades still go Home');
}
// v7 redesign (Jet, 2026-10-06): only a fully successful trade returns Home;
// failures send the buyer back to the offers to try again.
assert.equal(tradeDetailReturnsHome({status:EscrowStatus.COMPLETED,resolvedOutcome:Outcome.RELEASE} as EscrowState,false),true,'a completed release goes Home');
for (const status of [EscrowStatus.CANCELLED, EscrowStatus.EXPIRED]) {
 assert.equal(tradeDetailReturnsHome({status} as EscrowState,false),false,`${status} goes back to the offers`);
}
assert.equal(tradeDetailReturnsHome({status:EscrowStatus.COMPLETED,resolvedOutcome:Outcome.REFUND} as EscrowState,false),false,'a completed refund goes back to the offers');
assert.equal(tradeDetailReturnsHome({status:EscrowStatus.CLAIMED,resolvedOutcome:Outcome.REFUND} as EscrowState,false,true),false,'a settled refund goes back to the offers');
assert.equal(tradeDetailReturnsHome(null,false),false);
console.log('PASS brief 12 (v7): active and failed trades return to the offers; only a completed release returns Home');
