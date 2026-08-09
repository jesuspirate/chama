// ─────────────────────────────────────────────────────────────────────────────
// Read-only reconstruction verifier for an already-funded parent escrow that
// was frozen by PLAN_START before LOCK could be published.
//
// This script does NOT load private keys, build signatures, write app state, or
// broadcast. It only tries to reproduce the original Taproot address byte-for-
// byte by scanning candidate refund-lock heights.
//
// Run with tsx:
//   npx tsx scripts/verify-funded-parent-address.ts \
//     --parent-id e2ae2beaf55b932c965543e436a5be400e6248f2bdcea4f82cb46f724ac2c3f9 \
//     --address tb1p... \
//     --buyer-key <64-hex> \
//     --seller-key <64-hex> \
//     --arbiter-key <64-hex> \
//     --funder seller \
//     --network signet \
//     --start-height 100000 \
//     --end-height 100100
//
// Optional on-chain verification (requires --expected-sats):
//   --txid <txid> --vout 0 --expected-sats 100000
// ─────────────────────────────────────────────────────────────────────────────
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { pathToFileURL } from "node:url";
import {
  buildOnchainEscrow,
  DISPUTE_CSV_BLOCKS,
  REFUND_CLTV_BLOCKS,
  type OnchainEscrowParams,
} from "../src/bond-multisig/onchain-escrow.js";
import { MAINNET, SIGNET } from "../src/bond-multisig/multisig.js";

const HEX_64 = /^[0-9a-f]{64}$/i;

export type VerifierNetwork = "signet" | "mainnet";

export interface VerifierInputs {
  parentId: string;
  address: string;
  buyerKey: string;
  sellerKey: string;
  arbiterKey: string;
  funder: "buyer" | "seller";
  network: VerifierNetwork;
  startHeight: number;
  endHeight: number;
  txid?: string;
  vout?: number;
  expectedSats?: bigint;
}

export interface HeightMatch {
  refundLockUntil: number;
  address: string;
  scriptHex: string;
}

export function parseArgs(argv: string[]): VerifierInputs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const requireFlag = (flag: string): string => {
    const value = get(flag);
    if (!value) throw new Error(`Missing required flag ${flag}`);
    return value;
  };

  const parentId = requireFlag("--parent-id");
  const address = requireFlag("--address");
  const buyerKey = requireFlag("--buyer-key");
  const sellerKey = requireFlag("--seller-key");
  const arbiterKey = requireFlag("--arbiter-key");

  const funderRaw = get("--funder") ?? "seller";
  if (funderRaw !== "buyer" && funderRaw !== "seller") {
    throw new Error('--funder must be "buyer" or "seller"');
  }

  const networkRaw = get("--network") ?? "signet";
  if (networkRaw !== "signet" && networkRaw !== "mainnet") {
    throw new Error('--network must be "signet" or "mainnet"');
  }

  const startHeight = parseInt(requireFlag("--start-height"), 10);
  const endHeight = parseInt(requireFlag("--end-height"), 10);
  if (!Number.isInteger(startHeight) || !Number.isInteger(endHeight)) {
    throw new Error("--start-height and --end-height must be integers");
  }
  if (startHeight > endHeight) {
    throw new Error("--start-height must be <= --end-height");
  }
  if (endHeight - startHeight > 10_000) {
    throw new Error("Height range exceeds 10,000 candidates; narrow the window");
  }

  const txid = get("--txid");
  const voutRaw = get("--vout");
  const expectedSatsRaw = get("--expected-sats");

  if (voutRaw !== undefined && txid === undefined) {
    throw new Error("--vout requires --txid");
  }
  const vout = voutRaw !== undefined ? parseInt(voutRaw, 10) : undefined;
  if (txid !== undefined && (vout === undefined || !Number.isInteger(vout) || vout < 0)) {
    throw new Error("--txid requires a non-negative integer --vout");
  }

  let expectedSats: bigint | undefined;
  if (expectedSatsRaw !== undefined) {
    try {
      expectedSats = BigInt(expectedSatsRaw);
      if (expectedSats < 0n) throw new Error();
    } catch {
      throw new Error("--expected-sats must be a non-negative integer");
    }
  }
  if (txid !== undefined && expectedSats === undefined) {
    throw new Error("--txid/--vout requires --expected-sats");
  }

  for (const [name, key] of [
    ["--buyer-key", buyerKey],
    ["--seller-key", sellerKey],
    ["--arbiter-key", arbiterKey],
  ] as const) {
    if (!HEX_64.test(key)) throw new Error(`${name} must be 64 hex chars`);
  }
  if (txid !== undefined && !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error("--txid must be 64 hex chars");
  }
  if (!address.startsWith(networkRaw === "signet" ? "tb1p" : "bc1p")) {
    throw new Error(`--address does not match ${networkRaw} P2TR prefix`);
  }

  return {
    parentId,
    address,
    buyerKey,
    sellerKey,
    arbiterKey,
    funder: funderRaw,
    network: networkRaw,
    startHeight,
    endHeight,
    txid,
    vout,
    expectedSats,
  };
}

export function networkFor(network: VerifierNetwork): typeof SIGNET | typeof MAINNET {
  return network === "signet" ? SIGNET : MAINNET;
}

export function validateAddressForNetwork(address: string, network: VerifierNetwork): void {
  const btcNetwork = networkFor(network);
  try {
    const decoded = btc.Address(btcNetwork).decode(address);
    if (decoded.type !== "tr") {
      throw new Error("Address is not a Taproot (P2TR) address");
    }
  } catch (err) {
    throw new Error(
      `Address does not decode as a ${network} P2TR address: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type BuildEscrowFn = (params: OnchainEscrowParams) => { address: string; script: Uint8Array };

export function selectUniqueHeightMatch(
  inputs: Pick<
    VerifierInputs,
    | "address"
    | "buyerKey"
    | "sellerKey"
    | "arbiterKey"
    | "funder"
    | "network"
    | "startHeight"
    | "endHeight"
  >,
  buildEscrow: BuildEscrowFn = buildOnchainEscrow,
): HeightMatch {
  validateAddressForNetwork(inputs.address, inputs.network);

  const network = networkFor(inputs.network);
  const baseParams: Omit<OnchainEscrowParams, "refundLockUntil"> = {
    buyerXonly: hexToBytes(inputs.buyerKey),
    sellerXonly: hexToBytes(inputs.sellerKey),
    arbiterXonly: hexToBytes(inputs.arbiterKey),
    funder: inputs.funder,
    disputeCsvBlocks: DISPUTE_CSV_BLOCKS,
    network,
  };

  const matches: HeightMatch[] = [];
  for (let h = inputs.startHeight; h <= inputs.endHeight; h++) {
    try {
      const escrow = buildEscrow({ ...baseParams, refundLockUntil: h });
      if (escrow.address === inputs.address) {
        matches.push({
          refundLockUntil: h,
          address: escrow.address,
          scriptHex: bytesToHex(escrow.script),
        });
      }
    } catch {
      // invalid tree for this height; skip
    }
  }

  if (matches.length === 0) {
    throw new Error("No matching address found in the candidate range");
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple refund-lock heights produced the target address: ${matches.map((m) => m.refundLockUntil).join(", ")}`,
    );
  }
  return matches[0];
}

export function findMatchingRefundHeight(
  inputs: Pick<
    VerifierInputs,
    | "address"
    | "buyerKey"
    | "sellerKey"
    | "arbiterKey"
    | "funder"
    | "network"
    | "startHeight"
    | "endHeight"
  >,
): HeightMatch {
  return selectUniqueHeightMatch(inputs, buildOnchainEscrow);
}

export async function fetchFundingOutput(
  network: VerifierNetwork,
  txid: string,
  vout: number,
): Promise<{ scriptpubkey: string; value: number }> {
  const base =
    network === "signet"
      ? "https://mutinynet.com/api"
      : "https://mempool.space/api";
  const url = `${base}/tx/${txid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Esplora fetch failed: ${res.status} ${res.statusText}`);
  const tx = (await res.json()) as { vout: Array<{ scriptpubkey: string; value: number }> };
  const out = tx.vout[vout];
  if (!out) throw new Error(`Output ${vout} not found in tx ${txid}`);
  return out;
}

export interface VerificationResult {
  parentId: string;
  match: HeightMatch;
  disputeCsvBlocks: number;
  refundCltvDelta: number;
  fundedOutput?: { txid: string; vout: number; scriptpubkey: string; valueSats: number };
}

export async function verifyFundedParentAddress(
  inputs: VerifierInputs,
  fetchOutput: typeof fetchFundingOutput = fetchFundingOutput,
): Promise<VerificationResult> {
  const match = findMatchingRefundHeight(inputs);

  const result: VerificationResult = {
    parentId: inputs.parentId,
    match,
    disputeCsvBlocks: DISPUTE_CSV_BLOCKS,
    refundCltvDelta: REFUND_CLTV_BLOCKS,
  };

  if (inputs.txid !== undefined && inputs.vout !== undefined && inputs.expectedSats !== undefined) {
    const out = await fetchOutput(inputs.network, inputs.txid, inputs.vout);
    if (out.scriptpubkey !== match.scriptHex) {
      throw new Error(
        `Funded output script does not match reconstructed escrow:\n  expected: ${match.scriptHex}\n  actual:   ${out.scriptpubkey}`,
      );
    }
    if (BigInt(out.value) !== inputs.expectedSats) {
      throw new Error(
        `Funded output amount does not match expected sats:\n  expected: ${inputs.expectedSats}\n  actual:   ${out.value}`,
      );
    }
    result.fundedOutput = {
      txid: inputs.txid,
      vout: inputs.vout,
      scriptpubkey: out.scriptpubkey,
      valueSats: out.value,
    };
  }

  return result;
}

function printResult(result: VerificationResult): void {
  console.log(`SUCCESS: Exact address reproduced for parent ${result.parentId}.`);
  console.log(`  refund-lock height: ${result.match.refundLockUntil}`);
  console.log(`  address:            ${result.match.address}`);
  console.log(`  script hex:         ${result.match.scriptHex}`);
  console.log(`  dispute CSV blocks: ${result.disputeCsvBlocks}`);
  console.log(`  refund CLTV delta:  ${result.refundCltvDelta} blocks`);
  if (result.fundedOutput) {
    console.log(`  funded output:      ${result.fundedOutput.txid}:${result.fundedOutput.vout}`);
    console.log(`  output value:       ${result.fundedOutput.valueSats} sats`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const inputs = parseArgs(argv);
  const result = await verifyFundedParentAddress(inputs);
  printResult(result);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
