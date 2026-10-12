import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { applicationId, judge, publisherHex, verifyRelease } from './verify-zapstore-release.mjs';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const id = 'app.chama.market';
const release = (version, created_at, key = sk) => finalizeEvent({
  kind: 30063, created_at, content: '',
  tags: [['d', `${id}@${version}`], ['i', id], ['version', version]],
}, key);
const opts = { pubkey, identifier: id, version: '6.4.23' };

test('reads the publisher and the package id from the repo files', () => {
  assert.equal(publisherHex(`name: Chama\npubkey: ${nip19.npubEncode(pubkey)}\n`), pubkey);
  assert.equal(publisherHex(`pubkey: ${pubkey}`), pubkey);
  assert.equal(applicationId('defaultConfig {\n  applicationId "app.chama.market"\n}'), id);
  assert.throws(() => publisherHex('name: Chama'));
});

test('a fresh signed release event from the publisher passes', () => {
  const now = Math.floor(Date.now() / 1000);
  const result = judge([release('6.4.23', now)], { ...opts, since: now - 10 });
  assert.equal(result.ok, true);
  assert.equal(result.stale, false);
});

test('nothing published, wrong version, wrong author or bad signature fails', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(judge([], opts).ok, false);
  assert.equal(judge([release('6.4.22', now)], opts).ok, false);
  assert.equal(judge([release('6.4.23', now, generateSecretKey())], opts).ok, false, 'another key cannot stand in for the publisher');
  // Copy fields explicitly: nostr-tools caches a 'verified' symbol that an
  // object spread would carry over, hiding the tamper.
  const good = release('6.4.23', now);
  const tampered = { id: good.id, pubkey: good.pubkey, kind: good.kind, created_at: good.created_at, tags: good.tags, sig: good.sig, content: 'changed' };
  assert.equal(judge([tampered], opts).ok, false, 'a tampered event is rejected');
});

test('an older event means this run published nothing new and is reported as such', () => {
  const now = Math.floor(Date.now() / 1000);
  const result = judge([release('6.4.23', now - 3600)], { ...opts, since: now });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
});

test('a re-publish (--overwrite-zapstore) that lands nothing new fails', async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = [release('6.4.23', now - 3600)];
  const result = judge(old, { ...opts, since: now, requireNew: true });
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.match(result.reason, /not re-published/);
  assert.equal(judge([release('6.4.23', now)], { ...opts, since: now - 5, requireNew: true }).ok, true, 'a fresh re-publish passes');
  let calls = 0;
  const viaRelay = await verifyRelease({ relay: 'x', ...opts, since: now, requireNew: true, attempts: 2, delayMs: 1, fetcher: async () => (calls++, old) });
  assert.equal(viaRelay.ok, false, 'retries cannot turn an old event into a re-publish');
  assert.equal(calls, 2);
});

test('the CLI refuses --require-new without --since and exits 1 on a stale re-publish', () => {
  const cli = args => spawnSync(process.execPath, ['scripts/verify-zapstore-release.mjs', ...args], { encoding: 'utf8' });
  const noSince = cli(['--version', '0.0.0', '--require-new', '--relay', 'wss://127.0.0.1:9']);
  assert.equal(noSince.status, 2);
  assert.match(noSince.stderr, /--require-new needs --since/);
});

test('retries until the relay has the event, and reports an unreachable relay', async () => {
  const now = Math.floor(Date.now() / 1000);
  let calls = 0;
  const late = async () => (++calls < 3 ? [] : [release('6.4.23', now)]);
  const found = await verifyRelease({ relay: 'x', ...opts, since: now - 5, delayMs: 1, fetcher: late });
  assert.equal(found.ok, true);
  assert.equal(calls, 3);
  const down = await verifyRelease({ relay: 'x', ...opts, attempts: 2, delayMs: 1, fetcher: async () => { throw new Error('down'); } });
  assert.equal(down.ok, false);
  assert.equal(down.unreachable, true);
});

test('quiet only with an Amber bunker signer, and the override wins', () => {
  const mode = env => spawnSync('bash', ['-c', 'source scripts/zapstore-publish-mode.sh; chama_zapstore_mode'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout.trim();
  assert.equal(mode({ SIGN_WITH: `bunker://${'a'.repeat(64)}?relay=wss%3A%2F%2Fx` }), 'quiet');
  assert.equal(mode({ SIGN_WITH: 'browser' }), 'interactive');
  assert.equal(mode({}), 'interactive');
  assert.equal(mode({ SIGN_WITH: 'bunker://x', CHAMA_ZAPSTORE_INTERACTIVE: '1' }), 'interactive');
});

test('the release lane requires a new event when re-publishing, and logs the zsp version', () => {
  const lane = readFileSync('scripts/android-release.sh', 'utf8');
  const quiet = lane.slice(lane.indexOf('if [ "$mode" = "quiet" ]'), lane.indexOf('else', lane.indexOf('if [ "$mode" = "quiet" ]')));
  assert.match(quiet, /"\$zsp" --version/, 'quiet publish prints zsp --version first');
  assert.match(quiet, /if \[ "\$ZAPSTORE_OVERWRITE" = "1" \]; then\s+verify_args\+=\(--require-new\)/, '--overwrite-zapstore turns on --require-new');
  assert.match(quiet, /verify-zapstore-release\.mjs" "\$\{verify_args\[@\]\}"/, 'the relay check receives those arguments');
});
