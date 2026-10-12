// Fresh-device regression: resolve the sealed cycle from signed relay events,
// reject an outsider's successor CREATE, then choose valid members by time/id.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-client.js';
import { parseEscrowEvent } from './event-parser.js';
import { applyEvent } from './state-machine.js';
import { EscrowEventKind as K, Role as R, type CreatePayload, type EscrowState, type NostrEvent } from './types.js';
import { nextRotationRoundPayload, shareEscrowId } from '../chama/policy.js';
const secrets = Array.from({length: 7}, (_, i) => new Uint8Array(32).fill(i + 61));
const [host, a, b, c, outsider, arbiter, backup] = secrets;
const pk = (key: Uint8Array) => getPublicKey(key);
const T = Math.floor(Date.now() / 1000) - 604800 - 300;
const D = 604800, F = 86400, amount = 1000000, parentId = 'a1'.repeat(32);
const records: NostrEvent[] = [];
function sign(key: Uint8Array, kind: K, id: string, payload: object, at: number, prev?: string, parent?: string) {
  const event = finalizeEvent({kind, created_at: at, content: JSON.stringify(payload),
    tags: [['d', id], ...(prev ? [['e', prev, '', 'reply']] : []), ...(parent ? [['parent', parent]] : [])]}, key) as NostrEvent;
  return event;
}
function state(raw: NostrEvent, before: EscrowState | null = null, parent?: EscrowState) {
  const parsed = parseEscrowEvent(raw, raw.content, true, {parent});
  assert(parsed.ok, parsed.ok ? '' : parsed.error.message);
  const result = applyEvent(before, parsed.event);
  assert(result.ok, result.ok ? '' : result.error.message);
  return result.state;
}
const base = {type: 'escrow:create' as const, amountMsats: amount, mintUrl: 'fed1test', platformFeeBps: 0,
  platformFeePubkey: pk(host), communityArbiters: [pk(arbiter), pk(backup)], description: 'Sealed cycle'};
const parentRaw = sign(host, K.CREATE, parentId, {...base, category: 'chama', expirySeconds: D, createdAt: T,
  chamaCircle: {shareMsats: amount, seatThreshold: 3, seatCap: 3, fillDeadlineSec: T + F,
    roundEndSec: T + D, roundIndex: 1, prevCircleId: null, pot: 'rotation-v2'}}, T);
const parent = state(parentRaw); records.push(parentRaw);
const shares = [a, b, c].map((member, i) => {
  const id = shareEscrowId(parentId, pk(member), 1);
  const create = sign(member, K.CREATE, id, {...base, category: 'chama-share', chamaPolicy: 'share-v1',
    parent: parentId, sellerPubkey: pk(host), expirySeconds: D - 10, createdAt: T + 10}, T + 10, undefined, parentId);
  const before = state(create, null, parent);
  const lock = sign(member, K.LOCK, id, {type: 'escrow:lock', notesHash: `test-notes-${i}`,
    sharePolicy: 'holder-only-v1', arbiterPoolShare: true, buyerPubkey: pk(member), arbiterPubkey: before.participants[R.ARBITER],
    sellerReceivesMsats: amount, arbiterFeeMsats: 0, lockedAt: T + 100 + i,
    shares: [{shareIndex: 0, encryptedFor: {[pk(member)]: 'test-share'}},
      {shareIndex: 1, encryptedFor: {[pk(host)]: 'test-share'}},
      {shareIndex: 2, encryptedFor: {[pk(arbiter)]: 'test-share', [pk(backup)]: 'test-share'}}]}, T + 100 + i, create.id);
  records.push(create, lock);
  return state(lock, before);
});
const openedAt = T + D + 5;
const built = nextRotationRoundPayload({circles: [parent], shares}, openedAt);
assert(typeof built !== 'string', String(built));
const roundId = built.escrowId;
const validA = sign(a, K.CREATE, roundId, built.payload, openedAt);
const validB = sign(b, K.CREATE, roundId, built.payload, openedAt);
const late = sign(c, K.CREATE, roundId, {...built.payload, createdAt: openedAt + 1, expirySeconds: built.payload.expirySeconds - 1}, openedAt + 1);
const hostile = sign(outsider, K.CREATE, roundId, {...built.payload, createdAt: openedAt - 1, expirySeconds: built.payload.expirySeconds + 1}, openedAt - 1);
const wrongPool = sign(a, K.CREATE, roundId, {...built.payload, createdAt: openedAt - 1, expirySeconds: built.payload.expirySeconds + 1, communityArbiters: [pk(outsider)]}, openedAt - 1);
const expected = [validA, validB].sort((x, y) => x.id.localeCompare(y.id))[0];
// Neither a forged parent tag nor a share-v2 under round 1 may recurse
// through the commitment-cycle read and deadlock honest readers.
records.push(sign(outsider, K.CREATE, roundId, built.payload, openedAt, undefined, parentId));
records.push(sign(outsider, K.CREATE, 'b2'.repeat(32), {...base, category: 'chama-share', chamaPolicy: 'share-v2',
  parent: parentId, sellerPubkey: pk(host), expirySeconds: D - 10, createdAt: T + 10}, T + 10, undefined, parentId));

let relay: NostrEvent[] = [];
let queries: Record<string, unknown>[] = [];
class Socket {
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  constructor(_url: string) { queueMicrotask(() => this.onopen?.({} as Event)); }
  send(text: string) {
    const [type, id, filter] = JSON.parse(text); if (type !== 'REQ' || !String(id).startsWith('sm_fetch_')) return;
    queries.push(filter);
    queueMicrotask(() => {
      for (const raw of relay) {
        if (filter.kinds && !filter.kinds.includes(raw.kind)) continue;
        if (filter.authors && !filter.authors.includes(raw.pubkey)) continue;
        if (Object.entries(filter).some(([key, values]) => key.startsWith('#')
          && !raw.tags.some(t => t[0] === key.slice(1) && (values as string[]).includes(t[1])))) continue;
        this.onmessage?.({data: JSON.stringify(['EVENT', id, raw])} as MessageEvent);
      }
      this.onmessage?.({data: JSON.stringify(['EOSE', id])} as MessageEvent);
    });
  }
  close() {}
}
async function coldLoad(rounds: NostrEvent[], includeCycle = true) {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k)}});
  relay = [...(includeCycle ? records : []), ...rounds]; queries = [];
  const client = new EscrowClient({getPublicKey: async () => pk(b), signEvent: async event => finalizeEvent(event, b),
    nip44Encrypt: async text => text, nip44Decrypt: async text => text},
    {relays: ['wss://one.invalid', 'wss://two.invalid'], wsImpl: Socket as unknown as typeof WebSocket});
  try {
    client.connect(); await new Promise(r => setTimeout(r, 5));
    return await client.loadEscrow(roundId, {fullHistory: true});
  } finally { client.disconnect(); }
}
for (const order of [[hostile, late, validB, wrongPool, validA], [validA, wrongPool, validB, late, hostile]]) {
  const loaded = await coldLoad(order);
  assert(loaded, 'fresh device resolves the cycle and loads a sealed member’s round');
  assert.equal(loaded.eventChain[0].raw.id, expected.id, 'signed time then event id decide, independent of delivery order');
  assert(!loaded.eventChain.some(e => e.raw.id === hostile.id || e.raw.id === wrongPool.id));
  assert(queries.some(q => (q['#d'] as string[] | undefined)?.includes(parentId)), 'parent loaded from relay');
  assert(queries.some(q => (q['#parent'] as string[] | undefined)?.includes(parentId)), 'sealed shares discovered from relay');
}
assert.equal(await coldLoad([hostile]), null, 'outsider-only successor is refused on a fresh device');
assert.equal(await coldLoad([validA], false), null, 'a member name without the sealed cycle is insufficient');
console.log('PASS rotation cold load: sealed members, pinned terms, deterministic root and missing-context refusal');
