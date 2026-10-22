// 6.4.31: every remaining place Chama holds sats reaches Home as data, and a
// place Chama couldn't read is reported as unchecked, never as empty.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readHeldLeftovers, retryingClaims, returningFediFundings, reclaimedBondLeftovers,
  readOnchainPayoutLeftovers, type LeftoverReaders } from './held-leftovers.js';
import { scanOnchainPayout, type OnchainPayoutCandidate } from '../bond-multisig/onchain-payout-wallet.js';
import { MAX_DRAIN_ATTEMPTS, type PendingRedemption } from '../fedimint/pending-redemptions.js';
import type { CommitmentRecord } from '../bond-multisig/commitment-store.js';
import { SIGNET } from '../bond-multisig/multisig.js';

let cases = 0;
const claim = (over: Partial<PendingRedemption>): PendingRedemption => ({ escrowId: 'e', oobNotes: 'n', notesHash: 'h',
  amountMsats: 5_000_000, createdAt: 1, attempts: 1, ...over });

// Only claims still on automatic retry; every other claim state has its own card.
{
  const listed = retryingClaims([
    claim({ escrowId: 'retrying' }),
    claim({ escrowId: 'credited', creditedAt: 2 }),
    claim({ escrowId: 'poisoned', lastError: 'x', poisonedAt: 2 }),
    claim({ escrowId: 'exhausted', attempts: MAX_DRAIN_ATTEMPTS }),
    claim({ escrowId: 'unresolved', unresolvedCredit: true }),
    claim({ escrowId: 'archived', resolvedAt: 3, resolution: 'user-dismissed' }),
    claim({ escrowId: 'dead', probeVerdict: 'dead' }),
    claim({ escrowId: 'consumed', probeVerdict: 'consumed-uncredited' }),
    // The legacy outgoing export: the drain skips it and the export card shows it.
    claim({ escrowId: 'manual-fund-ecash' }),
    // Consumed by text only (older releases): the stranded card shows it.
    claim({ escrowId: 'consumed-text', lastError: 'Mint notes were consumed by the federation but no credit' }),
  ]);
  assert.deepEqual(listed.map(e => e.kind === 'claim-retrying' && e.escrowId), ['retrying']);
  assert.equal(listed[0].holder, 'federation'); assert.equal(listed[0].until, 'automatic-retry');
  cases++;
}

// Fedi fundings: all listed, including failing ones; outside Fedi they wait for Fedi.
{
  const entries = [{ escrowId: 'f1', oobNotes: 'n', amountMsats: 2_000_000, createdAt: 1, attempts: 0 },
    { escrowId: 'f2', oobNotes: 'n', amountMsats: 3_000_000, createdAt: 1, attempts: 12, lastError: 'boom' }];
  assert.deepEqual(returningFediFundings(entries, true).map(e => e.until), ['automatic-retry', 'automatic-retry']);
  const outside = returningFediFundings(entries, false);
  assert.deepEqual(outside.map(e => e.until), ['next-fedi-session', 'next-fedi-session']);
  assert.equal(outside[1].kind === 'fedi-funding-returning' && outside[1].lastError, 'boom');
  cases++;
}

// Reclaimed bonds: at the bond key until sent out; credited ones until confirmed; landed ones drop.
{
  const base = { bond: {} as any, amountSats: 10_000n, keyIndex: 0, createdAt: 1 } as const;
  const recs = [
    { ...base, bondId: 'locked', phase: 'locked' },
    { ...base, bondId: 'at-key', phase: 'reclaimed', reclaimTxid: 't1',
      utxos: [{ txid: 'u', index: 0, amountSats: 9_000n }],
      reclaimDestination: { requested: 'chama', actual: 'bond-key', address: 'bc1pkey' } },
    { ...base, bondId: 'confirming', phase: 'reclaimed', reclaimTxid: 't2', creditTxid: 'c2' },
    { ...base, bondId: 'landed', phase: 'reclaimed', reclaimTxid: 't3', creditTxid: 'c3', creditConfirmedAt: 5 },
    { ...base, bondId: 'to-wallet', phase: 'reclaimed', reclaimTxid: 't4',
      reclaimDestination: { requested: 'external', actual: 'external', address: 'bc1qmine' } },
  ] as unknown as CommitmentRecord[];
  const out = reclaimedBondLeftovers(recs);
  assert.deepEqual(out.map(e => [e.kind, e.id, e.holder, e.until]), [
    ['bond-key-waiting', 'bond-key:at-key', 'your-key', 'you-send-it-out'],
    ['bond-credit-confirming', 'bond-credit:confirming', 'federation', 'confirmations'],
  ]);
  assert.equal(out[0].kind === 'bond-key-waiting' && out[0].amountSats, 9_000n, 'what was swept, not the nominal bond');
  cases++;
}

// On-chain payouts: one failing explorer read marks that trade unchecked and never hides the others.
{
  const cand = (escrowId: string): OnchainPayoutCandidate => ({ escrowId, role: 'buyer' as any, address: `a-${escrowId}`, xonly: '00', network: SIGNET });
  const read = await readOnchainPayoutLeftovers([cand('paid'), cand('down'), cand('empty')], async c => {
    if (c.escrowId === 'down') throw new Error('explorer 502');
    return { ...c, utxos: [], hasUnconfirmed: c.escrowId === 'paid', balanceSats: c.escrowId === 'paid' ? 4_200n : 0n };
  });
  assert.deepEqual(read.entries.map(e => e.kind === 'onchain-payout' && [e.escrowId, e.amountSats, e.unconfirmed]), [['paid', 4_200n, true]]);
  assert.deepEqual(read.unchecked, [{ source: 'onchain-payouts', escrowId: 'down', reason: 'explorer 502' }]);
  cases++;
}

// A store that can't be read is named, and the other stores still show.
{
  const readers: LeftoverReaders = {
    claims: () => { throw new Error('Pending-redemption stash is unreadable'); },
    fediFundings: () => [{ escrowId: 'f', oobNotes: 'n', amountMsats: 1_000_000, createdAt: 1, attempts: 0 }],
    inFedi: false,
    bonds: () => { throw new Error('bond store unreadable'); },
    payoutCandidates: () => { throw new Error('Reconnect to check your on-chain payouts.'); },
    scanPayout: async () => { throw new Error('unused'); },
  };
  const read = await readHeldLeftovers(readers);
  assert.deepEqual(read.entries.map(e => e.kind), ['fedi-funding-returning']);
  assert.deepEqual(read.unchecked.map(u => u.source), ['claims', 'bonds', 'onchain-payouts']);
  cases++;
}

// The explorer itself: an unreadable answer throws instead of reading as zero.
{
  const candidate: OnchainPayoutCandidate = { escrowId: 'x', role: 'seller' as any,
    address: 'tb1p', xonly: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', network: SIGNET };
  await assert.rejects(scanOnchainPayout(candidate, async () => ({ error: 'rate limited' })), /unreadable/);
  await assert.rejects(scanOnchainPayout(candidate, async (path: string) => path.includes('/utxo')
    ? [{ txid: 'ab'.repeat(32), vout: 0, value: 1000, status: { confirmed: true } }] : { error: 'gone' }), /unreadable/);
  const empty = await scanOnchainPayout(candidate, async () => []);
  assert.equal(empty.balanceSats, 0n, 'an answered empty list is a real zero');
  cases++;
}

// Strict store readers throw on a corrupt stash or a storage error; the old
// readers keep reading those as empty, as before.
{
  const values = new Map<string, string>();
  let broken = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => { if (broken) throw new Error('SecurityError'); return values.get(k) ?? null; },
    setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k),
    clear: () => values.clear(), key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; },
  } });
  const { setLocalStorageUserScope, setStrictScopedStorageItem } = await import('../storage/user-scope.js');
  const { listPendingRedemptions, listPendingRedemptionsStrict, PENDING_REDEMPTIONS_KEY } = await import('../fedimint/pending-redemptions.js');
  const { listPendingFundings, listPendingFundingsStrict, PENDING_FUNDINGS_KEY } = await import('../fedimint/pending-fundings.js');
  const warn = console.warn; console.warn = () => {};
  try {
    setLocalStorageUserScope('ab'.repeat(32));
    // A good stash reads the same either way.
    setStrictScopedStorageItem(PENDING_FUNDINGS_KEY, JSON.stringify({ f: { escrowId: 'f', oobNotes: 'n', amountMsats: 1, createdAt: 1, attempts: 0 } }));
    assert.equal(listPendingFundingsStrict().length, 1);
    assert.equal(listPendingRedemptionsStrict().length, 0, 'nothing stored is a real empty');
    // Corrupt JSON.
    setStrictScopedStorageItem(PENDING_REDEMPTIONS_KEY, '{not json');
    setStrictScopedStorageItem(PENDING_FUNDINGS_KEY, '{not json');
    assert.throws(() => listPendingRedemptionsStrict());
    assert.throws(() => listPendingFundingsStrict());
    assert.equal(listPendingRedemptions().length, 0);
    assert.equal(listPendingFundings().length, 0);
    // Storage itself refusing to answer.
    values.clear(); broken = true;
    assert.throws(() => listPendingRedemptionsStrict(), /SecurityError/);
    assert.throws(() => listPendingFundingsStrict(), /SecurityError/);
    assert.equal(listPendingRedemptions().length, 0);
    broken = false;
    // An array stash is not a stash.
    setStrictScopedStorageItem(PENDING_REDEMPTIONS_KEY, '[]');
    assert.throws(() => listPendingRedemptionsStrict());
    // Without a signed-in identity, the only key is someone else's quarantined one.
    setLocalStorageUserScope(null);
    assert.throws(() => listPendingFundingsStrict(), /Sign in/);
    // Bonds: a corrupt store or a bond that no longer parses throws; the lenient list reads none.
    setLocalStorageUserScope('ab'.repeat(32));
    const { listCommitmentBonds, listCommitmentBondsStrict, COMMITMENT_STORAGE_KEY } = await import('../bond-multisig/commitment-store.js');
    assert.deepEqual(listCommitmentBondsStrict(), { records: [], unreadable: 0 }, 'no bonds stored is a real empty');
    setStrictScopedStorageItem(COMMITMENT_STORAGE_KEY, '{not json');
    assert.throws(() => listCommitmentBondsStrict());
    setStrictScopedStorageItem(COMMITMENT_STORAGE_KEY, JSON.stringify({ b: { bondId: 'b', ownerXonly: 'zz', lockUntil: 1, network: 'mainnet', address: 'bc1p', amountSats: '1', phase: 'reclaimed', createdAt: 1, updatedAt: 1 } }));
    assert.deepEqual(listCommitmentBondsStrict(), { records: [], unreadable: 1 });
    // Readers name the bad record and still list the good ones.
    const mixed = await readHeldLeftovers({ claims: () => [], fediFundings: () => [], inFedi: true, payoutCandidates: () => [],
      scanPayout: async () => { throw new Error('unused'); },
      bonds: () => ({ records: [{ bondId: 'ok', bond: {} as any, amountSats: 5n, phase: 'reclaimed', reclaimTxid: 't', creditTxid: 'c', createdAt: 1 } as any], unreadable: 2 }) });
    assert.deepEqual(mixed.entries.map(e => e.id), ['bond-credit:ok']);
    assert.deepEqual(mixed.unchecked, [{ source: 'bonds', reason: "2 saved bonds couldn't be read." }]);
    assert.equal(listCommitmentBonds().length, 0);
    broken = true;
    assert.throws(() => listCommitmentBondsStrict(), /SecurityError/);
  } finally { console.warn = warn; broken = false; setLocalStorageUserScope(null); }
  cases++;
}

// Wiring: Home's reader uses the strict stores and scans with unconfirmed outputs included.
{
  const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
  const i = hook.indexOf('const readHeldLeftovers = useCallback');
  const body = hook.slice(i, hook.indexOf('}, []);', i));
  assert.ok(i > 0);
  assert.ok(body.includes('claims: listPendingRedemptionsStrict'));
  assert.ok(body.includes('fediFundings: listPendingFundingsStrict'));
  assert.ok(body.includes('bonds: listCommitmentBondsStrict'));
  assert.ok(/scanOnchainPayout\(candidate,[\s\S]*true\)/.test(body));
  assert.ok(hook.includes('    readHeldLeftovers,\n'), 'exposed as an action');
  cases++;
}
console.log(`held leftovers: ${cases} cases passed`);
