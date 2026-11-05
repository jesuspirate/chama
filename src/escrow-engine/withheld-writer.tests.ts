// #43 writer (6.4.34): the funder's app writes the withheld-shares LOCK,
// releases on the other side's accept, and can take the sats back before it.
// Real signatures, real NIP-44, real Shamir split, real EscrowClient against an
// in-memory relay. The clock is pinned past the gate so the rules are in force.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { split, combine } from 'shamir-secret-sharing';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { EscrowClient, type Signer } from './escrow-client.js';
import { EscrowFedimintBridge } from '../fedimint/escrow-bridge.js';
import { shouldClearNativeLockAfterPublish, stashNativeLockIntent, upgradeNativeLockToSpent, markNativeLockPublishAttempted, getPendingNativeLock, recoverPendingNativeLock, type PendingNativeLock } from '../fedimint/pending-native-locks.js';
import { WITHHELD_SHARES_CREATE_AT as gate } from './protocol-hardening.js';
import { createWithheldShareStore, defaultWithheldShareStore, memoryWithheldShareStore, type WithheldShareStore } from './withheld-share-store.js';
import { chamaClientVersion, versionAtLeast, signsWithWithheldShareReader, WITHHELD_SHARES_READER_VERSION } from './client-tag.js';
import { EscrowEventKind as K, EscrowStatus as S, Role, type LockPayload, type LockShareEntry, type NostrEvent } from './types.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });
setLocalStorageUserScope('withheld-writer-test');

const NOW = gate + 7 * 86400;
const realNow = Date.now;
Date.now = () => NOW * 1000;

let failures = 0;
async function check(name: string, body: () => void | Promise<void>) {
  try { await body(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : error}`); }
}

const keys = [61, 62, 63].map(n => new Uint8Array(32).fill(n));
const [sellerKey, buyerKey, arbiterKey] = keys;
const [seller, buyer, arbiter] = keys.map(getPublicKey);
const keyOf: Record<string, Uint8Array> = { [seller]: sellerKey, [buyer]: buyerKey, [arbiter]: arbiterKey };
const dec = (me: string, from: string, ct: string) => nip44.decrypt(ct, nip44.getConversationKey(keyOf[me], from));

function signerFor(key: Uint8Array): Signer {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: async event => finalizeEvent(event, key),
    nip44Encrypt: async (text, to) => nip44.encrypt(text, nip44.getConversationKey(key, to)),
    nip44Decrypt: async (text, from) => nip44.decrypt(text, nip44.getConversationKey(key, from)),
  } as Signer;
}

/** One in-memory relay shared by every client in a test. */
function relay() {
  const events: NostrEvent[] = [];
  class Socket {
    onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
    constructor(_url: string) { queueMicrotask(() => this.onopen?.({} as Event)); }
    send(text: string) {
      const message = JSON.parse(text);
      if (message[0] === 'EVENT') {
        const event = message[1] as NostrEvent;
        if (!events.some(e => e.id === event.id)) events.push(event);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['OK', event.id, true, '']) } as MessageEvent));
        return;
      }
      if (message[0] !== 'REQ') return;
      const [, subId, ...filters] = message as [string, string, ...Record<string, unknown>[]];
      queueMicrotask(() => {
        for (const event of events) {
          const d = event.tags.find(t => t[0] === 'd')?.[1];
          const hit = filters.some(f => (!f.kinds || (f.kinds as number[]).includes(event.kind))
            && (!f['#d'] || (f['#d'] as string[]).includes(d ?? ''))
            && (!f.ids || (f.ids as string[]).includes(event.id))
            && (!f.authors || (f.authors as string[]).includes(event.pubkey)));
          if (hit) this.onmessage?.({ data: JSON.stringify(['EVENT', subId, event]) } as MessageEvent);
        }
        this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) } as MessageEvent);
      });
    }
    close() {}
  }
  return { events, Socket };
}

const NOTES = 'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vZXhhbXBsZSJ9XX0-writer-43';
const notesHash = bytesToHex(sha256(new TextEncoder().encode(NOTES)));
async function bundle() {
  const parts = await split(new TextEncoder().encode(NOTES), 3, 2);
  return { notesHash, shares: parts.map((bytes, index) => ({ index, data: Buffer.from(bytes).toString('base64') })),
    totalMsats: 100000, sellerReceivesMsats: 100000, arbiterFeeMsats: 0 };
}
async function rebuild(plaintexts: string[]): Promise<string | null> {
  if (new Set(plaintexts).size < 2) return null;
  try {
    const notes = new TextDecoder().decode(await combine(plaintexts.map(t => new Uint8Array(Buffer.from(JSON.parse(t).data, 'base64')))));
    return bytesToHex(sha256(new TextEncoder().encode(notes))) === notesHash ? notes : null;
  } catch { return null; }
}
/** Every share plaintext `people` can decrypt from what the relay holds. */
function decryptable(events: NostrEvent[], people: string[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.kind !== K.LOCK && event.kind !== K.LOCK_STEP) continue;
    const entries = (JSON.parse(event.content).shares ?? []) as LockShareEntry[];
    for (const entry of entries) for (const person of people) {
      const ct = entry.encryptedFor?.[person];
      if (ct) out.push(dec(person, event.pubkey, ct));
    }
  }
  return out;
}

let sequence = 0;
/** A gated Market trade: seller CREATE signed by an app at `sellerVersion`, buyer JOIN. */
function seed(events: NostrEvent[], sellerVersion: string | null, createdAt = NOW - 60, expirySeconds = 86400) {
  const d = `writer-${++sequence}`;
  const create = finalizeEvent({ kind: K.CREATE, created_at: createdAt, content: JSON.stringify({ type: 'escrow:create', category: 'marketplace',
    description: 'Writer #43', amountMsats: 100000, mintUrl: 'fed1test', platformFeeBps: 0, platformFeePubkey: seller, arbiterFeeMsats: 0,
    expirySeconds, communityArbiters: [arbiter], createdAt }),
    tags: [['d', d], ...(sellerVersion ? [['client', 'chama', sellerVersion]] : [])] }, sellerKey);
  const join = finalizeEvent({ kind: K.JOIN, created_at: createdAt + 1, content: JSON.stringify({ type: 'escrow:join', role: Role.BUYER, joinedAt: createdAt + 1 }),
    tags: [['d', d], ['e', create.id, '', 'reply']] }, buyerKey);
  events.push(create, join);
  return d;
}

async function clientFor(Socket: unknown, key: Uint8Array, store: WithheldShareStore = memoryWithheldShareStore(), signer: Signer = signerFor(key)) {
  const client = new EscrowClient(signer, { relays: ['wss://one.invalid', 'wss://two.invalid'],
    wsImpl: Socket as typeof WebSocket, withheldShareStore: store });
  client.connect();
  await new Promise(r => setTimeout(r, 5));
  return client;
}

/** The buyer's lock through the bridge's own share-building path. */
async function bridgeLock(client: EscrowClient, d: string) {
  const bridge = Object.create(EscrowFedimintBridge.prototype) as EscrowFedimintBridge;
  Object.assign(bridge, { escrow: client, signer: signerFor(buyerKey) });
  const state = client.getState(d)!;
  return (bridge as unknown as { publishLockBundle: (...args: unknown[]) => Promise<unknown> })
    .publishLockBundle(d, state, await bundle(), { buyerPubkey: buyer, sellerPk: seller, arbiterPubkey: arbiter }, {});
}
const lockOf = (events: NostrEvent[], d: string) => events.find(e => e.kind === K.LOCK && e.tags.some(t => t[0] === 'd' && t[1] === d))!;
const stepsOf = (events: NostrEvent[], d: string, step: string) => events.filter(e => e.kind === K.LOCK_STEP
  && e.tags.some(t => t[0] === 'd' && t[1] === d) && JSON.parse(e.content).step === step);
async function until(cond: () => boolean, label: string) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
  assert(cond(), `timed out waiting for ${label}`);
}

console.log('#43 withheld-shares writer');

await check('client tag: versions parse and compare; dev builds and other clients never count', () => {
  assert.deepEqual(chamaClientVersion([['client', 'chama', '6.4.34']]), [6, 4, 34]);
  assert.deepEqual(chamaClientVersion([['client', 'chama', '6.4.34-rc.2']]), [6, 4, 34]);
  assert.equal(chamaClientVersion([['client', 'chama', 'dev']]), null);
  assert.equal(chamaClientVersion([['client', 'other', '9.9.9']]), null);
  assert(versionAtLeast([6, 4, 34], WITHHELD_SHARES_READER_VERSION));
  assert(versionAtLeast([6, 5, 0], WITHHELD_SHARES_READER_VERSION));
  assert(!versionAtLeast([6, 4, 33], WITHHELD_SHARES_READER_VERSION));
  const chain = [{ pubkey: seller, timestamp: 1, raw: { tags: [['client', 'chama', '6.4.34']] } },
    { pubkey: seller, timestamp: 2, raw: { tags: [['client', 'chama', '6.4.33']] } }];
  assert(!signsWithWithheldShareReader(chain, seller), 'the most recent event decides');
  assert(!signsWithWithheldShareReader(chain, buyer), 'no event, no withheld shape');
});

await check('store: read-back, one step per LOCK, never a second split, no storage means no withheld LOCK', () => {
  const store = memoryWithheldShareStore();
  const record = { escrowId: 'x', notesHash: 'h', shares: [{ shareIndex: 1, plaintext: 'a' }, { shareIndex: 2, plaintext: 'b' }], savedAt: 1 };
  assert(store.save(record));
  assert(store.save(record), 'saving the same split again is fine');
  assert(!store.save({ ...record, shares: [{ shareIndex: 1, plaintext: 'c' }, { shareIndex: 2, plaintext: 'd' }] }), 'a different split never replaces a saved one');
  assert(store.choose('x', 'h', 'withdraw'));
  assert(store.choose('x', 'h', 'withdraw'), 'the same step again is fine');
  assert(!store.choose('x', 'h', 'release'), 'release after withdraw is refused');
  assert.equal(store.load('x', 'h')?.shares[0].plaintext, 'a');
  const dead = createWithheldShareStore({ read: () => null, write: () => {} });
  assert(!dead.save(record), 'a write that does not stick is not saved');
});

await check('a withheld LOCK gives the seller and arbiter nothing; accept, release, then claim reconstructs', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const buyerClient = await clientFor(Socket, buyerKey), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    const lock = lockOf(events, d);
    const payload = JSON.parse(lock.content) as LockPayload;
    assert.equal(payload.withheldShares, true);
    assert.deepEqual(payload.shares.map(s => Object.keys(s.encryptedFor)), [[buyer], [], []]);
    assert.equal(decryptable(events, [seller, arbiter]).length, 0, 'nothing for seller or arbiter before release');

    const sellerView = await sellerClient.loadEscrow(d, { fullHistory: true });
    assert.equal(sellerView?.lock.withheld?.releaseEventId, undefined);
    await until(() => stepsOf(events, d, 'accept').length === 1, 'the seller\'s automatic accept');
    assert.equal(stepsOf(events, d, 'release').length, 0, 'no release before the funder reads the accept');

    await buyerClient.loadEscrow(d, { fullHistory: true });
    await buyerClient.maybeAutoRelease(d);
    await until(() => stepsOf(events, d, 'release').length === 1, 'the funder\'s automatic release');
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 1, 'released once');
    assert.equal(stepsOf(events, d, 'release')[0].tags.find(t => t[0] === 'e')?.[1], stepsOf(events, d, 'accept')[0].id, 'release replies to the accept');

    const funded = await sellerClient.loadEscrow(d, { fullHistory: true });
    assert.equal(funded?.status, S.LOCKED);
    assert(funded?.lock.withheld?.releaseEventId, 'the seller reads the release');
    const sellerShare = decryptable(events, [seller]);
    const arbiterShare = decryptable(events, [arbiter]);
    assert.equal(sellerShare.length, 1); assert.equal(arbiterShare.length, 1);
    assert.equal(await rebuild([...sellerShare, ...arbiterShare]), NOTES, 'after release, 2-of-3 as agreed');
    assert.equal(await buyerClient.withdrawWithheldLock(d).then(() => 'published', e => (e as Error).message),
      'There is no funding of yours waiting to be taken back on this trade.', 'no withdraw after release');
    assert.equal(stepsOf(events, d, 'withdraw').length, 0);
  } finally { buyerClient.disconnect(); sellerClient.disconnect(); }
});

await check('take your sats back: one WITHDRAW for two taps, trade reopens, a late accept never gets a release', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const store = memoryWithheldShareStore();
  const buyerClient = await clientFor(Socket, buyerKey, store);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    const locked = buyerClient.getState(d)!;
    assert(buyerClient.canWithdrawWithheldLock(locked, buyer));
    assert(!buyerClient.canWithdrawWithheldLock(locked, seller), 'only the funder');
    // Count signed publishes: two withdraws signed in the same second share an
    // id, so the relay alone would hide a second publish.
    const relayManager = (buyerClient as unknown as { relayManager: { publish: (e: NostrEvent) => Promise<unknown> } }).relayManager;
    const publish = relayManager.publish.bind(relayManager);
    let withdrawPublishes = 0;
    relayManager.publish = (e: NostrEvent) => {
      if (e.kind === K.LOCK_STEP && JSON.parse(e.content).step === 'withdraw') withdrawPublishes++;
      return publish(e);
    };
    const [a, b] = await Promise.all([buyerClient.withdrawWithheldLock(d), buyerClient.withdrawWithheldLock(d)]);
    assert.equal(withdrawPublishes, 1, 'a double tap publishes one WITHDRAW');
    assert.equal(stepsOf(events, d, 'withdraw').length, 1);
    assert.equal(a?.status, S.CREATED); assert.equal(b?.status, S.CREATED);
    assert.equal(a?.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
    assert.equal(store.load(d, notesHash)?.step, 'withdraw');
    // A stale read on the same device (relays not showing the withdraw yet)
    // must not publish a second WITHDRAW.
    (buyerClient as unknown as { states: Map<string, unknown> }).states.set(d, locked);
    Date.now = () => (NOW + 5) * 1000;
    await buyerClient.withdrawWithheldLock(d).catch(() => {});
    Date.now = () => NOW * 1000;
    assert.equal(withdrawPublishes, 1, 'no second WITHDRAW from a stale read');

    // The seller accepts late (their app had not seen the withdraw).
    const lock = lockOf(events, d);
    events.push(finalizeEvent({ kind: K.LOCK_STEP, created_at: NOW + 60, content: JSON.stringify({ type: 'escrow:lock_step', step: 'accept', lockEventId: lock.id }),
      tags: [['d', d], ['e', lock.id, '', 'reply']] }, sellerKey));
    const after = await buyerClient.loadEscrow(d, { fullHistory: true });
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0, 'never a release after this device withdrew');
    assert.equal(after?.status, S.CREATED);
    assert.equal(decryptable(events, [seller, arbiter]).length, 0);
  } finally { buyerClient.disconnect(); }
});

await check('a device that chose to withdraw never releases, even on a read that still shows the LOCK accepted', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const store = memoryWithheldShareStore();
  const buyerClient = await clientFor(Socket, buyerKey, store), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    // The withdraw was chosen (and is being signed) when the accept arrives.
    assert(store.choose(d, notesHash, 'withdraw'));
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    const read = await buyerClient.loadEscrow(d, { fullHistory: true });
    assert.equal(read?.status, S.LOCKED); assert(read?.lock.acceptEventId);
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0);
    assert.equal(decryptable(events, [seller, arbiter]).length, 0);
  } finally { buyerClient.disconnect(); sellerClient.disconnect(); }
});

await check('a release chosen first blocks a later withdraw on the same device', async () => {
  const store = memoryWithheldShareStore();
  const record = { escrowId: 'r', notesHash: 'h', shares: [{ shareIndex: 1, plaintext: 'a' }, { shareIndex: 2, plaintext: 'b' }], savedAt: 1 };
  assert(store.save(record));
  assert(store.choose('r', 'h', 'release'));
  assert(!store.choose('r', 'h', 'withdraw'));
});

await check('today\'s LOCK when the other side runs 6.4.33, a dev build, or the shares cannot be saved', async () => {
  for (const [version, store, label] of [
    ['6.4.33', memoryWithheldShareStore(), 'older counterparty'],
    [null, memoryWithheldShareStore(), 'no client tag'],
    ['6.4.34', createWithheldShareStore({ read: () => null, write: () => {} }), 'store does not persist'],
  ] as const) {
    const { events, Socket } = relay();
    const d = seed(events, version);
    const buyerClient = await clientFor(Socket, buyerKey, store);
    try {
      await buyerClient.loadEscrow(d, { fullHistory: true });
      await bridgeLock(buyerClient, d);
      const payload = JSON.parse(lockOf(events, d).content) as LockPayload;
      assert.equal(payload.withheldShares, undefined, label);
      assert.deepEqual(payload.shares.map(s => Object.keys(s.encryptedFor)), [[buyer], [seller], [arbiter]], label);
      assert.equal(buyerClient.getState(d)?.status, S.LOCKED, label);
    } finally { buyerClient.disconnect(); }
  }
});

await check('before the gate the writer never withholds, whatever the other side runs', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34', gate - 60);
  const buyerClient = await clientFor(Socket, buyerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    assert.equal((JSON.parse(lockOf(events, d).content) as LockPayload).withheldShares, undefined);
  } finally { buyerClient.disconnect(); }
});

await check('the funder\'s saved notes are not cleared while its withheld LOCK is unreleased', () => {
  const base = { committedNotesHash: 'h', expectedNotesHash: 'h', custodyDurability: 'acknowledged' as const };
  assert(shouldClearNativeLockAfterPublish(base));
  assert(!shouldClearNativeLockAfterPublish({ ...base, withheldUnreleased: true }));
});

await check('a saved share that does not match the LOCK is never released', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const store = memoryWithheldShareStore();
  const buyerClient = await clientFor(Socket, buyerKey, store), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    // Corrupt the saved copy: same notes, different plaintext.
    const record = store.load(d, notesHash)!;
    const corrupt = memoryWithheldShareStore();
    corrupt.save({ ...record, shares: record.shares.map(s => ({ ...s, plaintext: `${s.plaintext} ` })) });
    (buyerClient as unknown as { config: { withheldShareStore: WithheldShareStore } }).config.withheldShareStore = corrupt;
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0);
    assert.equal(corrupt.load(d, notesHash)?.step, undefined, 'and the step is not spent on a refusal');
  } finally { buyerClient.disconnect(); sellerClient.disconnect(); }
});

await check('another of the funder\'s devices releases from the LOCK\'s own encrypted-to-self backup', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const phone = await clientFor(Socket, buyerKey), laptop = await clientFor(Socket, buyerKey), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await phone.loadEscrow(d, { fullHistory: true });
    await bridgeLock(phone, d);
    const backup = (JSON.parse(lockOf(events, d).content) as LockPayload).withheldBackup!;
    assert(backup, 'the LOCK carries the backup');
    for (const person of [seller, arbiter]) {
      assert.throws(() => dec(person, buyer, backup), 'only the funder can open the backup');
    }
    phone.disconnect();
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    await laptop.loadEscrow(d, { fullHistory: true });
    await laptop.maybeAutoRelease(d);
    await until(() => stepsOf(events, d, 'release').length === 1, 'release from the other device');
    assert.equal(await rebuild([...decryptable(events, [seller]), ...decryptable(events, [arbiter])]), NOTES);
  } finally { laptop.disconnect(); sellerClient.disconnect(); }
});

await check('notes that came back are never released from that device, even with no saved shares there', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const phone = await clientFor(Socket, buyerKey), sellerClient = await clientFor(Socket, sellerKey);
  const retired = memoryWithheldShareStore();
  const laptop = await clientFor(Socket, buyerKey, retired);
  try {
    await phone.loadEscrow(d, { fullHistory: true });
    await bridgeLock(phone, d);
    phone.disconnect();
    // The laptop's recovery took these notes back after a withdraw it read.
    assert(retired.retire(d, notesHash));
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    // A stale read on the laptop still shows the LOCK accepted.
    await laptop.loadEscrow(d, { fullHistory: true });
    await laptop.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0);
    assert(!retired.choose(d, notesHash, 'release'));
  } finally { laptop.disconnect(); sellerClient.disconnect(); }
});

await check('a withdraw that failed to send stays retryable after an accept arrives, and no release goes out', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const store = memoryWithheldShareStore();
  let refuseWithdraw = true;
  const base = signerFor(buyerKey);
  const signer: Signer = { ...base, signEvent: async event => {
    if (refuseWithdraw && event.kind === K.LOCK_STEP && JSON.parse(event.content).step === 'withdraw') throw new Error('signer declined');
    return base.signEvent(event);
  } } as Signer;
  const buyerClient = await clientFor(Socket, buyerKey, store, signer), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    await assert.rejects(buyerClient.withdrawWithheldLock(d), /signer declined/);
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    const accepted = await buyerClient.loadEscrow(d, { fullHistory: true });
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0, 'the chosen withdraw blocks the release');
    assert(buyerClient.canWithdrawWithheldLock(accepted!, buyer), 'the take-back stays on screen');
    refuseWithdraw = false;
    const after = await buyerClient.withdrawWithheldLock(d);
    assert.equal(stepsOf(events, d, 'withdraw').length, 1);
    assert.equal(after?.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
    assert.equal(decryptable(events, [seller, arbiter]).length, 0);
  } finally { buyerClient.disconnect(); sellerClient.disconnect(); }
});

await check('an accept that lands after the deadline is never released; the funder takes the sats back', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34', NOW - 60, 3600);
  const buyerClient = await clientFor(Socket, buyerKey), sellerClient = await clientFor(Socket, sellerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    await bridgeLock(buyerClient, d);
    Date.now = () => (NOW + 2 * 86400) * 1000;
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'late accept');
    const late = await buyerClient.loadEscrow(d, { fullHistory: true });
    assert.equal(late?.status, S.EXPIRED, 'the late accept moves the trade past its deadline');
    await buyerClient.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0, 'no release past the deadline');
    assert(buyerClient.canWithdrawWithheldLock(late!, buyer), 'the take-back is offered');
    const after = await buyerClient.withdrawWithheldLock(d);
    assert.equal(stepsOf(events, d, 'withdraw').length, 1);
    assert.equal(after?.rejectedLocks?.[0].code, 'WITHDRAWN_BEFORE_ACCEPT');
    assert.equal(decryptable(events, [seller, arbiter]).length, 0);
  } finally { Date.now = () => NOW * 1000; buyerClient.disconnect(); sellerClient.disconnect(); }
});

await check('a backup release first reads the whole history: a withdraw from another device stops it', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const phone = await clientFor(Socket, buyerKey), sellerClient = await clientFor(Socket, sellerKey);
  const laptop = await clientFor(Socket, buyerKey);
  try {
    await phone.loadEscrow(d, { fullHistory: true });
    await bridgeLock(phone, d);
    await sellerClient.loadEscrow(d, { fullHistory: true });
    await until(() => stepsOf(events, d, 'accept').length === 1, 'accept');
    await phone.withdrawWithheldLock(d);
    assert.equal(stepsOf(events, d, 'withdraw').length, 1);
    // The laptop's last read predates the withdraw: LOCK + accept only.
    const copy = relay();
    copy.events.push(...events.filter(e => !(e.kind === K.LOCK_STEP && JSON.parse(e.content).step === 'withdraw')));
    const stale = await clientFor(copy.Socket, buyerKey);
    const staleState = await stale.loadEscrow(d, { fullHistory: true });
    stale.disconnect();
    assert.equal(staleState?.status, S.LOCKED); assert(staleState?.lock.acceptEventId);
    (laptop as unknown as { states: Map<string, unknown> }).states.set(d, staleState);
    await laptop.maybeAutoRelease(d);
    assert.equal(stepsOf(events, d, 'release').length, 0, 'no release over a withdraw the laptop never saw');
    assert.equal(decryptable(events, [seller, arbiter]).length, 0);
  } finally { phone.disconnect(); laptop.disconnect(); sellerClient.disconnect(); }
});

await check('a backup that cannot be made never stops a LOCK whose sats already moved', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const buyerClient = await clientFor(Socket, buyerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    const base = signerFor(buyerKey);
    const bridge = Object.create(EscrowFedimintBridge.prototype) as EscrowFedimintBridge;
    Object.assign(bridge, { escrow: buyerClient, signer: { ...base, nip44Encrypt: async (text: string, to: string) => {
      if (text.startsWith('[')) throw new Error('plaintext too large');
      return base.nip44Encrypt(text, to);
    } } });
    await (bridge as unknown as { publishLockBundle: (...args: unknown[]) => Promise<unknown> })
      .publishLockBundle(d, buyerClient.getState(d)!, await bundle(), { buyerPubkey: buyer, sellerPk: seller, arbiterPubkey: arbiter }, {});
    const payload = JSON.parse(lockOf(events, d).content) as LockPayload;
    assert.equal(payload.withheldShares, true);
    assert.equal(payload.withheldBackup, undefined);
    assert.equal(buyerClient.getState(d)?.status, S.LOCKED);
  } finally { buyerClient.disconnect(); }
});

await check('recovery retires the held-back shares before taking withdrawn notes back, and waits if it cannot', async () => {
  const { events, Socket } = relay();
  const d = seed(events, '6.4.34');
  const buyerClient = await clientFor(Socket, buyerKey);
  try {
    await buyerClient.loadEscrow(d, { fullHistory: true });
    stashNativeLockIntent({ escrowId: d, amountMsats: 100000, federationId: 'fed1test' });
    upgradeNativeLockToSpent({ escrowId: d, oobNotes: NOTES, amountMsats: 100000, federationId: 'fed1test' });
    markNativeLockPublishAttempted(d);
    await bridgeLock(buyerClient, d);
    await buyerClient.withdrawWithheldLock(d);
    let credited = 0;
    const deps = {
      loadEscrow: (id: string) => buyerClient.loadEscrow(id, { fullHistory: true }),
      getConnectedRelayCount: () => 2,
      redeemNotes: async () => { throw new Error('refused notes must use the measured-credit path'); },
      redeemRejectedNotes: async () => { credited++; },
      currentFederationId: () => 'fed1test',
      hashNotes: async (notes: string) => bytesToHex(sha256(new TextEncoder().encode(notes))),
    };
    // Storage that can't record the tombstone: keep the notes, take nothing back.
    const entry: PendingNativeLock = getPendingNativeLock(d)!;
    assert(entry?.oobNotes, 'the funder\'s notes are still saved after a withheld LOCK');
    setLocalStorageUserScope(null);
    const waiting = await recoverPendingNativeLock(entry, deps, { ignoreAttemptCap: true });
    setLocalStorageUserScope('withheld-writer-test');
    assert.equal(waiting, 'kept'); assert.equal(credited, 0);
    const outcome = await recoverPendingNativeLock(getPendingNativeLock(d)!, deps, { ignoreAttemptCap: true });
    assert.equal(outcome, 'reabsorbed'); assert.equal(credited, 1, 'the sats came back once, with measured credit');
    assert.equal(getPendingNativeLock(d), null, 'the saved notes are settled');
    assert.equal(defaultWithheldShareStore().load(d, notesHash)?.step, 'withdraw', 'retired on this device');
  } finally { buyerClient.disconnect(); }
});

await check('the device store never treats a failed read as empty', () => {
  setLocalStorageUserScope(null);
  const store = defaultWithheldShareStore();
  assert(!store.save({ escrowId: 'z', notesHash: 'h', shares: [], savedAt: 1 }), 'no identity, no save');
  setLocalStorageUserScope('withheld-writer-test');
  assert(defaultWithheldShareStore().save({ escrowId: 'z', notesHash: 'h', shares: [{ shareIndex: 1, plaintext: 'a' }, { shareIndex: 2, plaintext: 'b' }], savedAt: 1 }));
});

Date.now = realNow;
if (failures) { console.error(`withheld-writer: ${failures} failing`); process.exit(1); }
console.log('withheld-writer: all checks passed');
process.exit(0);
