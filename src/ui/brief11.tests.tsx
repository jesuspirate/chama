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
for (const status of [EscrowStatus.COMPLETED, EscrowStatus.CANCELLED, EscrowStatus.EXPIRED]) {
 assert.equal(tradeDetailReturnsHome({status} as EscrowState,false),true,`${status} goes Home`);
}
assert.equal(tradeDetailReturnsHome({status:EscrowStatus.CLAIMED,resolvedOutcome:Outcome.REFUND} as EscrowState,false,true),true,'Confirmed refund payout goes Home before COMPLETE arrives');
assert.equal(tradeDetailReturnsHome(null,false),false);
console.log('PASS brief 12: active offers retain navigation, terminal trades and settled refunds return Home');
