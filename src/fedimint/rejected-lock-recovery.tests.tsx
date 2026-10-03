import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {chain} from '../escrow-engine/two-truths.tests.js';
import { EscrowEventKind as K, Role } from '../escrow-engine/types.js';
import { replayEventChain, applyEvent } from '../escrow-engine/state-machine.js';
import { sortEventChain } from '../escrow-engine/event-parser.js';
import {hashNotes} from './fedimint-client.js';
import {rejectedLockRecovery} from './rejected-lock-recovery.js';
import {stashNativeLockIntent, upgradeNativeLockToSpent, markNativeLockPublishAttempted, getPendingNativeLock, recoverPendingNativeLock} from './pending-native-locks.js';
import {setLocalStorageUserScope} from '../storage/user-scope.js';
import {needsYouReasonFor, selectNeedsYouTrades, decideChamaBarLabel} from '../ui/decisions.js';
import {isExpiredUnfundedListing} from '../escrow-engine/expired-listing.js';
import {RejectedLockRefund} from '../ui/screens/TradeDetail.js';
const data = new Map<string,string>();
Object.assign(globalThis, {localStorage: {getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => data.set(k,v), removeItem: (k:string) => data.delete(k)}});
setLocalStorageUserScope('refused-lock-test');
const notes = 'test-only-bearer-notes';
const lock = chain.find(e => e.kind === K.LOCK)!;
(lock.payload as any).notesHash = await hashNotes(notes);
const r = replayEventChain(sortEventChain(chain)); assert(r.ok);
const state = r.state;
const owner = lock.pubkey;
const input = {escrowId: state.id, amountMsats: 170000, federationId: 'test-fed'};
stashNativeLockIntent(input); upgradeNativeLockToSpent({...input, oobNotes: notes}); markNativeLockPublishAttempted(state.id);
const entry = getPendingNativeLock(state.id)!;
state.rejectedLockRecovery = rejectedLockRecovery(state, entry, owner);
assert(state.rejectedLockRecovery);
assert.equal(rejectedLockRecovery(state, entry, state.participants[Role.BUYER]), undefined);
assert(rejectedLockRecovery({...state, provenance:'summary'}, entry, owner), 'retained positive refusal remains recovery evidence regardless of display provenance');
for (const status of ['CREATED', 'CANCELLED', 'EXPIRED'] as const) {
  assert(rejectedLockRecovery({...state, status: status as any}, entry, owner));
}
const {isPartialReplayDowngrade} = await import('../escrow-engine/escrow-client.js');
assert.equal(isPartialReplayDowngrade({...state, status: 'LOCKED' as any, eventChain: [...state.eventChain, lock]}, state), false, 'quarantined LOCK corrects stale cache');
assert.equal(isPartialReplayDowngrade({...state, status: 'LOCKED' as any}, {...state, rejectedLocks: []}), true, 'mere absence still preserves known custody');
assert.equal(rejectedLockRecovery(state, {...entry,oobNotes:'different-notes'}, owner), undefined);
assert.equal(needsYouReasonFor(state, owner, 1790900000), 'funding-refund');
assert.equal(isExpiredUnfundedListing(state, 1790900000), false, 'expired listing keeps recoverable funding visible');
assert.equal(isExpiredUnfundedListing({...state,rejectedLockRecovery:undefined}, 1790900000), false, 'missing-note room remains visible from the quarantined witness');
const urgent = selectNeedsYouTrades({escrows:[state], userPubkey:owner, nowSec:1790900000});
assert.deepEqual(decideChamaBarLabel({needsYouCount:urgent.length, balanceMsats:4000, hasActiveBuyerSellerCommitment:false}), {kind:'needs-you',count:1});
const html = renderToStaticMarkup(createElement(RejectedLockRefund, {amountMsats:170000,onReclaim:async()=>{}}));
assert.match(html, /Take your 170 sats back/);
assert.match(html, /This lock didn&#x27;t reach the trade/);
const { LiveTradeSurface } = await import('../ui/screens/LiveTradeSurface.js');
const room = renderToStaticMarkup(createElement(LiveTradeSurface, {
  state: {...state, status: 'CANCELLED' as any}, pubkey: owner,
  onBack: () => {}, onOpenFullView: () => {}, onVote: async () => {},
  onSendChat: async () => {}, onReclaimRejectedLock: async () => {},
}));
assert.match(room, /Take your 170 sats back/);
assert.doesNotMatch(room, /Nothing was locked/);
let balance = 4000, calls = 0;
const deps = {loadEscrow: async()=>state, getConnectedRelayCount:()=>1, currentFederationId:()=> 'test-fed', hashNotes,
 redeemNotes:async()=>{throw Error('legacy success is not a credit receipt');},
 redeemRejectedNotes:async(e:typeof entry)=>{assert.equal(e.oobNotes,notes);calls++;balance+=170000;}, now:()=>1790900000000};
assert.equal(calls,0);
assert.equal(await recoverPendingNativeLock(entry,{...deps,currentFederationId:()=> 'other'}, {reclaimRejected:true}), 'kept');
assert.equal(await recoverPendingNativeLock(entry,{...deps,loadEscrow:async()=>({...state,rejectedLocks:undefined})}, {reclaimRejected:true}), 'kept', 'mere relay absence never refunds');
assert.equal(await recoverPendingNativeLock(entry,{...deps,redeemRejectedNotes:async()=>{throw Error('already spent');}}, {reclaimRejected:true}), 'kept', 'dead-note error alone cannot prove wallet credit');
assert(getPendingNativeLock(state.id)?.oobNotes);
assert.equal(await recoverPendingNativeLock(entry,{...deps,redeemRejectedNotes:undefined}, {reclaimRejected:true}), 'kept', 'legacy retry success cannot substitute for measured credit');
assert.equal(await recoverPendingNativeLock(entry,deps), 'reabsorbed', 'signed refusal automatically returns the saved note');
assert.equal(balance,174000); assert.equal(calls,1); assert.equal(getPendingNativeLock(state.id),null);
state.rejectedLockRecovery = rejectedLockRecovery(state,getPendingNativeLock(state.id),owner);
assert.equal(state.rejectedLockRecovery,undefined);
assert.notEqual(needsYouReasonFor(state, owner,1790900000),'funding-refund');
const restoredRoom = renderToStaticMarkup(createElement(LiveTradeSurface, {state, pubkey:owner, onBack:()=>{}, onOpenFullView:()=>{}, onVote:async()=>{}, onSendChat:async()=>{}}));
assert.match(restoredRoom, /Your 170 sats are back in your wallet/);
assert.doesNotMatch(restoredRoom, /Take your 170 sats back|can&#x27;t find the note/);
console.log('PASS refused LOCK funding: exact saved notes, needs-you, explicit refund, wallet credit and fail-closed evidence gates.');

// Exercise the bridge binding and existing credit bracket, not only an injected
// recovery callback: a clean reissue resolve without a balance delta stays closed.
const {EscrowFedimintBridge} = await import('./escrow-bridge.js');
let verifiedBalance = 4000, creditOnRedeem = false;
const wallet = {getFederationId:()=> 'test-fed', parseNotes:async()=>({totalAmount:170000,federationId:'test-fed'}),
  getBalance:async()=>verifiedBalance, redeemWithRetry:async()=>{if(creditOnRedeem) verifiedBalance+=170000;}};
const bridge = new EscrowFedimintBridge({} as any,wallet as any,{} as any);
const credit = bridge.nativeLockRecoveryDeps().redeemRejectedNotes!;
await assert.rejects(credit(entry),/could not verify/);
assert.equal(verifiedBalance,4000);
creditOnRedeem=true;
await credit(entry);
assert.equal(verifiedBalance,174000);
console.log('PASS actual bridge refund binding demands the exact 170-sat wallet credit.');

// Re-sign the lapsed-seat chronology with synthetic keys: replay authenticates
// every event. Plaintext test shares model the encrypted payload, never money.
const {finalizeEvent, getPublicKey, verifyEvent} = await import('nostr-tools');
const {parseEscrowEvent} = await import('../escrow-engine/event-parser.js');
const root = chain.find(e=>e.kind === K.CREATE)!;
const originalKeys = [...new Set([...chain.map(e=>e.pubkey), ...(root.payload as any).communityArbiters,
  (root.payload as any).platformFeePubkey, (lock.payload as any).arbiterPubkey].filter(Boolean))];
const secrets = new Map(originalKeys.map((key,index)=>[key,new Uint8Array(32).fill(index+41)]));
const renamed = new Map([...secrets].map(([key,secret])=>[key,getPublicKey(secret)]));
const rename = (value:any):any => typeof value === 'string' ? renamed.get(value) ?? value : Array.isArray(value)
  ? value.map(rename) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,v])=>[renamed.get(key) ?? key,rename(v)])) : value;
const ids = new Map<string,string>();
const signedChain = [...chain].sort((a,b)=>a.timestamp-b.timestamp).map(e=>{
  const raw = finalizeEvent({kind:e.kind,created_at:e.timestamp,
    tags:e.raw.tags.map(t=>t.map(part=>ids.get(part) ?? renamed.get(part) ?? part)), content:JSON.stringify(rename(e.payload))},secrets.get(e.pubkey)!);
  ids.set(e.raw.id,raw.id); assert(verifyEvent(raw));
  const parsed = parseEscrowEvent(raw, raw.content); assert(parsed.ok);
  return parsed.event;
});
const signedReplay = replayEventChain(sortEventChain(signedChain)); assert(signedReplay.ok);
assert.equal(signedReplay.state.lock.notesHash,null);
assert.equal(signedReplay.state.rejectedLocks?.[0].code,'ORDER_NOT_FINALIZED');
stashNativeLockIntent(input); upgradeNativeLockToSpent({...input,oobNotes:notes}); markNativeLockPublishAttempted(input.escrowId);
verifiedBalance = 4000;
const signedBridge = new EscrowFedimintBridge({loadEscrow:async()=>signedReplay.state,getConnectedRelayCount:()=>1} as any,wallet as any,{} as any);
assert.equal(await recoverPendingNativeLock(getPendingNativeLock(input.escrowId)!,signedBridge.nativeLockRecoveryDeps()),'reabsorbed');
assert.equal(verifiedBalance,174000); assert.equal(getPendingNativeLock(input.escrowId),null);
console.log('PASS signed lapsed-seat chain, quarantined late LOCK, automatic reabsorb and verified balance restoration');

// A seat that lapses during the wallet spend is checked again BEFORE SSS.
let preflights = 0, splits = 0;
verifiedBalance = 174000;
const beforeSplit = {...signedReplay.state, rejectedLocks:undefined, amountMsats:170000, items:undefined};
const gateWallet = {...wallet,
  spendNotesForLock:async(amount:number,_meta:unknown,onSpent:(notes:string)=>void)=>{verifiedBalance-=amount;onSpent(notes);return {oobNotes:notes};},
  buildEscrowLockBundle:async()=>{splits++;throw Error('split must never happen');}};
const gateBridge = new EscrowFedimintBridge({loadEscrow:async()=>beforeSplit,getConnectedRelayCount:()=>1,resolveDurableMoneyPublish:()=>{}} as any,gateWallet as any,{} as any);
(gateBridge as any).prepareLockContext = async()=>{
  if (++preflights > 1) throw Error('The seat lapsed during spend');
  return {state:beforeSplit,buyerPubkey:beforeSplit.participants.buyer,sellerPk:beforeSplit.participants.seller,arbiterPubkey:'test-arbiter',expectedFed:null};
};
await assert.rejects(gateBridge.lockAndPublish(beforeSplit.id),/seat lapsed/);
assert.equal(splits,0); assert.equal(verifiedBalance,174000);
assert.equal(getPendingNativeLock(beforeSplit.id)?.oobNotes,undefined);
console.log('PASS seat recheck before splitting; a spend that outlasts its seat is reabsorbed automatically');
