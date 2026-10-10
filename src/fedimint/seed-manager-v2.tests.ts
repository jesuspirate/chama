import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { NostrEvent } from '../escrow-engine/types.js';
import type { Signer, UnsignedEvent } from '../escrow-engine/escrow-client.js';
import { getOrCreateSeed, clearSeedCache, republishSeed, cachedSeedRequiresFederationRecovery,
  SeedNeedsRecoveryCode, SeedNeedsRestoreConfirmation, recoverSeedWordsFromEvents, checkAndMaybeRepublishSeed, SEED_RECOVERY_RETRY_DELAYS_MS, SEED_PUBLISHED_MARKER_KEY } from './seed-manager.js';
import { SEED_V2_BROWSER_D_TAG, wrapSeedBackup, formatRecoveryCode, InvalidRecoveryCode } from './seed-backup-v2.js';
const secret = new Uint8Array(32).fill(1), pubkey = getPublicKey(secret);
const conversation = nip44.v2.utils.getConversationKey(secret, pubkey);
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const codeBytes = new Uint8Array(16).fill(7), code = formatRecoveryCode(codeBytes);
const payload = wrapSeedBackup(mnemonic, codeBytes, 'browser', new Uint8Array(24).fill(9));
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
function event(d: string, plaintext: string, at = 100): NostrEvent {
  return finalizeEvent({ kind: 30078, tags: [['d', d], ['client', 'chama']], created_at: at,
    content: nip44.v2.encrypt(plaintext, conversation) }, secret) as NostrEvent;
}
const v2 = event(SEED_V2_BROWSER_D_TAG, JSON.stringify(payload));
const v1 = event('chama-fedimint-seed-v1', mnemonic, 50);
const retired = event('chama-fedimint-seed-v1', JSON.stringify({ retired: true, movedTo: SEED_V2_BROWSER_D_TAG }), 150);
let writes: NostrEvent[] = [], queries = 0;
function client(events: NostrEvent[]) { return {
  async queryOnce(filter: any) {
    queries++;
    assert.equal(filter.authors[0], pubkey);
    // No result cap can hide a protected scope; unrelated app-data is filtered.
    return events;
  },
  hasRecoveryReadQuorum() { return true; }, getConnectedRelayCount() { return 3; },
  async publishRaw(e: NostrEvent) { writes.push(e); },
} as any; }
function reset() { clearSeedCache(); values.clear(); writes = []; queries = 0; }
const logs: unknown[][] = [];
const methods = ['debug', 'info', 'warn', 'error'] as const;
const original = methods.map(k => console[k]);
methods.forEach(k => { console[k] = (...args: unknown[]) => { logs.push(args); }; });
let cases = 0;
try {
  reset();
  await assert.rejects(getOrCreateSeed(client([v1, v2]), signer), SeedNeedsRecoveryCode); cases++;
  assert.equal(writes.length, 0);
  await assert.rejects(getOrCreateSeed(client([v1]), signer, { recoveryCode: formatRecoveryCode(new Uint8Array(16).fill(2)), restoreConfirmed: true }), InvalidRecoveryCode); cases++;
  assert.equal(writes.length, 0);
  await assert.rejects(getOrCreateSeed(client([]), signer, { recoveryCode: code }), SeedNeedsRestoreConfirmation); cases++;
  const words = await getOrCreateSeed(client([]), signer, { recoveryCode: code, restoreConfirmed: true });
  assert.equal(words.join(' '), mnemonic); cases++;
  assert.equal(cachedSeedRequiresFederationRecovery(pubkey), true);
  assert.equal(queries, 1, 'Signed local v2 cache does not wait on relays, even after dismissal or wrong code');
  assert.ok([...values.values()].every(value => !value.includes(code) && !value.includes(mnemonic)));
  assert.equal(await republishSeed(client([]), signer), false);
  assert.equal(writes.length, 0, 'Readers never downgrade or republish v2'); cases++;
  const health = await checkAndMaybeRepublishSeed(client([v2]), signer);
  assert.equal(health.lastPublishedAt, null, 'A skipped protected republish is not reported as a publication'); cases++;
  clearSeedCache();
  await assert.rejects(getOrCreateSeed(client([]), signer), SeedNeedsRecoveryCode); cases++;

  reset();
  await assert.rejects(getOrCreateSeed(client([retired, v1]), signer), SeedNeedsRecoveryCode); cases++;
  clearSeedCache();
  await assert.rejects(getOrCreateSeed(client([]), signer), SeedNeedsRecoveryCode); cases++;
  assert.equal(writes.length, 0, 'Retired v1 never generates a seed even after reload and relay loss');
  assert.equal((await getOrCreateSeed(client([retired, v2]), signer,
    { recoveryCode: code, restoreConfirmed: true })).join(' '), mnemonic,
    'Code entry after a cached retirement marker still fetches the protected backup'); cases++;
  // This is the unchanged legacy-reader decryption path used before v2.
  assert.equal(await recoverSeedWordsFromEvents([retired], pubkey, signer, { delaysMs: [] }), null,
    'Current legacy reader cannot interpret the retirement JSON as a mnemonic'); cases++;

  reset();
  await assert.rejects(getOrCreateSeed(client([retired, event('chama-fedimint-seed-v1', mnemonic, 200)]), signer), SeedNeedsRecoveryCode); cases++;
  assert.equal(writes.length, 0, 'A later legacy republish cannot undo a known retirement');

  reset();
  const native = event(`chama-wallet-seed-v2:native:${'ab'.repeat(32)}`, '{}');
  await assert.rejects(getOrCreateSeed(client([native]), signer), SeedNeedsRecoveryCode); cases++;
  assert.equal(writes.length, 0, 'Any v2 scope refuses fresh browser generation');
  assert.ok(values.size > 0, 'Protected existence is remembered without storing code or cleartext');

  reset();
  await assert.rejects(getOrCreateSeed(client([event(SEED_V2_BROWSER_D_TAG, '{}'), v1]), signer,
    { recoveryCode: code, restoreConfirmed: true }), /Invalid protected/); cases++;
  assert.equal(writes.length, 0, 'Malformed v2 never falls through to v1 or fresh generation');

  reset();
  const damaged = { ...v2, sig: '00'.repeat(64) };
  // Forged v2 is not treated as an authenticated backup.
  assert.equal((await getOrCreateSeed(client([damaged, v1]), signer)).join(' '), mnemonic); cases++;
  assert.equal(writes.length, 0);

  reset();
  await assert.rejects(getOrCreateSeed(client([v1]), signer, { requireRestoreConfirmation: true }), SeedNeedsRestoreConfirmation); cases++;
  assert.equal((await getOrCreateSeed(client([v1]), signer, { requireRestoreConfirmation: true, restoreConfirmed: true })).join(' '), mnemonic); cases++;
  // A v2 written by a newer device prevents an older session republishing v1.
  await republishSeed(client([v2, v1]), signer); assert.equal(writes.length, 0); cases++;
  await republishSeed(client([retired]), signer); assert.equal(writes.length, 0); cases++;
  await republishSeed(client([]), signer); assert.equal(writes.length, 0); cases++;
  await republishSeed({ ...client([v1]), hasRecoveryReadQuorum: () => false }, signer); assert.equal(writes.length, 0); cases++;
  await republishSeed(client([v1]), signer); assert.equal(writes.length, 1, 'Unprotected legacy republish still works after a complete read'); cases++;

  reset();
  await getOrCreateSeed(client([v1]), signer);
  const changedWhileReading = { ...client([v1]), async queryOnce() {
    clearSeedCache(); values.clear();
    await getOrCreateSeed(client([v2]), signer, { recoveryCode: code, restoreConfirmed: true });
    return [v1];
  } };
  assert.equal(await republishSeed(changedWhileReading, signer), false,
    'A session cache changed while relays were read must not be republished or downgraded');
  assert.equal(writes.length, 0); cases++;

  reset();
  values.set(SEED_PUBLISHED_MARKER_KEY, JSON.stringify({ [pubkey]: { firstPublishedAt: 1, lastEventId: v1.id } }));
  const previousDelay = SEED_RECOVERY_RETRY_DELAYS_MS[0];
  SEED_RECOVERY_RETRY_DELAYS_MS[0] = 0;
  let readCount = 0;
  try {
    await assert.rejects(getOrCreateSeed({ ...client([]), async queryOnce() { return ++readCount === 1 ? [] : [v2]; } }, signer), SeedNeedsRecoveryCode);
    assert.equal(readCount, 2, 'Protected backup returned on retry is not filtered out');
    assert.equal(writes.length, 0); cases++;
  } finally { SEED_RECOVERY_RETRY_DELAYS_MS[0] = previousDelay; }

  reset();
  const badSigner = { ...signer, async nip44Decrypt() { throw new Error(`secret ${mnemonic} ${code}`); } };
  await assert.rejects(getOrCreateSeed(client([v2]), badSigner, { recoveryCode: code, restoreConfirmed: true }), /Couldn't open/); cases++;
  assert.equal(writes.length, 0);
  assert.ok(!JSON.stringify(logs).includes(code) && !JSON.stringify(logs).includes(mnemonic), 'No secret reaches console or mlog');
} finally { methods.forEach((k, i) => { console[k] = original[i]; }); clearSeedCache(); }
console.log(`PASS protected seed reader: ${cases} recovery, refusal, cache, retirement, downgrade and secret-redaction cases`);
