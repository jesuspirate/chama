/** Diagnostic only. npx tsx scripts/probe-escrow-retention.ts [wss://relay...]
 * Ephemeral author; no wallet/key input. Deliberately NOT a valid money chain.
 * Production clients ignore its unknown payload type and diagnostic-only tags.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { DEFAULT_RELAYS } from '../src/escrow-engine/default-relays.js';

const secret = generateSecretKey();
const d = `chama-retention-probe-${randomUUID()}`;
const now = Math.floor(Date.now() / 1000) - 20;
const events = [];
for (let kind = 38100; kind <= 38108; kind++) {
  events.push(finalizeEvent({ kind, created_at: now + kind - 38100,
    tags: [['d', d], ['t', 'chama:retention-probe'], ...(events.length ? [['e', events.at(-1)!.id, '', 'reply']] : [])],
    content: JSON.stringify({ type: 'chama:retention-probe', synthetic: true, sequence: events.length }),
  }, secret));
}
const older = events.find(e => e.kind === 38103)!;
const newer = finalizeEvent({ kind: older.kind, created_at: now + 10,
  tags: older.tags, content: JSON.stringify({ type: 'chama:retention-probe', synthetic: true, collision: true }),
}, secret);
events.push(newer);

async function probe(url: string) {
  const ws = new WebSocket(url);
  const acknowledgements: Record<string, unknown> = {};
  const returned = new Map<string, typeof older>();
  let eose = false;
  const result = await new Promise<Record<string, unknown>>(resolve => {
    let queryStarted = false;
    const finish = (error?: string) => {
      clearTimeout(deadline); clearTimeout(queryTimer);
      ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate();
      const accepted = (id: string) => (acknowledgements[id] as any)?.accepted === true;
      const verdict = !eose || !accepted(older.id) || !accepted(newer.id) ? 'INCONCLUSIVE'
        : returned.has(newer.id) && !returned.has(older.id) ? 'REPLACEMENT_OBSERVED'
        : returned.has(newer.id) && returned.has(older.id) ? 'BOTH_RETAINED'
        : 'ACCEPTED_BUT_NOT_RETURNED';
      resolve({ relay: url, verdict, eose, error, acknowledgements,
        returned: [...returned.values()].map(e => ({ id: e.id, kind: e.kind, created_at: e.created_at })),
        missing: events.filter(e => !returned.has(e.id)).map(e => ({ id: e.id, kind: e.kind })) });
    };
    const query = () => {
      if (queryStarted || ws.readyState !== WebSocket.OPEN) return;
      queryStarted = true;
      ws.send(JSON.stringify(['REQ', d, { authors: [older.pubkey], '#d': [d], kinds: events.map(e => e.kind) }]));
    };
    const deadline = setTimeout(() => finish('timeout'), 20000);
    let queryTimer: ReturnType<typeof setTimeout>;
    ws.on('open', () => {
      for (const event of events) ws.send(JSON.stringify(['EVENT', event]));
      queryTimer = setTimeout(query, 6000);
    });
    ws.on('message', bytes => {
      let m: any; try { m = JSON.parse(bytes.toString()); } catch { return; }
      if (m[0] === 'OK') {
        acknowledgements[m[1]] = { accepted: m[2], message: m[3] };
        if (Object.keys(acknowledgements).length === events.length) query();
      }
      if (m[0] === 'EVENT' && m[1] === d && verifyEvent(m[2]) && m[2].pubkey === older.pubkey && m[2].tags.some((t: string[]) => t[0] === 'd' && t[1] === d)) returned.set(m[2].id, m[2]);
      if (m[0] === 'EOSE' && m[1] === d) { eose = true; finish(); }
    });
    ws.on('error', error => finish(error.message));
    ws.on('close', () => finish('closed before EOSE'));
  });
  return result;
}
console.log(JSON.stringify({ probe: d, author: older.pubkey, older: older.id, newer: newer.id,
  results: await Promise.all((process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RELAYS).map(probe)),
}, null, 2));
