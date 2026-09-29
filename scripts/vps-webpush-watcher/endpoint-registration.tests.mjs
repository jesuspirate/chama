import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

// Run the actual watcher HTTP server and disk store. Only outbound push is
// mocked; no phone, production credentials or external relay is contacted.
const temp = await mkdtemp(path.join(tmpdir(), 'chama-endpoint-test-'));
const store = path.join(temp, 'registrations.json');
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
relay.on('connection', socket => socket.on('message', data => {
  const msg = JSON.parse(String(data));
  if (msg[0] === 'REQ') socket.send(JSON.stringify(['EOSE', msg[1]]));
}));
const mock = pathToFileURL(path.join(temp, 'push.mjs')).href;
await writeFile(path.join(temp, 'push.mjs'), `export default {
  setVapidDetails() {},
  async sendNotification(subscription, payload) {
    if (!JSON.parse(payload).test) throw Error('Expected test wake');
  }
};`);
await writeFile(path.join(temp, 'loader.mjs'), `export async function resolve(specifier, context, next) {
  return specifier === 'web-push' ? { url: ${JSON.stringify(mock)}, shortCircuit: true } : next(specifier, context);
}`);
await writeFile(path.join(temp, 'bootstrap.mjs'), `import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`);
let child, base;
async function start() {
  child = spawn(process.execPath, ['--import', path.join(temp, 'bootstrap.mjs'), fileURLToPath(new URL('./watcher.mjs', import.meta.url))], {
    env: { ...process.env, VAPID_PUBLIC: 'test', VAPID_PRIVATE: 'test', VAPID_SUBJECT: 'mailto:test@example.invalid',
      FCM_SERVICE_ACCOUNT_FILE: '', CHAMA_RELAYS: `ws://127.0.0.1:${relay.address().port}`,
      BIND: '127.0.0.1', PORT: '0', STORE_PATH: store },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Watcher did not listen')), 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Watcher exited ${code}: ${output}`)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
const endpoint = { transport: 'unifiedpush', endpoint: 'https://ntfy.sh/chama-test-endpoint-only',
  keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
async function post(route, body) {
  const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await response.text();
  return response.status;
}
const testBody = { endpoint, nonce: 'a'.repeat(32) };
try {
  await start();
  assert.equal(await post('test', testBody), 404, 'unregistered endpoint is not reachable');
  assert.equal(await post('register', { endpoint, tags: [] }), 204, 'fresh enable accepts an empty tag array');
  let health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.endpoints, 1);
  assert.equal(health.tags, 0);
  assert.equal(await post('test', testBody), 204, 'endpoint-only registration reaches mocked transport');
  assert.equal(await post('test', testBody), 429, 'delivery test cooldown is retained');
  const saved = JSON.parse(await readFile(store, 'utf8'));
  assert.deepEqual(saved.rows[0].tags, []);
  await stop();
  await start();
  assert.equal(await post('test', testBody), 204, 'endpoint-only registration survives restart');
  for (const tags of [null, {}, [''], [7], ['x'.repeat(65)], Array(201).fill('tag')]) {
    assert.equal(await post('register', { endpoint, tags }), 400, 'malformed or oversized tags rejected');
  }
  assert.equal(await post('register', { endpoint, tags: Array.from({ length: 200 }, (_, i) => `tag-${i}`) }), 204, '200-tag cap still accepted');
  assert.equal(await post('register', { endpoint, tags: [] }), 204, 'empty refresh preserves existing watches');
  health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.tags, 200);
  assert.equal(await post('unregister', { endpoint, tags: Array.from({ length: 200 }, (_, i) => `tag-${i}`) }), 204);
  assert.equal(await post('test', testBody), 404, 'unregister removes the endpoint when its last watch is removed');
  assert.equal(await post('register', { endpoint, tags: [] }), 204);
  assert.equal(await post('unregister', { endpoint, tags: [] }), 204);
  assert.equal(await post('test', testBody), 404, 'empty unregister removes an endpoint-only registration');
  await stop();
  saved.rows[0].expiresAt = Date.now() - 1;
  await writeFile(store, JSON.stringify(saved));
  await start();
  assert.equal(await post('test', testBody), 404, 'expired endpoint-only records are not restored');
  console.log('PASS endpoint-only HTTP registration, delivery, persistence, expiry, unregister and tag cap');
} finally {
  await stop();
  for (const socket of relay.clients) socket.terminate();
  await new Promise(resolve => relay.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
