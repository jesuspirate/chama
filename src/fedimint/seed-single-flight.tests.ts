// Oct 27 2026: Bestie and Bitcrazy each had two different seed backups on
// relays, made by first sign-ins that overlapped. One creation runs per
// identity at a time, it reads the relays again first, and a skipped creation
// opens the backup that appeared instead of making another.
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { NostrEvent } from '../escrow-engine/types.js';
import type { Signer, UnsignedEvent } from '../escrow-engine/escrow-client.js';
import { getOrCreateSeed, clearSeedCache } from './seed-manager.js';

const secret = new Uint8Array(32).fill(5), pubkey = getPublicKey(secret);
const conversation = nip44.v2.utils.getConversationKey(secret, pubkey);
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v),
  removeItem: (k: string) => values.delete(k), clear: () => values.clear(),
} });
const signer: Signer = {
  async getPublicKey() { return pubkey; },
  async signEvent(unsigned: UnsignedEvent) { return finalizeEvent(unsigned, secret) as NostrEvent; },
  async nip44Encrypt(value: string) { return nip44.v2.encrypt(value, conversation); },
  async nip44Decrypt(value: string) { return nip44.v2.decrypt(value, conversation); },
};
const existing = finalizeEvent({ kind: 30078, tags: [['d', 'chama-fedimint-seed-v1'], ['client', 'chama']], created_at: 100,
  content: nip44.v2.encrypt(mnemonic, conversation) }, secret) as NostrEvent;

/** Relays that answer each read from `answers` in turn (the last repeats) and keep what is published. */
function relays(answers: NostrEvent[][]) {
  const published: NostrEvent[] = [];
  let reads = 0;
  const client = {
    async queryOnce() {
      const answer = answers[Math.min(reads++, answers.length - 1)];
      await new Promise(r => setTimeout(r, 5));
      return [...answer, ...published];
    },
    hasRecoveryReadQuorum() { return true; }, getConnectedRelayCount() { return 3; },
    async publishRaw(e: NostrEvent) { await new Promise(r => setTimeout(r, 5)); published.push(e); },
  } as any;
  return { client, published, reads: () => reads };
}
const quiet = (['info', 'warn', 'debug', 'error'] as const).map(k => [k, console[k]] as const);
quiet.forEach(([k]) => { console[k] = () => {}; });
try {
  {
    // Two first sign-ins at once on a fresh identity publish ONE backup.
    clearSeedCache(); values.clear();
    const pool = relays([[]]);
    const [a, b] = await Promise.all([getOrCreateSeed(pool.client, signer), getOrCreateSeed(pool.client, signer)]);
    assert.equal(pool.published.length, 1, 'one backup for one identity');
    assert.deepEqual(a, b, 'both callers get the same words');
  }
  {
    // A backup written elsewhere between the first read and creation is opened, not replaced.
    clearSeedCache(); values.clear();
    const pool = relays([[], [existing]]);
    assert.equal((await getOrCreateSeed(pool.client, signer)).join(' '), mnemonic);
    assert.equal(pool.published.length, 0, 'nothing published over the existing backup');
  }
  {
    // A backup seen in the re-read that then can't be read again: fail closed, never generate.
    clearSeedCache(); values.clear();
    const pool = relays([[], [existing], []]);
    await assert.rejects(getOrCreateSeed(pool.client, signer));
    assert.equal(pool.published.length, 0, 'no second backup while relays flap');
  }
  {
    // A true first launch still creates and saves one backup.
    clearSeedCache(); values.clear();
    const pool = relays([[]]);
    const words = await getOrCreateSeed(pool.client, signer);
    assert.equal(words.length, 12);
    assert.equal(pool.published.length, 1);
    assert.equal(pool.reads(), 2, 'the relays are read once more before creating');
  }
  {
    // Another tab holds the creation lock (e.g. an unanswered signer prompt):
    // this tab stops and lets reconnect retry. It never creates without it.
    clearSeedCache(); values.clear();
    const pool = relays([[]]);
    const held = { request: (_name: string, options: { signal?: AbortSignal }) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')));
      setTimeout(() => reject(new DOMException('timed out', 'AbortError')), 20);
    }) };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: held } });
    try {
      await assert.rejects(getOrCreateSeed(pool.client, signer), (e: any) => e?.code !== undefined || /relay/i.test(String(e?.message)));
      assert.equal(pool.published.length, 0, 'no backup made without the lock');
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    }
  }
  {
    // With a working cross-tab lock, two sign-ins still publish one backup.
    clearSeedCache(); values.clear();
    const pool = relays([[]]);
    let tail: Promise<unknown> = Promise.resolve();
    const locks = { request: (_name: string, _options: unknown, fn: () => Promise<unknown>) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
    try {
      await Promise.all([getOrCreateSeed(pool.client, signer), getOrCreateSeed(pool.client, signer)]);
      assert.equal(pool.published.length, 1);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    }
  }
} finally {
  quiet.forEach(([k, fn]) => { console[k] = fn; });
}
console.log('PASS seed single-flight: one backup per identity, a backup that appears is opened, relays that flap never cause a second one');
