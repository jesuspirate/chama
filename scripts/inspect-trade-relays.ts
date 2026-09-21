/** Which relay holds which events of one trade?
 *
 *   npx tsx scripts/inspect-trade-relays.ts sm_xxxxxxxx [wss://extra-relay]
 *
 * READ-ONLY. Opens each relay, asks for that trade's chain by its `d` tag,
 * and prints a kind-by-relay matrix. Nothing is published, no key is read,
 * no wallet is touched — this only answers "who still has what".
 *
 * Written 2026-09-20 for `sm_mtnxzb5y_zpepqcpj`, a settled trade whose buyer
 * cannot claim because replay fails with INVALID_STATE. The community relay's
 * measured response had no LOCK. This tells you whether ANY relay still does
 * — i.e. whether the sats are recoverable and from where.
 */
import WebSocket from 'ws';
import { DEFAULT_RELAYS } from '../src/escrow-engine/default-relays.js';
import { parseEscrowEvent } from '../src/escrow-engine/event-parser.js';
import { applyEvent } from '../src/escrow-engine/state-machine.js';
import { EscrowEventKind } from '../src/escrow-engine/types.js';
import type { EscrowState } from '../src/escrow-engine/types.js';

// Names come from EscrowEventKind in src/escrow-engine/types.ts. Getting these
// wrong is not cosmetic: an earlier revision labelled 38107 CHAT, and a CANCEL
// then read as idle chatter in the one report meant to explain a stuck trade.
const KIND_NAMES: Record<number, string> = {
  38100: 'CREATE', 38101: 'JOIN', 38102: 'LOCK', 38103: 'VOTE', 38104: 'RESOLVE',
  38105: 'CLAIM', 38106: 'COMPLETE', 38107: 'CANCEL', 38108: 'CHAT',
  38111: 'SUBSCRIBE', 38112: 'PERIOD_RELEASE', 38113: 'PREMIUM',
};
const KINDS = Object.keys(KIND_NAMES).map(Number);
const TIMEOUT_MS = 8_000;

const tradeId = process.argv[2];
if (!tradeId || !/^sm_[a-z0-9_]+$/i.test(tradeId)) {
  console.error('Usage: npx tsx scripts/inspect-trade-relays.ts sm_xxxxxxxx [wss://relay …]');
  process.exit(1);
}
const relays = [...new Set([...DEFAULT_RELAYS, ...process.argv.slice(3)])];

/** Raw signed events, kept so the replay pass can run the real parser. */
const rawEvents = new Map<string, unknown>();

interface Found { kind: number; id: string; created_at: number; pubkey: string; tags: string[][]; bytes: number }
type Filter = Record<string, unknown>;

/** One relay, one REQ, closed as soon as EOSE lands or the clock runs out. */
function askRelay(url: string, filter: Filter = { kinds: KINDS, '#d': [tradeId] }): Promise<{ url: string; ok: boolean; eose: boolean; events: Found[]; error?: string }> {
  return new Promise(resolve => {
    const events: Found[] = [];
    let eose = false;
    let settled = false;
    let ws: WebSocket;
    const done = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve({ url, ok, eose, events, error });
    };
    const timer = setTimeout(() => done(events.length > 0 || eose, eose ? undefined : 'timeout'), TIMEOUT_MS);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      done(false, e instanceof Error ? e.message : String(e));
      return;
    }
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'chama-inspect', filter])));
    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[2]) {
        const e = msg[2] as Found;
        if (!rawEvents.has(e.id)) rawEvents.set(e.id, msg[2]);
        events.push({
          kind: e.kind, id: e.id, created_at: e.created_at, pubkey: e.pubkey,
          tags: Array.isArray(e.tags) ? e.tags : [],
          bytes: raw.length,
        });
      } else if (msg[0] === 'EOSE') {
        eose = true;
        done(true);
      } else if (msg[0] === 'CLOSED') {
        done(false, String(msg[2] ?? 'closed by relay'));
      }
    });
    ws.on('error', (e: Error) => done(false, e.message));
    ws.on('close', () => done(events.length > 0 || eose, eose ? undefined : 'closed before EOSE'));
  });
}

const results = await Promise.all(relays.map(url => askRelay(url)));

console.log(`\nTrade ${tradeId}\n`);
const width = Math.max(...relays.map(r => r.length)) + 2;
const header = 'relay'.padEnd(width) + KINDS.map(k => KIND_NAMES[k].padEnd(9)).join('');
console.log(header);
console.log('-'.repeat(header.length));

const everywhere = new Map<number, Set<string>>();
for (const r of results) {
  const cells = KINDS.map(k => {
    const hits = r.events.filter(e => e.kind === k);
    for (const h of hits) {
      if (!everywhere.has(k)) everywhere.set(k, new Set());
      everywhere.get(k)!.add(h.id);
    }
    return (hits.length === 0 ? '·' : hits.length === 1 ? '✓' : `✓${hits.length}`).padEnd(9);
  });
  const status = r.ok ? '' : `  ← ${r.error ?? 'no answer'}`;
  console.log(r.url.padEnd(width) + cells.join('') + status);
}

console.log('\nWhat this means:');
// Never turn "nobody answered" into "nothing exists". A pool that failed to
// resolve, connect or reach EOSE has told us nothing about this trade, and a
// verdict drawn from silence is exactly the kind of confident wrong answer
// this script exists to prevent.
const answered = results.filter(r => r.ok && r.eose);
if (answered.length === 0) {
  console.log('  NO RELAY ANSWERED. This run proves nothing about the trade —');
  console.log('  only that this machine could not reach the pool:');
  for (const r of results) console.log(`    ${r.url}: ${r.error ?? 'no EOSE'}`);
  console.log('\n  Run it from a machine with direct network access and try again.\n');
  process.exit(2);
}
if (answered.length < results.length) {
  console.log(`  (${results.length - answered.length} of ${results.length} relays did not answer; absence below`);
  console.log('   means absent from the ones that DID.)');
}
const missing = KINDS.filter(k => !everywhere.has(k));
const present = KINDS.filter(k => everywhere.has(k));
console.log(`  present on at least one relay : ${present.map(k => KIND_NAMES[k]).join(', ') || 'nothing'}`);
console.log(`  found on NO relay             : ${missing.map(k => KIND_NAMES[k]).join(', ') || 'none'}`);

// A chain cannot replay without CREATE, and cannot pay out without LOCK.
const communityAnswered = answered.some(r => r.url.includes('relay.chama.community'));
if (!communityAnswered) {
  console.log('\n  note: the community relay did not answer this run. It is the durable');
  console.log('    one — any conclusion about permanence needs its reply.');
}
if (!everywhere.has(38102) && everywhere.has(38100)) {
  console.log('\n  ⚠ No LOCK anywhere in this pool. The custody event that names the');
  console.log('    escrowed notes is gone from every relay asked. Only a device that');
  console.log('    still holds it in its local cache can republish it — typically');
  console.log('    whoever locked the sats. Ask them to open the trade on a build');
  console.log('    with backfill-on-open, or use the trade timeline\'s Re-broadcast.');
}
for (const [kind, ids] of everywhere) {
  if (ids.size > 1 && kind !== 38103 && kind !== 38108) {
    console.log(`\n  note: ${ids.size} distinct ${KIND_NAMES[kind]} events exist. Duplicates are`);
    console.log('    normal for VOTE/CHAT; elsewhere they may explain a replay refusal.');
  }
}
console.log('');

// ══════════════════════════════════════════════════════════════════════════
// Pass 2 — chain-pointer audit
// ══════════════════════════════════════════════════════════════════════════
//
// A matrix says what survives. It cannot say whether a missing event ever
// existed. The chain itself can: every event carries an `e` tag naming its
// predecessor, so a surviving VOTE that points at an id no relay holds is
// positive evidence that the id was signed — and that whoever signed the
// VOTE had read it. That distinguishes "never published" from "published,
// then lost", which is the whole question.

const byId = new Map<string, Found>();
for (const r of results) for (const e of r.events) if (!byId.has(e.id)) byId.set(e.id, e);

const prevOf = (e: Found): string | undefined =>
  e.tags.find(t => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? ''))?.[1];

const chain = [...byId.values()].sort((a, b) => a.created_at - b.created_at);
if (chain.length > 0) {
  console.log('Chain as the relays hold it (oldest first):\n');
  const short = (id: string) => id.slice(0, 8);
  const when = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19);
  for (const e of chain) {
    const prev = prevOf(e);
    const link = prev ? (byId.has(prev) ? `→ ${short(prev)}` : `→ ${short(prev)} MISSING`) : '(root)';
    console.log(
      `  ${when(e.created_at)}  ${String(KIND_NAMES[e.kind] ?? e.kind).padEnd(9)}` +
      `${short(e.id)}  by ${short(e.pubkey)}  ${String(e.bytes).padStart(6)}B  ${link}`,
    );
  }
  const authors = [...new Set(chain.map(e => e.pubkey))];
  console.log(`\n  ${authors.length} distinct author(s): ${authors.map(short).join(', ')}`);
}

// Ids named by a surviving event that no relay in this pool holds.
const dangling = [...new Set(
  chain.map(prevOf).filter((id): id is string => !!id && !byId.has(id)),
)];

if (dangling.length > 0) {
  console.log(`\nAsking every relay for ${dangling.length} named-but-absent id(s) directly…`);
  const byIdResults = await Promise.all(relays.map(url => askRelay(url, { ids: dangling })));
  const recovered = new Map<string, { event: Found; url: string }>();
  for (const r of byIdResults) for (const e of r.events) if (!recovered.has(e.id)) recovered.set(e.id, { event: e, url: r.url });
  for (const id of dangling) {
    const hit = recovered.get(id);
    if (hit) {
      console.log(`  ${id.slice(0, 8)}  FOUND on ${hit.url} — ${KIND_NAMES[hit.event.kind] ?? hit.event.kind}, ${hit.event.bytes}B`);
    } else {
      const namer = chain.find(e => prevOf(e) === id);
      console.log(`  ${id.slice(0, 8)}  held by no relay that answered.`);
      if (namer) {
        console.log(`      named as predecessor by ${KIND_NAMES[namer.kind] ?? namer.kind} ${namer.id.slice(0, 8)},`);
        console.log(`      signed by ${namer.pubkey.slice(0, 8)} at ${new Date(namer.created_at * 1000).toISOString().slice(0, 19)}.`);
        console.log('      That signature is proof the id existed. Whether it ever');
        console.log('      reached a relay depends on whether its namer is a different');
        console.log('      author than whoever authored the missing event — a second');
        console.log('      author could only have read it FROM a relay.');
      }
    }
  }
}

// Does this author's LOCK survive on these relays for OTHER trades? If every
// LOCK they ever wrote is absent while their other kinds survive, the fault is
// in the LOCK path, not in this trade.
const lockAuthors = [...new Set(chain.filter(e => e.kind !== 38100).map(e => e.pubkey))];
if (!everywhere.has(38102) && lockAuthors.length > 0) {
  console.log('\nDo these authors have surviving LOCKs on ANY trade?');
  const probes = await Promise.all(
    relays.map(url => askRelay(url, { kinds: [38102], authors: lockAuthors, limit: 20 })),
  );
  for (const r of probes) {
    if (!r.ok) { console.log(`  ${r.url.padEnd(width)}  ← ${r.error ?? 'no answer'}`); continue; }
    const ds = r.events.map(e => e.tags.find(t => t[0] === 'd')?.[1] ?? '?');
    console.log(`  ${r.url.padEnd(width)}  ${r.events.length} LOCK(s)${ds.length ? `: ${ds.slice(0, 6).join(', ')}` : ''}`);
    for (const e of r.events) console.log(`      ${String(e.bytes).padStart(6)}B  ${new Date(e.created_at * 1000).toISOString().slice(0, 10)}  by ${e.pubkey.slice(0, 8)}`);
  }
  console.log('\n  A row of 0 everywhere means no LOCK this author ever signed survives —');
  console.log('  a publish-path fault. Surviving LOCKs elsewhere make it trade-specific,');
  console.log('  and their byte sizes tell you what this pool accepts.');
}
console.log('');


// ══════════════════════════════════════════════════════════════════════════
// Pass 3 — replay what the relays hold, through the real reducer
// ══════════════════════════════════════════════════════════════════════════
//
// A matrix says which events survive; the chain view says how they point at
// each other. Neither says whether the surviving chain REPLAYS, or where it
// stops. That is the question behind every "history couldn't be rebuilt"
// toast, and it is answerable here: same parser, same state machine, same
// order the client would use.
//
// VOTE and RESOLVE are per-recipient ciphertext and this script holds no
// participant key, so those are reported as UNREADABLE rather than guessed
// at. CREATE, JOIN, LOCK and CANCEL are plaintext on the wire and replay
// exactly as a client would apply them — which is enough to answer the only
// question that matters here: does the chain ever leave CREATED, and if so,
// on which event.

console.log('Replay of the relay-held chain (same parser, same reducer):\n');
let state: EscrowState | null = null;
let stopped = false;
for (const e of chain) {
  const name = String(KIND_NAMES[e.kind] ?? e.kind).padEnd(9);
  const short = e.id.slice(0, 8);
  const raw = rawEvents.get(e.id) as { content?: string } | undefined;
  if (!raw) { console.log(`  ${name}${short}  — raw event not retained`); continue; }
  const readable = e.kind === EscrowEventKind.CREATE
    || e.kind === EscrowEventKind.JOIN
    || e.kind === EscrowEventKind.LOCK
    || e.kind === EscrowEventKind.CANCEL;
  if (!readable) {
    console.log(`  ${name}${short}  UNREADABLE here (encrypted to participants) — replay stops being decisive past this point`);
    stopped = true;
    break;
  }
  const parsed = parseEscrowEvent(raw as never, String(raw.content ?? ''), true, state ? { state } : undefined);
  if (!parsed.ok) {
    const e2 = (parsed as { error: { code: string; message: string } }).error;
    console.log(`  ${name}${short}  PARSE FAILED · ${e2.code} · ${e2.message}`);
    stopped = true;
    break;
  }
  const applied = applyEvent(state, parsed.event);
  if (!applied.ok) {
    const e3 = (applied as { error: { code: string; message: string } }).error;
    console.log(`  ${name}${short}  REFUSED · ${e3.code} · ${e3.message}`);
    console.log(`      state before this event: ${state ? state.status : '(none)'}`);
    stopped = true;
    break;
  }
  state = applied.state;
  console.log(`  ${name}${short}  → ${state.status}${state.lock?.lockedAt ? `  (lockedAt ${state.lock.lockedAt})` : ''}`);
}

if (!stopped && state) {
  console.log(`\n  Replayed to ${state.status}.`);
}
if (state) {
  const locked = chain.some(e => e.kind === EscrowEventKind.LOCK);
  console.log(`\n  LOCK in the relay-held chain: ${locked ? 'yes' : 'NO'}`);
  console.log(`  lock.lockedAt after replay   : ${state.lock?.lockedAt ?? 'not set'}`);
  if (!locked) {
    console.log('\n  With no LOCK, the only transition out of CREATED is missing. Any');
    console.log('  event whose refusal names a non-CREATED state is therefore telling');
    console.log("  you that SOME device's chain has a LOCK this pool does not.");
  }
}
console.log('');
