// ─────────────────────────────────────────────────────────────────────────────
// Recovery PSBT builder for an already-funded parent escrow that was frozen by
// PLAN_START before LOCK could be published.
//
// This script is a thin recovery wrapper around the existing escrow primitives
// in src/bond-multisig/onchain-escrow*.ts. It does NOT sign or broadcast; it
// only produces a PSBT that can be passed to the buyer and seller for
// cooperative signing.
//
// Run with tsx after the verifier has produced the exact refundLockUntil:
//   npx tsx scripts/build-recovery-psbt.ts \
//     --parent-id sm_msl0k7rp_gyuf2w0i \
//     --expected-address tb1pxm57qln85r6eqn2h8777auknxkm84jr7hzv3dkdg4002dmz0d3lsee5v83 \
//     --buyer-key <64-hex> \
//     --seller-key <64-hex> \
//     --arbiter-key <64-hex> \
//     --funder seller \
//     --network signet \
//     --refund-lock-until <height> \
//     --txid 0b4cbd09e3e7f1e092b7f5aee4a08fb96eefa98d14add5d96d172c49bdf82f0a \
//     --vout 0 \
//     --amount-sats 100000 \
//     --destination tb1p... \
//     --fee-rate 1 \
//     --max-fee-sats 500
// ─────────────────────────────────────────────────────────────────────────────
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { pathToFileURL } from "node:url";
import {
  buildOnchainEscrow,
  DISPUTE_CSV_BLOCKS,
  LEAF_SPEND_VSIZE,
  type OnchainEscrow,
} from "../src/bond-multisig/onchain-escrow.js";
import {
  buildSettlementPsbt,
  verifySettlementPsbt,
} from "../src/bond-multisig/onchain-escrow-settle.js";
import { MAINNET, SIGNET } from "../src/bond-multisig/multisig.js";

const HEX_64 = /^[0-9a-f]{64}$/i;

export type VerifierNetwork = "signet" | "mainnet";

export interface RecoveryInputs {
  parentId: string;
  expectedAddress: string;
  buyerKey: string;
  sellerKey: string;
  arbiterKey: string;
  funder: "buyer" | "seller";
  network: VerifierNetwork;
  refundLockUntil: number;
  txid: string;
  vout: number;
  amountSats: bigint;
  destination: string;
  feeRateSatsPerVb: bigint;
  maxFeeSats: bigint;
}

function networkFor(network: VerifierNetwork): typeof SIGNET | typeof MAINNET {
  return network === "signet" ? SIGNET : MAINNET;
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

export async function fetchOutspend(
  network: VerifierNetwork,
  txid: string,
  vout: number,
): Promise<{ spent: boolean }> {
  const base =
    network === "signet"
      ? "https://mutinynet.com/api"
      : "https://mempool.space/api";
  const url = `${base}/tx/${txid}/outspend/${vout}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Esplora outspend fetch failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { spent?: unknown };
  if (typeof data.spent !== "boolean") {
    throw new Error(`Malformed outspend response for ${txid}:${vout}: ${JSON.stringify(data)}`);
  }
  return { spent: data.spent };
}

export function parseArgs(argv: string[]): RecoveryInputs {
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
  const expectedAddress = requireFlag("--expected-address");
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

  const refundLockUntil = parseInt(requireFlag("--refund-lock-until"), 10);
  if (!Number.isInteger(refundLockUntil) || refundLockUntil <= 0) {
    throw new Error("--refund-lock-until must be a positive integer");
  }

  const txid = requireFlag("--txid");
  const vout = parseInt(requireFlag("--vout"), 10);
  if (!Number.isInteger(vout) || vout < 0) throw new Error("--vout must be a non-negative integer");

  const amountSats = BigInt(requireFlag("--amount-sats"));
  if (amountSats <= 0n) throw new Error("--amount-sats must be positive");

  const destination = requireFlag("--destination");
  const feeRateSatsPerVb = BigInt(get("--fee-rate") ?? "1");
  if (feeRateSatsPerVb <= 0n) throw new Error("--fee-rate must be positive");

  const maxFeeSats = BigInt(requireFlag("--max-fee-sats"));
  if (maxFeeSats <= 0n || maxFeeSats >= amountSats) {
    throw new Error("--max-fee-sats must be positive and less than --amount-sats");
  }

  for (const [name, key] of [
    ["--buyer-key", buyerKey],
    ["--seller-key", sellerKey],
    ["--arbiter-key", arbiterKey],
  ] as const) {
    if (!HEX_64.test(key)) throw new Error(`${name} must be 64 hex chars`);
  }
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("--txid must be 64 hex chars");

  const btcNetwork = networkFor(networkRaw);
  for (const [name, addr] of [["--expected-address", expectedAddress], ["--destination", destination]] as const) {
    try {
      const decoded = btc.Address(btcNetwork).decode(addr);
      if (decoded.type !== "tr") {
        throw new Error("must be a Taproot (P2TR) address");
      }
    } catch (err) {
      throw new Error(
        `${name} does not decode as a ${networkRaw} P2TR address: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    parentId,
    expectedAddress,
    buyerKey,
    sellerKey,
    arbiterKey,
    funder: funderRaw,
    network: networkRaw,
    refundLockUntil,
    txid,
    vout,
    amountSats,
    destination,
    feeRateSatsPerVb,
    maxFeeSats,
  };
}

export function buildRecoveryEscrow(inputs: RecoveryInputs): OnchainEscrow {
  const network = networkFor(inputs.network);
  return buildOnchainEscrow({
    buyerXonly: hexToBytes(inputs.buyerKey),
    sellerXonly: hexToBytes(inputs.sellerKey),
    arbiterXonly: hexToBytes(inputs.arbiterKey),
    funder: inputs.funder,
    refundLockUntil: inputs.refundLockUntil,
    disputeCsvBlocks: DISPUTE_CSV_BLOCKS,
    network,
  });
}

export interface RecoveryVerification {
  escrow: OnchainEscrow;
  scriptpubkey: string;
  valueSats: number;
}

export async function verifyLiveFunding(
  inputs: RecoveryInputs,
  fetchOutput: typeof fetchFundingOutput = fetchFundingOutput,
  checkOutspend: typeof fetchOutspend = fetchOutspend,
): Promise<RecoveryVerification> {
  const escrow = buildRecoveryEscrow(inputs);
  if (escrow.address !== inputs.expectedAddress) {
    throw new Error(
      `Reconstructed address does not match expected address:\n  expected: ${inputs.expectedAddress}\n  actual:   ${escrow.address}`,
    );
  }

  const out = await fetchOutput(inputs.network, inputs.txid, inputs.vout);
  const expectedScript = bytesToHex(escrow.script);
  if (out.scriptpubkey !== expectedScript) {
    throw new Error(
      `Live output script does not match reconstructed escrow:\n  expected: ${expectedScript}\n  actual:   ${out.scriptpubkey}`,
    );
  }
  if (BigInt(out.value) !== inputs.amountSats) {
    throw new Error(
      `Live output amount does not match expected sats:\n  expected: ${inputs.amountSats}\n  actual:   ${out.value}`,
    );
  }

  const spendStatus = await checkOutspend(inputs.network, inputs.txid, inputs.vout);
  if (typeof spendStatus.spent !== "boolean") {
    throw new Error(
      `Malformed outspend status for ${inputs.txid}:${inputs.vout}: ${JSON.stringify(spendStatus)}`,
    );
  }
  if (spendStatus.spent) {
    throw new Error(`Live output ${inputs.txid}:${inputs.vout} has already been spent`);
  }

  return { escrow, scriptpubkey: out.scriptpubkey, valueSats: out.value };
}

export function buildRecoveryPsbt(verified: RecoveryVerification, inputs: RecoveryInputs): string {
  const { escrow } = verified;
  if (inputs.destination === escrow.address) {
    throw new Error("Recovery destination must not be the same as the escrow address");
  }

  const feeSats = BigInt(LEAF_SPEND_VSIZE.coop) * inputs.feeRateSatsPerVb;
  if (feeSats > inputs.maxFeeSats) {
    throw new Error(
      `Computed fee ${feeSats} sats exceeds --max-fee-sats ${inputs.maxFeeSats}`,
    );
  }

  const utxo = {
    txid: inputs.txid,
    index: inputs.vout,
    amountSats: inputs.amountSats,
  } as const;

  const psbt = buildSettlementPsbt({
    escrow,
    utxos: [utxo],
    destination: inputs.destination,
    feeSats,
    leaf: "coop",
  });

  const check = verifySettlementPsbt(psbt, {
    escrow,
    utxos: [utxo],
    destination: inputs.destination,
    maxFeeSats: inputs.maxFeeSats,
    network: escrow.params.network,
    leaf: "coop",
  });
  if (!check.ok) {
    throw new Error(`Recovery PSBT verification failed:\n${check.failures.join("\n")}`);
  }

  return psbt;
}

function printResult(
  inputs: RecoveryInputs,
  verified: RecoveryVerification,
  psbt: string,
): void {
  const feeSats = BigInt(LEAF_SPEND_VSIZE.coop) * inputs.feeRateSatsPerVb;
  const payout = inputs.amountSats - feeSats;
  console.log("RECOVERY PSBT BUILT (unsigned, cooperative 2-of-2 buyer+seller spend)");
  console.log(`  parent id:             ${inputs.parentId}`);
  console.log(`  parent escrow address: ${verified.escrow.address}`);
  console.log(`  script hex:            ${bytesToHex(verified.escrow.script)}`);
  console.log(`  live funded output:    ${inputs.txid}:${inputs.vout}`);
  console.log(`  live output value:     ${verified.valueSats} sats`);
  console.log(`  destination:           ${inputs.destination}`);
  console.log(`  payout:                ${payout} sats`);
  console.log(`  fee:                   ${feeSats} sats @ ${inputs.feeRateSatsPerVb} sat/vB`);
  console.log(`  max fee ceiling:       ${inputs.maxFeeSats} sats`);
  console.log(`  PSBT (base64):`);
  console.log(psbt);
}

export async function main(argv: string[]): Promise<void> {
  const inputs = parseArgs(argv);
  const verified = await verifyLiveFunding(inputs);
  const psbt = buildRecoveryPsbt(verified, inputs);
  printResult(inputs, verified, psbt);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
