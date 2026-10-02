// Replay hardening, step 0: evidence before code (docs/replay-hardening-brief.md).
//
// Reproduces the brief's findings through the real cold-load path —
// relay REQ, nostr-tools signature verification, decrypt, parse, sort,
// replay — instead of calling the reducer directly. Every event is signed
// with its author's own key; strangers use only public data (the escrow id
// and the parties' pubkeys). Assertions pin TODAY's behaviour, which is
// fail-closed. When step 1 (trade identity is creator + id) and step 2
// (invalid events from non-entitled authors are dropped) land, the
// assertions marked "STEP 1" / "STEP 2" are the ones expected to change.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-client.js';
import { EscrowEventKind as K, EscrowStatus as S, Outcome as O, Role as R, type NostrEvent } from './types.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k), clear: () => storage.clear(),
} });

// A relay that answers REQ with whatever it holds for the filter's `#d`.
// Deliberately no `authors` handling: the client sends none (that is finding 0).
let relayEvents: NostrEvent[] = [];
const requests: Record<string, unknown>[] = [];
class Relay {
  static all: Relay[] = [];
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void; onclose?: () => void; onerror?: () => void;
  readyState = 1;
  constructor(public url: string) { Relay.all.push(this); }
  send(s: string) {
    const message = JSON.parse(s);
    if (message[0] !== 'REQ') return;
    const [, subId, filter] = message;
    requests.push(filter);
    queueMicrotask(() => {
      for (const event of relayEvents) {
        if (filter['#d'] && !event.tags.some(t => t[0] === 'd' && filter['#d'].includes(t[1]))) continue;
        if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
        if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
        this.onmessage?.({ data: JSON.stringify(['EVENT', subId, event]) } as MessageEvent);
      }
      this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) } as MessageEvent);
    });
  }
  close() {}
}

const key = (n: number) => new Uint8Array(32).fill(n);
const SELLER = key(1), BUYER = key(2), ARBITER = key(3), STRANGER = key(4), FRESH_DEVICE = key(5);
const pk = (k: Uint8Array) => getPublicKey(k);
const T = Math.floor(Date.now() / 1000) - 3600;

// Plaintext escrow payloads: decryptEventContent's "Shape 1". A stranger
// needs no key material from the parties to produce one.
function sign(secret: Uint8Array, kind: K, id: string, payload: Record<string, unknown>, at: number, prev?: NostrEvent): NostrEvent {
  return finalizeEvent({ kind, created_at: at, content: JSON.stringify(payload),
    tags: [['d', id], ['t', String(payload.type)], ...(prev ? [['e', prev.id, '', 'reply']] : [])] }, secret) as NostrEvent;
}

function createPayload(sellerPk: string, amountMsats: number, at: number) {
  return { type: 'escrow:create', category: 'p2p-trade', description: 'Sell sats for USD',
    amountMsats, fiatAmount: 50, fiatCurrency: 'USD', mintUrl: 'fed11test', platformFeeBps: 0,
    platformFeePubkey: sellerPk, arbiterFeeMsats: 0, paymentMethods: ['Zelle'], expirySeconds: 86400 * 7,
    communityArbiters: [pk(ARBITER)], createdAt: at };
}

/** The brief's baseline: CREATE, LOCK, buyer RELEASE, seller RELEASE, RESOLVE. */
function baseline(id: string) {
  const create = sign(SELLER, K.CREATE, id, createPayload(pk(SELLER), 100_000_000, T), T);
  const lock = sign(SELLER, K.LOCK, id, { type: 'escrow:lock', notesHash: 'h',
    shares: [0, 1, 2].map(shareIndex => ({ shareIndex, encryptedFor: { [pk(BUYER)]: 'b', [pk(SELLER)]: 's', [pk(ARBITER)]: 'a' } })),
    sellerReceivesMsats: 100_000_000, arbiterFeeMsats: 0, buyerPubkey: pk(BUYER), arbiterPubkey: pk(ARBITER),
    lockedAt: T + 10 }, T + 10, create);
  const buyerVote = sign(BUYER, K.VOTE, id, { type: 'escrow:vote', outcome: O.RELEASE, role: R.BUYER, votedAt: T + 20 }, T + 20, lock);
  const sellerVote = sign(SELLER, K.VOTE, id, { type: 'escrow:vote', outcome: O.RELEASE, role: R.SELLER, votedAt: T + 30 }, T + 30, buyerVote);
  const resolve = sign(BUYER, K.RESOLVE, id, { type: 'escrow:resolve', outcome: O.RELEASE,
    majority: [R.BUYER, R.SELLER], arbiterInvolved: false, resolvedAt: T + 40 }, T + 40, sellerVote);
  return { create, lock, buyerVote, sellerVote, resolve, chain: [create, lock, buyerVote, sellerVote, resolve] };
}

/** A fresh device: nothing cached, real signature verifier, cold load. */
async function coldLoad(id: string, events: NostrEvent[]) {
  relayEvents = events;
  Relay.all = [];
  storage.clear();
  const client = new EscrowClient({ getPublicKey: async () => pk(FRESH_DEVICE),
    signEvent: async event => finalizeEvent(event, FRESH_DEVICE), nip44Encrypt: async v => v, nip44Decrypt: async v => v,
  }, { relays: ['wss://one.invalid', 'wss://two.invalid'], wsImpl: Relay as unknown as typeof WebSocket });
  try {
    client.connect();
    for (const relay of Relay.all) relay.onopen?.({} as Event);
    const state = await client.loadEscrow(id, { fullHistory: true });
    return { state, failure: client.getLastLoadFailure(id) };
  } finally { client.disconnect(); }
}

let idSeq = 0;
const nextId = () => `sm_${T.toString(36)}_rh${(++idSeq).toString().padStart(6, '0')}`;

// ── Baseline loads ────────────────────────────────────────────────────────
{
  const id = nextId();
  const { chain } = baseline(id);
  const { state, failure } = await coldLoad(id, chain);
  assert.equal(failure, null, `baseline loads: ${failure?.code} ${failure?.message}`);
  assert.equal(state?.status, S.APPROVED);
  assert.equal(state?.resolvedOutcome, O.RELEASE);
  assert.ok(requests.every(f => !('authors' in f)), 'the trade fetch carries no authors filter');
  console.log('PASS baseline chain cold-loads to APPROVED/release; fetch has no authors filter');
}

// ── Finding 1: one stray signed event makes the whole trade fail to load ──
{
  const strays: [string, (id: string, b: ReturnType<typeof baseline>) => NostrEvent, string][] = [
    ['arbiter VOTE before either principal voted',
      (id, b) => sign(ARBITER, K.VOTE, id, { type: 'escrow:vote', outcome: O.REFUND, role: R.ARBITER, votedAt: T + 15 }, T + 15, b.lock),
      'ARBITER_TOO_EARLY'],
    ['stranger VOTE claiming buyer',
      (id, b) => sign(STRANGER, K.VOTE, id, { type: 'escrow:vote', outcome: O.REFUND, role: R.BUYER, votedAt: T + 15 }, T + 15, b.lock),
      'NOT_PARTICIPANT'],
    ['stranger VOTE claiming arbiter',
      (id, b) => sign(STRANGER, K.VOTE, id, { type: 'escrow:vote', outcome: O.REFUND, role: R.ARBITER, votedAt: T + 15 }, T + 15, b.lock),
      'NOT_PARTICIPANT'],
    ['stranger CANCEL after RESOLVE',
      (id, b) => sign(STRANGER, K.CANCEL, id, { type: 'escrow:cancel', cancellerRole: R.SELLER, reason: 'x', cancelledAt: T + 50 }, T + 50, b.resolve),
      'INVALID_STATE'],
  ];
  for (const [name, make, code] of strays) {
    const id = nextId();
    const b = baseline(id);
    const { state, failure } = await coldLoad(id, [...b.chain, make(id, b)]);
    // STEP 2: expected to load as APPROVED/release with a replay note instead.
    assert.equal(state, null, `${name}: trade does not load today`);
    assert.equal(failure?.reason, 'chain-incomplete', name);
    assert.equal(failure?.code, code, `${name}: ${failure?.code} ${failure?.message}`);
    console.log(`PASS finding 1 reproduced through loadEscrow: ${name} → ${code}`);
  }
}

// ── Finding 2: a stranger's backdated CREATE takes the root ───────────────
{
  const id = nextId();
  const real = sign(SELLER, K.CREATE, id, createPayload(pk(SELLER), 100_000_000, T), T);
  const impostor = sign(STRANGER, K.CREATE, id, createPayload(pk(STRANGER), 1_000, T - 10), T - 10);

  const alone = await coldLoad(id, [real]);
  assert.equal(alone.state?.status, S.CREATED);
  assert.equal(alone.state?.participants[R.SELLER], pk(SELLER));
  assert.equal(alone.state?.amountMsats, 100_000_000);

  // STEP 1: with the expected creator known, this must root at `real`.
  const unlocked = await coldLoad(id, [real, impostor]);
  assert.equal(unlocked.failure, null, `${unlocked.failure?.code}`);
  assert.equal(unlocked.state?.status, S.CREATED, 'unlocked listing still reads as open');
  assert.equal(unlocked.state?.participants[R.SELLER], pk(STRANGER), 'impostor is seated as seller');
  assert.equal(unlocked.state?.amountMsats, 1_000, "impostor's terms replace the real listing");
  console.log('PASS finding 2 reproduced through loadEscrow: backdated stranger CREATE replaces the open listing');

  const b = baseline(id);
  const locked = await coldLoad(id, [...b.chain, impostor]);
  assert.equal(locked.state, null, 'a locked trade under an impostor root fails to load');
  assert.equal(locked.failure?.code, 'NOT_PARTICIPANT', `${locked.failure?.code} ${locked.failure?.message}`);
  console.log('PASS finding 2 reproduced through loadEscrow: locked trade under an impostor root fails NOT_PARTICIPANT (fail-closed)');
}

// ── Finding 2 severity: a buyer-funded listing ────────────────────────────
// In `marketplace` the BUYER locks (funderRole). An impostor who copies the
// real listing's terms but names their own arbiter is presented, on a fresh
// device, as an open listing the buyer can fund, with the impostor holding
// seller + arbiter (2 of 3). What stands between the buyer and that lock
// today is UI, not consensus: TradeDetail's arbiter provenance check flags
// an arbiter outside the community roster / bonded / device-trusted pool.
{
  const id = nextId();
  const SOCK = key(6);
  const listing = (sellerPk: string, arbiters: string[], at: number) => ({
    ...createPayload(sellerPk, 50_000_000, at), category: 'marketplace', description: 'Handmade chair',
    communityArbiters: arbiters });
  const real = sign(SELLER, K.CREATE, id, listing(pk(SELLER), [pk(ARBITER)], T), T);
  const impostor = sign(STRANGER, K.CREATE, id, listing(pk(STRANGER), [pk(SOCK)], T - 10), T - 10);
  const { state, failure } = await coldLoad(id, [real, impostor]);
  assert.equal(failure, null, `${failure?.code}`);
  assert.equal(state?.status, S.CREATED, 'reads as an open, fundable listing');
  assert.equal(state?.description, 'Handmade chair', 'same title and price as the real listing');
  assert.equal(state?.amountMsats, 50_000_000);
  assert.equal(state?.participants[R.SELLER], pk(STRANGER), 'impostor is the seller');
  assert.deepEqual(state?.communityArbiters, [pk(SOCK)], "impostor's own arbiter pool");
  console.log('PASS finding 2 severity: a buyer-funded listing is presented under the impostor with their arbiter pool');
}

// ── Finding 2 boundary: a CREATE dated after the real one is harmless ─────
{
  const id = nextId();
  const real = sign(SELLER, K.CREATE, id, createPayload(pk(SELLER), 100_000_000, T), T);
  const late = sign(STRANGER, K.CREATE, id, createPayload(pk(STRANGER), 1_000, T + 10), T + 10);
  const { state } = await coldLoad(id, [real, late]);
  assert.equal(state?.participants[R.SELLER], pk(SELLER));
  assert.equal(state?.amountMsats, 100_000_000);
  console.log('PASS a later stranger CREATE is skipped as DUPLICATE_CREATE');
}

process.exit(0);
