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
assert.match(html, /buyer&#x27;s seat had lapsed/);
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
assert.equal(await recoverPendingNativeLock(entry,deps), 'kept', 'background drain waits for explicit reclaim');
assert.equal(calls,0);
assert.equal(await recoverPendingNativeLock(entry,{...deps,currentFederationId:()=> 'other'}, {reclaimRejected:true}), 'kept');
assert.equal(await recoverPendingNativeLock(entry,{...deps,loadEscrow:async()=>({...state,rejectedLocks:undefined})}, {reclaimRejected:true}), 'kept', 'mere relay absence never refunds');
assert.equal(await recoverPendingNativeLock(entry,{...deps,redeemRejectedNotes:async()=>{throw Error('already spent');}}, {reclaimRejected:true}), 'kept', 'dead-note error alone cannot prove wallet credit');
assert(getPendingNativeLock(state.id)?.oobNotes);
assert.equal(await recoverPendingNativeLock(entry,{...deps,redeemRejectedNotes:undefined}, {reclaimRejected:true}), 'kept', 'legacy retry success cannot substitute for measured credit');
assert.equal(await recoverPendingNativeLock(entry,deps,{reclaimRejected:true}), 'reabsorbed');
assert.equal(balance,174000); assert.equal(calls,1); assert.equal(getPendingNativeLock(state.id),null);
state.rejectedLockRecovery = rejectedLockRecovery(state,getPendingNativeLock(state.id),owner);
assert.equal(state.rejectedLockRecovery,undefined);
assert.notEqual(needsYouReasonFor(state, owner,1790900000),'funding-refund');
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
