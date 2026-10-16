import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { base64, hex } from '@scure/base';
import vectors from './fixtures/seed-backup-v2-vectors.json';
import { generateRecoveryCode, parseRecoveryCode, formatRecoveryCode, deriveSeedWrapKey,
  wrapSeedBackup, unwrapSeedBackup, parseSeedBackupV2, type SeedBackupScope } from './seed-backup-v2.js';
for (const vector of vectors) {
  const code = hex.decode(vector.codeHex), scope = vector.scope as SeedBackupScope;
  assert.equal(formatRecoveryCode(code), vector.code);
  assert.deepEqual(parseRecoveryCode(vector.code.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(hex.encode(deriveSeedWrapKey(code, scope)), vector.keyHex);
  assert.equal(Buffer.from(hkdfSync('sha256', code, 'chama-seed-backup-v2', scope, 32)).toString('hex'), vector.keyHex);
  const payload = { v: 2 as const, scope, codeCheck: vector.codeCheck, nonce: vector.nonce, box: vector.box };
  assert.deepEqual(wrapSeedBackup(vector.mnemonic, code, scope, base64.decode(vector.nonce)), payload);
  assert.equal(unwrapSeedBackup(payload, vector.code, scope), vector.mnemonic);
  assert.throws(() => unwrapSeedBackup(payload, formatRecoveryCode(new Uint8Array(16).fill(2)), scope));
  const box = base64.decode(vector.box); box[0] ^= 1;
  assert.throws(() => unwrapSeedBackup({ ...payload, box: base64.encode(box) }, vector.code, scope));
  assert.throws(() => unwrapSeedBackup({ ...payload, codeCheck: '00000000' }, vector.code, scope));
  assert.throws(() => unwrapSeedBackup({ ...payload, nonce: base64.encode(new Uint8Array(24)) }, vector.code, scope));
  const other = scope === 'browser' ? `native:${'ab'.repeat(32)}` as const : 'browser';
  assert.throws(() => unwrapSeedBackup(payload, vector.code, other));
  // Even changing both scope fields cannot bypass authenticated scope binding.
  assert.throws(() => unwrapSeedBackup({ ...payload, scope: other }, vector.code, other));
  for (const bad of ['{}', '{', JSON.stringify({ ...payload, nonce: 'bad' }), JSON.stringify({ ...payload, box: '!' })]) {
    assert.throws(() => parseSeedBackupV2(bad, scope));
  }
}
const zeros = new Uint8Array(16);
assert.deepEqual(parseRecoveryCode(formatRecoveryCode(zeros).replace(/0/g, 'O')), zeros);
const ones = new Uint8Array(16); ones[15] = 1;
assert.deepEqual(parseRecoveryCode(formatRecoveryCode(ones).replace(/1/g, 'l')), ones);
assert.deepEqual(parseRecoveryCode(formatRecoveryCode(ones).replace(/1/g, 'I')), ones);
for (const input of ['0'.repeat(25), '0'.repeat(27), 'Z'.repeat(26), 'U'.repeat(26)]) assert.throws(() => parseRecoveryCode(input));
for (let i = 0; i < 32; i++) assert.equal(parseRecoveryCode(generateRecoveryCode()).length, 16);
console.log('PASS seed v2: 2 fixed browser/native vectors; Node HKDF cross-check; code parsing, scope binding, corruption and wrong-code rejection');
