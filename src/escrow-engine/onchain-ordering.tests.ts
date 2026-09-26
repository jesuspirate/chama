import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { EscrowClient, type Signer } from './escrow-client.js';
import { EscrowEventKind as Kind, EscrowStatus, Role, type NostrEvent } from './types.js';

class RelaySocket {
  static last: RelaySocket;
  events: NostrEvent[] = [];
  filters: Record<string, unknown>[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null;
  onclose = null;
  constructor(_url: string) { RelaySocket.last = this; }
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg[0] !== 'REQ' || !String(msg[1]).startsWith('sm_fetch_')) return;
    const filter = msg[2]; this.filters.push(filter);
    queueMicrotask(() => {
      for (const event of this.events) if (filter.since == null || event.created_at >= filter.since) this.emit(['EVENT', msg[1], event]);
      this.emit(['EOSE', msg[1]]);
    });
  }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  close() {}
}

const fixture = safetyFixture({ buyer: btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),
  seller: btc.utils.pubSchnorr(new Uint8Array(32).fill(12)), arbiter: btc.utils.pubSchnorr(new Uint8Array(32).fill(13)) }, 2_000_000, 'ordering-test');
const base = fixture.events.map(e => e.raw);
const terms = fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER, joinedAt: Date.now()/1000, fundingTerms: fixture.terms });
fixture.apply(terms);
const lock = fixture.event(Kind.LOCK, 'seller', { type: 'escrow:lock', notesHash: '', shares: [],
  onchain: { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 0 },
  buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter, sellerReceivesMsats: 100_000_000,
  arbiterFeeMsats: 0, lockedAt: Date.now()/1000 });
const signer: Signer = { getPublicKey: async () => fixture.pks.buyer,
  signEvent: async () => { throw new Error('read-only test'); }, nip44Encrypt: async s => s, nip44Decrypt: async s => s };
for (const outOfOrder of [true, false]) {
  const reloads: boolean[] = [];
  const client = new EscrowClient(signer, { relays: ['wss://relay.test'], wsImpl: RelaySocket as unknown as typeof WebSocket }, {
    onHistoryReload: (_id, loading) => reloads.push(loading),
  });
  try {
    client.connect(); const socket = RelaySocket.last;
    socket.events = base; socket.onopen?.({} as Event);
    await client.loadEscrow(fixture.state.id);
    const receive = (event: NostrEvent) => (client as unknown as { handleIncomingEvent(e: NostrEvent, url: string): Promise<void> }).handleIncomingEvent(event, 'wss://relay.test');
    const before = socket.filters.length;
    socket.events = [...base, terms.raw, lock.raw];
    if (!outOfOrder) await receive(terms.raw);
    await receive(lock.raw);
    if (outOfOrder) {
      for (let i=0; i<150 && client.getState(fixture.state.id)?.status !== EscrowStatus.LOCKED; i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(client.getState(fixture.state.id)?.status, EscrowStatus.LOCKED, 'missing terms recovered through actual relay fetch and replay');
      assert.equal(socket.filters[before].since, undefined, 'missing predecessor recovery asks for full history');
      assert.deepEqual(reloads, [true, false]);
    }
    await receive(terms.raw); await receive(lock.raw); await receive(lock.raw);
    assert.equal(client.getState(fixture.state.id)?.status, EscrowStatus.LOCKED);
    assert.equal(reloads.filter(Boolean).length, outOfOrder ? 1 : 0, 'ordered terms/LOCK and duplicates never start a reload storm');
  } finally { client.disconnect(); }
}
console.log('On-chain receive ordering: missing terms heal to LOCKED; ordered and duplicate delivery stay quiet');
