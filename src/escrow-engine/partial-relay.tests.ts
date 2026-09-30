import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-client.js';
import { EscrowEventKind, type NostrEvent } from './types.js';
import { enqueueDurableMoneyPublish, defaultDurableMoneyPublishStore, readDurableMoneyPublishes } from './durable-money-publish.js';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string,v: string) => storage.set(k,v), removeItem: (k: string) => storage.delete(k),
} });
class Socket {
  static all: Socket[] = [];
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  sent: NostrEvent[] = [];
  constructor(public url: string) { Socket.all.push(this); }
  send(s: string) {
    const message = JSON.parse(s);
    if (message[0] !== 'EVENT') return;
    this.sent.push(message[1]);
    if ([EscrowEventKind.CREATE, EscrowEventKind.CANCEL].includes(message[1].kind)) queueMicrotask(() => this.ack(message[1].id, true));
  }
  ack(id: string, accepted: boolean) { this.onmessage?.({ data: JSON.stringify(['OK', id, accepted, accepted ? 'saved' : 'blocked']) } as MessageEvent); }
  close() {}
}
const secret = new Uint8Array(32).fill(14);
const client = new EscrowClient({ getPublicKey: async () => getPublicKey(secret),
  signEvent: async event => finalizeEvent(event, secret), nip44Encrypt: async value => value, nip44Decrypt: async value => value,
}, { relays: ['wss://one.invalid','wss://two.invalid'], wsImpl: Socket as unknown as typeof WebSocket });
try {
  client.connect();
  for (const socket of Socket.all) socket.onopen?.({} as Event);
  const { escrowId } = await client.createEscrow({ category: 'p2p-trade', description: 'Relay test', amountMsats: 1000000, mintUrl: 'test', arbiterFeeMsats: 0, communityArbiters: [] });
  const now = Math.floor(Date.now() / 1000);
  const store = defaultDurableMoneyPublishStore();
  for (const allReject of [false, true]) {
    const id = allReject ? 'all_reject' : 'partial_accept';
    enqueueDurableMoneyPublish(store, { event: { id, pubkey: getPublicKey(secret), sig: 'already-signed', kind: EscrowEventKind.PREMIUM,
      created_at: now, tags: [['d',escrowId]], content: '{}' }, escrowId, type: 'premium', spentAt: now, liveUntil: now + 60 });
    const pending = client.drainDurableMoneyPublishes(now);
    for (let i = 0; i < 100 && !Socket.all[0].sent.some(e => e.id === id); i++) await new Promise(r => setTimeout(r, 1));
    assert.ok(Socket.all[0].sent.some(e => e.id === id));
    Socket.all[0].ack(id, false);
    await Promise.resolve();
    assert.equal(client.getState(escrowId)?.custodyNotice, undefined, 'one rejection is not an overall failure');
    Socket.all[1].ack(id, !allReject);
    await pending;
    if (allReject) {
      assert.equal(client.getState(escrowId)?.custodyNotice?.status, 'pending', 'zero accepts keeps the retry notice');
      assert.equal(readDurableMoneyPublishes(store).length, 1, 'undelivered money event remains durable');
    } else {
      assert.equal(client.getState(escrowId)?.custodyNotice, undefined, 'an accepted update has no rejection warning');
      assert.equal(readDurableMoneyPublishes(store).length, 0);
    }
  }
  const {deleteListings} = await import('./delete-listings.js');
  const {parseEscrowEvent, sortEventChain} = await import('./event-parser.js');
  const {replayEventChain} = await import('./state-machine.js');
  const {shouldShowOnBrowse} = await import('../ui/decisions.js');
  const ids = [escrowId];
  for (let i = 0; i < 2; i++) ids.push((await client.createEscrow({category:'p2p-trade', description:`Delete ${i}`,
    amountMsats:1000000, mintUrl:'test', arbiterFeeMsats:0, communityArbiters:[]})).escrowId);
  const retired: string[] = [];
  await deleteListings(ids, (id,reason) => client.cancel(id,reason), id => retired.push(id));
  assert.deepEqual(retired, ids);
  const cancels = Socket.all[0].sent.filter(e => e.kind === EscrowEventKind.CANCEL);
  assert.equal(cancels.length, ids.length, 'N listings publish N signed CANCELs');
  for (const id of ids) {
    const raw = Socket.all[0].sent.filter(e => [EscrowEventKind.CREATE,EscrowEventKind.CANCEL].includes(e.kind)
      && e.tags.some(t => t[0] === 'd' && t[1] === id));
    assert(raw.every(e => verifyEvent(e as any)));
    const parsed = raw.map(e => {const r=parseEscrowEvent(e,e.content); assert(r.ok); return r.event;});
    const remote = replayEventChain(sortEventChain(parsed)); assert(remote.ok);
    assert.equal(remote.state.status, 'CANCELLED');
    assert.equal(shouldShowOnBrowse({escrow:remote.state,browseCategory:'all',nowSec:now}),false,
      'second device drops cancelled offers without the local retirement ledger');
  }
  console.log('PASS mixed relay acceptance stays quiet; zero accepts preserves retry and custody');
} finally { client.disconnect(); }
