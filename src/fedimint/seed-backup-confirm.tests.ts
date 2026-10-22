// M10: on-chain trade keys come from the wallet seed, and the encrypted
// backup on relays is the only copy another device can restore it from.
// confirmSeedBackupOnRelays must prove a relay holds THAT backup before a
// key goes out, resend only the exact signed copy, and fail closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { NostrEvent } from '../escrow-engine/types.js';
import type { Signer, UnsignedEvent } from '../escrow-engine/escrow-client.js';
import { getOrCreateSeed, clearSeedCache, confirmSeedBackupOnRelays, SeedBackupUnconfirmed,
  SEED_BACKUP_UNCONFIRMED } from './seed-manager.js';
import { SEED_V2_BROWSER_D_TAG } from './seed-backup-v2.js';

const secret = new Uint8Array(32).fill(3), pubkey = getPublicKey(secret);
const conversation = nip44.v2.utils.getConversationKey(secret, pubkey);
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const other = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v),
  removeItem: (k: string) => values.delete(k), clear: () => values.clear(),
} });
let signs = 0, decrypts = 0;
const signer: Signer = {
  async getPublicKey() { return pubkey; },
  async signEvent(unsigned: UnsignedEvent) { signs++; return finalizeEvent(unsigned, secret) as NostrEvent; },
  async nip44Encrypt(value: string) { return nip44.v2.encrypt(value, conversation); },
  async nip44Decrypt(value: string) { decrypts++; return nip44.v2.decrypt(value, conversation); },
};
function event(d: string, plaintext: string, at: number): NostrEvent {
  return finalizeEvent({ kind: 30078, tags: [['d', d], ['client', 'chama']], created_at: at,
    content: nip44.v2.encrypt(plaintext, conversation) }, secret) as NostrEvent;
}
const v1 = event('chama-fedimint-seed-v1', mnemonic, 100);
const v1Newer = event('chama-fedimint-seed-v1', mnemonic, 200);
const v1Older = event('chama-fedimint-seed-v1', mnemonic, 50);
const displaced = event('chama-fedimint-seed-v1', other, 300);
const retired = event('chama-fedimint-seed-v1', JSON.stringify({ retired: true, movedTo: SEED_V2_BROWSER_D_TAG }), 400);
const retiredOlder = event('chama-fedimint-seed-v1', JSON.stringify({ retired: true, movedTo: SEED_V2_BROWSER_D_TAG }), 40);
const unreadableNewer = finalizeEvent({ kind: 30078, tags: [['d', 'chama-fedimint-seed-v1'], ['client', 'chama']], created_at: 250,
  content: 'not-a-ciphertext' }, secret) as NostrEvent;
const v2 = event(SEED_V2_BROWSER_D_TAG, '{}', 500);

/** A relay pool. `keep` decides whether a resent event sticks. */
let writes: NostrEvent[] = [], queries = 0;
function relays(stored: NostrEvent[], opts: { keep?: boolean; failPublish?: boolean; failQuery?: boolean; noQuorum?: boolean } = {}) {
  return {
    async queryOnce(filter: any) {
      queries++;
      assert.deepEqual(filter.kinds, [30078]);
      assert.deepEqual(filter.authors, [pubkey]);
      // The opening read takes every scope; the confirmation reads exactly the restorable ones.
      if (filter['#d']) assert.deepEqual(filter['#d'], ['chama-fedimint-seed-v1', SEED_V2_BROWSER_D_TAG]);
      if (opts.failQuery) throw new Error('relay down');
      return stored.map(e => ({ ...e, tags: e.tags.map(t => [...t]) }));
    },
    hasRecoveryReadQuorum() { return !opts.noQuorum; }, getConnectedRelayCount() { return 3; },
    async publishRaw(e: NostrEvent) {
      writes.push(e);
      if (opts.failPublish) throw new Error('publish refused');
      if (opts.keep) stored.push(e);
    },
  } as any;
}
async function openSeed() {
  clearSeedCache(); values.clear();
  // Opening the seed saves the verified signed backup on this device.
  await getOrCreateSeed(relays([v1]), signer);
  writes = []; queries = 0; signs = 0; decrypts = 0;
}
const logs: unknown[][] = [];
const methods = ['debug', 'info', 'warn', 'error'] as const;
const original = methods.map(k => console[k]);
methods.forEach(k => { console[k] = (...args: unknown[]) => { logs.push(args); }; });
let cases = 0;
try {
  // Nothing opened this session: nothing to confirm, nothing written.
  clearSeedCache(); values.clear(); writes = [];
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1]), signer), { confirmed: false, problem: 'seed-not-open' });
  assert.equal(writes.length, 0); cases++;

  // The relays hold this device's backup: confirmed with no write and no decrypt prompt.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1]), signer), { confirmed: true, resent: false });
  assert.equal(writes.length, 0); assert.equal(decrypts, 0); assert.equal(signs, 0); cases++;

  // Relays lost it: the EXACT saved signed event is resent, never re-signed or regenerated.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([], { keep: true }), signer), { confirmed: true, resent: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, v1.id); assert.equal(writes[0].sig, v1.sig); assert.equal(writes[0].content, v1.content);
  assert.equal(signs, 0); cases++;

  // Relays only hold an older copy: resend ours, then confirm.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1Older], { keep: true }), signer), { confirmed: true, resent: true });
  assert.equal(writes[0].id, v1.id); cases++;

  // Resend did not stick: fail closed after exactly one resend and one re-read.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([]), signer), { confirmed: false, problem: 'not-on-relays' });
  assert.equal(writes.length, 1); assert.equal(queries, 2); cases++;

  // Publish throws: still re-reads, still fails closed, never throws to the caller.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([], { failPublish: true }), signer), { confirmed: false, problem: 'not-on-relays' });
  assert.equal(queries, 2); cases++;

  // Query throws: fails closed without throwing.
  await openSeed();
  assert.equal((await confirmSeedBackupOnRelays(relays([v1], { failQuery: true }), signer)).confirmed, false); cases++;

  // A relay answering with our id but a forged signature proves nothing.
  await openSeed();
  const forged = { ...v1, sig: '00'.repeat(64) };
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([forged]), signer), { confirmed: false, problem: 'not-on-relays' });
  assert.equal(writes.length, 1, 'the genuine copy was resent'); cases++;

  // A newer copy written elsewhere that opens to the same words counts, and
  // becomes the copy this device resends later.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, v1Newer]), signer), { confirmed: true, resent: false });
  assert.equal(writes.length, 0);
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([], { keep: true }), signer), { confirmed: true, resent: true });
  assert.equal(writes[0].id, v1Newer.id); cases++;

  // A newer copy with DIFFERENT words is what a restore would open: refuse, write nothing.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, displaced]), signer), { confirmed: false, problem: 'different-seed-on-relays' });
  assert.equal(writes.length, 0); cases++;

  // A newer retirement marker means a restore would ask for a recovery code instead.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, retired]), signer), { confirmed: false, problem: 'different-seed-on-relays' });
  assert.equal(writes.length, 0); cases++;

  // A protected browser backup outranks v1 on restore: never confirm the v1 copy beside it.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, v2]), signer), { confirmed: false, problem: 'different-seed-on-relays' });
  assert.equal(writes.length, 0); cases++;

  // A retirement marker anywhere blocks every v1 copy on restore, even an older one.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, retiredOlder]), signer), { confirmed: false, problem: 'different-seed-on-relays' });
  assert.equal(writes.length, 0); cases++;

  // An empty read from too few relays never triggers a resend.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([], { keep: true, noQuorum: true }), signer), { confirmed: false, problem: 'not-on-relays' });
  assert.equal(writes.length, 0); cases++;

  // A newer copy that doesn't open is skipped on restore, so ours still counts…
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, unreadableNewer]), signer), { confirmed: true, resent: false });
  // …and alone it is not ours, so ours is resent.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([unreadableNewer], { keep: true }), signer), { confirmed: true, resent: true });
  cases++;

  // Each copy is opened at most once per check (one prompt per copy for asking signers).
  await openSeed();
  await confirmSeedBackupOnRelays(relays([v1, v1Newer]), signer);
  assert.equal(decrypts, 1); cases++;

  // Background checks never open a copy: anything needing the signer waits, and nothing is written.
  await openSeed();
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1, v1Newer]), signer, { mayPrompt: false }), { confirmed: false, problem: 'not-on-relays' });
  assert.equal(decrypts, 0); assert.equal(writes.length, 0);
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1]), signer, { mayPrompt: false }), { confirmed: true, resent: false });
  cases++;

  // No verified local copy: nothing to resend, fail closed.
  await openSeed();
  for (const key of [...values.keys()]) if (key.startsWith('chama_seed_event_cache_v1')) values.delete(key);
  assert.deepEqual(await confirmSeedBackupOnRelays(relays([v1]), signer), { confirmed: false, problem: 'no-local-copy' });
  assert.equal(writes.length, 0); cases++;

  // The typed refusal carries a code the screens can key on.
  const refusal = new SeedBackupUnconfirmed('not-on-relays');
  assert.equal(refusal.code, SEED_BACKUP_UNCONFIRMED);
  assert.match(refusal.message, /No sats moved/);
  assert.match(new SeedBackupUnconfirmed('different-seed-on-relays').message, /different backup/); cases++;

  // Wiring: each place an on-chain key or deposit address goes out checks
  // the backup first, before the signed event is published.
  const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
  const body = (start: string, end: string) => {
    const i = hook.indexOf(start); assert.ok(i >= 0, start);
    const j = hook.indexOf(end, i); assert.ok(j > i, end);
    return hook.slice(i, j);
  };
  const create = body('const createEscrow = useCallback', 'const joinEscrow = useCallback');
  assert.ok(create.indexOf('await requireRestorableEscrowKey(client)') >= 0
    && create.indexOf('await requireRestorableEscrowKey(client)') < create.indexOf('client.createEscrow('), 'CREATE checks first');
  const join = body('const joinEscrow = useCallback', 'const requireBridge');
  assert.ok(join.indexOf('await requireRestorableEscrowKey(client)') >= 0
    && join.indexOf('await requireRestorableEscrowKey(client)') < join.indexOf('client.joinEscrow('), 'JOIN checks first');
  const terms = body('const prepareOnchainFunding = useCallback', 'const checkOnchainFunding = useCallback');
  assert.ok(terms.indexOf('await requireRestorableEscrowKey(client)') >= 0
    && terms.indexOf('await requireRestorableEscrowKey(client)') < terms.indexOf('client.joinEscrow('), 'deposit terms check first');
  assert.ok(join.includes('getEffectiveParticipantAt(seatState, role) === mySeat'), 'only a seat still held skips the check');
  assert.ok(hook.includes('confirmSeedBackupOnRelays(client, signer, { mayPrompt: false })'), 'keep-alive never prompts');
  const guard = body('const requireRestorableEscrowKey = useCallback', 'const createEscrow = useCallback');
  assert.ok(guard.includes('throw new SeedBackupUnconfirmed'), 'unconfirmed throws');
  cases++;
} finally {
  methods.forEach((k, i) => { console[k] = original[i] as any; });
}
console.log(`seed backup confirm: ${cases} cases passed`);
