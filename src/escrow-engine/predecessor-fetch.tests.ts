import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { deriveEscrowSigningKey } from '../bond-multisig/onchain-escrow-funding.js';
import { deriveBondSigningKey } from '../bond-multisig/commitment-bond.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { parseEscrowEvent } from './event-parser.js';
import { EscrowClient, missingPredecessorIds } from './escrow-client.js';
import { clearEventCache } from './escrow-event-cache.js';
import type { NostrFilter } from './relay-manager.js';
import { EscrowEventKind as Kind, EscrowStatus, Role, type NostrEvent } from './types.js';

// Oct 28 mainnet: public relays kept only the newest of the funder's three
// LOCKs, so a read held a LOCK whose predecessor no #d query returned, and the
// trade failed MISSING_PREDECESSOR. An explicit open now asks the relays for
// the missing id before failing; replay itself is unchanged and strict.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
} });

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b = deriveEscrowSigningKey(WORDS, 'buyer', { network: SIGNET });
const s = deriveEscrowSigningKey(WORDS, 'seller', { network: SIGNET });
const a = deriveBondSigningKey(WORDS, { network: SIGNET, index: 7 });
const ID = 'pred-fetch';
const fixture = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000, ID);
fixture.apply(fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER,
  joinedAt: Date.now() / 1000, fundingTerms: fixture.terms }));
const now = Math.floor(Date.now() / 1000);
const lockTerms = { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 1 };
const lockPayload = (lockedAt: number) => ({ type: 'escrow:lock' as const, notesHash: '', shares: [],
  onchain: lockTerms, buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter,
  sellerReceivesMsats: 100000000, arbiterFeeMsats: 0, lockedAt });
const sibling = fixture.event(Kind.LOCK, 'seller', lockPayload(now));
const raw = finalizeEvent({ kind: Kind.LOCK, created_at: sibling.timestamp + 8, content: JSON.stringify(lockPayload(now + 8)),
  tags: [['d', ID], ['t', 'escrow:lock'], ['e', sibling.raw.id, '', 'reply']] }, new Uint8Array(32).fill(32));
const parsedOnSibling = parseEscrowEvent(raw, raw.content);
assert.ok(parsedOnSibling.ok);
const onSibling = raw as NostrEvent;
const base = fixture.events.map(e => e.raw as NostrEvent);

assert.deepEqual(missingPredecessorIds([...base, onSibling]), [sibling.raw.id], 'the missing link is named');
assert.deepEqual(missingPredecessorIds([...base, sibling.raw as NostrEvent, onSibling]), [], 'a whole chain names none');

async function clientWith(answer: { byD: NostrEvent[]; byId: (ids: string[]) => NostrEvent[] }) {
  storage.clear(); // each case starts on a fresh device
  await clearEventCache();
  const secret = new Uint8Array(32).fill(31); // the buyer
  const client = new EscrowClient({ getPublicKey: async () => getPublicKey(secret),
    signEvent: async event => finalizeEvent(event, secret), nip44Encrypt: async v => v, nip44Decrypt: async v => v,
  }, { relays: ['wss://one.invalid'] });
  const asked: NostrFilter[] = [];
  const relay = (client as any).relayManager;
  relay.fetchEscrowEvents = async () => answer.byD;
  relay.fetchOnce = async (filter: NostrFilter) => { asked.push(filter); return filter.ids ? answer.byId(filter.ids) : []; };
  relay.republishToPreferredRelay = async () => {};
  return { client, asked };
}

{
  // The relay holds the predecessor but the #d answer lacked it: fetched by id, the trade loads.
  const { client, asked } = await clientWith({ byD: [...base, onSibling],
    byId: ids => ids.includes(sibling.raw.id) ? [sibling.raw as NostrEvent] : [] });
  const state = await client.loadEscrow(ID, { repairFromCache: true });
  assert.ok(state, 'the trade loads once the predecessor is fetched');
  assert.equal(state!.status, EscrowStatus.LOCKED);
  assert.deepEqual(asked.map(f => f.ids), [[sibling.raw.id]], 'one fetch, by exactly the missing id');
  client.disconnect();
}
{
  // Background loads (boot, discovery) never fan out: only explicit opens fetch.
  const { client, asked } = await clientWith({ byD: [...base, onSibling], byId: () => [sibling.raw as NostrEvent] });
  assert.equal(await client.loadEscrow(ID), null, 'still fails closed without the predecessor');
  assert.equal(asked.filter(f => f.ids).length, 0);
  client.disconnect();
}
{
  // Nobody has it: still fails closed, after a bounded ask.
  const { client, asked } = await clientWith({ byD: [...base, onSibling], byId: () => [] });
  assert.equal(await client.loadEscrow(ID, { repairFromCache: true }), null);
  assert.equal(asked.filter(f => f.ids).length, 1, 'asked once, then stopped');
  client.disconnect();
}
{
  // A relay answering with an event that isn't the one asked for, or isn't
  // this trade's, is ignored: it can't stand in for the missing link.
  const foreign = finalizeEvent({ kind: Kind.LOCK, created_at: now, content: sibling.raw.content,
    tags: [['d', 'another-trade'], ['t', 'escrow:lock']] }, new Uint8Array(32).fill(32)) as NostrEvent;
  const { client } = await clientWith({ byD: [...base, onSibling], byId: () => [foreign, { ...foreign, id: sibling.raw.id }] });
  assert.equal(await client.loadEscrow(ID, { repairFromCache: true }), null, 'a wrong-trade event is not the predecessor');
  client.disconnect();
}
console.log('predecessor-fetch: explicit opens fetch a missing predecessor by id; replay stays strict');
