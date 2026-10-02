// End-to-end: an outsider cannot make a trade fail to load.
//
// The escrow id (`d` tag) and the ids in a trade's chain are public, and anyone
// can NIP-44-encrypt an envelope to the participants. So an outsider can publish
// events that pass the signature check, decrypt, and parse. This drives the full
// cold-load path (relay fetch → schnorr verify → decrypt → parse → sort →
// replay) with REAL signatures and REAL NIP-44, on a fresh device per case.
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { EscrowClient } from './escrow-client.js';
import { EscrowEventKind, EscrowStatus, Outcome, Role, type NostrEvent } from './types.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
} });

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const seller = key(), buyer = key(), arbiter = key(), outsider = key();
const everyone = [buyer.pk, seller.pk, arbiter.pk];
const ESCROW_ID = 'outsider-replay-e2e';
const T0 = Math.floor(Date.now() / 1000) - 600;

const seal = (from: Uint8Array, to: string, text: string) =>
  nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(from, to));
const envelope = (from: Uint8Array, payload: unknown) => JSON.stringify({
  encryptedFor: Object.fromEntries(everyone.map(pk => [pk, seal(from, pk, JSON.stringify(payload))])),
});
/** Explicit fields, never a spread: finalizeEvent stamps a hidden "verified"
 *  marker that a copied object would carry past the signature check. */
const sign = (by: { sk: Uint8Array }, kind: number, at: number, prev: string | null, content: string): NostrEvent => {
  const e = finalizeEvent({ kind, created_at: at, content,
    tags: [['d', ESCROW_ID], ...(prev ? [['e', prev, '', 'reply']] : [])] }, by.sk);
  return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
};

const lockPayload = (at: number) => ({
  type: 'escrow:lock', notesHash: 'notes-hash',
  shares: [0, 1, 2].map(shareIndex => ({ shareIndex,
    encryptedFor: Object.fromEntries(everyone.map(pk => [pk, `share-${shareIndex}`])) })),
  sellerReceivesMsats: 99_000_000, arbiterFeeMsats: 1_000_000,
  buyerPubkey: buyer.pk, arbiterPubkey: arbiter.pk, lockedAt: at,
});
const votePayload = (role: Role, outcome: Outcome, at: number) =>
  ({ type: 'escrow:vote', role, outcome, votedAt: at });

const create = sign(seller, EscrowEventKind.CREATE, T0, null, JSON.stringify({
  type: 'escrow:create', description: 'Sell 100k sats for $50', amountMsats: 100_000_000,
  fiatAmount: 50, fiatCurrency: 'USD', category: 'p2p-trade', mintUrl: 'fed11q...',
  platformFeeBps: 0, platformFeePubkey: seller.pk,
  arbiterFeeMsats: 1_000_000, paymentMethods: ['Zelle'], expirySeconds: 86400, createdAt: T0,
}));
const lock = sign(seller, EscrowEventKind.LOCK, T0 + 10, create.id, JSON.stringify(lockPayload(T0 + 10)));
const voteBuyer = sign(buyer, EscrowEventKind.VOTE, T0 + 20, lock.id,
  envelope(buyer.sk, votePayload(Role.BUYER, Outcome.RELEASE, T0 + 20)));
const voteSeller = sign(seller, EscrowEventKind.VOTE, T0 + 30, voteBuyer.id,
  envelope(seller.sk, votePayload(Role.SELLER, Outcome.RELEASE, T0 + 30)));
const resolve = sign(buyer, EscrowEventKind.RESOLVE, T0 + 40, voteSeller.id, envelope(buyer.sk, {
  type: 'escrow:resolve', outcome: Outcome.RELEASE, majority: [Role.BUYER, Role.SELLER],
  arbiterInvolved: false, resolvedAt: T0 + 40,
}));
const baseline = [create, lock, voteBuyer, voteSeller, resolve];

class Socket {
  static chain: NostrEvent[] = [];
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  constructor(public url: string) { queueMicrotask(() => this.onopen?.({} as Event)); }
  send(raw: string) {
    const message = JSON.parse(raw);
    if (message[0] !== 'REQ' || !String(message[1]).startsWith('sm_fetch_')) return;
    queueMicrotask(() => {
      for (const event of Socket.chain) this.emit(['EVENT', message[1], event]);
      this.emit(['EOSE', message[1]]);
    });
  }
  emit(message: unknown[]) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  close() {}
}

/** A fresh device belonging to `viewer`, cold-loading whatever the relay holds. */
async function coldLoad(chain: NostrEvent[], viewer = buyer) {
  Socket.chain = chain;
  const client = new EscrowClient({
    getPublicKey: async () => viewer.pk,
    signEvent: async event => finalizeEvent(event, viewer.sk),
    nip44Encrypt: async (text, pk) => seal(viewer.sk, pk, text),
    nip44Decrypt: async (text, pk) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(viewer.sk, pk)),
  }, { relays: ['wss://relay.invalid'], wsImpl: Socket as unknown as typeof WebSocket });
  try {
    client.connect();
    await new Promise(r => setTimeout(r, 5));
    const state = await client.loadEscrow(ESCROW_ID, { fullHistory: true });
    return { state, failure: client.getLastLoadFailure(ESCROW_ID) };
  } finally { client.disconnect(); }
}

const clean = await coldLoad(baseline);
assert.equal(clean.state?.status, EscrowStatus.APPROVED, 'baseline chain loads');
assert.equal(clean.state?.resolvedOutcome, Outcome.RELEASE);

const cases: Array<[string, NostrEvent, string]> = [
  ['arbiter VOTE before any principal voted',
    sign(arbiter, EscrowEventKind.VOTE, T0 + 15, lock.id,
      envelope(arbiter.sk, votePayload(Role.ARBITER, Outcome.REFUND, T0 + 15))), 'ARBITER_TOO_EARLY'],
  ['outsider VOTE claiming the buyer role',
    sign(outsider, EscrowEventKind.VOTE, T0 + 15, lock.id,
      envelope(outsider.sk, votePayload(Role.BUYER, Outcome.REFUND, T0 + 15))), 'NOT_PARTICIPANT'],
  ['outsider VOTE claiming the arbiter role',
    sign(outsider, EscrowEventKind.VOTE, T0 + 15, lock.id,
      envelope(outsider.sk, votePayload(Role.ARBITER, Outcome.REFUND, T0 + 15))), 'NOT_PARTICIPANT'],
  ['outsider CANCEL after RESOLVE',
    sign(outsider, EscrowEventKind.CANCEL, T0 + 50, resolve.id, JSON.stringify({
      type: 'escrow:cancel', cancellerRole: Role.SELLER, reason: 'x', cancelledAt: T0 + 50 })), 'INVALID_STATE'],
  ['outsider LOCK before the real one',
    sign(outsider, EscrowEventKind.LOCK, T0 + 5, create.id, JSON.stringify(lockPayload(T0 + 5))), 'NOT_PARTICIPANT'],
  ['outsider LOCK after the real one',
    sign(outsider, EscrowEventKind.LOCK, T0 + 15, lock.id, JSON.stringify(lockPayload(T0 + 15))), 'INVALID_STATE'],
  ['outsider CLAIM after RESOLVE',
    sign(outsider, EscrowEventKind.CLAIM, T0 + 50, resolve.id, envelope(outsider.sk, {
      type: 'escrow:claim', claimerRole: Role.SELLER, notesHashVerification: 'notes-hash', claimedAt: T0 + 50 })), 'WRONG_CLAIMER'],
  ['outsider CLAIM before RESOLVE',
    sign(outsider, EscrowEventKind.CLAIM, T0 + 15, lock.id, envelope(outsider.sk, {
      type: 'escrow:claim', claimerRole: Role.SELLER, notesHashVerification: 'notes-hash', claimedAt: T0 + 15 })), 'INVALID_STATE'],
];

let failures = 0;
for (const viewer of [buyer, arbiter]) {
  for (const [name, extra, code] of cases) {
    const { state, failure } = await coldLoad([...baseline, extra], viewer);
    const note = state?.replayNotes?.find(n => n.eventId === extra.id);
    const ok = state?.status === EscrowStatus.APPROVED && state.resolvedOutcome === Outcome.RELEASE
      && note?.code === code && !state.eventChain.some(e => e.raw.id === extra.id);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${viewer === buyer ? 'buyer' : 'arbiter'} device · ${name}` +
      (ok ? ` (skipped as ${code})` : ` — ${failure ? `load failed: ${failure.code}` : `status ${state?.status}, note ${note?.code}`}`));
  }
}
assert.equal(failures, 0, `${failures} hostile chain(s) did not load to the honest state`);
console.log('PASS an outsider-authored event never stops a signed trade from cold-loading');
