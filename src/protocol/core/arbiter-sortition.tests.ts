// Arbiter sortition (selection v2, library only).
//
//   npx tsx src/protocol/core/arbiter-sortition.tests.ts           run (part of npm test)
//   npx tsx src/protocol/core/arbiter-sortition.tests.ts --write   regenerate the vectors
//
// The vectors in docs/conformance/arbiter-sortition-vectors.json pin the exact
// seed, draw and panel for fixed inputs, so another implementation (a future
// Fedimint module, a second client) can prove it seats the same arbiter.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ARBITER_SORTITION_VERSION,
  SORTITION_DEFAULTS,
  deriveSortitionSeed,
  drawSortitionArbiter,
  drawSortitionPanel,
  eligibleSortitionArbiters,
  sortitionNonceCommitment,
  verifySortitionNonce,
  type SortitionCandidate,
  type SortitionTrade,
} from './arbiter-sortition.js';
import { pickArbiterFromPool } from './arbiter-pick.js';

const h = (label: string) => bytesToHex(sha256(utf8ToBytes(label)));
const keys = Array.from({ length: 12 }, (_, i) => h(`arbiter-${i}`));
const BUYER = h('buyer');
const SELLER = h('seller');
const SELLER_NONCE = h('seller-nonce');
const BUYER_NONCE = h('buyer-nonce');

const candidate = (pubkey: string, over: Partial<SortitionCandidate> = {}): SortitionCandidate => ({
  pubkey, bondSats: 300_000, openExposureSats: 0, bondMaturityHeight: 900_000, ...over,
});
const trade: SortitionTrade = { valueSats: 100_000, buyer: BUYER, seller: SELLER, mustCoverHeight: 880_000 };

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok ${name}`); };

console.log('arbiter sortition');

test('commit-reveal: a nonce opens its own commitment and nothing else', () => {
  const c = sortitionNonceCommitment(SELLER_NONCE);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.notEqual(c, SELLER_NONCE, 'commitment is not the nonce');
  assert.equal(verifySortitionNonce(c, SELLER_NONCE), true);
  assert.equal(verifySortitionNonce(c.toUpperCase(), SELLER_NONCE.toUpperCase()), true, 'case-insensitive');
  assert.equal(verifySortitionNonce(c, BUYER_NONCE), false);
  assert.equal(verifySortitionNonce(c, 'not hex'), false, 'bad input is false, not a throw');
  assert.equal(verifySortitionNonce('', SELLER_NONCE), false);
});

test('seed: deterministic, and every input changes it', () => {
  const base = { sellerNonce: SELLER_NONCE, buyerNonce: BUYER_NONCE, escrowId: 'esc-1', round: 0 };
  const s = bytesToHex(deriveSortitionSeed(base));
  assert.equal(bytesToHex(deriveSortitionSeed({ ...base })), s);
  assert.equal(bytesToHex(deriveSortitionSeed({ ...base, sellerNonce: SELLER_NONCE.toUpperCase() })), s);
  const variants = [
    { ...base, sellerNonce: h('other') },
    { ...base, buyerNonce: h('other') },
    { ...base, escrowId: 'esc-2' },
    { ...base, round: 1 },
    { ...base, sellerNonce: BUYER_NONCE, buyerNonce: SELLER_NONCE },
  ].map((v) => bytesToHex(deriveSortitionSeed(v)));
  assert.equal(new Set([s, ...variants]).size, 6, 'six distinct seeds');
  assert.throws(() => deriveSortitionSeed({ ...base, escrowId: '' }));
  assert.throws(() => deriveSortitionSeed({ ...base, round: -1 }));
  assert.throws(() => deriveSortitionSeed({ ...base, buyerNonce: 'abc' }));
});

test('eligibility: bond multiple, capacity, maturity, parties, exclusions, earlier seats', () => {
  const cands = [
    candidate(keys[0], { score: 0.9 }),
    candidate(keys[1], { bondSats: 299_999 }), // under 3 × value
    candidate(keys[2], { openExposureSats: 200_001 }), // 200_001 + 100_000 > 300_000
    candidate(keys[3], { bondMaturityHeight: 880_000 }), // matures at the cover height, not after
    candidate(keys[4]),
    candidate(keys[5]),
    candidate(BUYER),
    candidate(SELLER),
    candidate(keys[6], { feeBps: 600 }),
    candidate(keys[7], { score: 0.2 }),
    candidate('not-a-key'),
    candidate(keys[8], { bondSats: 1.5 }),
  ];
  const eligible = eligibleSortitionArbiters(cands, { ...trade, previouslySeated: [keys[5]] }, {
    exclude: [keys[4].toUpperCase()], maxFeeBps: 500, minScore: 0.5,
  });
  assert.deepEqual(eligible, [keys[0]]);
  // Exactly at the limits is eligible.
  assert.deepEqual(eligibleSortitionArbiters([candidate(keys[0], { bondSats: 300_000, openExposureSats: 200_000, bondMaturityHeight: 880_001 })], trade), [keys[0]]);
  // With a minimum score, an unscored arbiter is out; with none, everyone is in.
  assert.deepEqual(eligibleSortitionArbiters([candidate(keys[0])], trade, { minScore: 0.5 }), []);
  // Without the optional filters the fee and score candidates come back.
  assert.deepEqual(eligibleSortitionArbiters([candidate(keys[6], { feeBps: 600 }), candidate(keys[7], { score: 0.2 })], trade), [keys[6], keys[7]].sort());
  assert.throws(() => eligibleSortitionArbiters(cands, trade, { exclude: keys.slice(0, SORTITION_DEFAULTS.maxExclude + 1) }));
  assert.throws(() => eligibleSortitionArbiters(cands, { ...trade, valueSats: 0 }));
});

test('eligibility: order- and case-independent; duplicates keep the largest bond', () => {
  const cands = keys.slice(0, 6).map((k) => candidate(k));
  const a = eligibleSortitionArbiters(cands, trade);
  const b = eligibleSortitionArbiters([...cands].reverse().map((c) => ({ ...c, pubkey: c.pubkey.toUpperCase() })), trade);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort(), 'sorted');
  const dup = eligibleSortitionArbiters([candidate(keys[0], { bondSats: 10 }), candidate(keys[0])], trade);
  assert.deepEqual(dup, [keys[0]]);
});

test('draw: refuses below the minimum pool; otherwise seats a pool member', () => {
  const seed = deriveSortitionSeed({ sellerNonce: SELLER_NONCE, buyerNonce: BUYER_NONCE, escrowId: 'esc-1', round: 0 });
  assert.deepEqual(drawSortitionArbiter(keys.slice(0, 4), seed), { ok: false, reason: 'POOL_TOO_SMALL', poolSize: 4, minPool: 5 });
  assert.deepEqual(drawSortitionArbiter([], seed, 0), { ok: false, reason: 'POOL_TOO_SMALL', poolSize: 0, minPool: 0 });
  const d = drawSortitionArbiter(keys.slice(0, 5), seed);
  assert.equal(d.ok, true);
  if (d.ok) assert.ok(keys.slice(0, 5).includes(d.arbiter));
  // Input order and case never change the seat.
  const e = drawSortitionArbiter(keys.slice(0, 5).reverse().map((k) => k.toUpperCase()), seed);
  assert.deepEqual(e, d);
  assert.throws(() => drawSortitionArbiter(keys, new Uint8Array(31)));
});

test('draw: roughly uniform over the pool across many trades', () => {
  const pool = keys.slice(0, 6);
  const counts = new Map(pool.map((k) => [k, 0]));
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const seed = deriveSortitionSeed({ sellerNonce: SELLER_NONCE, buyerNonce: BUYER_NONCE, escrowId: `esc-${i}`, round: 0 });
    const d = drawSortitionArbiter(pool, seed);
    assert.ok(d.ok);
    if (d.ok) counts.set(d.arbiter, (counts.get(d.arbiter) ?? 0) + 1);
  }
  for (const [, n] of counts) assert.ok(Math.abs(n - N / 6) < N / 6 * 0.12, `count ${n} within 12% of ${N / 6}`);
});

test('the creator can no longer steer the seat by choosing the escrow id', () => {
  // Legacy: two ids with the same char codes in a different order always pick the same seat.
  assert.equal(pickArbiterFromPool(keys.slice(0, 6), 'ab-12'), pickArbiterFromPool(keys.slice(0, 6), 'ba-21'));
  // v2: the same two ids are independent draws, and without the buyer's nonce
  // the creator cannot compute which seat any id will give.
  const seat = (id: string, buyerNonce: string) => {
    const d = drawSortitionArbiter(keys.slice(0, 6), deriveSortitionSeed({ sellerNonce: SELLER_NONCE, buyerNonce, escrowId: id, round: 0 }));
    return d.ok ? d.arbiter : '';
  };
  const seatsForOneId = new Set(Array.from({ length: 40 }, (_, i) => seat('ab-12', h(`buyer-nonce-${i}`))));
  assert.ok(seatsForOneId.size >= 5, 'one id lands on most seats depending on the buyer');
});

test('panel: distinct, skips earlier rulers, refuses when too few remain', () => {
  const pool = keys.slice(0, 10);
  const seed = deriveSortitionSeed({ sellerNonce: SELLER_NONCE, buyerNonce: BUYER_NONCE, escrowId: 'esc-1', round: 1 });
  const p3 = drawSortitionPanel(pool, seed, 3, [keys[0]]);
  assert.ok(p3);
  assert.equal(p3!.length, 3);
  assert.equal(new Set(p3).size, 3);
  assert.ok(!p3!.includes(keys[0]));
  // Ten in the pool, four skipped: six left, so a panel of seven refuses and six fills.
  const skipped = [keys[0], ...p3!];
  assert.equal(drawSortitionPanel(pool, seed, 7, skipped), null);
  const p6 = drawSortitionPanel(pool, seed, 6, skipped);
  assert.deepEqual([...p6!].sort(), pool.filter((k) => !skipped.includes(k)).sort(), 'the six remaining');
  assert.deepEqual(drawSortitionPanel([...pool].reverse(), seed, 3, [keys[0].toUpperCase()]), p3, 'order/case independent');
  assert.throws(() => drawSortitionPanel(pool, seed, 0));
});

// ── Conformance vectors ──────────────────────────────────────────────────────

function buildVectors() {
  const pool = keys.slice(0, 9);
  const cases = [
    { name: 'first-draw', escrowId: 'esc-vector-1', round: 0 },
    { name: 'redraw-round-1', escrowId: 'esc-vector-1', round: 1 },
    { name: 'other-escrow', escrowId: 'esc-vector-2', round: 0 },
    { name: 'unicode-escrow-id', escrowId: 'chama-ñ-✓', round: 0 },
  ];
  return {
    format: 'chama-arbiter-sortition-vectors',
    formatVersion: 1,
    selectionVersion: ARBITER_SORTITION_VERSION,
    source: 'src/protocol/core/arbiter-sortition.tests.ts',
    sellerNonce: SELLER_NONCE,
    sellerCommitment: sortitionNonceCommitment(SELLER_NONCE),
    buyerNonce: BUYER_NONCE,
    eligible: [...pool].sort(),
    vectors: cases.map((c) => {
      const seed = deriveSortitionSeed({ sellerNonce: SELLER_NONCE, buyerNonce: BUYER_NONCE, escrowId: c.escrowId, round: c.round });
      const draw = drawSortitionArbiter(pool, seed);
      return {
        name: c.name,
        escrowId: c.escrowId,
        round: c.round,
        seed: bytesToHex(seed),
        arbiter: draw.ok ? draw.arbiter : null,
        index: draw.ok ? draw.index : null,
        panel3: drawSortitionPanel(pool, seed, 3, draw.ok ? [draw.arbiter] : []),
      };
    }),
  };
}

const vectorsPath = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'docs/conformance/arbiter-sortition-vectors.json');
const expected = JSON.stringify(buildVectors(), null, 2) + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(vectorsPath, expected);
  console.log(`wrote ${vectorsPath}`);
} else {
  test('conformance vectors are current', () => {
    assert.equal(readFileSync(vectorsPath, 'utf8'), expected, 'regenerate with --write and review the diff');
  });
}

console.log(`PASS arbiter sortition (${passed} checks)`);
