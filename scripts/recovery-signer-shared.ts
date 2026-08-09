// ─────────────────────────────────────────────────────────────────────────────
// Shared recovery signer/finalizer primitives.
//
// Accepts the mnemonic only through a hidden TTY prompt (or stdin/stdout
// fallback). The mnemonic never travels on argv or in the environment. Derived
// seed and private key buffers are explicitly zeroed after use; the mnemonic
// string reference is dropped as soon as possible (best effort in JS).
//
// Supports PSBT input via file path or stdin, verifies live funding and the
// settlement expectation locally, co-signs a cooperative recovery PSBT, and
// combines/finalizes partially signed PSBTs. No relay writes, no broadcast.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import {
  buildOnchainEscrow,
  type OnchainEscrow,
} from "../src/bond-multisig/onchain-escrow.js";
import {
  coSignSettlement,
  finalizeSettlement,
  verifySettlementPsbt,
  type SettlementCheck,
} from "../src/bond-multisig/onchain-escrow-settle.js";
import {
  fetchFundingOutput,
  fetchOutspend,
  type RecoveryInputs,
  type RecoveryVerification,
  buildRecoveryEscrow,
} from "./build-recovery-psbt.js";
import { SIGNET, MAINNET, type BtcNetwork } from "../src/bond-multisig/multisig.js";

const HEX_64 = /^[0-9a-f]{64}$/i;

export type SignerRole = "buyer" | "seller";

export interface SignerInputs {
  role: SignerRole;
  parentId: string;
  expectedAddress: string;
  buyerKey: string;
  sellerKey: string;
  arbiterKey: string;
  funder: "buyer" | "seller";
  network: "signet" | "mainnet";
  refundLockUntil: number;
  txid: string;
  vout: number;
  amountSats: bigint;
  destination: string;
  maxFeeSats: bigint;
  /** If provided, read the PSBT from this file; otherwise read from stdin. */
  psbtFile?: string;
}

export interface FinalizerInputs {
  parentId: string;
  expectedAddress: string;
  buyerKey: string;
  sellerKey: string;
  arbiterKey: string;
  funder: "buyer" | "seller";
  network: "signet" | "mainnet";
  refundLockUntil: number;
  txid: string;
  vout: number;
  amountSats: bigint;
  destination: string;
  maxFeeSats: bigint;
  /** One or more partially signed PSBTs (base64). Paths or '-' for stdin. */
  psbtFiles: string[];
}

function networkFor(network: "signet" | "mainnet"): typeof SIGNET | typeof MAINNET {
  return network === "signet" ? SIGNET : MAINNET;
}

// ── Mnemonic input: hidden TTY prompt, never argv/env ────────────────────────

/**
 * Read a single line from the terminal with echo disabled. Falls back to
 * stdin/stdout if /dev/tty cannot be opened. The prompt is written to stderr so
 * stdout remains clean for the signed PSBT.
 */
export async function hiddenPrompt(label: string): Promise<string> {
  const ttyInPath = "/dev/tty";
  const ttyOutPath = "/dev/tty";

  let ttyIn: fs.ReadStream | undefined;
  let ttyOut: fs.WriteStream | undefined;
  try {
    ttyIn = fs.createReadStream(ttyInPath);
    ttyOut = fs.createWriteStream(ttyOutPath);
  } catch {
    // fall through to stdin/stdout
  }

  const input = ttyIn ?? process.stdin;
  const output = ttyOut ?? process.stdout;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input,
      output,
      terminal: true,
    });

    output.write(`${label}: `);
    let masked = false;
    const onKeypress = (_c: string, key: readline.Key) => {
      if (!rl.terminal) return;
      const len = rl.line.length;
      if (key && key.name === "return") {
        output.write("\n");
      } else if (key && key.name === "backspace" && len > 0) {
        output.write("\b \b");
      } else if (key && key.name === "c" && key.ctrl) {
        output.write("\n");
        process.exit(130);
      } else if (key && key.sequence && key.sequence.length === 1) {
        output.write("*");
        masked = true;
      }
    };

    if (rl.terminal) {
      // readline's 'keypress' event is emitted when terminal: true.
      rl.on("keypress", onKeypress as readline.ReadLine & ((c: string, k: readline.Key) => void));
    }

    rl.question("", (answer) => {
      if (!masked && rl.terminal) output.write("\n");
      rl.close();
      resolve(answer.trim());
    });

    rl.on("error", reject);
  });
}

// ── Key derivation with explicit buffer zeroing ──────────────────────────────

export interface DerivedKey {
  priv: Uint8Array;
  xonly: Uint8Array;
  path: string;
}

/**
 * Derive the escrow signing key for (mnemonic, escrowId). The caller MUST call
 * zeroKeyBuffers on the returned object after use. The mnemonic string should
 * be dropped from scope immediately after this call.
 */
export function deriveRecoverySigningKey(
  mnemonic: string,
  escrowId: string,
  network: "signet" | "mainnet",
): DerivedKey {
  if (!escrowId) throw new Error("escrowId is required to derive an escrow key");
  const btcNetwork = networkFor(network);
  const coin = btcNetwork === SIGNET ? 1 : 0;
  // Same path as buildRecoveryEscrow/deriveEscrowSigningKey uses.
  const path = `m/86'/${coin}'/1'/0/${escrowKeyIndexFor(escrowId)}`;
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error("BIP86 derivation produced no private key");
  const priv = node.privateKey.slice();
  const xonly = btc.utils.pubSchnorr(priv);
  // Zero the BIP39 seed buffer immediately.
  seed.fill(0);
  // HDKey holds a reference to the private key we copied; clear its copy too.
  if (node.privateKey) node.privateKey.fill(0);
  return { priv, xonly, path };
}

function escrowKeyIndexFor(escrowId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < escrowId.length; i++) {
    h ^= escrowId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 0x7fffffff;
}

/** Best-effort overwrite of sensitive Uint8Array buffers. */
export function zeroKeyBuffers(...bufs: (Uint8Array | undefined)[]): void {
  for (const b of bufs) {
    if (b) b.fill(0);
  }
}

// ── PSBT I/O ─────────────────────────────────────────────────────────────────

export async function readPsbt(source?: string): Promise<string> {
  const raw =
    source === undefined || source === "-"
      ? await readStdin()
      : await fs.promises.readFile(source, "utf8");
  const trimmed = raw.trim();
  // Accept base64 only. Hex PSBTs are not supported by this tooling.
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    throw new Error("PSBT does not look like base64");
  }
  return trimmed;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseHex64(name: string, value: string): string {
  if (!HEX_64.test(value)) throw new Error(`${name} must be 64 hex chars`);
  return value;
}

function parseP2trAddress(name: string, addr: string, network: "signet" | "mainnet"): void {
  const btcNetwork = networkFor(network);
  try {
    const decoded = btc.Address(btcNetwork).decode(addr);
    if (decoded.type !== "tr") throw new Error("must be a Taproot (P2TR) address");
  } catch (err) {
    throw new Error(
      `${name} does not decode as a ${network} P2TR address: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function parseSignerArgs(argv: string[]): SignerInputs {
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

  const role = get("--role");
  if (role !== "buyer" && role !== "seller") {
    throw new Error('--role must be "buyer" or "seller"');
  }

  const parentId = requireFlag("--parent-id");
  const expectedAddress = requireFlag("--expected-address");
  const buyerKey = parseHex64("--buyer-key", requireFlag("--buyer-key"));
  const sellerKey = parseHex64("--seller-key", requireFlag("--seller-key"));
  const arbiterKey = parseHex64("--arbiter-key", requireFlag("--arbiter-key"));

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
  if (!HEX_64.test(txid)) throw new Error("--txid must be 64 hex chars");

  const vout = parseInt(requireFlag("--vout"), 10);
  if (!Number.isInteger(vout) || vout < 0) throw new Error("--vout must be a non-negative integer");

  const amountSats = BigInt(requireFlag("--amount-sats"));
  if (amountSats <= 0n) throw new Error("--amount-sats must be positive");

  const destination = requireFlag("--destination");
  const maxFeeSats = BigInt(requireFlag("--max-fee-sats"));
  if (maxFeeSats <= 0n || maxFeeSats >= amountSats) {
    throw new Error("--max-fee-sats must be positive and less than --amount-sats");
  }

  parseP2trAddress("--expected-address", expectedAddress, networkRaw);
  parseP2trAddress("--destination", destination, networkRaw);

  return {
    role,
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
    maxFeeSats,
    psbtFile: get("--psbt-file"),
  };
}

export function parseFinalizerArgs(argv: string[]): FinalizerInputs {
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
  const buyerKey = parseHex64("--buyer-key", requireFlag("--buyer-key"));
  const sellerKey = parseHex64("--seller-key", requireFlag("--seller-key"));
  const arbiterKey = parseHex64("--arbiter-key", requireFlag("--arbiter-key"));

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
  if (!HEX_64.test(txid)) throw new Error("--txid must be 64 hex chars");

  const vout = parseInt(requireFlag("--vout"), 10);
  if (!Number.isInteger(vout) || vout < 0) throw new Error("--vout must be a non-negative integer");

  const amountSats = BigInt(requireFlag("--amount-sats"));
  if (amountSats <= 0n) throw new Error("--amount-sats must be positive");

  const destination = requireFlag("--destination");
  const maxFeeSats = BigInt(requireFlag("--max-fee-sats"));
  if (maxFeeSats <= 0n || maxFeeSats >= amountSats) {
    throw new Error("--max-fee-sats must be positive and less than --amount-sats");
  }

  const psbtFiles: string[] = [];
  let idx = args.indexOf("--psbt-file");
  while (idx >= 0) {
    const value = args[idx + 1];
    if (!value) throw new Error("--psbt-file requires a value");
    psbtFiles.push(value);
    idx = args.indexOf("--psbt-file", idx + 1);
  }
  if (psbtFiles.length === 0) {
    throw new Error("At least one --psbt-file is required");
  }

  parseP2trAddress("--expected-address", expectedAddress, networkRaw);
  parseP2trAddress("--destination", destination, networkRaw);

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
    maxFeeSats,
    psbtFiles,
  };
}

// ── Recovery escrow reconstruction ───────────────────────────────────────────

export function buildInputsFromSigner(si: SignerInputs): RecoveryInputs {
  return {
    parentId: si.parentId,
    expectedAddress: si.expectedAddress,
    buyerKey: si.buyerKey,
    sellerKey: si.sellerKey,
    arbiterKey: si.arbiterKey,
    funder: si.funder,
    network: si.network,
    refundLockUntil: si.refundLockUntil,
    txid: si.txid,
    vout: si.vout,
    amountSats: si.amountSats,
    destination: si.destination,
    feeRateSatsPerVb: 1n,
    maxFeeSats: si.maxFeeSats,
  };
}

export function buildInputsFromFinalizer(fi: FinalizerInputs): RecoveryInputs {
  return {
    parentId: fi.parentId,
    expectedAddress: fi.expectedAddress,
    buyerKey: fi.buyerKey,
    sellerKey: fi.sellerKey,
    arbiterKey: fi.arbiterKey,
    funder: fi.funder,
    network: fi.network,
    refundLockUntil: fi.refundLockUntil,
    txid: fi.txid,
    vout: fi.vout,
    amountSats: fi.amountSats,
    destination: fi.destination,
    feeRateSatsPerVb: 1n,
    maxFeeSats: fi.maxFeeSats,
  };
}

export function buildSignerEscrow(inputs: SignerInputs): OnchainEscrow {
  return buildRecoveryEscrow(buildInputsFromSigner(inputs));
}

export function buildFinalizerEscrow(inputs: FinalizerInputs): OnchainEscrow {
  return buildRecoveryEscrow(buildInputsFromFinalizer(inputs));
}

// ── Live funding verification (replicated locally) ───────────────────────────

export async function verifyRecoveryFunding(
  inputs: SignerInputs | FinalizerInputs,
  fetchOutput: typeof fetchFundingOutput = fetchFundingOutput,
  checkOutspend: typeof fetchOutspend = fetchOutspend,
): Promise<RecoveryVerification> {
  const recoveryInputs = "role" in inputs ? buildInputsFromSigner(inputs) : buildInputsFromFinalizer(inputs);
  const escrow = buildRecoveryEscrow(recoveryInputs);
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

// ── Settlement expectation / verification ────────────────────────────────────

export function buildRecoveryExpectation(
  inputs: SignerInputs | FinalizerInputs,
  escrow: OnchainEscrow,
): Parameters<typeof verifySettlementPsbt>[1] {
  return {
    escrow,
    utxos: [{ txid: inputs.txid, index: inputs.vout, amountSats: inputs.amountSats }],
    destination: inputs.destination,
    maxFeeSats: inputs.maxFeeSats,
    network: escrow.params.network,
    leaf: "coop",
  };
}

export function checkRecoveryPsbt(
  psbtB64: string,
  inputs: SignerInputs | FinalizerInputs,
  escrow: OnchainEscrow,
): SettlementCheck {
  return verifySettlementPsbt(psbtB64, buildRecoveryExpectation(inputs, escrow));
}

// ── Co-signing and finalization ──────────────────────────────────────────────

export function signRecoveryPsbt(psbtB64: string, privKey: Uint8Array): string {
  return coSignSettlement(psbtB64, privKey);
}

export function combineAndFinalizeRecoveryPsbt(
  psbtsB64: readonly string[],
  escrow: OnchainEscrow,
): { txHex: string; txid: string } {
  const txHex = finalizeSettlement(psbtsB64, { escrow, leaf: "coop" });
  const tx = btc.Transaction.fromRaw(hexToBytes(txHex), { allowUnknown: true, allowUnknownOutputs: true });
  return { txHex, txid: tx.id as string };
}
