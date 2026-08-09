// ─────────────────────────────────────────────────────────────────────────────
// Deterministic tests for scripts/build-recovery-psbt.ts
// ─────────────────────────────────────────────────────────────────────────────
import { strict as assert } from "node:assert";
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import {
  buildRecoveryEscrow,
  buildRecoveryPsbt,
  parseArgs,
  verifyLiveFunding,
  type RecoveryInputs,
} from "./build-recovery-psbt.js";
import {
  coSignSettlement,
  finalizeSettlement,
  verifySettlementPsbt,
} from "../src/bond-multisig/onchain-escrow-settle.js";
import { deriveEscrowSigningKey } from "../src/bond-multisig/onchain-escrow-funding.js";
import { SIGNET } from "../src/bond-multisig/multisig.js";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ESCROW_ID = "sm_msl0k7rp_gyuf2w0i";
const REFUND_HEIGHT = 3332614;
const FUND_TXID = "0b4cbd09e3e7f1e092b7f5aee4a08fb96eefa98d14add5d96d172c49bdf82f0a";
const FUND_VOUT = 0;
const FUND_VALUE = 100_000n;

// Live public x-only keys for the funded parent, as verified by Codex and Kimi.
const BUYER_KEY = "619d0d50ee286510fa8504a3eb69a0da52376a506dc06fe7bddaed625d597c7c";
const SELLER_KEY = "0cf8c8903249d2a41e4299eec2a7cb570179dbc9f0f2e3804627d3e6e074051d";
const ARBITER_KEY = "d6fb707bb00057e7ba3f65000a4a3499bd107105bc62742162bd02f6e3a41615";

const EXPECTED_ADDRESS = "tb1pxm57qln85r6eqn2h8777auknxkm84jr7hzv3dkdg4002dmz0d3lsee5v83";

// Use a key clearly different from the escrow address as the recovery destination.
const recoveryDestination = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_recovery_destination`, { network: SIGNET });
const RECOVERY_ADDRESS = btc.Address(SIGNET).encode(
  btc.OutScript.decode(btc.p2tr(bytesToHex(recoveryDestination.xonly)).script),
);

function baseInputs(overrides?: Partial<RecoveryInputs>): RecoveryInputs {
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
    feeRateSatsPerVb: 1n,
    maxFeeSats: 500n,
    ...overrides,
  };
}

async function testBuildEscrowReproducesExpectedAddress(): Promise<void> {
  const escrow = buildRecoveryEscrow(baseInputs());
  assert.equal(escrow.address, EXPECTED_ADDRESS);
  assert.equal(escrow.params.refundLockUntil, REFUND_HEIGHT);
}

async function testLiveFundingVerification(): Promise<void> {
  const inputs = baseInputs();
  const verified = await verifyLiveFunding(inputs);
  assert.equal(verified.escrow.address, EXPECTED_ADDRESS);
  assert.equal(verified.scriptpubkey, bytesToHex(verified.escrow.script));
  assert.equal(BigInt(verified.valueSats), FUND_VALUE);
}

async function testWrongExpectedAddressRejected(): Promise<void> {
  const inputs = baseInputs({ expectedAddress: "tb1ptdqzltvmaug8t78vyj9vh40ffnxf899szq3jz4rqn02udk29qlwqwph9vk" });
  await assert.rejects(
    () => verifyLiveFunding(inputs),
    /Reconstructed address does not match expected address/,
  );
}

async function testWrongLiveScriptRejected(): Promise<void> {
  const inputs = baseInputs();
  const fakeOutput = async () => ({ scriptpubkey: "00".repeat(34), value: 100_000 });
  const fakeOutspend = async () => ({ spent: false });
  await assert.rejects(
    () => verifyLiveFunding(inputs, fakeOutput, fakeOutspend),
    /Live output script does not match reconstructed escrow/,
  );
}

async function testWrongLiveAmountRejected(): Promise<void> {
  const inputs = baseInputs();
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(buildRecoveryEscrow(inputs).script), value: 99_999 });
  const fakeOutspend = async () => ({ spent: false });
  await assert.rejects(
    () => verifyLiveFunding(inputs, fakeOutput, fakeOutspend),
    /Live output amount does not match expected sats/,
  );
}

async function testSpentOutputRejected(): Promise<void> {
  const inputs = baseInputs();
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(buildRecoveryEscrow(inputs).script), value: 100_000 });
  const fakeOutspend = async () => ({ spent: true });
  await assert.rejects(
    () => verifyLiveFunding(inputs, fakeOutput, fakeOutspend),
    /has already been spent/,
  );
}

async function testMalformedOutspendRejected(): Promise<void> {
  const inputs = baseInputs();
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(buildRecoveryEscrow(inputs).script), value: 100_000 });
  const fakeOutspend = async () => ({ spent: "maybe" } as unknown as { spent: boolean });
  await assert.rejects(
    () => verifyLiveFunding(inputs, fakeOutput, fakeOutspend),
    /Malformed outspend/,
  );
}

async function testExcessiveFeeRejected(): Promise<void> {
  const inputs = baseInputs({ feeRateSatsPerVb: 10n, maxFeeSats: 100n });
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(buildRecoveryEscrow(inputs).script), value: 100_000 });
  const fakeOutspend = async () => ({ spent: false });
  const verified = await verifyLiveFunding(inputs, fakeOutput, fakeOutspend);
  assert.throws(
    () => buildRecoveryPsbt(verified, inputs),
    /Computed fee .* exceeds --max-fee-sats/,
  );
}

async function testDestinationEqualsEscrowRejected(): Promise<void> {
  const inputs = baseInputs({ destination: EXPECTED_ADDRESS });
  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(buildRecoveryEscrow(inputs).script), value: 100_000 });
  const fakeOutspend = async () => ({ spent: false });
  const verified = await verifyLiveFunding(inputs, fakeOutput, fakeOutspend);
  assert.throws(
    () => buildRecoveryPsbt(verified, inputs),
    /Recovery destination must not be the same as the escrow address/,
  );
}

async function testBadDestinationRejected(): Promise<void> {
  assert.throws(
    () => parseArgs([
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
      "--destination", "notanaddress",
      "--fee-rate", "1",
      "--max-fee-sats", "500",
    ]),
    /does not decode as a signet P2TR address/,
  );
}

async function testRecoveryPsbtRoundTripSignToDistinctAddress(): Promise<void> {
  const testBuyer = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_roundtrip_buyer`, { network: SIGNET });
  const testSeller = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_roundtrip_seller`, { network: SIGNET });
  const testArbiter = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_roundtrip_arbiter`, { network: SIGNET });
  const testDestination = deriveEscrowSigningKey(WORDS, `${ESCROW_ID}_roundtrip_destination`, { network: SIGNET });

  const inputs: RecoveryInputs = {
    parentId: `${ESCROW_ID}_roundtrip`,
    expectedAddress: "",
    buyerKey: bytesToHex(testBuyer.xonly),
    sellerKey: bytesToHex(testSeller.xonly),
    arbiterKey: bytesToHex(testArbiter.xonly),
    funder: "seller",
    network: "signet",
    refundLockUntil: REFUND_HEIGHT,
    txid: "a".repeat(64),
    vout: 0,
    amountSats: 100_000n,
    destination: btc.Address(SIGNET).encode(
      btc.OutScript.decode(btc.p2tr(bytesToHex(testDestination.xonly)).script),
    ),
    feeRateSatsPerVb: 1n,
    maxFeeSats: 500n,
  };

  const escrow = buildRecoveryEscrow(inputs);
  inputs.expectedAddress = escrow.address;

  const fakeOutput = async () => ({ scriptpubkey: bytesToHex(escrow.script), value: 100_000 });
  const fakeOutspend = async () => ({ spent: false });
  const verified = await verifyLiveFunding(inputs, fakeOutput, fakeOutspend);
  const psbt = buildRecoveryPsbt(verified, inputs);

  const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknown: true, allowUnknownOutputs: true });
  assert.equal(tx.inputsLength, 1);
  assert.equal(tx.outputsLength, 1);
  const out = tx.getOutput(0);
  assert.equal(out.amount, 99_838n);
  assert.notEqual(inputs.destination, escrow.address, "destination must differ from escrow address");

  const signedByBuyer = coSignSettlement(psbt, testBuyer.priv);
  const signedByBoth = coSignSettlement(signedByBuyer, testSeller.priv);
  const hexTx = finalizeSettlement([signedByBoth], { escrow: verified.escrow, leaf: "coop" });
  assert.ok(hexTx.length > 0);

  const finalTx = btc.Transaction.fromRaw(hexToBytes(hexTx), { allowUnknown: true, allowUnknownOutputs: true });
  assert.equal(finalTx.inputsLength, 1);
  assert.equal(finalTx.outputsLength, 1);
}

async function testVerificationCatchesMismatch(): Promise<void> {
  const inputs = baseInputs();
  const verified = await verifyLiveFunding(inputs);
  const psbt = buildRecoveryPsbt(verified, inputs);
  const check = verifySettlementPsbt(psbt, {
    escrow: verified.escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: 99_999n }],
    destination: inputs.destination,
    maxFeeSats: 500n,
    network: verified.escrow.params.network,
    leaf: "coop",
  });
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes("amount")));
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "escrow reproduces expected address", fn: testBuildEscrowReproducesExpectedAddress },
  { name: "live funding verification", fn: testLiveFundingVerification },
  { name: "wrong expected address rejected", fn: testWrongExpectedAddressRejected },
  { name: "wrong live script rejected", fn: testWrongLiveScriptRejected },
  { name: "wrong live amount rejected", fn: testWrongLiveAmountRejected },
  { name: "spent output rejected", fn: testSpentOutputRejected },
  { name: "malformed outspend rejected", fn: testMalformedOutspendRejected },
  { name: "excessive fee rejected", fn: testExcessiveFeeRejected },
  { name: "destination equals escrow rejected", fn: testDestinationEqualsEscrowRejected },
  { name: "bad destination rejected", fn: testBadDestinationRejected },
  { name: "recovery PSBT round-trip sign to distinct address", fn: testRecoveryPsbtRoundTripSignToDistinctAddress },
  { name: "verification catches amount mismatch", fn: testVerificationCatchesMismatch },
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
