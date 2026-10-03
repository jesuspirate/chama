import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EscrowClient } from '../escrow-engine/escrow-client.js';
import { parseEscrowEvent, sortEventChain } from '../escrow-engine/event-parser.js';
import { replayEventChain, applyEvent } from '../escrow-engine/state-machine.js';
import { EscrowEventKind as K, EscrowStatus as S, Role as R, type NostrEvent, type LockPayload } from '../escrow-engine/types.js';
import { hashNotes } from './fedimint-client.js';
import { rejectedLockRecovery } from './rejected-lock-recovery.js';
import { stashNativeLockIntent, upgradeNativeLockToSpent, markNativeLockPublishAttempted, getPendingNativeLock, recoverPendingNativeLock } from './pending-native-locks.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { needsYouReasonFor, decideChamaBarLabel, selectNeedsYouTrades } from '../ui/decisions.js';
import { LiveTradeSurface } from '../ui/screens/LiveTradeSurface.js';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k)}});
setLocalStorageUserScope('cancelled-lock-test');
const seller = new Uint8Array(32).fill(81), buyer = new Uint8Array(32).fill(82), arbiter = new Uint8Array(32).fill(83), outsider = new Uint8Array(32).fill(84);
const pk = (key: Uint8Array) => getPublicKey(key);
const id = 'sm_cancel_refund_test', T = Math.floor(Date.now() / 1000) - 120;
const notes = 'synthetic-cancelled-trade-notes', hash = await hashNotes(notes), amount = 170000;
function signed(key: Uint8Array, kind: K, payload: object, at: number, prev?: string) {
  return finalizeEvent({kind, created_at: at, content: JSON.stringify(payload), tags: [['d', id], ...(prev ? [['e', prev, '', 'reply']] : [])]}, key) as NostrEvent;
}
function parse(raw: NostrEvent) {
  const result = parseEscrowEvent(raw, raw.content, true); assert(result.ok, result.ok ? '' : result.error.message); return result.event;
}
const create = signed(seller, K.CREATE, {type: 'escrow:create', category: 'marketplace', description: 'Test item', amountMsats: amount,
  mintUrl: 'test-fed', platformFeeBps: 0, platformFeePubkey: pk(seller), communityArbiters: [pk(arbiter)], arbiterFeeMsats: 0,
  expirySeconds: 86400, createdAt: T}, T);
const join = signed(buyer, K.JOIN, {type: 'escrow:join', role: R.BUYER, joinedAt: T + 1}, T + 1, create.id);
const cancel = signed(seller, K.CANCEL, {type: 'escrow:cancel', cancellerRole: R.SELLER, reason: 'Cancelled', cancelledAt: T + 2}, T + 2, join.id);
const payload = {type: 'escrow:lock', notesHash: hash, buyerPubkey: pk(buyer), arbiterPubkey: pk(arbiter),
  sellerReceivesMsats: amount, arbiterFeeMsats: 0, lockedAt: T + 3,
  shares: [buyer, seller, arbiter].map((key, shareIndex) => ({shareIndex, encryptedFor: {[pk(key)]: 'test-only-share'}}))};
const lock = signed(buyer, K.LOCK, payload, T + 3, join.id);
const prefix = [create, join, cancel].map(parse);
const result = replayEventChain(sortEventChain([...prefix, parse(lock)])); assert(result.ok, result.ok ? '' : result.error.message);
const state = result.state;
// The relay serializes fresh objects, so the real signature verifier runs.
class Socket {
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  constructor(_url: string) { queueMicrotask(() => this.onopen?.({} as Event)); }
  send(text: string) {
    const [type, subId, filter] = JSON.parse(text);
    if (type !== 'REQ' || !String(subId).startsWith('sm_fetch_')) return;
    queueMicrotask(() => {
      for (const raw of [create, join, cancel, lock]) {
        if (filter.kinds && !filter.kinds.includes(raw.kind)) continue;
        this.onmessage?.({data: JSON.stringify(['EVENT', subId, raw])} as MessageEvent);
      }
      this.onmessage?.({data: JSON.stringify(['EOSE', subId])} as MessageEvent);
    });
  }
  close() {}
}
const client = new EscrowClient({getPublicKey: async () => pk(buyer), signEvent: async event => finalizeEvent(event, buyer),
  nip44Encrypt: async text => text, nip44Decrypt: async text => text},
  {relays: ['wss://one.invalid', 'wss://two.invalid'], wsImpl: Socket as unknown as typeof WebSocket});
try {
  client.connect(); await new Promise(r => setTimeout(r, 5));
  const loaded = await client.loadEscrow(id, {fullHistory: true});
  assert.equal(loaded?.status, S.CANCELLED);
  assert.equal(loaded?.lock.notesHash, null);
  assert.equal(loaded?.rejectedLocks?.[0].event.raw.id, lock.id, 'cold load retains the exact signed refused lock');
} finally { client.disconnect(); }

assert.equal(state.status, S.CANCELLED);
assert.equal(state.lock.notesHash, null);
assert.equal(state.rejectedLocks?.[0].event.raw.id, lock.id);
assert.equal(state.rejectedLocks?.[0].code, 'CANCELLED_BEFORE_LOCK');
assert(!state.eventChain.some(e => e.raw.id === lock.id), 'refused lock never enters committed custody');
assert(!applyEvent(state, parse(lock)).ok, 'live reducer continues to refuse the lock');
// A missing JOIN, missing predecessor, wrong locker, or ambiguous same-second
// race is not sufficient evidence to return bearer notes.
for (const [name, events] of [
  ['missing buyer JOIN', [parse(create), parse(cancel), parse(lock)]],
  ['missing predecessor', [...prefix, parse(signed(buyer, K.LOCK, payload, T + 3, 'ff'.repeat(32)))]],
  ['wrong author', [...prefix, parse(signed(outsider, K.LOCK, payload, T + 3, join.id))]],
  ['same-second race', [...prefix, parse(signed(buyer, K.LOCK, {...payload, lockedAt: T + 2}, T + 2, join.id))]],
] as const) {
  assert(!replayEventChain(sortEventChain([...events])).ok, `${name} stays strict`);
}
const onchainLock = parse(lock);
onchainLock.payload = {...(onchainLock.payload as LockPayload), onchain: {} as any};
assert(!replayEventChain(sortEventChain([...prefix, onchainLock])).ok, 'on-chain deposits stay on their strict recovery path');
const beforeCancel = signed(buyer, K.LOCK, {...payload, lockedAt: T + 1}, T + 1, join.id);
assert(!replayEventChain(sortEventChain([...prefix, parse(beforeCancel)])).ok, 'accepted custody before cancellation remains strict');
const input = {escrowId: id, amountMsats: amount, federationId: 'test-fed'};
stashNativeLockIntent(input); upgradeNativeLockToSpent({...input, oobNotes: notes}); markNativeLockPublishAttempted(id);
const entry = getPendingNativeLock(id)!;
state.rejectedLockRecovery = rejectedLockRecovery(state, entry, pk(buyer));
assert(state.rejectedLockRecovery);
assert.equal(rejectedLockRecovery(state, entry, pk(seller)), undefined);
assert.equal(rejectedLockRecovery(state, {...entry, oobNotes: 'wrong-notes'}, pk(buyer)), undefined);
assert.equal(rejectedLockRecovery({...state, lock: {...state.lock, notesHash: hash}}, entry, pk(buyer)), undefined);
assert.equal(needsYouReasonFor(state, pk(buyer), T + 4), 'funding-refund');
const urgent = selectNeedsYouTrades({escrows: [state], userPubkey: pk(buyer), nowSec: T + 4});
assert.deepEqual(decideChamaBarLabel({needsYouCount: urgent.length, balanceMsats: 0, hasActiveBuyerSellerCommitment: false}), {kind: 'needs-you', count: 1});
const html = renderToStaticMarkup(createElement(LiveTradeSurface, {state, pubkey: pk(buyer), onBack() {}, onOpenFullView() {},
  onVote: async () => {}, onSendChat: async () => {}, onReclaimRejectedLock: async () => {}}));
assert.match(html, /Take your 170 sats back/); assert.doesNotMatch(html, /seat had lapsed/);
const deps = {loadEscrow: async () => state, getConnectedRelayCount: () => 2, currentFederationId: () => 'test-fed', hashNotes,
  redeemNotes: async () => {}, now: () => (T + 4) * 1000};
assert.equal(await recoverPendingNativeLock(entry, deps), 'kept', 'a legacy redemption success cannot prove credit');
assert.equal(await recoverPendingNativeLock(entry, {...deps, currentFederationId: () => 'another-fed', redeemRejectedNotes: async () => {throw Error('must not redeem');}}), 'kept');
let credited = 0;
assert.equal(await recoverPendingNativeLock(entry, {...deps, redeemRejectedNotes: async saved => {assert.equal(saved.oobNotes, notes); credited += saved.amountMsats;}}), 'reabsorbed');
assert.equal(credited, amount); assert.equal(getPendingNativeLock(id), null);
console.log('PASS signed cancel-before-lock recovery: no custody, exact bearer match, visible action and credit gate');
