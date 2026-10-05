/** node --import tsx scripts/replay-conflict-fixture.ts [--base-url URL] [--dry-run] */
import WebSocket from 'ws';
import { DEFAULT_RELAYS } from '../src/escrow-engine/default-relays.js';
import { makeReplayConflictFixture } from './lib/replay-conflict-fixture.js';

let baseUrl = 'http://localhost:3000/', dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--base-url' && process.argv[i + 1]) baseUrl = process.argv[++i];
  else throw new Error(`Unknown/missing option: ${arg}. Only --base-url URL and --dry-run are supported; existing trade ids and keys are never accepted.`);
}
const fixture = makeReplayConflictFixture(baseUrl);
const events = [fixture.genuine, fixture.control, fixture.forged];

async function publishAndReadBack(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Set(events.map(e => e.id));
    const seen = new Set<string>();
    let done = false;
    const timer = setTimeout(() => finish(new Error('publish/readback timed out')), 18000);
    function finish(error?: Error) {
      if (done) return; done = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(url);
    }
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('closed before verification')));
    socket.on('open', () => socket.send(JSON.stringify(['EVENT', events[0]])));
    socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (message[0] === 'OK' && pending.has(message[1])) {
          if (message[2] !== true) return finish(new Error(`rejected ${message[1]}: ${String(message[3]).slice(0, 200)}`));
          pending.delete(message[1]);
          const next = events.find(e => pending.has(e.id));
          if (next) socket.send(JSON.stringify(['EVENT', next]));
          else socket.send(JSON.stringify(['REQ', 'fixture-readback', { ids: events.map(e => e.id) }]));
        } else if (message[0] === 'EVENT' && message[1] === 'fixture-readback') {
          const event = message[2];
          const expected = events.find(e => e.id === event?.id);
          if (expected && event.sig === expected.sig && event.content === expected.content
            && event.pubkey === expected.pubkey && event.created_at === expected.created_at
            && event.kind === expected.kind && JSON.stringify(event.tags) === JSON.stringify(expected.tags)) seen.add(event.id);
        } else if (message[0] === 'EOSE' && message[1] === 'fixture-readback') {
          finish(seen.size === events.length ? undefined : new Error(`only ${seen.size}/${events.length} events read back`));
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

console.log('Fresh, read-only listings. No wallet, funding, JOIN, LOCK or votes. Expires in 24 hours.');
console.log('Trade id:', fixture.tradeId);
console.log('Creator:', fixture.creator);
console.log('Plain link (fresh reader must refuse):', fixture.plainLink);
console.log('Creator link (genuine 1-sat listing):', fixture.creatorLink);
console.log('Unambiguous control:', fixture.controlLink);
console.log('CREATE ids:', fixture.genuine.id, fixture.forged.id);
if (dryRun) console.log('DRY RUN — no events published.');
else {
  const results = await Promise.allSettled(DEFAULT_RELAYS.map(publishAndReadBack));
  const verified = results.flatMap((r, i) => {
    if (r.status === 'fulfilled') { console.log('Verified:', r.value); return [r.value]; }
    console.error('Not verified:', DEFAULT_RELAYS[i], r.reason?.message ?? String(r.reason)); return [];
  });
  if (!verified.includes(DEFAULT_RELAYS[0]) || verified.length < 3) {
    console.error('INCOMPLETE fixture: fewer than three relays including Chama verified every event. Do not treat a missing conflict as a pass. Rerun creates a new throwaway id.');
    process.exitCode = 1;
  } else console.log('READY — all three events acknowledged and read back on Chama plus at least two other relays. Open the plain link FIRST in a fresh reader, then the creator link.');
}
