// ─────────────────────────────────────────────────────────────────────────────
// Deterministic tests for scripts/verify-funded-parent-address.ts
//
// Run directly:
//   npx tsx scripts/verify-funded-parent-address.tests.ts
// Or through the package gate once added to npm test.
// ─────────────────────────────────────────────────────────────────────────────
import { strict as assert } from "node:assert";
import {
  findMatchingRefundHeight,
  parseArgs,
  selectUniqueHeightMatch,
  verifyFundedParentAddress,
  type VerifierInputs,
} from "./verify-funded-parent-address.js";

const TEST_KEYS = {
  buyer: "c804f0cde1273a13b0c9297469e99febea43b50a9248b9d9e2c16535f7d656a9",
  seller: "055808865301d39e9ff61aee3405d6674166dfae076ea40de27969980e92da39",
  arbiter: "3e464669e03f370fc5e1c0ce1f60f8aee081496db989bc207b7b3187414b8fa6",
};

// Computed once from the above keys at height 200_000 on signet, seller-funder.
const KNOWN_ADDRESS = "tb1ptdqzltvmaug8t78vyj9vh40ffnxf899szq3jz4rqn02udk29qlwqwph9vk";
const KNOWN_SCRIPT_HEX =
  "51205b402fad9bef1075f8ec248acbd5e94ccc9394b010232154609bd5c6d94507dc";
const KNOWN_HEIGHT = 200_000;

function baseInputs(overrides?: Partial<VerifierInputs>): VerifierInputs {
  return {
    parentId: "e2ae2beaf55b932c965543e436a5be400e6248f2bdcea4f82cb46f724ac2c3f9",
    address: KNOWN_ADDRESS,
    buyerKey: TEST_KEYS.buyer,
    sellerKey: TEST_KEYS.seller,
    arbiterKey: TEST_KEYS.arbiter,
    funder: "seller",
    network: "signet",
    startHeight: KNOWN_HEIGHT - 10,
    endHeight: KNOWN_HEIGHT + 10,
    ...overrides,
  };
}

async function testUniqueMatch(): Promise<void> {
  const match = findMatchingRefundHeight(baseInputs());
  assert.equal(match.refundLockUntil, KNOWN_HEIGHT);
  assert.equal(match.address, KNOWN_ADDRESS);
  assert.equal(match.scriptHex, KNOWN_SCRIPT_HEX);
}

async function testNoMatch(): Promise<void> {
  assert.throws(
    () => findMatchingRefundHeight(baseInputs({ startHeight: 100_000, endHeight: 100_010 })),
    /No matching address found in the candidate range/,
  );
}

async function testMultipleMatchRejection(): Promise<void> {
  // Inject a fake builder that returns the same address for two consecutive
  // heights so we can deterministically exercise the ambiguous-match refusal.
  const fakeScript = new Uint8Array([0x51, 0x20, ...new Uint8Array(32)]);
  const fakeBuild = () => ({ address: KNOWN_ADDRESS, script: fakeScript });
  assert.throws(
    () =>
      selectUniqueHeightMatch(
        baseInputs({ startHeight: KNOWN_HEIGHT, endHeight: KNOWN_HEIGHT + 1 }),
        fakeBuild,
      ),
    /Multiple refund-lock heights produced the target address: 200000, 200001/,
  );
}

async function testWrongNetworkPrefix(): Promise<void> {
  assert.throws(
    () => findMatchingRefundHeight(baseInputs({ network: "mainnet" })),
    /does not decode as a mainnet P2TR address/,
  );
}

async function testInvalidRange(): Promise<void> {
  assert.throws(
    () => parseArgs(["node", "script", "--parent-id", "p", "--address", KNOWN_ADDRESS, "--buyer-key", TEST_KEYS.buyer, "--seller-key", TEST_KEYS.seller, "--arbiter-key", TEST_KEYS.arbiter, "--start-height", "100", "--end-height", "10101"]),
    /Height range exceeds/,
  );
}

async function testVoutWithoutTxid(): Promise<void> {
  assert.throws(
    () => parseArgs(["node", "script", "--parent-id", "p", "--address", KNOWN_ADDRESS, "--buyer-key", TEST_KEYS.buyer, "--seller-key", TEST_KEYS.seller, "--arbiter-key", TEST_KEYS.arbiter, "--start-height", "1", "--end-height", "2", "--vout", "0"]),
    /--vout requires --txid/,
  );
}

async function testTxidWithoutExpectedSats(): Promise<void> {
  assert.throws(
    () => parseArgs(["node", "script", "--parent-id", "p", "--address", KNOWN_ADDRESS, "--buyer-key", TEST_KEYS.buyer, "--seller-key", TEST_KEYS.seller, "--arbiter-key", TEST_KEYS.arbiter, "--start-height", "1", "--end-height", "2", "--txid", "a".repeat(64), "--vout", "0"]),
    /requires --expected-sats/,
  );
}

async function testWrongOutputScript(): Promise<void> {
  const inputs = baseInputs({
    txid: "a".repeat(64),
    vout: 0,
    expectedSats: 100_000n,
  });
  const fetchOutput = async () => ({ scriptpubkey: "00".repeat(34), value: 100_000 });
  await assert.rejects(
    () => verifyFundedParentAddress(inputs, fetchOutput),
    /Funded output script does not match reconstructed escrow/,
  );
}

async function testWrongAmount(): Promise<void> {
  const inputs = baseInputs({
    txid: "a".repeat(64),
    vout: 0,
    expectedSats: 100_000n,
  });
  const fetchOutput = async () => ({ scriptpubkey: KNOWN_SCRIPT_HEX, value: 99_999 });
  await assert.rejects(
    () => verifyFundedParentAddress(inputs, fetchOutput),
    /Funded output amount does not match expected sats/,
  );
}

async function testSuccessfulOutputVerification(): Promise<void> {
  const inputs = baseInputs({
    txid: "a".repeat(64),
    vout: 0,
    expectedSats: 100_000n,
  });
  const fetchOutput = async () => ({ scriptpubkey: KNOWN_SCRIPT_HEX, value: 100_000 });
  const result = await verifyFundedParentAddress(inputs, fetchOutput);
  assert.equal(result.fundedOutput?.txid, inputs.txid);
  assert.equal(result.fundedOutput?.vout, 0);
  assert.equal(result.fundedOutput?.valueSats, 100_000);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "unique match", fn: testUniqueMatch },
  { name: "no match", fn: testNoMatch },
  { name: "multiple match rejection guard", fn: testMultipleMatchRejection },
  { name: "wrong network prefix", fn: testWrongNetworkPrefix },
  { name: "invalid range rejected", fn: testInvalidRange },
  { name: "--vout without --txid rejected", fn: testVoutWithoutTxid },
  { name: "--txid without --expected-sats rejected", fn: testTxidWithoutExpectedSats },
  { name: "wrong output script rejected", fn: testWrongOutputScript },
  { name: "wrong amount rejected", fn: testWrongAmount },
  { name: "successful output verification", fn: testSuccessfulOutputVerification },
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
