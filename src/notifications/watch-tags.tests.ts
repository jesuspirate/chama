import assert from 'node:assert/strict';
import { openTradeWatchTags } from './watch-tags.js';
import { deriveWatchTag } from './web-push-client.js';
import { EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
import type { Signer } from '../escrow-engine/escrow-client.js';
const key = new Uint8Array(32).fill(7);
const signer = { getPublicKey: async () => 'buyer', conversationKey: async () => key } as unknown as Signer;
const trade = { id: 'sm_existing', status: EscrowStatus.LOCKED, provenance: 'replayed',
  participants: { [Role.BUYER]: 'buyer', [Role.SELLER]: 'seller', [Role.ARBITER]: null },
  communityArbiters: ['bystander'],
} as unknown as EscrowState;
const expected = [await deriveWatchTag(key, trade.id, 0)];
assert.deepEqual(await openTradeWatchTags(signer, [trade]), expected, 'existing trade needs no own publish');
assert.deepEqual(await openTradeWatchTags(signer, [trade, trade]), expected, 'deduplicated');
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, status: EscrowStatus.COMPLETED }]), []);
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, provenance: 'summary' }]), []);
assert.deepEqual(await openTradeWatchTags({ ...signer, getPublicKey: async () => 'bystander' }, [trade]), [], 'pool membership is not participation');
assert.deepEqual(await openTradeWatchTags({ ...signer, conversationKey: undefined }, [trade]), [], 'no local ECDH');
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, status: EscrowStatus.EXPIRED }]), expected, 'expired escrow can still resolve');
console.log('PASS watch existing open participant trades without publishing');

// Real ECDH pairs: an alerts-off sender wakes an opted-in peer whose watch was
// seeded from the first committed JOIN, before that peer publishes anything.
const { makeChainEventTagger, seedOpenTradeWatches } = await import('./watch-tags.js');
const { NsecSigner } = await import('../escrow-engine/nsec-signer.js');
const { EscrowEventKind, TAGS } = await import('../escrow-engine/types.js');
const seller = new NsecSigner('11'.repeat(32));
const buyer = new NsecSigner('22'.repeat(32));
const arbiter = new NsecSigner('33'.repeat(32));
const [sp, bp, ap] = await Promise.all([seller.getPublicKey(), buyer.getPublicKey(), arbiter.getPublicKey()]);
const joined = { ...trade, status: EscrowStatus.CREATED, participants: { [Role.SELLER]: sp, [Role.BUYER]: bp, [Role.ARBITER]: ap } };
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let enabled = true;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => enabled ? '1' : null } });
try {
  const registered: string[] = [];
  const register = async (tags: readonly string[]) => { registered.push(...tags); return true; };
  await seedOpenTradeWatches(buyer, [joined], register);
  assert.equal(registered.length, 2, 'first peer event seeds both participant watches');
  enabled = false;
  const ownRegistrations: string[] = [];
  const tagger = makeChainEventTagger(seller, async tags => { ownRegistrations.push(...tags); return true; });
  const wakeTags = await tagger({ kind: EscrowEventKind.LOCK, created_at: 1, content: '', tags: [
    [TAGS.ESCROW_ID, joined.id], ...[sp, bp, ap, bp].map(pk => [TAGS.PARTICIPANT, pk]),
  ] });
  assert.equal(wakeTags.length, 2, 'alerts-off LOCK carries one tag per OTHER participant');
  assert.ok(wakeTags.some(t => registered.includes(t[1])), 'peer registration matches sender tag');
  assert.deepEqual(ownRegistrations, [], 'alerts-off sender never registers');
  registered.length = 0;
  await seedOpenTradeWatches(buyer, [joined], register);
  assert.deepEqual(registered, [], 'alerts-off state seeding never registers');
  assert.deepEqual(await makeChainEventTagger({ ...signer, conversationKey: undefined })({kind: EscrowEventKind.LOCK, created_at: 1, content: '', tags: [['d', joined.id], ['p', 'seller']]}), []);
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
console.log('PASS alerts-off sender tags match peer watches seeded from JOIN');
