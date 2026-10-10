import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'chama-signer-'));
chmodSync(dir, 0o700);
const file = join(dir, 'connection');
const connection = `bunker://${'a'.repeat(64)}?relay=wss%3A%2F%2Fexample.com&secret=test-only`;
const run = (extra = {}) => spawnSync(process.execPath,
  ['scripts/read-zapstore-signer.mjs', file],
  { encoding: 'utf8', env: { ...process.env, CHAMA_ZAPSTORE_SIGNER_FILE: '', ...extra } });
try {
  await test('missing default falls back; missing explicit configuration fails', () => {
    assert.equal(run().stdout, 'browser');
    assert.equal(run({ CHAMA_ZAPSTORE_SIGNER_FILE: file }).status, 1);
  });
  await test('loads private connection without exposing it on stderr', () => {
    writeFileSync(file, connection, { mode: 0o600 });
    const result = run();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, connection);
    assert.equal(result.stderr, '');
  });
  await test('refuses readable-by-others files and directories', () => {
    chmodSync(file, 0o644);
    assert.equal(run().status, 1);
    chmodSync(file, 0o600);
    chmodSync(dir, 0o755);
    assert.equal(run().status, 1);
    chmodSync(dir, 0o700);
  });
  await test('invalid connection fails without leaking content', () => {
    writeFileSync(file, 'sensitive-invalid-value');
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('sensitive-invalid-value'));
  });
  await test('explicit signer wins without consulting a missing file', () => {
    const result = spawnSync('bash', ['-c',
      'source scripts/zapstore-signer.sh; chama_zapstore_signer; test "$SIGN_WITH" = browser'],
    { env: { ...process.env, SIGN_WITH: 'browser', CHAMA_ZAPSTORE_SIGNER_FILE: '/missing' } });
    assert.equal(result.status, 0);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
