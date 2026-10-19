// Audit M2: a stranger's future-dated event must not flip a live trade to
// EXPIRED. Gated on the signed CREATE time (December rules); older chains keep
// their old law on every replay.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { parseEscrowEvent } from './event-parser.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { TRADE_RULES_DEC_2026_CREATE_AT as cutoff } from './protocol-hardening.js';
import { EscrowEventKind as K, Role, EscrowStatus as S, type EscrowPayload, type EscrowState } from './types.js';

const keys = [41, 42, 43, 44].map(n => new Uint8Array(32).fill(n));
const [seller, buyer, arbiter, stranger] = keys.map(getPublicKey);
let sequence = 0;
function event(kind: K, payload: EscrowPayload, key: Uint8Array, at: number, id: string, prev?: string) {
  const raw = finalizeEvent({ kind, created_at: at, tags: [['d', id], ...(prev ? [['e', prev, '', 'reply']] : [])], content: JSON.stringify(payload) }, key);
  const parsed = parseEscrowEvent(raw, raw.content); assert(parsed.ok, parsed.ok ? '' : parsed.error.message);
  return parsed.event;
}
function lockedTrade(at: number) {
  const id = `expiry-author-${++sequence}`;
  const c = event(K.CREATE, { type: 'escrow:create', category: 'p2p-trade', description: 'M2', amountMsats: 100000, mintUrl: 'fed1test', platformFeeBps: 0, platformFeePubkey: seller, expirySeconds: 3600, communityArbiters: [arbiter], createdAt: at }, keys[0], at, id);
  let r = applyEvent(null, c); assert(r.ok, r.ok ? '' : r.error.message);
  const l = event(K.LOCK, { type: 'escrow:lock', notesHash: 'test', shares: [0, 1, 2].map(shareIndex => ({ shareIndex, encryptedFor: Object.fromEntries([seller, buyer, arbiter].map(pk => [pk, 'encrypted'])) })), buyerPubkey: buyer, arbiterPubkey: arbiter, sellerReceivesMsats: 100000, arbiterFeeMsats: 0, lockedAt: at + 10 }, keys[0], at + 10, id, c.raw.id);
  r = applyEvent(r.state, l); assert(r.ok, r.ok ? '' : r.error.message);
  assert.equal(r.state.status, S.LOCKED);
  return { chain: [c, l], state: r.state as EscrowState };
}
const late = (state: EscrowState) => state.expiresAt + 60;
const roleOf = (key: Uint8Array) => key === keys[0] ? Role.SELLER : key === keys[2] ? Role.ARBITER : Role.BUYER;
const vote = (state: EscrowState, key: Uint8Array, at: number) =>
  event(K.VOTE, { type: 'escrow:vote', role: roleOf(key), outcome: 'release', votedAt: at } as EscrowPayload, key, at, state.id, state.eventChain.at(-1)!.raw.id);
const cancel = (state: EscrowState, key: Uint8Array, at: number) =>
  event(K.CANCEL, { type: 'escrow:cancel', cancellerRole: Role.SELLER, cancelledAt: at } as EscrowPayload, key, at, state.id, state.eventChain.at(-1)!.raw.id);

for (const at of [cutoff - 1, cutoff, cutoff + 1]) {
  const { chain, state } = lockedTrade(at);
  for (const make of [vote, cancel]) {
    const strangerEvent = make(state, keys[3], late(state));
    const result = applyEvent(state, strangerEvent);
    if (at < cutoff && make === vote) {
      // A stranger's late VOTE was already refused by the vote handler.
      assert(!result.ok); assert.equal(result.error.code, 'NOT_PARTICIPANT');
    } else if (at < cutoff) {
      // Old law: any other late event flips the trade, as before.
      assert(result.ok, result.ok ? '' : result.error.code + ' ' + result.error.message); assert.equal(result.state.status, S.EXPIRED, 'Legacy chains keep the old expiry law');
    } else {
      assert(!result.ok, 'A stranger cannot carry a December trade past its deadline');
      assert.equal(result.error.code, 'EXPIRY_NOT_IN_TRADE');
      // Replay skips the stranger and the trade stays LOCKED.
      const replay = replayEventChain([...chain, strangerEvent]);
      assert(replay.ok, replay.ok ? '' : replay.error.message);
      assert.equal(replay.state.status, S.LOCKED, 'Replay keeps the trade live');
      assert(replay.state.replayNotes?.some(n => n.code === 'EXPIRY_NOT_IN_TRADE'));
    }
  }
  // Someone in the trade still carries it past the deadline, under any law.
  for (const key of [keys[0], keys[1]]) {
    const result = applyEvent(state, vote(state, key, late(state)));
    assert(result.ok, result.ok ? '' : result.error.message);
    assert.equal(result.state.status, S.EXPIRED, 'A party in the trade still triggers expiry');
  }
  // Before the deadline a stranger's event is judged by the usual rules.
  assert(!applyEvent(state, vote(state, keys[3], state.expiresAt - 60)).ok);
}
console.log('PASS M2: only people in a trade can carry it past its deadline (December rules); legacy chains unchanged');
