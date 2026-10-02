// Replay hardening evidence (docs/replay-hardening-brief.md).
//
// Drives the real cold-load path — relay REQ, nostr-tools signature
// verification, decrypt, parse, sort, replay — instead of calling the reducer
// directly. Every event is signed with its author's own key; strangers use
// only public data (the escrow id and the parties' pubkeys).
//
// Step 0 pinned the behaviour before any fix. Step 1 (trade identity is
// creator + id) flipped the finding-2 blocks; step 2 (invalid events from
// non-entitled authors are dropped) flipped finding 1.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-client.js';
import { creatorTaggedEscrowId } from './trade-identity.js';
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

// ── Finding 1 after step 2: a stray signed event is noted and skipped ─────
// Step 0 pinned the opposite here: each of these made the trade fail to load
// (chain-incomplete). outsider-replay.tests.ts covers eight such events on two
// viewer devices with real NIP-44; these four keep the step-0 rows comparable.
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
    const stray = make(id, b);
    const { state, failure } = await coldLoad(id, [...b.chain, stray]);
    assert.equal(failure, null, `${name}: ${failure?.code} ${failure?.message}`);
    assert.equal(state?.status, S.APPROVED, `${name}: loads to the honest state`);
    assert.equal(state?.resolvedOutcome, O.RELEASE);
    assert.ok(!state?.eventChain.some(e => e.raw.id === stray.id), `${name}: the stray is not in the chain`);
    assert.equal(state?.replayNotes?.find(n => n.eventId === stray.id)?.code, code, `${name}: noted as ${code}`);
    console.log(`PASS finding 1 after step 2: ${name} is skipped (${code}) and the trade loads APPROVED/release`);
  }
}

// ── Control: the signature verifier really runs on this path ──────────────
// The fake relay serialises every event, so the client verifies fresh objects
// and never sees finalizeEvent's cached "verified" marker. With a broken
// signature the stray CANCEL never reaches replay, so it leaves no note.
{
  const id = nextId();
  const b = baseline(id);
  const stray = sign(STRANGER, K.CANCEL, id, { type: 'escrow:cancel', cancellerRole: R.SELLER, reason: 'x', cancelledAt: T + 50 }, T + 50, b.resolve);
  const forged: NostrEvent = { id: stray.id, pubkey: stray.pubkey, created_at: stray.created_at, kind: stray.kind,
    tags: stray.tags, content: stray.content, sig: stray.sig.replace(/^../, stray.sig.startsWith('00') ? '11' : '00') };
  const { state, failure } = await coldLoad(id, [...b.chain, forged]);
  assert.equal(failure, null, `a badly signed stray is dropped before replay: ${failure?.code} ${failure?.message}`);
  assert.equal(state?.status, S.APPROVED);
  assert.ok(!state?.eventChain.some(e => e.raw.id === forged.id), 'the badly signed event never reaches the chain');
  assert.ok(!state?.replayNotes?.some(n => n.eventId === forged.id), 'nor replay: it is dropped at verification');
  console.log('PASS control: an event with a tampered signature is dropped, never reaching replay');
}

// ── Finding 2 after step 1: a stranger's CREATE cannot take a listing ─────
// Step 0 pinned the opposite here: the backdated CREATE became the root, and
// a buyer-funded (`marketplace`) listing was presented under the impostor with
// the impostor's own arbiter pool. A trade is now (creator, id). The unlocked,
// locked and link-with-`by` cases live in trade-identity.tests.ts; this keeps
// the severity case and the dating boundary on the same cold-load path.
{
  const SOCK = key(6);
  const listing = (sellerPk: string, arbiters: string[], at: number) => ({
    ...createPayload(sellerPk, 50_000_000, at), category: 'marketplace', description: 'Handmade chair',
    communityArbiters: arbiters });
  // The impostor's CREATE dated before the real one (the attack) and after it
  // (harmless before step 1). Both now get the same answer.
  for (const [when, at] of [['backdated', T - 10], ['later', T + 10]] as const) {
    // New ids name their creator: the impostor's CREATE is not this trade's.
    const tagged = creatorTaggedEscrowId(T.toString(36), `rh${(++idSeq).toString().padStart(6, '0')}`, pk(SELLER));
    const real = sign(SELLER, K.CREATE, tagged, listing(pk(SELLER), [pk(ARBITER)], T), T);
    const impostor = sign(STRANGER, K.CREATE, tagged, listing(pk(STRANGER), [pk(SOCK)], at), at);
    const fresh = await coldLoad(tagged, [real, impostor]);
    assert.equal(fresh.failure, null, `${when}: ${fresh.failure?.code} ${fresh.failure?.message}`);
    assert.equal(fresh.state?.status, S.CREATED);
    assert.equal(fresh.state?.participants[R.SELLER], pk(SELLER), `${when}: the real seller is the seller`);
    assert.deepEqual(fresh.state?.communityArbiters, [pk(ARBITER)], `${when}: the real arbiter pool`);
    assert.ok(!fresh.state?.eventChain.some(e => e.raw.id === impostor.id), `${when}: the impostor's CREATE is not in the chain`);
    console.log(`PASS creator-tagged id: a ${when} stranger CREATE is ignored and the real buyer-funded listing loads`);

    // Old ids name nobody. A fresh device with no record of the trade cannot
    // tell the two apart, so it shows neither. The listing is hidden, never
    // replaced. (Before step 1 the later CREATE was skipped as DUPLICATE_CREATE.)
    const old = nextId();
    const oldReal = sign(SELLER, K.CREATE, old, listing(pk(SELLER), [pk(ARBITER)], T), T);
    const oldImpostor = sign(STRANGER, K.CREATE, old, listing(pk(STRANGER), [pk(SOCK)], at), at);
    const refused = await coldLoad(old, [oldReal, oldImpostor]);
    assert.equal(refused.state, null, `${when}: an old id with two creators opens as neither listing`);
    assert.equal(refused.failure?.reason, 'conflicting-creators', when);
    assert.equal(refused.failure?.code, 'CONFLICTING_CREATES', when);
    console.log(`PASS old id: a ${when} stranger CREATE makes a fresh device refuse the listing (CONFLICTING_CREATES)`);
  }
}

process.exit(0);
