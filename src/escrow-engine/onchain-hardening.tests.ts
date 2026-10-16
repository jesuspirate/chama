// M6, M7, H7 (money-path review, Oct 2026): on-chain fee cap, corroborated
// funding reads, and a dust deposit can no longer freeze an agreed payout.
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { deriveEscrowSigningKey } from '../bond-multisig/onchain-escrow-funding.js';
import { deriveBondSigningKey } from '../bond-multisig/commitment-bond.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import { EscrowStatus, isLateOnchainDeposit } from './types.js';
import {
  MAINNET_HEDGE_EXPLORERS, MAX_SETTLEMENT_FEE_RATE, capSettlementFeeRate, esploraRequiredFeeRate,
} from '../bond-multisig/fund-watcher.js';
import {
  ESCROW_FUNDING_MIN_CONFS, disputeSpendSet, escrowFundingExplorers, escrowFundingMinConfs, findCorroboratedEscrowFunding,
} from '../bond-multisig/escrow-chain-reads.js';
import {
  buildSettlementPsbt, coSignSettlement, finalizeSettlement, settlementFeeCeilingSats, verifySettlementPsbt,
} from '../bond-multisig/onchain-escrow-settle.js';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b = deriveEscrowSigningKey(WORDS, 'buyer', { network: SIGNET });
const s = deriveEscrowSigningKey(WORDS, 'seller', { network: SIGNET });
const a = deriveBondSigningKey(WORDS, { network: SIGNET, index: 7 });
const fixture = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000);

// ── M6: a wrong fee answer cannot burn the escrow ───────────────────────────
assert.equal(await esploraRequiredFeeRate(async () => ({ hourFee: 7 })), 7n);
assert.equal(await esploraRequiredFeeRate(async () => ({ hourFee: 5000 })), MAX_SETTLEMENT_FEE_RATE,
  'an absurd explorer fee answer is capped');
assert.equal(MAX_SETTLEMENT_FEE_RATE, 100n, 'same cap as bond reclaims');
assert.equal(capSettlementFeeRate(300n), 100n, 'the sweep fee bump is capped too');
assert.equal(capSettlementFeeRate(42n), 42n);
{
  // The co-signer's ceiling follows the capped rate, so an inflated-fee PSBT
  // built from a lying explorer is refused by an honest verifier.
  const funding = { txid: '11'.repeat(32), index: 0, amountSats: 1_000_000n };
  const destination = btc.p2tr(b.xonly, undefined, SIGNET).address!;
  const ceiling = settlementFeeCeilingSats('coop', await esploraRequiredFeeRate(async () => ({ hourFee: 9999 })), 1);
  const greedy = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [funding], destination, feeSats: ceiling + 1n });
  assert(!verifySettlementPsbt(greedy, { escrow: fixture.escrow, utxos: [funding], destination, maxFeeSats: ceiling, network: SIGNET }).ok);
}

// ── H7: a dust deposit after the proposal cannot freeze the payout ──────────
{
  const funding = { txid: '11'.repeat(32), index: 0, amountSats: 100_000n };
  const dust = { txid: '22'.repeat(32), index: 1, amountSats: 330n };
  const destination = btc.p2tr(b.xonly, undefined, SIGNET).address!;
  const committed = { committedOutpoint: { txid: funding.txid, index: funding.index }, minInputSats: 100_000n };
  // Proposal built before the dust landed.
  const proposal = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [funding], destination, feeSats: 1000n });
  const afterDust = { escrow: fixture.escrow, utxos: [funding, dust], destination, maxFeeSats: 3000n, network: SIGNET, leaf: 'coop' as const };

  assert(!verifySettlementPsbt(proposal, afterDust).ok, 'old rule: the dust deposit froze the proposal');
  assert(verifySettlementPsbt(proposal, { ...afterDust, ...committed }).ok,
    'with the committed outpoint, the agreed proposal still verifies after a dust deposit');
  const signed = coSignSettlement(coSignSettlement(proposal, b.priv), s.priv);
  assert(verifySettlementPsbt(signed, { ...afterDust, ...committed }).ok);
  assert(finalizeSettlement([signed], { escrow: fixture.escrow, leaf: 'coop' }).length > 0, 'and finalizes');

  // A fresh proposal that sweeps the dust as well is fine too.
  const sweepAll = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [funding, dust], destination, feeSats: 1000n });
  assert(verifySettlementPsbt(sweepAll, { ...afterDust, ...committed }).ok);

  // What the subset rule must still refuse.
  const dustOnly = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [{ ...dust, amountSats: 100_000n }], destination, feeSats: 1000n });
  assert(!verifySettlementPsbt(dustOnly, { ...afterDust, utxos: [funding, { ...dust, amountSats: 100_000n }], ...committed }).ok,
    'a settlement that skips the committed funding output is refused');
  const split = { txid: '33'.repeat(32), index: 0, amountSats: 60_000n };
  const firstHalf = { ...funding, amountSats: 40_000n };
  const partial = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [firstHalf], destination, feeSats: 1000n });
  assert(!verifySettlementPsbt(partial, { ...afterDust, utxos: [firstHalf, split], ...committed }).ok,
    'leaving part of the committed amount behind is refused');
  assert(!verifySettlementPsbt(proposal, { ...afterDust, committedOutpoint: committed.committedOutpoint }).ok,
    'a committed outpoint without the committed amount fails closed');
  const stranger = { txid: '44'.repeat(32), index: 0, amountSats: 5_000n };
  const smuggled = buildSettlementPsbt({ escrow: fixture.escrow, utxos: [funding, stranger], destination, feeSats: 1000n });
  assert(!verifySettlementPsbt(smuggled, { ...afterDust, ...committed }).ok, 'unknown inputs are still refused');
}

// ── H7, dispute leaf: dust re-sent every few blocks cannot keep the appeal
// window shut until the funder's refund matures ─────────────────────────────
{
  const csv = 144;
  const committed = { utxo: { txid: '11'.repeat(32), index: 0, amountSats: 100_000n }, blockHeight: 1000, fundingScript: fixture.escrow.script };
  const earlyDust = { utxo: { txid: '22'.repeat(32), index: 0, amountSats: 330n }, blockHeight: 1010, fundingScript: fixture.escrow.script };
  const freshDust = { utxo: { txid: '33'.repeat(32), index: 0, amountSats: 330n }, blockHeight: 1150, fundingScript: fixture.escrow.script };
  const found = [committed, earlyDust, freshDust];
  const ref = { txid: committed.utxo.txid, index: committed.utxo.index };
  const tipHeight = 1000 + csv - 1; // committed deposit has exactly csv confirmations

  const open = disputeSpendSet({ found, committed: ref, tipHeight, csvBlocks: csv });
  assert(open.open, 'the appeal window runs from the committed deposit, not the newest dust');
  assert.deepEqual(open.spend.map(f => f.utxo.txid), [committed.utxo.txid], 'immature deposits are left behind');
  assert.equal(open.fundingHeight, 1000);

  const later = disputeSpendSet({ found, committed: ref, tipHeight: 1010 + csv - 1, csvBlocks: csv });
  assert(later.open && later.spend.length === 2, 'a deposit whose own wait has passed is swept with it');

  const shut = disputeSpendSet({ found, committed: ref, tipHeight: tipHeight - 1, csvBlocks: csv });
  assert(!shut.open && shut.blocksRemaining > 0, 'the committed deposit still has to wait out the window');
  assert.throws(() => disputeSpendSet({ found: [earlyDust, freshDust], committed: ref, tipHeight, csvBlocks: csv }),
    /committed funding output/);
  assert.throws(() => disputeSpendSet({ found: [{ ...committed, blockHeight: undefined }], committed: ref, tipHeight, csvBlocks: csv }),
    /funding height is unknown/);

  // The resulting dispute spend verifies against an expectation that still
  // knows every output, and builds with the committed deposit's maturity.
  const destination = btc.p2tr(b.xonly, undefined, SIGNET).address!;
  const csvEscrow = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000).escrow;
  assert((csvEscrow.params.disputeCsvBlocks ?? 0) > 0, 'fixture has a dispute wait');
  {
    const window = disputeSpendSet({ found, committed: ref, tipHeight: 1000 + csvEscrow.params.disputeCsvBlocks! - 1, csvBlocks: csvEscrow.params.disputeCsvBlocks! });
    assert(window.open);
    const psbt = buildSettlementPsbt({ escrow: csvEscrow, utxos: window.spend.map(f => f.utxo), destination, feeSats: 1000n,
      leaf: 'dispute', fundingHeight: window.fundingHeight, tipHeight: 1000 + csvEscrow.params.disputeCsvBlocks! - 1 });
    assert(verifySettlementPsbt(psbt, { escrow: csvEscrow, utxos: found.map(f => f.utxo), destination, maxFeeSats: 5000n,
      network: SIGNET, leaf: 'dispute', committedOutpoint: ref, minInputSats: 100_000n }).ok,
      'a dispute payout that leaves the fresh dust behind is accepted by the co-signer');
  }
}

// M7 and the join hold: the seat question uses when the deposit first
// appeared, so waiting for a second confirmation cannot lapse the trade.
{
  const deadlineAt = 10_000;
  const state = { status: EscrowStatus.CREATED, onchainFundingTerms: {}, expiresAt: deadlineAt,
    lock: { lockedAt: null }, joinHolds: {}, participants: {} } as never;
  assert(!isLateOnchainDeposit(state, { deposit: 'confirmed', depositSeenAt: deadlineAt - 60 }, deadlineAt + 900),
    'a deposit that confirmed before the deadline still locks after it');
  assert(isLateOnchainDeposit(state, { deposit: 'confirmed', depositSeenAt: deadlineAt + 60 }, deadlineAt + 900));
}

// ── M7: funding needs two explorers to agree, and two confirmations ─────────
assert.equal(escrowFundingMinConfs(MAINNET), ESCROW_FUNDING_MIN_CONFS.mainnet);
assert.equal(escrowFundingMinConfs(MAINNET), 2);
assert.equal(escrowFundingMinConfs(SIGNET), 1);
assert.deepEqual(escrowFundingExplorers(MAINNET, 'https://mempool.space/api'), [...MAINNET_HEDGE_EXPLORERS]);
assert.deepEqual(escrowFundingExplorers(MAINNET, 'https://my-node.example/api/'), ['https://my-node.example/api'],
  "the user's own explorer stays the single authority");
{
  const address = fixture.escrow.address;
  const script = bytesToHex(fixture.escrow.script);
  type View = { value: number; height: number; tip: number; down?: boolean; utxos?: boolean };
  const explorer = (v: View) => async (path: string) => {
    if (v.down) throw new Error('offline');
    if (path === '/blocks/tip/height') return v.tip;
    if (path.endsWith('/utxo')) return v.utxos === false ? [] : [{ txid: '11'.repeat(32), vout: 0, value: v.value }];
    if (path.includes('/outspend/')) return { spent: false };
    return { vout: [{ scriptpubkey: script, value: v.value }], status: { confirmed: true, block_height: v.height } };
  };
  const read = async (views: Record<string, View>, minConfs = 2) => findCorroboratedEscrowFunding({
    address, network: SIGNET, minConfs, bases: Object.keys(views), fetcherFor: base => explorer(views[base]!),
  });
  const honest = { value: 100_000, height: 100, tip: 101 };
  assert.equal((await read({ A: honest, B: honest, C: honest })).length, 1);
  assert.equal((await read({ A: honest, B: honest, C: { ...honest, down: true } })).length, 1, 'one explorer down is fine');
  assert.equal((await read({ A: honest, B: { ...honest, utxos: false }, C: { ...honest, utxos: false } })).length, 0,
    'one explorer claiming a deposit the others do not see is not enough');
  assert.equal((await read({ A: honest, B: { ...honest, value: 1_000_000 }, C: { ...honest, value: 2_000_000 } })).length, 0,
    'explorers disagreeing on the amount count nothing');
  await assert.rejects(read({ A: honest, B: { ...honest, down: true }, C: { ...honest, down: true } }),
    'a single surviving explorer is never trusted alone');
  assert.equal((await read({ A: { ...honest, tip: 100 }, B: { ...honest, tip: 100 }, C: { ...honest, tip: 100 } })).length, 0,
    'one confirmation is not enough for an escrow deposit');
  assert.equal((await read({ A: honest }, 2)).length, 1, 'a single configured explorer is read directly');
}

console.log('PASS M6/M7/H7: settlement fees capped, funding corroborated at two confirmations, dust cannot freeze a payout');
