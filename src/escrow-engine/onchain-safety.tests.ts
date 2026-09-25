import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { EscrowEventKind as Kind, EscrowStatus, Role, getEffectiveParticipantAt, type LockPayload } from './types.js';
import { deriveOnchainView } from './onchain-escrow-view.js';
import { buildOnchainEscrow } from '../bond-multisig/onchain-escrow.js';
import { deriveEscrowSigningKey, deriveCommittedBondKey, findEscrowFundingUtxos, escrowDepositWindowSafe } from '../bond-multisig/onchain-escrow-funding.js';
import { buildCommitmentBond, deriveBondSigningKey } from '../bond-multisig/commitment-bond.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { buildSettlementPsbt, coSignSettlement, finalizeSettlement, verifySettlementPsbt } from '../bond-multisig/onchain-escrow-settle.js';
import { finalRefundSettlementProof, confirmedRefundTxid, hasValidSettlementSignatureForRole } from './onchain-settlement-transport.js';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b = deriveEscrowSigningKey(WORDS, 'buyer', { network: SIGNET });
const s = deriveEscrowSigningKey(WORDS, 'seller', { network: SIGNET });
const a = deriveBondSigningKey(WORDS, { network: SIGNET, index: 7 });
const fixture = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000);
const termsEvent = () => fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER,
  joinedAt: Date.now() / 1000, fundingTerms: fixture.terms });
const attacker = btc.utils.pubSchnorr(new Uint8Array(32).fill(14));
const attackTree = buildOnchainEscrow({ ...fixture.escrow.params, buyerXonly: attacker });
// The attack is spendable by one person: the seller controls both COOP keys.
const attackPsbt = buildSettlementPsbt({ escrow: attackTree,
  utxos: [{ txid: 'aa'.repeat(32), index: 0, amountSats: 100000n }],
  destination: btc.p2tr(s.xonly, undefined, SIGNET).address!, feeSats: 1000n });
const attackSigned = coSignSettlement(coSignSettlement(attackPsbt, new Uint8Array(32).fill(14)), s.priv);
assert(hasValidSettlementSignatureForRole(attackSigned, attackTree, Role.BUYER, 'coop'));
assert(hasValidSettlementSignatureForRole(attackSigned, attackTree, Role.SELLER, 'coop'));
assert(finalizeSettlement([attackSigned], { escrow: attackTree, leaf: 'coop' }).length > 0);
const badTerms = { ...fixture.terms, buyerXonly: bytesToHex(attacker), address: attackTree.address };
const e = termsEvent();
assert.equal(applyEvent(fixture.state, { ...e, payload: { ...e.payload, fundingTerms: badTerms } } as typeof e).ok, false);
// Real arbiter signature is required even though the funder signs the outer JOIN.
for (const bond of [
  { ...fixture.terms.arbiterBond, sig: '00'.repeat(64) },
  { ...fixture.terms.arbiterBond, content: fixture.terms.arbiterBond.content.replace(bytesToHex(a.xonly), bytesToHex(attacker)) },
]) {
  const event = termsEvent();
  assert.equal(applyEvent(fixture.state, { ...event, payload: { ...event.payload, fundingTerms: { ...fixture.terms, arbiterBond: bond } } } as typeof event).ok, false);
}
fixture.apply(e);
const committedAddress = fixture.state.onchainFundingTerms!.address;
const reloaded = replayEventChain(fixture.events);
assert(reloaded.ok);
assert.equal(reloaded.state.onchainFundingTerms!.address, committedAddress);
assert.equal(getEffectiveParticipantAt(reloaded.state, Role.BUYER, 9999999999), fixture.pks.buyer);
assert.equal(applyEvent(fixture.state, termsEvent()).ok, false, 'refund height cannot be recommitted');
const lockTerms = { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 0 };
const lock = fixture.event(Kind.LOCK, 'seller', { type: 'escrow:lock', notesHash: '', shares: [],
  onchain: lockTerms, buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter,
  sellerReceivesMsats: 100000000, arbiterFeeMsats: 0, lockedAt: Date.now() / 1000 });
for (const mutation of [badTerms, { buyerXonly: bytesToHex(attacker) }, { sellerXonly: bytesToHex(attacker) },
  { arbiterXonly: bytesToHex(attacker) }, { address: attackTree.address }, { refundLockUntil: 2000001 },
  { network: 'mainnet' }, { disputeCsvBlocks: 0 }, { funder: 'buyer' }, { amountSats: '99999' }]) {
  const bad = { ...lock, payload: { ...lock.payload, onchain: { ...lockTerms, ...mutation } } } as typeof lock;
  assert.equal(applyEvent(fixture.state, bad).ok, false, `reject ${JSON.stringify(mutation)}`);
}
// Sign the malicious wire payload with the real funder identity and pass it
// through the normal signature-verifying parser. It is authentic, but its
// counterparty key authorization is invalid; the reducer must still reject it.
const signedMaliciousLock = fixture.event(Kind.LOCK, 'seller', {
  ...lock.payload, onchain: { ...lockTerms, ...badTerms },
} as LockPayload);
assert.equal(applyEvent(fixture.state, signedMaliciousLock).ok, false, 'authentic funder signature cannot authorize the counterparty key');
fixture.apply(lock);
assert.equal(fixture.state.status, EscrowStatus.LOCKED);
for (const status of [EscrowStatus.LOCKED, EscrowStatus.APPROVED]) {
  const view = deriveOnchainView({ state: { ...fixture.state, status }, viewerRole: Role.BUYER, recomputedAddress: committedAddress });
  assert.equal(view.stage, 'checking-deposit'); assert.equal(view.canSettle, false);
}
assert.equal(deriveOnchainView({ state: fixture.state, viewerRole: Role.BUYER, recomputedAddress: committedAddress, depositVerified: true }).stage, 'locked');

const bond = buildCommitmentBond(a.xonly, 2100000, SIGNET);
const records = [{ bondId: 'bond-7', bond, keyIndex: 7, amountSats: 100000n, phase: 'locked' as const, createdAt: 1 }];
const recovered = deriveCommittedBondKey(WORDS, bytesToHex(a.xonly), records, SIGNET);
assert.deepEqual(recovered.xonly, a.xonly);
assert.throws(() => deriveCommittedBondKey(WORDS, bytesToHex(a.xonly), [], SIGNET));
assert.throws(() => deriveCommittedBondKey(WORDS, bytesToHex(a.xonly), [{ ...records[0], keyIndex: 0 }], SIGNET));
assert.notDeepEqual(deriveEscrowSigningKey(WORDS, fixture.state.id, { network: SIGNET }).xonly, recovered.xonly);

const utxos = [{ txid: lockTerms.fundingTxid, index: 0, amountSats: 100000n }];
const buyerDestination = btc.p2tr(b.xonly, undefined, SIGNET).address!;
const funderDestination = btc.p2tr(s.xonly, undefined, SIGNET).address!;
for (const leaf of ['coop', 'dispute', 'refund'] as const) {
  const destination = leaf === 'refund' ? funderDestination : buyerDestination;
  const expectation = { escrow: fixture.escrow, utxos, destination, maxFeeSats: 3000n, network: SIGNET, leaf, tipHeight: 2000000 };
  const psbt = buildSettlementPsbt({ ...expectation, feeSats: 1000n, fundingHeight: 100,
    ...(leaf === 'refund' ? { lockTime: 2000000 } : {}) });
  assert(verifySettlementPsbt(psbt, expectation).ok);
  const privs = leaf === 'coop' ? [b.priv, s.priv] : leaf === 'dispute' ? [b.priv, recovered.priv] : [s.priv];
  const signed = privs.reduce((p, key) => coSignSettlement(p, key), psbt);
  for (const role of leaf === 'coop' ? [Role.BUYER, Role.SELLER] : leaf === 'dispute' ? [Role.BUYER, Role.ARBITER] : [Role.SELLER]) {
    assert(hasValidSettlementSignatureForRole(signed, fixture.escrow, role as Role.BUYER | Role.SELLER | Role.ARBITER, leaf));
  }
  const raw = finalizeSettlement([signed], { escrow: fixture.escrow, leaf });
  const tx = btc.Transaction.fromRaw(Buffer.from(raw, 'hex'), { allowUnknown: true, allowUnknownOutputs: true });
  const witness = tx.getInput(0).finalScriptWitness!;
  const leafScript = fixture.escrow.leaves[leaf];
  assert.equal(bytesToHex(witness.at(-2)!), bytesToHex(leafScript));
  const msg = tx.preimageWitnessV1(0, [fixture.escrow.script], 0, [100000n], undefined, leafScript, 0xc0);
  const signingKeys = leaf === 'refund' ? [s.xonly] : leaf === 'coop' ? [s.xonly, b.xonly] : [a.xonly, s.xonly, b.xonly];
  signingKeys.forEach((key, i) => { if (witness[i].length) assert(schnorr.verify(witness[i], msg, key), `${leaf} actual witness signature`); });
  if (leaf === 'refund') {
    assert(!verifySettlementPsbt(psbt, { ...expectation, tipHeight: 1999999 }).ok);
    assert.throws(() => buildSettlementPsbt({ ...expectation, feeSats: 1000n, lockTime: 2000000, tipHeight: 1999999 }));
    assert(!verifySettlementPsbt(psbt, { ...expectation, destination: buyerDestination }).ok);
    for (const mutation of ['sequence', 'lockTime', 'amount'] as const) {
      const bad = btc.Transaction.fromPSBT(base64.decode(psbt), { allowUnknown: true, allowUnknownOutputs: true });
      if (mutation === 'sequence') bad.updateInput(0, { sequence: 0xffffffff });
      if (mutation === 'amount') bad.updateOutput(0, { amount: 90000n });
      const changed = mutation === 'lockTime'
        ? buildSettlementPsbt({ escrow: fixture.escrow, utxos, destination, feeSats: 1000n, lockTime: 1 })
        : base64.encode(bad.toPSBT());
      assert(!verifySettlementPsbt(changed, expectation).ok, mutation);
    }
    const journal = fixture.event(Kind.SETTLEMENT, 'seller', { type: 'escrow:settlement', leaf, role: Role.SELLER, final: true, psbt: signed });
    const refundProof = finalRefundSettlementProof(journal as any, fixture.terms);
    assert(refundProof);
    assert.equal(await confirmedRefundTxid(fixture.terms, [journal as any], async () => ({ spent: false })), null);
    assert.equal(await confirmedRefundTxid(fixture.terms, [journal as any], async path => path.includes('/outspend/')
      ? { spent: true, txid: refundProof.txid } : { status: { confirmed: false } }), null);
    assert.equal(await confirmedRefundTxid(fixture.terms, [journal as any], async path => path.includes('/outspend/')
      ? { spent: true, txid: 'ff'.repeat(32) } : { status: { confirmed: true } }), null);
    assert.equal(await confirmedRefundTxid(fixture.terms, [journal as any], async path => path.includes('/outspend/')
      ? { spent: true, txid: refundProof.txid } : { status: { confirmed: true } }), refundProof.txid);
    const wrong = { ...journal, payload: { ...journal.payload, psbt: coSignSettlement(psbt, b.priv) } };
    assert.equal(finalRefundSettlementProof(wrong as any, fixture.terms), null);
    fixture.apply(journal);
    const complete = fixture.event(Kind.COMPLETE, 'seller', { type: 'escrow:complete', completedAt: Date.now() / 1000 }, [['settlement', journal.raw.id]]);
    fixture.apply(complete);
    assert(fixture.state.onchainRefundClaimed);
    assert.equal(fixture.state.status, EscrowStatus.LOCKED, "An unbroadcast future refund must not terminate the counterparty’s voting rights");
  }
}

// Recipient verification refuses fabricated values, scripts, confirmations and spent deposits.
const script = bytesToHex(fixture.escrow.script);
let output = { scriptpubkey: script, value: 100000 };
let status = { confirmed: true, block_height: 100 };
let spent = false;
const fetchJson = async (path: string) => path === '/blocks/tip/height' ? 100
  : path.endsWith('/utxo') ? [{ txid: lockTerms.fundingTxid, vout: 0, value: 100000 }]
  : path.includes('/outspend/') ? { spent } : { vout: [output], status };
const read = () => findEscrowFundingUtxos({ address: committedAddress, network: SIGNET, fetchJson, minConfs: 1 });
assert.equal((await read()).length, 1);
output = { scriptpubkey: script, value: 99999 }; assert.equal((await read()).length, 0);
output = { scriptpubkey: '00', value: 100000 }; assert.equal((await read()).length, 0);
output = { scriptpubkey: script, value: 100000 };
status = { confirmed: false, block_height: 100 }; assert.equal((await read()).length, 0);
status = { confirmed: true, block_height: 101 }; assert.equal((await read()).length, 0);
status = { confirmed: true, block_height: 100 }; spent = true; assert.equal((await read()).length, 0);
console.log('on-chain safety: signed commitments, substitution rejection, recipient checks, bond-key dispute and CLTV refund passed');

assert(escrowDepositWindowSafe({ refundLockUntil: 5320, fundingHeights: [1001], tipHeight: 1001, awaitingCounterpayment: true }));
assert(!escrowDepositWindowSafe({ refundLockUntil: 1002, fundingHeights: [1001], tipHeight: 1001, awaitingCounterpayment: true }), 'malicious immediate-refund terms cannot enable counterpayment');
assert(!escrowDepositWindowSafe({ refundLockUntil: 5320, fundingHeights: [1001], tipHeight: 5200, awaitingCounterpayment: true }), 'counterpayment requires a remaining dispute window');
