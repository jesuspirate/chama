import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { EscrowClient, type Signer } from './escrow-client.js';
import { EscrowEventKind as K, EscrowStatus as S, Outcome, Role, type NostrEvent } from './types.js';
import { putCachedEvents, clearEventCache } from './escrow-event-cache.js';
import { canVote } from './state-machine.js';
import { defaultDurableMoneyPublishStore, readDurableMoneyPublishes } from './durable-money-publish.js';
import { setSimMode, eventIsSim } from '../sim/simMode.js';

// Only storage and the relay transport are replaced. Publishing, signature
// verification, participant encryption, live delivery and cold replay are real.
const storage = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
type Filter = { kinds?: number[]; authors?: string[]; '#d'?: string[] };
class Relay {
  static all: Relay[] = [];
  static events: NostrEvent[] = [];
  static locks: NostrEvent[] = [];
  static rejectLocks = false;
  static pendingAcks: (() => void)[] = [];
  onopen?: (event: Event) => void;
  onmessage?: (event: MessageEvent) => void;
  subscriptions = new Map<string, Filter>();
  constructor(public url: string) { Relay.all.push(this); }
  emit(message: unknown[]) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  matches(event: NostrEvent, filter: Filter) {
    return (!filter.kinds || filter.kinds.includes(event.kind))
      && (!filter.authors || filter.authors.includes(event.pubkey))
      && (!filter['#d'] || event.tags.some(t => t[0] === 'd' && filter['#d']!.includes(t[1])));
  }
  send(wire: string) {
    const [type, id, filter] = JSON.parse(wire);
    if (type === 'CLOSE') { this.subscriptions.delete(id); return; }
    if (type === 'REQ') {
      this.subscriptions.set(id, filter);
      queueMicrotask(() => {
        for (const event of Relay.events) if (this.matches(event, filter)) this.emit(['EVENT', id, event]);
        this.emit(['EOSE', id]);
      });
    }
    if (type !== 'EVENT') return;
    const event = id as NostrEvent;
    assert(verifyEvent(event as Parameters<typeof verifyEvent>[0]), 'relay receives a valid signed event');
    const deliver = () => {
      const accepted = event.kind !== K.LOCK || !Relay.rejectLocks;
      if (accepted) {
        Relay.events.push(event);
        for (const peer of Relay.all) {
          if (peer === this) continue;
          for (const [sub, f] of peer.subscriptions) if (peer.matches(event, f)) peer.emit(['EVENT', sub, event]);
        }
      }
      this.emit(['OK', event.id, accepted, accepted ? 'saved' : 'blocked: test rejection']);
    };
    if (event.kind === K.LOCK) { Relay.locks.push(event); Relay.pendingAcks.push(deliver); }
    else queueMicrotask(deliver);
  }
  close() { this.subscriptions.clear(); }
}
const secret = (n: number) => new Uint8Array(32).fill(n);
const buyerKey = secret(31), sellerKey = secret(32), arbiterKey = secret(33);
const buyerPk = getPublicKey(buyerKey), sellerPk = getPublicKey(sellerKey), arbiterPk = getPublicKey(arbiterKey);
function signer(key: Uint8Array): Signer {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: async event => finalizeEvent(event, key),
    nip44Encrypt: async (value, peer) => nip44.v2.encrypt(value, nip44.v2.utils.getConversationKey(key, peer)),
    nip44Decrypt: async (value, peer) => nip44.v2.decrypt(value, nip44.v2.utils.getConversationKey(key, peer)),
  };
}
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(check(), message);
}
async function run(mode: 'sim' | 'legacy-ecash' | 'durable-ecash' | 'onchain', reject: boolean) {
  await clearEventCache();
  storage.clear(); setSimMode(mode === 'sim');
  Relay.all = []; Relay.events = []; Relay.locks = []; Relay.pendingAcks = []; Relay.rejectLocks = reject;
  const clients: EscrowClient[] = [];
  const open = (key: Uint8Array) => {
    const client = new EscrowClient(signer(key), { relays: ['wss://relay.chama.community'], wsImpl: Relay as unknown as typeof WebSocket });
    clients.push(client); client.connect(); Relay.all.at(-1)!.onopen?.({} as Event); return client;
  };
  const seller = open(sellerKey), buyer = open(buyerKey);
  try {
    let id: string;
    let onchain: Parameters<EscrowClient['lockEscrow']>[1]['onchain'];
    if (mode === 'onchain') {
      const fixture = safetyFixture({ buyer: schnorr.getPublicKey(buyerKey), seller: schnorr.getPublicKey(sellerKey),
        arbiter: schnorr.getPublicKey(arbiterKey) }, 2_000_000, `sm_lock_publish_${reject ? 'reject' : 'accept'}`);
      fixture.apply(fixture.event(K.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER,
        joinedAt: Math.floor(Date.now() / 1000), fundingTerms: fixture.terms }));
      Relay.events = fixture.events.map(event => event.raw);
      id = fixture.state.id;
      onchain = { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 0 };
      assert.equal((await seller.loadEscrow(id))?.status, S.CREATED);
    } else {
      ({ escrowId: id } = await seller.createEscrow({ category: 'p2p-trade', description: 'Lock delivery',
        amountMsats: 100_000_000, mintUrl: 'test-only', arbiterFeeMsats: 0, communityArbiters: [arbiterPk] }));
    }
    assert.equal((await buyer.loadEscrow(id))?.status, S.CREATED);
    buyer.watchEscrow(id);
    const now = Math.floor(Date.now() / 1000);
    const pending = seller.lockEscrow(id, {
      notesHash: onchain ? '' : 'test-notes-hash',
      shares: onchain ? [] : [0, 1, 2].map(shareIndex => ({ shareIndex,
        encryptedFor: { [buyerPk]: 'test-share', [sellerPk]: 'test-share', [arbiterPk]: 'test-share' } })),
      ...(onchain ? { onchain } : {}),
      sellerReceivesMsats: 100_000_000, arbiterFeeMsats: 0, buyerPubkey: buyerPk, arbiterPubkey: arbiterPk,
      handle: 'test-payment-handle', rail: 'test',
      ...(mode === 'durable-ecash' ? { custody: { spentAt: now, liveUntil: now + 3600, amountMsats: 100_000_000 } } : {}),
    }).then(state => ({ state, error: undefined }), error => ({ state: undefined, error }));
    await until(() => Relay.locks.length === 1, `${mode}: LOCK must actually reach the relay`);
    assert.equal(seller.getState(id)?.status, S.CREATED, 'do not report a successful lock before relay acknowledgement');
    assert.equal(eventIsSim(Relay.locks[0]), mode === 'sim', 'preserve the sim partition on the signed event');
    Relay.pendingAcks.shift()!();
    const result = await pending;
    const outbox = readDurableMoneyPublishes(defaultDurableMoneyPublishStore());
    if (reject) {
      assert.equal(buyer.getState(id)?.status, S.CREATED);
      if (mode === 'durable-ecash') {
        assert.equal(result.error, undefined);
        assert.equal(result.state?.status, S.LOCKED, 'funded ecash keeps its recoverable local state');
        assert.notEqual(result.state?.lock.custodyDurability, 'acknowledged');
        assert.equal(outbox.length, 1, 'keep the original signed money event for retry');
        assert.equal(outbox[0].event.id, Relay.locks[0].id);
      } else {
        assert(result.error instanceof Error, 'surface publish failure to the caller');
        assert.equal(seller.getState(id)?.status, S.CREATED, 'a rejected publish cannot pretend to be acknowledged');
        assert.equal(outbox.length, 0);
      }
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.state?.status, S.LOCKED);
      assert.equal(result.state?.lock.custodyDurability, 'acknowledged');
      await until(() => buyer.getState(id)?.status === S.LOCKED, 'buyer advances via live relay delivery');
      assert.equal(buyer.getState(id)?.lock.handle?.value, 'test-payment-handle', 'buyer decrypts its handle envelope');
      const freshBuyer = open(buyerKey);
      assert.equal((await freshBuyer.loadEscrow(id, { fullHistory: true }))?.status, S.LOCKED, 'a fresh device also sees the published lock');
      if (mode === 'sim' || mode === 'onchain') {
        // Model an earlier build's locally held LOCK that never reached a
        // relay. Cache APIs use their in-memory storage adapter in Node.
        const originalLock = Relay.locks[0];
        const complete = [...Relay.events];
        Relay.events = Relay.events.filter(event => event.id !== originalLock.id);
        await putCachedEvents(id, complete, S.LOCKED);
        const restartedSeller = open(sellerKey);
        assert.equal((await restartedSeller.loadEscrow(id, { repairFromCache: true, fullHistory: true }))?.status,
          S.CREATED, 'a valid CREATED relay chain does not trigger disk-cache repair, even on explicit open');
        assert.equal(Relay.locks.length, 1, 'restarting does not automatically republish the disk-only LOCK');
        const repair = seller.loadEscrow(id, { repairFromCache: true });
        await until(() => Relay.locks.length === 2, 'warm reopen completeness retry backfills the missing LOCK');
        assert.equal(Relay.locks[1].id, originalLock.id, 'backfill reuses the original signed LOCK');
        Relay.pendingAcks.shift()!();
        assert.equal((await repair)?.status, S.LOCKED);
        assert(Relay.events.some(event => event.id === originalLock.id));
        console.log(`PASS ${mode} old unsent LOCK: ordinary reopen is not guaranteed recovery; warm reopen backfill preserves signature`);
      }
      if (!onchain) {
        assert(canVote(buyer.getState(id)!, buyerPk, undefined, Outcome.RELEASE).canVote, 'buyer can confirm payment');
        await buyer.vote(id, Outcome.RELEASE);
        const freshSeller = open(sellerKey);
        const voted = await freshSeller.loadEscrow(id, { fullHistory: true });
        assert(voted?.eventChain.some(event => event.kind === K.VOTE && event.pubkey === buyerPk), 'buyer vote is published and decryptable by the seller');
      }
      assert.equal(outbox.length, 0, 'acknowledged locks leave no pending money publish');
    }
    console.log(`PASS ${mode} LOCK ${reject ? 'rejection' : onchain ? 'delivery and cold reload' : 'delivery, cold reload and voting'}`);
  } finally { clients.forEach(client => client.disconnect()); }
}
try {
  for (const mode of ['sim', 'legacy-ecash', 'durable-ecash', 'onchain'] as const) {
    await run(mode, false);
    await run(mode, true);
  }
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
