// #43 refused-lock rules (roadmap/refused-lock-design.md): withheld shares,
// ACCEPT pins a LOCK against its acceptor's own CANCEL, RELEASE, WITHDRAW.
// Real signatures, real Shamir split, real NIP-44: the acceptance test is that a
// seller and arbiter holding everything published for a refused LOCK cannot
// rebuild the buyer's notes.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { split, combine } from 'shamir-secret-sharing';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseEscrowEvent, sortEventChain } from './event-parser.js';
import { applyEvent, canVote, replayEventChain } from './state-machine.js';
import { WITHHELD_SHARES_CREATE_AT as gate, TRADE_RULES_DEC_2026_CREATE_AT } from './protocol-hardening.js';
import { shareCommitment, releasedShareMatches } from './holder-shares.js';
import { rejectedLockRecovery } from '../fedimint/rejected-lock-recovery.js';
import {
  EscrowEventKind as K, Role, EscrowStatus as S, Outcome,
  type EscrowPayload, type EscrowState, type LockShareEntry, type ParsedEscrowEvent,
} from './types.js';

const keys = [41, 42, 43, 44].map(n => new Uint8Array(32).fill(n));
const [seller, buyer, arbiter, backup] = keys.map(getPublicKey);
const keyOf: Record<string, Uint8Array> = { [seller]: keys[0], [buyer]: keys[1], [arbiter]: keys[2], [backup]: keys[3] };
let sequence = 0;
let failures = 0;
async function check(name: string, body: () => void | Promise<void>) {
  try { await body(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : error}`); }
}

function sign(kind: K, payload: EscrowPayload, signer: string, at: number, d: string, prev?: string): ParsedEscrowEvent {
  const raw = finalizeEvent({ kind, created_at: at, tags: [['d', d], ...(prev ? [['e', prev, '', 'reply']] : [])], content: JSON.stringify(payload) }, keyOf[signer]);
  const parsed = parseEscrowEvent(raw, raw.content);
  assert(parsed.ok, parsed.ok ? '' : `${parsed.error.code}: ${parsed.error.message}`);
  return parsed.event;
}
const enc = (from: string, to: string, text: string) => nip44.encrypt(text, nip44.getConversationKey(keyOf[from], to));
const dec = (me: string, from: string, ct: string) => nip44.decrypt(ct, nip44.getConversationKey(keyOf[me], from));

const NOTES = 'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vZXhhbXBsZSJ9XX0-test-notes-for-43';
const notesHash = bytesToHex(sha256(new TextEncoder().encode(NOTES)));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
async function shares() {
  const parts = await split(new TextEncoder().encode(NOTES), 3, 2);
  return parts.map((bytes, index) => JSON.stringify({ index, data: b64(bytes) }));
}
async function rebuild(plaintexts: string[]): Promise<string | null> {
  try {
    const bytes = plaintexts.map(text => new Uint8Array(Buffer.from(JSON.parse(text).data, 'base64')));
    if (new Set(plaintexts).size < 2) return null;
    const notes = new TextDecoder().decode(await combine(bytes));
    return bytesToHex(sha256(new TextEncoder().encode(notes))) === notesHash ? notes : null;
  } catch { return null; }
}

/** A Market listing (seller creates, buyer funds), created `at`. */
function market(at: number) {
  const d = `withheld-${++sequence}`;
  const create = sign(K.CREATE, { type: 'escrow:create', category: 'marketplace', description: 'Synthetic #43', amountMsats: 100000,
    mintUrl: 'fed1test', platformFeeBps: 0, platformFeePubkey: seller, expirySeconds: 86400, communityArbiters: [arbiter], createdAt: at } as EscrowPayload,
    seller, at, d);
  const join = sign(K.JOIN, { type: 'escrow:join', role: Role.BUYER, joinedAt: at + 1 } as EscrowPayload, buyer, at + 1, d, create.raw.id);
  return { d, create, join };
}

/** The buyer's LOCK. withheld: only share 0 carries ciphertext (to the buyer). */
function lockEvent(d: string, prev: string, at: number, plaintexts: string[], withheld: boolean): ParsedEscrowEvent {
  const holders = [buyer, seller, arbiter];
  const entries: LockShareEntry[] = plaintexts.map((text, shareIndex) => withheld && shareIndex !== 0
    ? { shareIndex, encryptedFor: {}, commitment: shareCommitment(d, notesHash, shareIndex, text) }
    : { shareIndex, encryptedFor: { [holders[shareIndex]]: enc(buyer, holders[shareIndex], text) } });
  return sign(K.LOCK, { type: 'escrow:lock', notesHash, shares: entries, sharePolicy: 'holder-only-v1',
    ...(withheld ? { withheldShares: true } : {}), sellerReceivesMsats: 100000, arbiterFeeMsats: 0,
    buyerPubkey: buyer, arbiterPubkey: arbiter, lockedAt: at } as EscrowPayload, buyer, at, d, prev);
}
const step = (d: string, signer: string, at: number, prev: string, payload: object) =>
  sign(K.LOCK_STEP, { type: 'escrow:lock_step', ...payload } as EscrowPayload, signer, at, d, prev);
const cancel = (d: string, at: number, prev: string) =>
  sign(K.CANCEL, { type: 'escrow:cancel', cancellerRole: Role.SELLER, cancelledAt: at } as EscrowPayload, seller, at, d, prev);
function releaseShares(plaintexts: string[], arbiterRecipients = [arbiter]): LockShareEntry[] {
  return [
    { shareIndex: 1, encryptedFor: { [seller]: enc(buyer, seller, plaintexts[1]) } },
    { shareIndex: 2, encryptedFor: Object.fromEntries(arbiterRecipients.map(pk => [pk, enc(buyer, pk, plaintexts[2])])) },
  ];
}
function replay(events: ParsedEscrowEvent[]): EscrowState {
  const result = replayEventChain(sortEventChain(events), { creator: seller });
  assert(result.ok, result.ok ? '' : `${result.error.code}: ${result.error.message}`);
  return result.state;
}
/** Everything a set of people can decrypt from a read: LOCK shares and released shares. */
function decryptable(events: ParsedEscrowEvent[], people: string[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const entries = event.kind === K.LOCK ? (event.payload as { shares: LockShareEntry[] }).shares
      : event.kind === K.LOCK_STEP ? ((event.payload as { shares?: LockShareEntry[] }).shares ?? []) : [];
    for (const entry of entries) for (const person of people) {
      const ct = entry.encryptedFor[person];
      if (ct) out.push(dec(person, event.pubkey, ct));
    }
  }
  return out;
}

const T0 = gate + 3600;

console.log('#43 withheld shares');

await check('control: an old all-shares LOCK refused by a cancel can be rebuilt by seller + arbiter (the bug)', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const cancelled = cancel(d, T0 + 5, create.raw.id);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, false);
  const state = replay([create, join, cancelled, lock]);
  assert.equal(state.status, S.CANCELLED);
  assert.equal(state.rejectedLocks?.[0].code, 'CANCELLED_BEFORE_LOCK');
  assert.equal(await rebuild(decryptable([create, join, cancelled, lock], [seller, arbiter])), NOTES);
});

await check('refused withheld LOCK: seller + arbiter hold nothing that rebuilds the notes; buyer recovery still offered', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const cancelled = cancel(d, T0 + 5, create.raw.id);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const read = [create, join, cancelled, lock];
  const state = replay(read);
  assert.equal(state.status, S.CANCELLED);
  assert.equal(state.rejectedLocks?.[0].code, 'CANCELLED_BEFORE_LOCK');
  assert.deepEqual(decryptable(read, [seller, arbiter, backup]), [], 'nothing in the read is encrypted to them');
  assert.equal(await rebuild(decryptable(read, [buyer])), null, 'the buyer\'s single published share rebuilds nothing either');
  const recovery = rejectedLockRecovery(state, { oobNotes: NOTES, amountMsats: 100000 } as never, buyer);
  assert.equal(recovery?.eventId, lock.raw.id);
});

await check('backdated cancel after the seller accepted: set aside, trade stays funded', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  // Signed after seeing the LOCK, dated before it, replying to the CREATE.
  const backdated = cancel(d, T0 + 5, create.raw.id);
  const state = replay([create, join, lock, accept, backdated]);
  assert.equal(state.status, S.LOCKED);
  assert.equal(state.lock.acceptedBy, seller);
  assert.equal(state.rejectedLocks, undefined);
  assert(state.replayNotes?.some(note => note.eventId === backdated.raw.id && note.code === 'CANCEL_AFTER_ACCEPT'));
  // Without the accept, today's rule still holds: the cancel refuses the LOCK.
  assert.equal(replay([create, join, lock, backdated]).status, S.CANCELLED);
});

await check('the pin also protects an old app\'s all-shares LOCK on a gated trade', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, false);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const state = replay([create, join, lock, accept, cancel(d, T0 + 5, create.raw.id)]);
  assert.equal(state.status, S.LOCKED);
  assert.equal(state.lock.withheld, undefined);
});

await check('release after accept: shares merged, commitments match, votes open; claim material is the usual two shares', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const before = replay([create, join, lock, accept]);
  assert.equal(canVote(before, seller, T0 + 30).canVote, false, 'no vote before release');
  const vote = sign(K.VOTE, { type: 'escrow:vote', outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: T0 + 25 } as EscrowPayload, buyer, T0 + 25, d, accept.raw.id);
  const early = applyEvent(before, vote);
  assert(!early.ok && early.error.code === 'SHARES_NOT_RELEASED');
  const release = step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) });
  const read = [create, join, lock, accept, release];
  const state = replay(read);
  assert.equal(state.lock.withheld?.releaseEventId, release.raw.id);
  assert.equal(state.lock.shares.size, 3);
  assert.equal(canVote(state, seller, T0 + 40).canVote, true);
  const sellerShare = dec(seller, buyer, state.lock.shares.get('1')!.encryptedFor[seller]);
  assert(releasedShareMatches(state, 1, sellerShare));
  assert(!releasedShareMatches(state, 1, plain[2]), 'a share that differs from the commitment does not match');
  // After release the 2-of-3 is the agreed trust: seller + arbiter together can rebuild.
  assert.equal(await rebuild(decryptable(read, [seller, arbiter])), NOTES);
});

await check('release is refused before accept, from anyone but the funder, or routing a share to a principal', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const locked = replay([create, join, lock]);
  const noAccept = applyEvent(locked, step(d, buyer, T0 + 15, lock.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) }));
  assert(!noAccept.ok && noAccept.error.code === 'LOCK_STEP_ORDER');
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const accepted = replay([create, join, lock, accept]);
  const byArbiter = applyEvent(accepted, step(d, arbiter, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) }));
  assert(!byArbiter.ok && byArbiter.error.code === 'NOT_PARTICIPANT');
  const toSeller = applyEvent(accepted, step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain, [arbiter, seller]) }));
  assert(!toSeller.ok && toSeller.error.code === 'INVALID_SHARES', 'the arbiter share never goes to a principal');
  const acceptByArbiter = applyEvent(locked, step(d, arbiter, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id }));
  assert(!acceptByArbiter.ok && acceptByArbiter.error.code === 'NOT_PARTICIPANT');
  const acceptByFunder = applyEvent(locked, step(d, buyer, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id }));
  assert(!acceptByFunder.ok && acceptByFunder.error.code === 'NOT_PARTICIPANT');
});

await check('withdraw before release: LOCK set aside, trade open again, buyer recovery offered', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const withdraw = step(d, buyer, T0 + 600, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  const state = replay([create, join, lock, withdraw]);
  assert.equal(state.status, S.CREATED);
  assert.equal(state.lock.notesHash, null);
  assert.equal(state.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
  assert.equal(rejectedLockRecovery(state, { oobNotes: NOTES, amountMsats: 100000 } as never, buyer)?.eventId, lock.raw.id);
  // Live: the withdraw asks for a reload instead of applying.
  const live = applyEvent(replay([create, join, lock]), withdraw);
  assert(!live.ok && live.error.code === 'LOCK_WITHDRAWN');
  // Same after an accept, as long as nothing was released.
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const late = step(d, buyer, T0 + 700, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  assert.equal(replay([create, join, lock, accept, late]).status, S.CREATED);
});

await check('release outranks withdraw; a withdraw by anyone else or of an all-shares LOCK does nothing', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const release = step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) });
  const withdraw = step(d, buyer, T0 + 40, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  const both = replay([create, join, lock, accept, release, withdraw]);
  assert.equal(both.status, S.LOCKED);
  assert.equal(both.lock.withheld?.releaseEventId, release.raw.id);
  const bySeller = step(d, seller, T0 + 40, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  assert.equal(replay([create, join, lock, bySeller]).status, S.LOCKED);
  const oldShape = lockEvent(d, join.raw.id, T0 + 10, plain, false);
  const oldWithdraw = step(d, buyer, T0 + 40, oldShape.raw.id, { step: 'withdraw', lockEventId: oldShape.raw.id });
  assert.equal(replay([create, join, oldShape, oldWithdraw]).status, S.LOCKED, 'shares already out: no withdraw');
});

await check('gate edges: a withheld LOCK is refused one second before the date and accepted at it', async () => {
  const plain = await shares();
  for (const [at, ok] of [[gate - 1, false], [gate, true]] as const) {
    const { d, create, join } = market(at);
    const created = replay([create, join]);
    const result = applyEvent(created, lockEvent(d, join.raw.id, at + 10, plain, true));
    assert.equal(result.ok, ok, `created ${at - gate}s from the gate`);
    if (!ok) assert.equal((result as { error: { code: string } }).error.code, 'INVALID_SHARES');
  }
  // Before the date a LOCK_STEP changes nothing and a backdated cancel keeps today's effect.
  const { d, create, join } = market(gate - 1);
  const lock = lockEvent(d, join.raw.id, gate + 10, plain, false);
  const accept = step(d, seller, gate + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const state = replay([create, join, lock, accept, cancel(d, gate + 5, create.raw.id)]);
  assert.equal(state.status, S.CANCELLED, 'trades created before the date keep the rules they were created under');
  assert(TRADE_RULES_DEC_2026_CREATE_AT < gate);
});

await check('a withheld LOCK must carry the funder\'s own share, to the funder alone', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const created = replay([create, join]);
  // Funder's ciphertext addressed to the seller instead.
  const wrong = sign(K.LOCK, { type: 'escrow:lock', notesHash, sharePolicy: 'holder-only-v1', withheldShares: true,
    shares: [{ shareIndex: 0, encryptedFor: { [seller]: enc(buyer, seller, plain[0]) } },
      { shareIndex: 1, encryptedFor: {}, commitment: shareCommitment(d, notesHash, 1, plain[1]) },
      { shareIndex: 2, encryptedFor: {}, commitment: shareCommitment(d, notesHash, 2, plain[2]) }],
    sellerReceivesMsats: 100000, arbiterFeeMsats: 0, buyerPubkey: buyer, arbiterPubkey: arbiter, lockedAt: T0 + 10 } as EscrowPayload,
    buyer, T0 + 10, d, join.raw.id);
  const result = applyEvent(created, wrong);
  assert(!result.ok && result.error.code === 'INVALID_SHARES');
});

await check('ORDER_NOT_FINALIZED on a seller-funded withheld LOCK: buyer + arbiter hold nothing; seller recovery offered', async () => {
  const plain = await shares();
  const at = T0, d = `withheld-${++sequence}`;
  const item = { id: 'a', label: 'A', amountMsats: 100000 };
  const create = sign(K.CREATE, { type: 'escrow:create', category: 'p2p-trade', description: 'Synthetic #43 order', amountMsats: 100000,
    mintUrl: 'fed1test', platformFeeBps: 0, platformFeePubkey: seller, expirySeconds: 86400, communityArbiters: [arbiter], createdAt: at,
    items: [item] } as EscrowPayload, seller, at, d);
  const join = sign(K.JOIN, { type: 'escrow:join', role: Role.BUYER, joinedAt: at + 1, orderFinalizedAt: at + 1,
    selectedItems: [{ itemId: 'a', label: 'A', amountMsats: 100000, quantity: 1 }] } as EscrowPayload, buyer, at + 1, d, create.raw.id);
  const lockAt = at + 1 + 5 * 60 + 2 * 60 + 5; // after the hold and its grace
  const holders = [buyer, seller, arbiter];
  const lock = sign(K.LOCK, { type: 'escrow:lock', notesHash, sharePolicy: 'holder-only-v1', withheldShares: true,
    shares: plain.map((text, shareIndex) => shareIndex === 1
      ? { shareIndex, encryptedFor: { [seller]: enc(seller, seller, text) } }
      : { shareIndex, encryptedFor: {}, commitment: shareCommitment(d, notesHash, shareIndex, text) }),
    selectedItems: [{ itemId: 'a', label: 'A', amountMsats: 100000, quantity: 1 }],
    sellerReceivesMsats: 100000, arbiterFeeMsats: 0, buyerPubkey: buyer, arbiterPubkey: arbiter, lockedAt: lockAt } as EscrowPayload,
    seller, lockAt, d, join.raw.id);
  void holders;
  const read = [create, join, lock];
  const state = replay(read);
  assert.equal(state.rejectedLocks?.[0].code, 'ORDER_NOT_FINALIZED');
  assert.deepEqual(decryptable(read, [buyer, arbiter, backup]), []);
  assert.equal(rejectedLockRecovery(state, { oobNotes: NOTES, amountMsats: 100000 } as never, seller)?.eventId, lock.raw.id);
});

await check('the app: no "needs you" before release, and the waiting notice names who is waiting', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { WithheldSharesNotice } = await import('../ui/components/WithheldSharesNotice.js');
  const { needsYouReasonFor } = await import('../ui/decisions.js');
  const { translate } = await import('../i18n/index.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const waiting = replay([create, join, lock, accept]);
  for (const who of [buyer, seller, arbiter]) assert.equal(needsYouReasonFor(waiting, who, T0 + 60), null, 'nobody is summoned before release');
  const t = (key: string) => translate('en', key);
  const sellerView = renderToStaticMarkup(createElement(WithheldSharesNotice, { state: waiting, pubkey: seller, t }));
  assert.match(sellerView, /deliver anything yet/);
  const buyerView = renderToStaticMarkup(createElement(WithheldSharesNotice, { state: waiting, pubkey: buyer, t }));
  assert.match(buyerView, /once the other side accepts/);
  const release = step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) });
  const funded = replay([create, join, lock, accept, release]);
  assert.equal(renderToStaticMarkup(createElement(WithheldSharesNotice, { state: funded, pubkey: seller, t })), '');
  assert.equal(needsYouReasonFor(funded, seller, T0 + 60), 'vote', 'after release the seller is summoned as today');
});

await check('the app accepts on its own, once, only as the principal who did not fund', async () => {
  const { EscrowClient } = await import('./escrow-client.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const locked = replay([create, join, lock]);
  for (const [me, expected] of [[seller, 1], [buyer, 0], [arbiter, 0]] as const) {
    const published: { kind: number; tags: string[][]; content: string }[] = [];
    const client = Object.create(EscrowClient.prototype) as any;
    client.states = new Map([[d, locked]]);
    client.rawEvents = new Map();
    client.lockAcceptsInFlight = new Set();
    client.callbacks = {};
    client.getPubkey = async () => me;
    client.setHotRawEvents = () => {};
    client.signWithSimTag = async (u: any) => finalizeEvent(u, keyOf[me]);
    client.relayManager = { publish: async (e: any) => { published.push(e); } };
    await Promise.all([client.maybeAutoAccept(d), client.maybeAutoAccept(d)]);
    await client.maybeAutoAccept(d);
    assert.equal(published.length, expected, `${me === seller ? 'seller' : me === buyer ? 'buyer' : 'arbiter'} publishes ${expected}`);
    if (expected) {
      assert.equal(published[0].kind, K.LOCK_STEP);
      assert.deepEqual(published[0].tags.find(tag => tag[0] === 'e')?.slice(0, 2), ['e', lock.raw.id]);
      assert.equal(client.states.get(d).lock.acceptedBy, seller);
    }
  }
  // Before the date the app never sends one.
  const old = market(gate - 10);
  const oldLocked = replay([old.create, old.join, lockEvent(old.d, old.join.raw.id, gate + 10, plain, false)]);
  const client = Object.create(EscrowClient.prototype) as any;
  let sent = 0;
  Object.assign(client, { states: new Map([[old.d, oldLocked]]), lockAcceptsInFlight: new Set(), getPubkey: async () => seller,
    relayManager: { publish: async () => { sent++; } } });
  await client.maybeAutoAccept(old.d);
  assert.equal(sent, 0);
});

await check('a withdrawn LOCK\'s saved notes come back automatically, with measured credit', async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  const { setLocalStorageUserScope } = await import('../storage/user-scope.js');
  setLocalStorageUserScope('withheld-test');
  const { stashNativeLockIntent, upgradeNativeLockToSpent, markNativeLockPublishAttempted, getPendingNativeLock, recoverPendingNativeLock } = await import('../fedimint/pending-native-locks.js');
  const { hashNotes } = await import('../fedimint/fedimint-client.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const state = replay([create, join, lock, step(d, buyer, T0 + 600, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id })]);
  const input = { escrowId: d, amountMsats: 100000, federationId: 'test-fed' };
  stashNativeLockIntent(input); upgradeNativeLockToSpent({ ...input, oobNotes: NOTES }); markNativeLockPublishAttempted(d);
  let credited = 0;
  const outcome = await recoverPendingNativeLock(getPendingNativeLock(d)!, {
    loadEscrow: async () => state, getConnectedRelayCount: () => 1, currentFederationId: () => 'test-fed', hashNotes,
    redeemNotes: async () => { throw Error('not a credit receipt'); },
    redeemRejectedNotes: async (entry: { oobNotes: string }) => { assert.equal(entry.oobNotes, NOTES); credited++; },
    now: () => (T0 + 700) * 1000,
  } as never);
  assert.equal(outcome, 'reabsorbed');
  assert.equal(credited, 1);
  assert.equal(getPendingNativeLock(d), null);
});

await check('review B1: steps never join the chain, so later events reply to the LOCK and an older reader still loads', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, false);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const accepted = replay([create, join, lock, accept]);
  assert(!accepted.eventChain.some(e => e.kind === K.LOCK_STEP), 'no LOCK_STEP in eventChain');
  assert.equal(accepted.eventChain.at(-1)!.raw.id, lock.raw.id, 'the tip a writer replies to is still the LOCK');
  const vote = sign(K.VOTE, { type: 'escrow:vote', outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: T0 + 30 } as EscrowPayload, buyer, T0 + 30, d, accepted.eventChain.at(-1)!.raw.id);
  // What an older reader holds: everything except the kind it does not know.
  const older = replay([create, join, lock, vote]);
  assert.equal(older.votes[Role.BUYER], Outcome.RELEASE);
  assert.equal(replay([create, join, lock, accept, vote]).votes[Role.BUYER], Outcome.RELEASE);
});

await check('review B2: a vote or resolve about a withdrawn LOCK never stops the trade loading', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const oldAppVote = sign(K.VOTE, { type: 'escrow:vote', outcome: Outcome.RELEASE, role: Role.SELLER, votedAt: T0 + 30 } as EscrowPayload, seller, T0 + 30, d, lock.raw.id);
  const withdraw = step(d, buyer, T0 + 600, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  const lateVote = sign(K.VOTE, { type: 'escrow:vote', outcome: Outcome.REFUND, role: Role.ARBITER, votedAt: T0 + 700 } as EscrowPayload, arbiter, T0 + 700, d, withdraw.raw.id);
  const state = replay([create, join, lock, oldAppVote, withdraw, lateVote]);
  assert.equal(state.status, S.CREATED);
  assert.equal(state.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
  assert.deepEqual(state.votes, {});
  assert(rejectedLockRecovery(state, { oobNotes: NOTES, amountMsats: 100000 } as never, buyer));
  // Without a withdraw, a vote with no LOCK in the read stays strict, as today.
  const hole = replayEventChain(sortEventChain([create, join, oldAppVote]), { creator: seller });
  assert(!hole.ok);
});

await check('review S2: a release the reducer refuses does not outrank a withdraw; a chain that cannot load fails closed', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  // Release with no accept before it: refused by the reducer.
  const junk = step(d, buyer, T0 + 20, lock.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) });
  const withdraw = step(d, buyer, T0 + 600, lock.raw.id, { step: 'withdraw', lockEventId: lock.raw.id });
  const state = replay([create, join, lock, junk, withdraw]);
  assert.equal(state.status, S.CREATED);
  assert.equal(state.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
});

await check('review S1: the funder\'s saved notes are kept while a withheld LOCK waits for release', async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  const { setLocalStorageUserScope } = await import('../storage/user-scope.js');
  setLocalStorageUserScope('withheld-test-s1');
  const { stashNativeLockIntent, upgradeNativeLockToSpent, markNativeLockPublishAttempted, getPendingNativeLock, recoverPendingNativeLock } = await import('../fedimint/pending-native-locks.js');
  const { hashNotes } = await import('../fedimint/fedimint-client.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const waiting = replay([create, join, lock, accept]);
  const input = { escrowId: d, amountMsats: 100000, federationId: 'test-fed' };
  stashNativeLockIntent(input); upgradeNativeLockToSpent({ ...input, oobNotes: NOTES }); markNativeLockPublishAttempted(d);
  let redeemed = 0;
  const deps = { getConnectedRelayCount: () => 1, currentFederationId: () => 'test-fed', hashNotes,
    redeemNotes: async () => { redeemed++; }, redeemRejectedNotes: async () => { redeemed++; }, now: () => (T0 + 700) * 1000 };
  assert.equal(await recoverPendingNativeLock(getPendingNativeLock(d)!, { ...deps, loadEscrow: async () => waiting } as never), 'kept');
  assert.equal(redeemed, 0);
  assert.equal(getPendingNativeLock(d)?.oobNotes, NOTES);
  const released = replay([create, join, lock, accept, step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain) })]);
  assert.equal(await recoverPendingNativeLock(getPendingNativeLock(d)!, { ...deps, loadEscrow: async () => released } as never), 'cleared-committed');
  assert.equal(redeemed, 0);
});

await check('review S3: a vote never passes on a released share that differs from the commitment', async () => {
  const { EscrowClient } = await import('./escrow-client.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const swapped = [{ shareIndex: 1, encryptedFor: { [seller]: enc(buyer, seller, plain[2]) } }, releaseShares(plain)[1]];
  for (const [shares1, expectEnvelope] of [[releaseShares(plain), true], [swapped, false]] as const) {
    const state = replay([create, join, lock, accept, step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: shares1 })]);
    const client = Object.create(EscrowClient.prototype) as any;
    client.signer = { nip44Decrypt: async (ct: string, from: string) => dec(seller, from, ct), nip44Encrypt: async (text: string, to: string) => enc(seller, to, text) };
    const envelope = await client.buildVoteShareEnvelope(state, Role.SELLER, seller, Outcome.RELEASE);
    assert.equal(!!envelope, expectEnvelope);
  }
});

await check('review S4: the arbiter share goes exactly to the trade\'s share recipients, never a stranger', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const accept = step(d, seller, T0 + 20, lock.raw.id, { step: 'accept', lockEventId: lock.raw.id });
  const accepted = replay([create, join, lock, accept]);
  const stranger = getPublicKey(new Uint8Array(32).fill(45));
  keyOf[stranger] = new Uint8Array(32).fill(45);
  const result = applyEvent(accepted, step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock.raw.id, shares: releaseShares(plain, [arbiter, stranger]) }));
  assert(!result.ok && result.error.code === 'INVALID_SHARES');
});

await check('review S5: Circles never take the refused-lock steps', async () => {
  const { EscrowClient } = await import('./escrow-client.js');
  const plain = await shares();
  const { d, create, join } = market(T0);
  const locked = replay([create, join, lockEvent(d, join.raw.id, T0 + 10, plain, false)]);
  const circle = { ...locked, chamaPolicy: 'share-v2' } as EscrowState;
  const lockId = locked.eventChain.find(e => e.kind === K.LOCK)!.raw.id;
  const result = applyEvent(circle, step(d, seller, T0 + 20, lockId, { step: 'accept', lockEventId: lockId }));
  assert(!result.ok && result.error.code === 'LOCK_STEP_NOT_IN_FORCE');
  let sent = 0;
  const client = Object.create(EscrowClient.prototype) as any;
  Object.assign(client, { states: new Map([[d, circle]]), lockAcceptsInFlight: new Set(), getPubkey: async () => seller,
    relayManager: { publish: async () => { sent++; } } });
  await client.maybeAutoAccept(d);
  assert.equal(sent, 0);
});

await check('re-review RB1/RS1: the withdraw skip covers only votes about the withdrawn LOCK; a release with a missing accept counts', async () => {
  const plain = await shares();
  const { d, create, join } = market(T0);
  const lock1 = lockEvent(d, join.raw.id, T0 + 10, plain, true);
  const withdraw = step(d, buyer, T0 + 60, lock1.raw.id, { step: 'withdraw', lockEventId: lock1.raw.id });
  const lock2 = lockEvent(d, join.raw.id, T0 + 100, plain, false);
  const v1 = sign(K.VOTE, { type: 'escrow:vote', outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: T0 + 120 } as EscrowPayload, buyer, T0 + 120, d, lock2.raw.id);
  const full = replay([create, join, lock1, withdraw, lock2, v1]);
  assert.equal(full.status, S.LOCKED);
  const gap = replayEventChain(sortEventChain([create, join, lock1, withdraw, v1]), { creator: seller });
  assert(!gap.ok, 'a vote about a LOCK missing from the read stays strict, never an open listing');
  // A funder-signed release whose accept is missing from the read outranks the withdraw.
  const accept = step(d, seller, T0 + 20, lock1.raw.id, { step: 'accept', lockEventId: lock1.raw.id });
  const release = step(d, buyer, T0 + 30, accept.raw.id, { step: 'release', lockEventId: lock1.raw.id, shares: releaseShares(plain) });
  const partial = replay([create, join, lock1, release, withdraw]);
  assert.equal(partial.status, S.LOCKED);
  assert.equal(partial.rejectedLocks, undefined);
  const { isPartialReplayDowngrade } = await import('./escrow-client.js');
  const known = replay([create, join, lock1, accept, release]);
  assert.equal(isPartialReplayDowngrade(known, replay([create, join, lock1])), true, 'a read that lost the accept and release is a downgrade');
});

if (failures) { console.error(`${failures} withheld-shares check(s) failed`); process.exit(1); }
console.log('withheld-shares: all checks passed');
