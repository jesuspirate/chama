import assert from 'node:assert/strict';
import {
  esploraFetcher, EsploraUnavailableError, ExplorerCoolingDownError, explorerCoolingUntil,
  noteExplorerFailure, noteExplorerSuccess, resetExplorerCooldowns, retryAfterMs,
} from './fund-watcher.js';
import { findCorroboratedEscrowFunding } from './escrow-chain-reads.js';
import { MAINNET } from './multisig.js';
import { createSharedChainRead } from './shared-chain-read.js';

// Retry-After: seconds or a date, clamped to 1-15 minutes; junk is ignored.
assert.equal(retryAfterMs('120'), 120_000);
assert.equal(retryAfterMs('5'), 60_000);
assert.equal(retryAfterMs('86400'), 15 * 60_000);
assert.equal(retryAfterMs(new Date(1_000_000 + 300_000).toUTCString(), 1_000_000), 300_000);
assert.equal(retryAfterMs(null), null);
assert.equal(retryAfterMs('soon'), null);
assert.equal(retryAfterMs('0'), 60_000, 'Retry-After: 0 still rests the floor, not the 5-minute default');

// Three failures in a row rest a host for a minute, then two, capped at 15.
resetExplorerCooldowns();
noteExplorerFailure('a.example', { nowMs: 0 });
noteExplorerFailure('a.example', { nowMs: 0 });
assert.equal(explorerCoolingUntil('a.example', 0), 0, 'two failures are not a streak');
noteExplorerFailure('a.example', { nowMs: 0 });
assert.equal(explorerCoolingUntil('a.example', 0), 60_000);
for (let i = 0; i < 3; i++) noteExplorerFailure('a.example', { nowMs: 60_000 });
assert.equal(explorerCoolingUntil('a.example', 60_000), 180_000, 'second rest doubles');
noteExplorerSuccess('a.example');
assert.equal(explorerCoolingUntil('a.example', 60_000), 0, 'an answer clears the record');
noteExplorerFailure('b.example', { nowMs: 0, rateLimitedForMs: null });
assert.equal(explorerCoolingUntil('b.example', 0), 5 * 60_000, 'a bare 429 rests the host five minutes');

const originalFetch = globalThis.fetch, originalWarn = console.warn;
console.warn = () => {};
const asked: string[] = [];
try {
  // A 429 from the shipped explorer: the hedge still answers this read, and
  // the next read never asks the limited host.
  resetExplorerCooldowns();
  globalThis.fetch = (async (url: string) => {
    const host = new URL(String(url)).host; asked.push(host);
    if (host === 'mempool.space') return new Response('slow down', { status: 429, headers: { 'retry-after': '600' } });
    return new Response('42', { status: 200 });
  }) as typeof fetch;
  assert.equal(await esploraFetcher('https://mempool.space/api', { network: MAINNET })('/blocks/tip/height'), 42);
  assert.ok(explorerCoolingUntil('mempool.space') > Date.now() + 590_000);
  asked.length = 0;
  assert.equal(await esploraFetcher('https://mempool.space/api', { network: MAINNET })('/blocks/tip/height'), 42);
  assert.ok(!asked.includes('mempool.space'), 'a resting host is not asked');

  // A user's own explorer that rate-limits fails fast as "couldn't check",
  // without a request, and never falls back to public hosts.
  resetExplorerCooldowns();
  globalThis.fetch = (async (url: string) => { asked.push(new URL(String(url)).host); return new Response('', { status: 429 }); }) as typeof fetch;
  await assert.rejects(esploraFetcher('https://own.example/api', { network: MAINNET })('/blocks/tip/height'), EsploraUnavailableError);
  asked.length = 0;
  await assert.rejects(esploraFetcher('https://own.example/api', { network: MAINNET })('/blocks/tip/height'),
    (e: unknown) => e instanceof EsploraUnavailableError && e.causes[0] instanceof ExplorerCoolingDownError);
  assert.equal(asked.length, 0, 'no request while resting');

  // The caller's own deadline (a slow link) never counts against a host,
  // and a 5xx does.
  resetExplorerCooldowns();
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise((_r, reject) => {
    asked.push(new URL(String(url)).host);
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;
  for (let i = 0; i < 4; i++) {
    const overall = new AbortController();
    const read = esploraFetcher('https://own.example/api', { network: MAINNET, signal: overall.signal, timeoutMs: 60_000 })('/blocks/tip/height');
    overall.abort(new DOMException('liveness deadline', 'TimeoutError'));
    await assert.rejects(read);
  }
  assert.equal(explorerCoolingUntil('own.example'), 0, 'overall deadlines do not rest the host');
  globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
  for (let i = 0; i < 3; i++) await assert.rejects(esploraFetcher('https://own.example/api', { network: MAINNET })('/blocks/tip/height'));
  assert.ok(explorerCoolingUntil('own.example') > 0, 'three 5xx answers rest the host');

  // M7 stays: with two of three explorers resting, a deposit read refuses
  // rather than trusting the one host left.
  resetExplorerCooldowns();
  noteExplorerFailure('mempool.space', { rateLimitedForMs: 600_000 });
  noteExplorerFailure('blockstream.info', { rateLimitedForMs: 600_000 });
  asked.length = 0;
  globalThis.fetch = (async (url: string) => { asked.push(new URL(String(url)).host); return new Response('[]', { status: 200 }); }) as typeof fetch;
  await assert.rejects(findCorroboratedEscrowFunding({ address: 'bc1qexampleexampleexampleexampleexample0000', network: MAINNET, minConfs: 2 }), EsploraUnavailableError);
  assert.ok(asked.length > 0 && asked.every(h => h === 'mempool.emzy.de'), 'only the rested-out host is asked');
} finally {
  globalThis.fetch = originalFetch; console.warn = originalWarn; resetExplorerCooldowns();
}

// Review of #96: an answer from a request sent before a rest never lifts it,
// and one burst of parallel failures is one incident, not fifteen.
resetExplorerCooldowns();
noteExplorerFailure('c.example', { nowMs: 1_000, startedMs: 500, rateLimitedForMs: 600_000 });
noteExplorerSuccess('c.example', 400);
assert.equal(explorerCoolingUntil('c.example', 1_000), 601_000, 'an in-flight success does not erase a 429 rest');
for (let i = 0; i < 15; i++) noteExplorerFailure('d.example', { nowMs: 2_000, startedMs: 1_000 });
assert.equal(explorerCoolingUntil('d.example', 2_000), 62_000, 'fifteen parallel timeouts rest the host one minute');
noteExplorerSuccess('d.example', 70_000);
assert.equal(explorerCoolingUntil('d.example', 70_000), 0, 'an answer sent after the rest clears it');
for (let i = 0; i < 3; i++) noteExplorerFailure('d.example', { nowMs: 80_000 });
assert.equal(explorerCoolingUntil('d.example', 80_000), 140_000, 'after a real answer the next rest starts at a minute again');
resetExplorerCooldowns();

// Shared reads: callers share one read in flight and its answer for the
// window; a failure is never kept.
{
  let t = 0, reads = 0;
  const shared = createSharedChainRead<number>({ ttlMs: 15_000, now: () => t });
  let release!: (v: number) => void;
  const first = shared('trade', () => { reads++; return new Promise<number>(r => { release = r; }); });
  const second = shared('trade', async () => { reads++; return 99; });
  release(7);
  assert.deepEqual([await first, await second], [7, 7]);
  assert.equal(reads, 1, 'one read for two callers');
  t = 14_999; assert.equal(await shared('trade', async () => { reads++; return 8; }), 7);
  t = 15_000; assert.equal(await shared('trade', async () => { reads++; return 8; }), 8);
  assert.equal(reads, 2);
  assert.equal(await shared('other', async () => { reads++; return 1; }), 1, 'keys are separate');
  await assert.rejects(shared('fails', async () => { throw new Error('explorer down'); }));
  assert.equal(await shared('fails', async () => 5), 5, 'a failure is asked again at once');
  t = 100_000; await shared('late', async () => 2);
  assert.equal(await shared('trade', async () => { reads++; return 9; }), 9, 'expired answers are dropped');
}
console.log('PASS explorer cooldown: Retry-After, failure streak backoff, 429 skips the host, own explorer rests without public fallback, deposit quorum still fails closed, shared reads, in-flight success keeps a rest, one burst is one rest, overall deadlines and 5xx');
