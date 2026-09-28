import assert from 'node:assert/strict';
import { fetchWakeEvents, replayWake } from './wake-replay.js';
const snapshot = { pubkey: 'a'.repeat(64), events: [], relays: [] };
assert.deepEqual([...replayWake([], snapshot.pubkey, '')], [], 'empty cache has no actionable trade');
await assert.rejects(fetchWakeEvents(snapshot), /No relay replied/, 'offline is a failure, never a successful empty read');
class EmptyRelay {
  onopen?: () => void; onmessage?: (event: {data: string}) => void;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send() { this.onmessage?.({data: JSON.stringify(['EOSE', 'wake'])}); }
  close() {}
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: EmptyRelay });
assert.deepEqual(await fetchWakeEvents({...snapshot, relays: ['wss://test.invalid']}), [], 'EOSE with nothing new is successful and silent');
console.log('PASS wake replay empty read and network-down distinction');

// A native wake must cover both transitions and opted-in chat, with replay dedup.
const { selectWakeNotifications, wakeNotification } = await import('./wake-replay.js');
const { safetyFixture } = await import('../../scripts/lib/escrow-safety-fixture.js');
const btc = await import('@scure/btc-signer');
const { EscrowStatus, EscrowEventKind: Kind, Role, Outcome } = await import('../escrow-engine/types.js');
const fixture = safetyFixture({
  buyer: btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),
  seller: btc.utils.pubSchnorr(new Uint8Array(32).fill(12)),
  arbiter: btc.utils.pubSchnorr(new Uint8Array(32).fill(13)),
}, 2_000_000, 'sm_wake_test');
const created = { ...fixture.state, escrowMode: 'ecash' as const };
const locked = { ...created, status: EscrowStatus.LOCKED };
assert.equal(wakeNotification(locked, created, fixture.pks.buyer)?.tag, `${created.id}:locked`);
const approved = { ...locked, status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE };
assert.equal(wakeNotification(approved, locked, fixture.pks.buyer)?.tag, `${created.id}:approved`);
assert.equal(wakeNotification(approved, locked, fixture.pks.buyer, {}, new Set([created.id])), null, 'already-claimed funds stay quiet');
const completed = { ...approved, status: EscrowStatus.COMPLETED };
assert.equal(wakeNotification(completed, approved, fixture.pks.seller)?.tag, `${created.id}:completed`, 'completion does not require a remaining action');
assert.equal(wakeNotification(completed, approved, 'stranger'), null);

const chat = fixture.event(Kind.CHAT, 'seller', { type: 'escrow:chat', message: 'Private payment details', sentAt: Math.floor(Date.now() / 1000), senderRole: Role.SELLER });
const chatState = { ...completed, chatMessages: [chat as import('../escrow-engine/types.js').ParsedEscrowEvent<import('../escrow-engine/types.js').ChatPayload>] };
const chatSnapshot = { pubkey: fixture.pks.buyer, events: created.eventChain.map(e => e.raw), relays: [], dmNotifyPref: 'on' as const, cachedAt: chat.timestamp * 1000 };
const old = new Map([[created.id, completed]]);
const notes = selectWakeNotifications([chatState], old, chatSnapshot, chat.timestamp * 1000, []);
assert.deepEqual(notes.map(n => n.tag), [`${created.id}:chat:${chat.raw.id}`], 'fresh chat delivers even on a completed trade');
assert.ok(!notes[0].body.includes('Private payment details'), 'chat contents stay out of OS notifications');
assert.deepEqual(selectWakeNotifications([chatState], old, chatSnapshot, chat.timestamp * 1000, [notes[0].tag]), [], 'repeated wake stays quiet');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, dmNotifyPref: 'off' }, 0, []), [], 'chat mute is honored');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, dmNotifyPref: 'auto' }, 0, []), [], 'buyer auto preference stays quiet');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, pubkey: fixture.pks.seller }, 0, []), [], 'own messages stay quiet');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, events: [...chatSnapshot.events, chat.raw] }, 0, []), [], 'cached chat is not new');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, cachedAt: (chat.timestamp + 1) * 1000 }, 0, []), [], 'old chat is not new');
console.log('PASS native wake transitions, chat privacy, preferences and replay dedup');
