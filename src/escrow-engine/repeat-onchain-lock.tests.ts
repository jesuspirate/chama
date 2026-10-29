import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveEscrowSigningKey } from '../bond-multisig/onchain-escrow-funding.js';
import { deriveBondSigningKey } from '../bond-multisig/commitment-bond.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { onchainLockAlreadySent } from './onchain-lock-recovery.js';
import { sortEventChain } from './event-parser.js';
import { EscrowEventKind as Kind, EscrowStatus, Outcome, Role } from './types.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { parseEscrowEvent } from './event-parser.js';

// Oct 28 mainnet: the funder's repeated taps signed three LOCKs for one
// deposit within 87 s: two siblings on the terms JOIN, then a LOCK on a LOCK.
// Replay refused the second ("Cannot LOCK in state LOCKED"), so the trade
// could not load anywhere, even with every event present.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b = deriveEscrowSigningKey(WORDS, 'buyer', { network: SIGNET });
const s = deriveEscrowSigningKey(WORDS, 'seller', { network: SIGNET });
const a = deriveBondSigningKey(WORDS, { network: SIGNET, index: 7 });
const fixture = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000, 'repeat-lock');
fixture.apply(fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER,
  joinedAt: Date.now() / 1000, fundingTerms: fixture.terms }));
const termsJoin = fixture.state.eventChain.at(-1)!;
const lockTerms = { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 1 };
const lockPayload = (lockedAt: number, onchain = lockTerms) => ({ type: 'escrow:lock' as const, notesHash: '', shares: [],
  onchain, buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter,
  sellerReceivesMsats: 100000000, arbiterFeeMsats: 0, lockedAt });
const now = Math.floor(Date.now() / 1000);
const beforeLock = fixture.state;
// Two siblings on the terms JOIN, signed before either was applied.
const first = fixture.event(Kind.LOCK, 'seller', lockPayload(now));
const sibling = fixture.event(Kind.LOCK, 'seller', lockPayload(now + 79));
assert.equal(first.prevEventId, termsJoin.raw.id);
assert.equal(sibling.prevEventId, termsJoin.raw.id);
fixture.apply(first);
// Then a LOCK chained on the sibling (as the third mainnet LOCK was), signed
// with a real e-tag to the sibling. The fixture's seller identity is fill(32).
const signedOn = (prev: string, payload: ReturnType<typeof lockPayload>, createdAt: number) => {
  const raw = finalizeEvent({ kind: Kind.LOCK, created_at: createdAt, content: JSON.stringify(payload),
    tags: [['d', 'repeat-lock'], ['t', 'escrow:lock'], ['e', prev, '', 'reply']] }, new Uint8Array(32).fill(32));
  const parsed = parseEscrowEvent(raw, raw.content);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.event;
};
const chainedOnSibling = signedOn(sibling.raw.id, lockPayload(now + 87), sibling.timestamp + 8);
assert.equal(chainedOnSibling.prevEventId, sibling.raw.id);
assert.equal(fixture.state.status, EscrowStatus.LOCKED);

const base = fixture.events.slice(0, -1);
const all = [...base, first, sibling, chainedOnSibling];
const replay = replayEventChain(all);
assert.ok(replay.ok, `repeat LOCKs with identical terms must load: ${!replay.ok && replay.error.code}`);
assert.equal(replay.state.status, EscrowStatus.LOCKED);
assert.equal(replay.state.eventChain.filter(e => e.kind === Kind.LOCK).length, 1, 'only the first LOCK enters the chain');
assert.equal(replay.state.eventChain.find(e => e.kind === Kind.LOCK)!.raw.id, first.raw.id);
assert.equal(replay.state.lock.lockedAt, now, 'deadlines run from the first LOCK');
assert.equal(replay.state.replayNotes?.filter(n => n.benign).length, 2, 'both repeats are noted as benign');
// Order on the wire must not matter once sorted, as the app sorts.
const reversed = replayEventChain(sortEventChain([chainedOnSibling, sibling, first, ...base.slice().reverse()]));
assert.ok(reversed.ok);
assert.equal(reversed.state.eventChain.find(e => e.kind === Kind.LOCK)!.raw.id, first.raw.id);

// Later events may point at a skipped LOCK (each client chains on its own tip).
const voteOn = (role: Role.BUYER | Role.SELLER, prev: string, createdAt: number) => {
  const raw = finalizeEvent({ kind: Kind.VOTE, created_at: createdAt,
    content: JSON.stringify({ type: 'escrow:vote', role, outcome: Outcome.RELEASE, votedAt: createdAt }),
    tags: [['d', 'repeat-lock'], ['t', 'escrow:vote'], ['e', prev, '', 'reply']] },
    new Uint8Array(32).fill(role === Role.BUYER ? 31 : 32));
  const parsed = parseEscrowEvent(raw, raw.content);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.event;
};
const buyerVote = voteOn(Role.BUYER, chainedOnSibling.raw.id, chainedOnSibling.timestamp + 5);
const withVote = replayEventChain(sortEventChain([...all, buyerVote]));
assert.ok(withVote.ok, `a vote chained on a skipped LOCK still loads: ${!withVote.ok && withVote.error.code}`);
assert.equal(withVote.state.votes[Role.BUYER], Outcome.RELEASE);
// A read holding the sibling and the LOCK on it, but not the first LOCK.
const lateRead = replayEventChain(sortEventChain([...base, sibling, chainedOnSibling]));
assert.ok(lateRead.ok, 'a read without the first LOCK loads from the sibling');
assert.equal(lateRead.state.lock.onchain?.fundingTxid, lockTerms.fundingTxid, 'same deposit either way');

// Different terms from the same funder stay strict: a second deposit is not a repeat.
const otherDeposit = fixture.event(Kind.LOCK, 'seller', lockPayload(now + 90, { ...lockTerms, fundingTxid: '22'.repeat(32) }));
const conflict = replayEventChain([...base, first, { ...otherDeposit, prevEventId: termsJoin.raw.id } as typeof otherDeposit]);
assert.equal(conflict.ok, false, 'a LOCK with different terms still fails the replay');
const otherAmount = fixture.event(Kind.LOCK, 'seller', { ...lockPayload(now + 91), sellerReceivesMsats: 1 });
assert.equal(replayEventChain([...base, first, { ...otherAmount, prevEventId: termsJoin.raw.id } as typeof otherAmount]).ok, false);
// The repeat is forgiven only from the author of the accepted LOCK.
const buyerCopy = { ...sibling, pubkey: fixture.pks.buyer } as typeof sibling;
assert.equal(applyEvent(replay.state, buyerCopy).ok, false);
assert.equal(replayEventChain([...base, first, buyerCopy]).ok, false, 'another author is not forgiven in replay');

// A read missing the parent of the only LOCK it holds still fails closed.
const partial = replayEventChain([...base, chainedOnSibling]);
assert.equal(partial.ok, false);
assert.equal(!partial.ok && partial.error.code, 'MISSING_PREDECESSOR');

// Writer: once this device holds a LOCK it never signs another.
assert.equal(onchainLockAlreadySent(beforeLock), false);
assert.equal(onchainLockAlreadySent(replay.state), true);
assert.equal(onchainLockAlreadySent({ ...beforeLock, lock: { ...beforeLock.lock, lockedAt: now } }), true);
const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
const publish = hook.slice(hook.indexOf('const onchainLockInFlight'), hook.indexOf('// Seed on launch'));
assert.match(publish, /onchainLockInFlight\.current\.get\(escrowId\)/, 'concurrent callers share one attempt');
assert.equal(publish.match(/onchainLockAlreadySent\(/g)?.length, 2, 'checked before and after the explorer wait');
assert.ok(publish.indexOf('onchainLockAlreadySent(latest)') < publish.indexOf('client.lockEscrow('));
console.log('repeat-onchain-lock: replay and send-once checks passed');
