// End-to-end: a stranger's backdated CREATE cannot become someone else's trade.
//
// Real signatures, the default signature verifier, and the full cold-load path
// (relay fetch → verify → parse → sort → replay) on a fresh device per case.
// Covers the three ways a trade is opened by id: Browse / a notification with
// no local record (no creator known), a trade link carrying `by`, and a device
// that already holds the trade.
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-client.js';
import { creatorTaggedEscrowId } from './trade-identity.js';
import { EscrowEventKind, EscrowStatus, type NostrEvent } from './types.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
} });

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const seller = key(), buyer = key(), arbiter = key(), stranger = key();
const T0 = Math.floor(Date.now() / 1000) - 600;

/** Explicit fields, never a spread: finalizeEvent stamps a hidden "verified"
 *  marker that a copied object would carry past the signature check. */
const sign = (by: { sk: Uint8Array }, id: string, kind: number, at: number, prev: string | null, payload: unknown): NostrEvent => {
  const e = finalizeEvent({ kind, created_at: at, content: JSON.stringify(payload),
    tags: [['d', id], ...(prev ? [['e', prev, '', 'reply']] : [])] }, by.sk);
  return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
};
const createPayload = (by: { pk: string }, at: number, amountMsats: number) => ({
  type: 'escrow:create', description: 'Sell sats for USD', amountMsats, fiatAmount: 50, fiatCurrency: 'USD',
  category: 'p2p-trade', mintUrl: 'fed11q...', platformFeeBps: 0, platformFeePubkey: by.pk,
  arbiterFeeMsats: 1_000_000, paymentMethods: ['Zelle'], expirySeconds: 86400, createdAt: at,
});
const lockPayload = (at: number) => ({
  type: 'escrow:lock', notesHash: 'notes-hash',
  shares: [0, 1, 2].map(shareIndex => ({ shareIndex,
    encryptedFor: Object.fromEntries([buyer.pk, seller.pk, arbiter.pk].map(pk => [pk, `share-${shareIndex}`])) })),
  sellerReceivesMsats: 99_000_000, arbiterFeeMsats: 1_000_000,
  buyerPubkey: buyer.pk, arbiterPubkey: arbiter.pk, lockedAt: at,
});

class Socket {
  static chain: NostrEvent[] = [];
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  constructor(public url: string) { queueMicrotask(() => this.onopen?.({} as Event)); }
  send(raw: string) {
    const message = JSON.parse(raw);
    if (message[0] === 'EVENT') queueMicrotask(() => this.emit(['OK', message[1].id, true, 'saved']));
    if (message[0] !== 'REQ' || !String(message[1]).startsWith('sm_fetch_')) return;
    queueMicrotask(() => {
      for (const event of Socket.chain) this.emit(['EVENT', message[1], event]);
      this.emit(['EOSE', message[1]]);
    });
  }
  emit(message: unknown[]) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  close() {}
}
async function device(run: (client: EscrowClient) => Promise<void>) {
  const client = new EscrowClient({
    getPublicKey: async () => buyer.pk, signEvent: async event => finalizeEvent(event, buyer.sk),
    nip44Encrypt: async text => text, nip44Decrypt: async text => text,
  }, { relays: ['wss://relay.invalid'], wsImpl: Socket as unknown as typeof WebSocket });
  try { client.connect(); await new Promise(r => setTimeout(r, 5)); await run(client); }
  finally { client.disconnect(); }
}

// ── An old-style id: nothing in it names the creator ──
const OLD = 'sm_lz4k2a_abcd1234';
const real = sign(seller, OLD, EscrowEventKind.CREATE, T0, null, createPayload(seller, T0, 100_000_000));
const forged = sign(stranger, OLD, EscrowEventKind.CREATE, T0 - 10, null, createPayload(stranger, T0 - 10, 1_000));
const lock = sign(seller, OLD, EscrowEventKind.LOCK, T0 + 10, real.id, lockPayload(T0 + 10));

Socket.chain = [forged, real];
await device(async client => {
  assert.equal(await client.loadEscrow(OLD), null, 'no creator known: the conflicted id opens as neither listing');
  assert.equal(client.getLastLoadFailure(OLD)?.reason, 'conflicting-creators');
  assert.equal(client.getLastLoadFailure(OLD)?.code, 'CONFLICTING_CREATES');
});
console.log('PASS Browse / notification with no local record: a conflicted id is refused, never shown as the forgery');

await device(async client => {
  const state = await client.loadEscrow(OLD, { creator: seller.pk });
  assert.equal(state?.initiator.pubkey, seller.pk, 'the link names the seller, so the seller\'s CREATE is the root');
  assert.equal(state?.amountMsats, 100_000_000);
  assert.ok(state?.replayNotes?.some(n => n.eventId === forged.id && n.code === 'FOREIGN_CREATE'));
  // The binding outlives the call: a later plain reload stays on the same key.
  const again = await client.loadEscrow(OLD, { fullHistory: true });
  assert.equal(again?.initiator.pubkey, seller.pk, 'a reload of a trade this device holds stays bound to its creator');
});
console.log('PASS trade link with `by`: roots at the real CREATE, and stays there on reload');

await device(async client => {
  assert.equal(await client.loadEscrow(OLD, { creator: stranger.pk }).then(s => s?.initiator.pubkey), stranger.pk,
    'a link that names the stranger opens the stranger\'s own listing, as theirs');
});

Socket.chain = [forged, real, lock];
await device(async client => {
  assert.equal(await client.loadEscrow(OLD), null, 'a funded trade under a forged root is refused, not read as open');
  assert.equal(client.getLastLoadFailure(OLD)?.reason, 'conflicting-creators');
  const state = await client.loadEscrow(OLD, { creator: seller.pk });
  assert.equal(state?.status, EscrowStatus.LOCKED, 'named, the funded trade loads LOCKED with its real seller');
  assert.equal(state?.initiator.pubkey, seller.pk);
});
console.log('PASS a funded trade is never downgraded to a stranger\'s open listing');

// ── A new id names its creator: the forgery is not a CREATE of it at all ──
const NEW = creatorTaggedEscrowId('lz4k2b', 'abcd1234', seller.pk);
const realNew = sign(seller, NEW, EscrowEventKind.CREATE, T0, null, createPayload(seller, T0, 100_000_000));
const forgedNew = sign(stranger, NEW, EscrowEventKind.CREATE, T0 - 10, null, createPayload(stranger, T0 - 10, 1_000));
Socket.chain = [forgedNew, realNew];
await device(async client => {
  const state = await client.loadEscrow(NEW);
  assert.equal(state?.initiator.pubkey, seller.pk, 'with no creator supplied, a creator-tagged id still loads the real listing');
  assert.equal(state?.amountMsats, 100_000_000);
});
Socket.chain = [forgedNew];
await device(async client => {
  assert.equal(await client.loadEscrow(NEW), null, 'a forgery alone under a creator-tagged id is nothing');
});
await device(async client => {
  const { escrowId, state } = await Promise.race([
    client.createEscrow({ category: 'p2p-trade', description: 'New listing', amountMsats: 1_000_000, mintUrl: 'test', arbiterFeeMsats: 0, communityArbiters: [] }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('createEscrow timed out')), 3000)),
  ]);
  assert.ok(escrowId.endsWith(`_${buyer.pk.slice(0, 16)}`), `a new trade's id names its creator: ${escrowId}`);
  assert.equal(state.initiator.pubkey, buyer.pk);
});
console.log('PASS new ids name their creator; a forged CREATE under one is ignored without any hint from the caller');
