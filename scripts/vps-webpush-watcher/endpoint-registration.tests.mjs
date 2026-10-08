import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
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
const wakes = path.join(temp, 'wakes.jsonl');
const subscriptions = new Map();
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
relay.on('connection', socket => socket.on('message', data => {
  const msg = JSON.parse(String(data));
  if (msg[0] === 'REQ') { subscriptions.set(socket,msg[1]); socket.send(JSON.stringify(['EOSE', msg[1]])); }
}));
const mock = pathToFileURL(path.join(temp, 'push.mjs')).href;
await writeFile(path.join(temp, 'push.mjs'), `import {appendFile} from 'node:fs/promises'; export default {
  setVapidDetails() {},
  async sendNotification(subscription, payload) {
    if (!JSON.parse(payload).test && !JSON.parse(payload).wake) throw Error('Expected opaque wake');
    if (subscription.endpoint.endsWith('/failure429')) throw Object.assign(Error('private provider body'), {statusCode:429});
    if (subscription.endpoint.endsWith('/timeout')) throw Error('private provider body');
    await appendFile(${JSON.stringify(wakes)}, payload + '\\n');
    return {statusCode:201};
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
  const communityTag = crypto.createHash('sha256').update('chama:community-wake:v1:us-blf').digest('base64url').slice(0,16);
  assert.equal(await post('register', {endpoint,tags:[communityTag]}),204);
  const before = (await readFile(wakes,'utf8')).trim().split('\n').length;
  // Move to the next signed second: freshness excludes pre-registration events.
  await new Promise(resolve=>setTimeout(resolve,1100));
  const join = finalizeEvent({kind:38101,created_at:Math.floor(Date.now()/1000),tags:[['d','test-listing'],['community','us-blf']],content:'public test JOIN'},new Uint8Array(32).fill(44));
  for (const [socket,id] of subscriptions) if (socket.readyState===1) socket.send(JSON.stringify(['EVENT',id,join]));
  let wakeRows = [];
  for (let i=0;i<20;i++) {
    wakeRows = (await readFile(wakes,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
    if (wakeRows.length>before) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(wakeRows.length,before+1,'actual watcher JOIN wakes registered creator community');
  assert.equal(wakeRows.at(-1).wake,1);
  assert.equal(wakeRows.at(-1).escrowId,undefined,'wake contains no trade details');
  assert.deepEqual(wakeRows.at(-1).tags,[communityTag]);
  assert.match(await readFile(path.join(temp,'wake-delivery.log'),'utf8'), new RegExp(`wake ${communityTag.slice(0,7)} unifiedpush sent [0-9]+ms http=201`));
  const chats = ['first','second'].map(content => finalizeEvent({kind:38108,created_at:Math.floor(Date.now()/1000),tags:[['d','test-listing'],['w',communityTag]],content},new Uint8Array(32).fill(44)));
  for (const [socket,id] of subscriptions) if (socket.readyState===1) for (const chat of chats) socket.send(JSON.stringify(['EVENT',id,chat]));
  for (let i=0;i<20;i++) {
    wakeRows = (await readFile(wakes,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
    if (wakeRows.length===before+3) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(wakeRows.length,before+3,'distinct CHATs within five seconds both wake after JOIN');
  const renewal = finalizeEvent({kind:38100,created_at:Math.floor(Date.now()/1000),tags:[['d','test-renewal'],['community','us-blf'],['renewal','test-listing']],content:'renew'},new Uint8Array(32).fill(44));
  for (const [socket,id] of subscriptions) if (socket.readyState===1) { socket.send(JSON.stringify(['EVENT',id,chats[0]])); socket.send(JSON.stringify(['EVENT',id,renewal])); }
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal((await readFile(wakes,'utf8')).trim().split('\n').length,before+3,'relay duplicates and renewal stay quiet');
  const failures = [
    {subscription:{...endpoint,endpoint:'https://ntfy.sh/failure429'},tag:'rate-limit-test',http:'429'},
    {subscription:{...endpoint,endpoint:'https://ntfy.sh/timeout'},tag:'network-test',http:'unknown'},
  ];
  for (const f of failures) assert.equal(await post('register',{endpoint:f.subscription,tags:[f.tag]}),204);
  await new Promise(resolve=>setTimeout(resolve,1100));
  for (const f of failures) {
    const event=finalizeEvent({kind:38108,created_at:Math.floor(Date.now()/1000),tags:[['d','private-test-trade'],['w',f.tag]],content:'private test body'},new Uint8Array(32).fill(44));
    for (const [socket,id] of subscriptions) if(socket.readyState===1) socket.send(JSON.stringify(['EVENT',id,event]));
  }
  let receipts='';
  for(let i=0;i<20;i++) {
    receipts=await readFile(path.join(temp,'wake-delivery.log'),'utf8');
    if(failures.every(f=>new RegExp(`wake ${f.tag.slice(0,7)} unifiedpush failed [0-9]+ms http=${f.http}`).test(receipts))) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  for(const f of failures) assert.match(receipts,new RegExp(`wake ${f.tag.slice(0,7)} unifiedpush failed [0-9]+ms http=${f.http}`));
  assert.doesNotMatch(receipts,/https:\/\/|private provider body|private-test-trade|private test body|p256dh|auth/,'receipts contain no endpoints, credentials, trade id or provider body');
  for(const f of failures) assert.equal(await post('unregister',{endpoint:f.subscription,tags:[f.tag]}),204);
  assert.equal(await post('unregister',{endpoint,tags:[communityTag]}),204);
  assert.equal(await post('register',{endpoint,tags:[]}),204);
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
  console.log('PASS actual signed JOIN community wake; endpoint-only registration, delivery, persistence, expiry, unregister and tag cap');
} finally {
  await stop();
  for (const socket of relay.clients) socket.terminate();
  await new Promise(resolve => relay.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
