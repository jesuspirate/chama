// ─────────────────────────────────────────────────────────────────────────────
// Deterministic tests for recovery signer/finalizer shared primitives.
//
// Tests do not hit the network. verifyLiveFunding is mocked so the suite stays
// offline and deterministic.
// ─────────────────────────────────────────────────────────────────────────────
import { strict as assert } from "node:assert";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { buildSettlementPsbt, finalizeSettlement } from "../src/bond-multisig/onchain-escrow-settle.js";
import { deriveEscrowSigningKey } from "../src/bond-multisig/onchain-escrow-funding.js";
import { SIGNET } from "../src/bond-multisig/multisig.js";
import { buildRecoveryEscrow, type RecoveryInputs, type RecoveryVerification } from "./build-recovery-psbt.js";
import {
  buildInputsFromSigner,
  assertRoleKeyMatch,
  buildRecoveryExpectation,
  checkRecoveryPsbt,
  combineAndFinalizeRecoveryPsbt,
  deriveRecoverySigningKey,
  hasSignerSignature,
  hiddenPrompt,
  hiddenPromptWithStreams,
  hiddenPromptNoEcho,
  parseFinalizerArgs,
  parseSignerArgs,
  readPsbt,
  signRecoveryPsbt,
  verifyRecoveryFunding,
  zeroKeyBuffers,
  type SignerInputs,
  type FinalizerInputs,
} from "./recovery-signer-shared.js";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BUYER_WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SELLER_WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const ESCROW_ID = "sm_msl0k7rp_gyuf2w0i";
const REFUND_HEIGHT = 3332614;
const FUND_TXID = "0b4cbd09e3e7f1e092b7f5aee4a08fb96eefa98d14add5d96d172c49bdf82f0a";
const FUND_VOUT = 0;
const FUND_VALUE = 100_000n;

const BUYER_KEY = "619d0d50ee286510fa8504a3eb69a0da52376a506dc06fe7bddaed625d597c7c";
const SELLER_KEY = "0cf8c8903249d2a41e4299eec2a7cb570179dbc9f0f2e3804627d3e6e074051d";
const ARBITER_KEY = "d6fb707bb00057e7ba3f65000a4a3499bd107105bc62742162bd02f6e3a41615";

const EXPECTED_ADDRESS = "tb1pxm57qln85r6eqn2h8777auknxkm84jr7hzv3dkdg4002dmz0d3lsee5v83";

const recoveryDestination = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_recovery_destination`, { network: SIGNET });
const RECOVERY_ADDRESS = btc.Address(SIGNET).encode(
  btc.OutScript.decode(btc.p2tr(bytesToHex(recoveryDestination.xonly)).script),
);

function baseSignerInputs(overrides?: Partial<SignerInputs>): SignerInputs {
  return {
    role: "buyer",
    parentId: ESCROW_ID,
    expectedAddress: EXPECTED_ADDRESS,
    buyerKey: BUYER_KEY,
    sellerKey: SELLER_KEY,
    arbiterKey: ARBITER_KEY,
    funder: "seller",
    network: "signet",
    refundLockUntil: REFUND_HEIGHT,
    txid: FUND_TXID,
    vout: FUND_VOUT,
    amountSats: FUND_VALUE,
    destination: RECOVERY_ADDRESS,
    maxFeeSats: 500n,
    expectedFeeSats: 162n,
    psbtFile: undefined,
    ...overrides,
  };
}

function baseFinalizerInputs(overrides?: Partial<FinalizerInputs>): FinalizerInputs {
  return {
    parentId: ESCROW_ID,
    expectedAddress: EXPECTED_ADDRESS,
    buyerKey: BUYER_KEY,
    sellerKey: SELLER_KEY,
    arbiterKey: ARBITER_KEY,
    funder: "seller",
    network: "signet",
    refundLockUntil: REFUND_HEIGHT,
    txid: FUND_TXID,
    vout: FUND_VOUT,
    amountSats: FUND_VALUE,
    destination: RECOVERY_ADDRESS,
    maxFeeSats: 500n,
    expectedFeeSats: 162n,
    psbtFiles: ["-"],
    ...overrides,
  };
}

function finalizerExpectation(inputs: SignerInputs | FinalizerInputs) {
  return {
    buyerKey: inputs.buyerKey,
    sellerKey: inputs.sellerKey,
    amountSats: inputs.amountSats,
    destination: inputs.destination,
    maxFeeSats: inputs.maxFeeSats,
    expectedFeeSats: inputs.expectedFeeSats,
  };
}

async function fakeVerifyFunding(inputs: SignerInputs | FinalizerInputs): Promise<RecoveryVerification> {
  const recoveryInputs: RecoveryInputs = {
    parentId: inputs.parentId,
    expectedAddress: inputs.expectedAddress,
    buyerKey: inputs.buyerKey,
    sellerKey: inputs.sellerKey,
    arbiterKey: inputs.arbiterKey,
    funder: inputs.funder,
    network: inputs.network,
    refundLockUntil: inputs.refundLockUntil,
    txid: inputs.txid,
    vout: inputs.vout,
    amountSats: inputs.amountSats,
    destination: inputs.destination,
    feeRateSatsPerVb: 1n,
    maxFeeSats: inputs.maxFeeSats,
  };
  const escrow = buildRecoveryEscrow(recoveryInputs);
  return { escrow, scriptpubkey: bytesToHex(escrow.script), valueSats: Number(inputs.amountSats) };
}

async function buildUnsignedRecoveryPsbt(inputs: SignerInputs): Promise<string> {
  const verified = await fakeVerifyFunding(inputs);
  const feeSats = 162n;
  return buildSettlementPsbt({
    escrow: verified.escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats,
    leaf: "coop",
  });
}

// ── Parsing tests ────────────────────────────────────────────────────────────

async function testSignerArgs(): Promise<void> {
  const inputs = parseSignerArgs([
    "node", "script",
    "--role", "seller",
    "--parent-id", ESCROW_ID,
    "--expected-address", EXPECTED_ADDRESS,
    "--buyer-key", BUYER_KEY,
    "--seller-key", SELLER_KEY,
    "--arbiter-key", ARBITER_KEY,
    "--funder", "buyer",
    "--network", "signet",
    "--refund-lock-until", String(REFUND_HEIGHT),
    "--txid", FUND_TXID,
    "--vout", "0",
    "--amount-sats", "100000",
    "--destination", RECOVERY_ADDRESS,
    "--max-fee-sats", "500",
    "--expected-fee-sats", "162",
    "--psbt-file", "psbt.base64",
  ]);
  assert.equal(inputs.role, "seller");
  assert.equal(inputs.funder, "buyer");
  assert.equal(inputs.psbtFile, "psbt.base64");
}

async function testSignerArgsBadRole(): Promise<void> {
  assert.throws(
    () => parseSignerArgs(["node", "script", "--role", "arbiter"]),
    /--role must be/,
  );
}

async function testFinalizerArgsMultiplePsbtFiles(): Promise<void> {
  const inputs = parseFinalizerArgs([
    "node", "script",
    "--parent-id", ESCROW_ID,
    "--expected-address", EXPECTED_ADDRESS,
    "--buyer-key", BUYER_KEY,
    "--seller-key", SELLER_KEY,
    "--arbiter-key", ARBITER_KEY,
    "--refund-lock-until", String(REFUND_HEIGHT),
    "--txid", FUND_TXID,
    "--vout", "0",
    "--amount-sats", "100000",
    "--destination", RECOVERY_ADDRESS,
    "--max-fee-sats", "500",
    "--expected-fee-sats", "162",
    "--psbt-file", "a.psbt",
    "--psbt-file", "b.psbt",
  ]);
  assert.deepEqual(inputs.psbtFiles, ["a.psbt", "b.psbt"]);
}

async function testFinalizerArgsRequiresPsbt(): Promise<void> {
  assert.throws(
    () => parseFinalizerArgs(["node", "script", "--parent-id", ESCROW_ID, "--expected-address", EXPECTED_ADDRESS, "--buyer-key", BUYER_KEY, "--seller-key", SELLER_KEY, "--arbiter-key", ARBITER_KEY, "--refund-lock-until", String(REFUND_HEIGHT), "--txid", FUND_TXID, "--vout", "0", "--amount-sats", "100000", "--destination", RECOVERY_ADDRESS, "--max-fee-sats", "500", "--expected-fee-sats", "162"]),
    /At least one --psbt-file is required/,
  );
}

// ── Key derivation and zeroing tests ─────────────────────────────────────────

async function testDeriveRecoveryKeyMatchesEscrowFunding(): Promise<void> {
  const fromShared = deriveRecoverySigningKey(WORDS, ESCROW_ID, "signet");
  const fromFunding = deriveEscrowSigningKey(WORDS, ESCROW_ID, { network: SIGNET });
  assert.equal(bytesToHex(fromShared.xonly), bytesToHex(fromFunding.xonly));
  assert.equal(fromShared.path, fromFunding.path);
  zeroKeyBuffers(fromShared.priv, fromShared.xonly, fromFunding.priv, fromFunding.xonly);
}

async function testZeroKeyBuffersOverwrites(): Promise<void> {
  const key = deriveRecoverySigningKey(WORDS, ESCROW_ID, "signet");
  assert.ok(key.priv.some((b) => b !== 0));
  zeroKeyBuffers(key.priv, key.xonly);
  assert.ok(key.priv.every((b) => b === 0));
}

// ── Verification tests ───────────────────────────────────────────────────────

async function testVerifyFundingMockSucceeds(): Promise<void> {
  const inputs = baseSignerInputs();
  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(escrow.script), value: Number(FUND_VALUE) });
  const fakeOutspend = async () => ({ spent: false });
  const verified = await verifyRecoveryFunding(inputs, fakeOutput, fakeOutspend);
  assert.equal(verified.escrow.address, EXPECTED_ADDRESS);
  assert.equal(verified.valueSats, Number(FUND_VALUE));
  assert.equal(verified.scriptpubkey, bytesToHex(escrow.script));
}

async function testCheckRecoveryPsbtAcceptsValid(): Promise<void> {
  const inputs = baseSignerInputs();
  const psbt = await buildUnsignedRecoveryPsbt(inputs);
  const verified = await fakeVerifyFunding(inputs);
  const check = checkRecoveryPsbt(psbt, inputs, verified.escrow);
  assert.equal(check.ok, true);
}

async function testCheckRecoveryPsbtRejectsBadDestination(): Promise<void> {
  const inputs = baseSignerInputs();
  const psbt = await buildUnsignedRecoveryPsbt(inputs);
  const verified = await fakeVerifyFunding(inputs);
  const badInputs = { ...inputs, destination: EXPECTED_ADDRESS };
  const check = checkRecoveryPsbt(psbt, badInputs, verified.escrow);
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes("destination") || f.includes("winner")));
}

// ── Signing and finalization tests ───────────────────────────────────────────

async function testRoundTripSignAndFinalize(): Promise<void> {
  const parentId = `${ESCROW_ID}_signer_roundtrip`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const feeSats = 162n;
  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats,
    leaf: "coop",
  });

  const buyerKey = deriveRecoverySigningKey(BUYER_WORDS, inputs.parentId, "signet");
  assert.equal(bytesToHex(buyerKey.xonly), inputs.buyerKey);
  const signedByBuyer = signRecoveryPsbt(psbt, buyerKey.priv);
  zeroKeyBuffers(buyerKey.priv, buyerKey.xonly);

  const sellerKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  assert.equal(bytesToHex(sellerKey.xonly), inputs.sellerKey);
  const signedBySeller = signRecoveryPsbt(psbt, sellerKey.priv);
  zeroKeyBuffers(sellerKey.priv, sellerKey.xonly);

  const { txHex, txid } = combineAndFinalizeRecoveryPsbt(
    [signedByBuyer, signedBySeller], escrow, finalizerExpectation(inputs),
  );
  assert.ok(txHex.length > 0);
  assert.ok(/^[0-9a-f]+$/.test(txid));

  const tx = btc.Transaction.fromRaw(hexToBytes(txHex), { allowUnknown: true, allowUnknownOutputs: true });
  assert.equal(tx.inputsLength, 1);
  assert.equal(tx.outputsLength, 1);
  assert.equal(tx.id, txid);
}

async function testRoundTripWithSeparateSignedPsbts(): Promise<void> {
  const parentId = `${ESCROW_ID}_separate_psbts`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  const buyerKey = deriveRecoverySigningKey(BUYER_WORDS, inputs.parentId, "signet");
  const buyerSigned = signRecoveryPsbt(psbt, buyerKey.priv);
  zeroKeyBuffers(buyerKey.priv, buyerKey.xonly);

  const sellerKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  const sellerSigned = signRecoveryPsbt(psbt, sellerKey.priv);
  zeroKeyBuffers(sellerKey.priv, sellerKey.xonly);

  const { txHex, txid } = combineAndFinalizeRecoveryPsbt(
    [buyerSigned, sellerSigned], escrow, finalizerExpectation(inputs),
  );
  assert.ok(txHex.length > 0);
  assert.ok(/^[0-9a-f]+$/.test(txid));
}

async function testFinalizerRequiresTwoSignatures(): Promise<void> {
  const inputs = baseSignerInputs();
  const psbt = await buildUnsignedRecoveryPsbt(inputs);
  const verified = await fakeVerifyFunding(inputs);
  assert.throws(
    () => combineAndFinalizeRecoveryPsbt([psbt], verified.escrow, finalizerExpectation(inputs)),
    /not signed|finalize|threshold|signature/i,
  );
}

// ── PSBT I/O tests ───────────────────────────────────────────────────────────

async function testReadPsbtFromFile(): Promise<void> {
  const tmp = `${process.pid}_test_read_psbt.tmp`;
  const fs = await import("node:fs");
  fs.writeFileSync(tmp, "  c29tZWJhc2U2NA==  \n", "utf8");
  try {
    const result = await readPsbt(tmp);
    assert.equal(result, "c29tZWJhc2U2NA==");
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function testReadPsbtRejectsGarbage(): Promise<void> {
  await assert.rejects(
    () => readPsbt("-"),
    /does not look like base64/,
  );
}

async function testSignerRejectsWrongMnemonic(): Promise<void> {
  const parentId = `${ESCROW_ID}_wrong_mnemonic`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    role: "buyer",
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  // Wrong mnemonic for the buyer role.
  const wrongKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  assert.notEqual(bytesToHex(wrongKey.xonly), inputs.buyerKey);
  assert.throws(
    () => assertRoleKeyMatch(inputs, wrongKey.xonly),
    /does not match/i,
  );
  zeroKeyBuffers(wrongKey.priv, wrongKey.xonly);
}

async function testSignerRejectsWrongRole(): Promise<void> {
  const parentId = `${ESCROW_ID}_wrong_role`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    role: "buyer",
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  // Sign with seller key while expecting buyer key.
  const sellerKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  assert.throws(
    () => assertRoleKeyMatch(inputs, sellerKey.xonly),
    /does not match/i,
  );
  zeroKeyBuffers(sellerKey.priv, sellerKey.xonly);
}

function mutatePsbtDestination(psbtB64: string, newDestination: string, network: typeof SIGNET): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), { allowUnknown: true, allowUnknownOutputs: true });
  // Rebuild with the same input but a different output.
  const out = tx.getOutput(0);
  const mutated = new btc.Transaction({ allowUnknown: true, allowUnknownOutputs: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    mutated.addInput({
      txid: inp.txid!,
      index: inp.index!,
      witnessUtxo: inp.witnessUtxo,
      sequence: inp.sequence,
      finalScriptSig: inp.finalScriptSig,
      tapInternalKey: inp.tapInternalKey,
      tapLeafScript: inp.tapLeafScript,
      tapMerkleRoot: inp.tapMerkleRoot,
    });
  }
  mutated.addOutputAddress(newDestination, out.amount!, network);
  return base64.encode(mutated.toPSBT());
}

async function testSignerRejectsAlteredPsbt(): Promise<void> {
  const inputs = baseSignerInputs();
  const psbt = await buildUnsignedRecoveryPsbt(inputs);
  const verified = await fakeVerifyFunding(inputs);

  // Tamper with destination.
  const tampered = mutatePsbtDestination(psbt, EXPECTED_ADDRESS, SIGNET);
  const check = checkRecoveryPsbt(tampered, inputs, verified.escrow);
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes("destination") || f.includes("winner")));
}

async function testFinalizerRejectsDuplicateSigner(): Promise<void> {
  const parentId = `${ESCROW_ID}_duplicate_signer`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  const buyerKey = deriveRecoverySigningKey(BUYER_WORDS, inputs.parentId, "signet");
  const buyerSigned1 = signRecoveryPsbt(psbt, buyerKey.priv);
  const buyerSigned2 = signRecoveryPsbt(psbt, buyerKey.priv);
  zeroKeyBuffers(buyerKey.priv, buyerKey.xonly);

  assert.throws(
    () => combineAndFinalizeRecoveryPsbt(
      [buyerSigned1, buyerSigned2], escrow, finalizerExpectation(inputs),
    ),
    /duplicate buyer|seller-signed/i,
  );
}

function mutatePsbtOutputAmount(psbtB64: string, newAmount: bigint): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), { allowUnknown: true, allowUnknownOutputs: true });
  const mutated = new btc.Transaction({ allowUnknown: true, allowUnknownOutputs: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    mutated.addInput({
      txid: inp.txid!,
      index: inp.index!,
      witnessUtxo: inp.witnessUtxo,
      sequence: inp.sequence,
      finalScriptSig: inp.finalScriptSig,
      tapInternalKey: inp.tapInternalKey,
      tapLeafScript: inp.tapLeafScript,
      tapMerkleRoot: inp.tapMerkleRoot,
    });
  }
  const out = tx.getOutput(0);
  mutated.addOutput({ script: out.script!, amount: newAmount });
  return base64.encode(mutated.toPSBT());
}

async function testFinalizerRejectsAlteredOutput(): Promise<void> {
  const parentId = `${ESCROW_ID}_altered_output`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  // Inflate payout by 1 sat (fee drops by 1 sat, still within maxFeeSats).
  const tampered = mutatePsbtOutputAmount(psbt, 99_839n);
  const buyerKey = deriveRecoverySigningKey(BUYER_WORDS, inputs.parentId, "signet");
  const sellerKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  const buyerSigned = signRecoveryPsbt(tampered, buyerKey.priv);
  const sellerSigned = signRecoveryPsbt(tampered, sellerKey.priv);
  zeroKeyBuffers(buyerKey.priv, buyerKey.xonly, sellerKey.priv, sellerKey.xonly);
  assert.throws(
    () => combineAndFinalizeRecoveryPsbt([buyerSigned, sellerSigned], escrow, finalizerExpectation(inputs)),
    /fee|payout|amount|output/i,
  );
}

async function testFinalizerRejectsAlteredFee(): Promise<void> {
  const parentId = `${ESCROW_ID}_altered_fee`;
  const testBuyer = deriveEscrowSigningKey(BUYER_WORDS, parentId, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(SELLER_WORDS, parentId, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${parentId}_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${parentId}_destination`, { network: SIGNET });

  const inputs = baseSignerInputs({
    parentId,
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
  });

  const escrow = buildRecoveryEscrow(buildInputsFromSigner(inputs));
  inputs.expectedAddress = escrow.address;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    feeSats: 162n,
    leaf: "coop",
  });

  // Reduce payout by 1 sat, increasing fee by 1 sat. Since fee is still only
  // 163 sats, the failure must come from amount mismatch, not fee ceiling.
  const tampered = mutatePsbtOutputAmount(psbt, 99_837n);
  const buyerKey = deriveRecoverySigningKey(BUYER_WORDS, inputs.parentId, "signet");
  const sellerKey = deriveRecoverySigningKey(SELLER_WORDS, inputs.parentId, "signet");
  const buyerSigned = signRecoveryPsbt(tampered, buyerKey.priv);
  const sellerSigned = signRecoveryPsbt(tampered, sellerKey.priv);
  zeroKeyBuffers(buyerKey.priv, buyerKey.xonly, sellerKey.priv, sellerKey.xonly);
  assert.throws(
    () => combineAndFinalizeRecoveryPsbt([buyerSigned, sellerSigned], escrow, finalizerExpectation(inputs)),
    /fee|payout|amount|output/i,
  );
}

async function testHiddenPromptFallbackWhenNoTty(): Promise<void> {
  // Simulate the case where /dev/tty is not available by overriding the prompt
  // to use a plain Readable/Writable pair. The fallback must still read the line.
  const { Readable, Writable } = await import("node:stream");
  const input = Readable.from(["secret words\n"]);
  const outputChunks: Buffer[] = [];
  const output = new Writable({ write(chunk, _enc, cb) { outputChunks.push(Buffer.from(chunk)); cb(); } });

  const answer = await hiddenPromptWithStreams("Mnemonic", input, output);
  assert.equal(answer, "secret words");
  const written = Buffer.concat(outputChunks).toString("utf8");
  assert.ok(written.includes("Mnemonic:"));
  assert.ok(written.includes("\n"));
}

async function testHiddenPromptNoEchoOnFakeTty(): Promise<void> {
  const secret = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const { Readable, Writable } = await import("node:stream");

  const outputChunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      outputChunks.push(Buffer.from(chunk));
      cb();
    },
  });

  let rawMode = false;
  const dataHandlers: Array<(data: Buffer) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  const input = Object.assign(new Readable({ read() {} }), {
    isRaw: false,
    setRawMode(mode: boolean) {
      rawMode = mode;
      this.isRaw = mode;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "data") dataHandlers.push(handler as (data: Buffer) => void);
      if (event === "error") errorHandlers.push(handler as (err: Error) => void);
      return this;
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const idx = event === "data" ? dataHandlers.indexOf(handler as (data: Buffer) => void) : -1;
      if (idx >= 0) dataHandlers.splice(idx, 1);
      return this;
    },
    pushSecret() {
      for (const h of dataHandlers) {
        h(Buffer.from(secret + "\r", "utf8"));
      }
    },
  });

  const promptPromise = hiddenPromptNoEcho("Mnemonic", input, output);
  // Yield so the prompt can set raw mode and attach listeners.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rawMode, true, "input must be put into raw mode");
  input.pushSecret();
  const answer = await promptPromise;
  assert.equal(answer, secret);

  const written = Buffer.concat(outputChunks).toString("utf8");
  assert.ok(written.includes("Mnemonic:"), "prompt label must be written");
  assert.ok(written.includes("\n"), "newline must be written after Enter");
  assert.ok(!written.includes(secret), "secret mnemonic must never appear in captured output");
}

async function testHiddenPromptNoEchoBackspace(): Promise<void> {
  const { Readable, Writable } = await import("node:stream");

  const outputChunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      outputChunks.push(Buffer.from(chunk));
      cb();
    },
  });

  const dataHandlers: Array<(data: Buffer) => void> = [];
  const input = Object.assign(new Readable({ read() {} }), {
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "data") dataHandlers.push(handler as (data: Buffer) => void);
      return this;
    },
    removeListener() {
      return this;
    },
    pushBytes(bytes: number[]) {
      for (const h of dataHandlers) {
        h(Buffer.from(bytes));
      }
    },
  });

  const promptPromise = hiddenPromptNoEcho("Mnemonic", input, output);
  await new Promise((r) => setTimeout(r, 10));
  // Type "abx", backspace, "c", enter => "abc"
  input.pushBytes([0x61, 0x62, 0x78, 0x7f, 0x63, 0x0d]);
  const answer = await promptPromise;
  assert.equal(answer, "abc");

  const written = Buffer.concat(outputChunks).toString("utf8");
  assert.ok(written.includes("\b \b"), "backspace must erase a character on screen");
  assert.ok(!written.includes("x"), "erased character must not remain in output");
  assert.ok(!written.includes("abc"), "final secret characters must not be echoed");
}

// ── hiddenPrompt is hard to test without a TTY; skip interactive test. ───────

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "signer args parse correctly", fn: testSignerArgs },
  { name: "signer args reject bad role", fn: testSignerArgsBadRole },
  { name: "finalizer args accept multiple PSBT files", fn: testFinalizerArgsMultiplePsbtFiles },
  { name: "finalizer args require PSBT file", fn: testFinalizerArgsRequiresPsbt },
  { name: "recovery key derivation matches escrow funding", fn: testDeriveRecoveryKeyMatchesEscrowFunding },
  { name: "zeroKeyBuffers overwrites buffers", fn: testZeroKeyBuffersOverwrites },
  { name: "verify funding mock succeeds", fn: testVerifyFundingMockSucceeds },
  { name: "checkRecoveryPsbt accepts valid PSBT", fn: testCheckRecoveryPsbtAcceptsValid },
  { name: "checkRecoveryPsbt rejects bad destination", fn: testCheckRecoveryPsbtRejectsBadDestination },
  { name: "sign and finalize round trip", fn: testRoundTripSignAndFinalize },
  { name: "round trip with separate signed PSBTs", fn: testRoundTripWithSeparateSignedPsbts },
  { name: "signer rejects wrong mnemonic", fn: testSignerRejectsWrongMnemonic },
  { name: "signer rejects wrong role key", fn: testSignerRejectsWrongRole },
  { name: "signer rejects altered PSBT", fn: testSignerRejectsAlteredPsbt },
  { name: "finalizer refuses unsigned PSBT", fn: testFinalizerRequiresTwoSignatures },
  { name: "finalizer rejects duplicate signer", fn: testFinalizerRejectsDuplicateSigner },
  { name: "finalizer rejects altered output", fn: testFinalizerRejectsAlteredOutput },
  { name: "finalizer rejects altered fee", fn: testFinalizerRejectsAlteredFee },
  { name: "readPsbt trims file contents", fn: testReadPsbtFromFile },
  { name: "readPsbt rejects non-base64", fn: testReadPsbtRejectsGarbage },
  { name: "hiddenPrompt fallback reads from stdin/stdout", fn: testHiddenPromptFallbackWhenNoTty },
  { name: "hiddenPrompt no-echo on fake TTY", fn: testHiddenPromptNoEchoOnFakeTty },
  { name: "hiddenPrompt backspace does not leak erased chars", fn: testHiddenPromptNoEchoBackspace },
];

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

run();
