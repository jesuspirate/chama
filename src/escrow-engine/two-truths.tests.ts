import assert from 'node:assert/strict';
import evidence from '../../docs/evidence/v6.4.14-brief-03-public-replay.json';
import { parseEscrowEvent, sortEventChain } from './event-parser.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { EscrowEventKind as K, EscrowStatus, Role, type EscrowState } from './types.js';
// Public CREATE/JOIN bodies are exact. Encrypted LOCK/CHAT bodies are modeled;
// ciphertext/signatures were not exported, so this does not authenticate them.
const firstJoin = evidence.events.find(e => e.kind === K.JOIN)!;
const seller = evidence.events[0].pubkey;
const buyer = firstJoin.pubkey;
const arbiter = evidence.events[0].payload!.communityArbiters![1];
export const chain = evidence.events.map(e => {
  const payload = e.payload ?? (e.kind === K.LOCK ? {
    type: 'escrow:lock', notesHash: 'modeled-notes-hash', buyerPubkey: buyer, arbiterPubkey: arbiter,
    sellerReceivesMsats: 170000, arbiterFeeMsats: 0, lockedAt: e.created_at,
    selectedItems: firstJoin.payload!.selectedItems,
    sharePolicy: 'holder-only-v1', shares: [buyer, seller, arbiter].map((pk, shareIndex) => ({shareIndex, encryptedFor: {[pk]: 'modeled-ciphertext'}})),
  } : {type: 'escrow:chat', message: 'Modeled encrypted chat', senderRole: e.pubkey === buyer ? Role.BUYER : Role.SELLER, sentAt: e.created_at});
  const parsed = parseEscrowEvent({...e, content: '', sig: ''}, JSON.stringify(payload), true);
  assert(parsed.ok, parsed.ok ? '' : parsed.error.message);
  return parsed.event;
});
assert.equal(chain.length, 7);
const lock = chain.find(e => e.kind === K.LOCK)!;
const chronological = [...chain].sort((a,b) => a.timestamp-b.timestamp);
let state: EscrowState | null = null;
for (const e of chronological.filter(e => e.timestamp < lock.timestamp)) {
  const r = applyEvent(state, e); if (r.ok) state = r.state;
}
const refused = applyEvent(state, lock);
assert(!refused.ok && refused.error.code === 'ORDER_NOT_FINALIZED');
const replay = replayEventChain(sortEventChain(chain));
assert(replay.ok, replay.ok ? '' : replay.error.code);
// Baseline report test proves the defect before the fix. The fix replaces this
// with CREATED + the second hold + a quarantined rejected LOCK assertion.
assert.equal(replay.state.status, EscrowStatus.LOCKED);
assert.equal(replay.state.amountMsats, 170000);
console.log('Confirmed: live signed-time apply refuses LOCK; global JOIN-first replay accepts it.');
