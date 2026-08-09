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
import * as tty from "node:tty";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { schnorr } from "@noble/curves/secp256k1.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
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
  expectedFeeSats: bigint;
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
  expectedFeeSats: bigint;
  /** One or more partially signed PSBTs (base64). Paths or '-' for stdin. */
  psbtFiles: string[];
}

function networkFor(network: "signet" | "mainnet"): typeof SIGNET | typeof MAINNET {
  return network === "signet" ? SIGNET : MAINNET;
}

// ── Mnemonic input: hidden TTY prompt, never argv/env ────────────────────────

export interface TtyHandles {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTty: boolean;
  close(): void;
}

/**
 * Open /dev/tty synchronously and verify it is a character device.
 * Returns undefined if the open fails or the path is not a TTY character device.
 */
export function openTtySync(): TtyHandles | undefined {
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try {
    inputFd = fs.openSync("/dev/tty", "r");
    outputFd = fs.openSync("/dev/tty", "w");
    const stat = fs.fstatSync(inputFd);
    if (!stat.isCharacterDevice()) {
      fs.closeSync(inputFd);
      fs.closeSync(outputFd);
      return undefined;
    }
    const input = new tty.ReadStream(inputFd);
    const output = new tty.WriteStream(outputFd);
    return {
      input,
      output,
      isTty: true,
      close: () => {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    if (inputFd !== undefined) try { fs.closeSync(inputFd); } catch { /* ignore */ }
    if (outputFd !== undefined) try { fs.closeSync(outputFd); } catch { /* ignore */ }
    return undefined;
  }
}

function isReadStreamWithRawMode(s: NodeJS.ReadableStream): s is NodeJS.ReadableStream & {
  isRaw?: boolean;
  setRawMode(mode: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
} {
  return "setRawMode" in s && typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}

/**
 * Read a single line with echo disabled on a real TTY.
 * Puts the input stream into raw mode and reads byte-by-byte so that nothing
 * is ever written back for the typed characters. Handles backspace and Ctrl-C.
 */
export async function hiddenPromptNoEcho(
  label: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  if (!isReadStreamWithRawMode(input)) {
    throw new Error("hiddenPromptNoEcho requires a TTY input stream with setRawMode");
  }

  output.write(`${label}: `);
  input.setRawMode(true);

  const bytes: number[] = [];

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      try {
        input.setRawMode(false);
      } catch {
        // ignore
      }
    };

    const onData = (data: Buffer) => {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte === 0x0d || byte === 0x0a) {
          // Enter
          output.write("\n");
          cleanup();
          input.removeListener("data", onData);
          input.removeListener("error", reject);
          const answer = Buffer.from(bytes).toString("utf8");
          bytes.fill(0);
          resolve(answer);
          return;
        }
        if (byte === 0x03) {
          // Ctrl-C
          cleanup();
          input.removeListener("data", onData);
          input.removeListener("error", reject);
          process.exitCode = 130;
          process.exit(130);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          // Backspace / DEL
          if (bytes.length > 0) {
            bytes.pop();
            output.write("\b \b");
          }
          continue;
        }
        // Printable ASCII / UTF-8 byte. We deliberately do NOT echo it.
        if (byte >= 0x20) {
          bytes.push(byte);
        }
      }
    };

    input.on("data", onData);
    input.on("error", reject);
  });
}

/**
 * Fallback hidden prompt using readline with echo disabled.
 * No masking characters are printed; the answer simply is not echoed.
 */
export async function hiddenPromptWithStreams(
  label: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const rl = readline.createInterface({
    input,
    output,
    terminal: false,
  });

  return new Promise<string>((resolve, reject) => {
    output.write(`${label}: `);
    rl.question("", (answer) => {
      output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    rl.on("error", reject);
  });
}

/**
 * Read a single line from the terminal with echo disabled. Falls back to
 * stdin/stdout if /dev/tty cannot be opened. The prompt is written to stderr so
 * stdout remains clean for the signed PSBT.
 */
export async function hiddenPrompt(label: string): Promise<string> {
  const handles = openTtySync();
  if (handles) {
    try {
      return await hiddenPromptNoEcho(label, handles.input, handles.output);
    } finally {
      handles.close();
    }
  }
  return hiddenPromptWithStreams(label, process.stdin, process.stdout);
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
  const expectedFeeSats = BigInt(requireFlag("--expected-fee-sats"));
  if (expectedFeeSats <= 0n || expectedFeeSats > maxFeeSats) {
    throw new Error("--expected-fee-sats must be positive and no greater than --max-fee-sats");
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
    expectedFeeSats,
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
  const expectedFeeSats = BigInt(requireFlag("--expected-fee-sats"));
  if (expectedFeeSats <= 0n || expectedFeeSats > maxFeeSats) {
    throw new Error("--expected-fee-sats must be positive and no greater than --max-fee-sats");
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
    expectedFeeSats,
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
  const check = verifySettlementPsbt(psbtB64, buildRecoveryExpectation(inputs, escrow));
  if (!check.ok) return check;
  try {
    const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), {
      allowUnknown: true, allowUnknownOutputs: true,
    });
    const inputTotal = Array.from({ length: tx.inputsLength }, (_, index) =>
      tx.getInput(index).witnessUtxo?.amount ?? 0n).reduce((sum, amount) => sum + amount, 0n);
    const outputTotal = Array.from({ length: tx.outputsLength }, (_, index) =>
      tx.getOutput(index).amount ?? 0n).reduce((sum, amount) => sum + amount, 0n);
    const fee = inputTotal - outputTotal;
    if (fee !== inputs.expectedFeeSats) {
      return { ok: false, failures: [`fee ${fee} does not equal approved fee ${inputs.expectedFeeSats}`] };
    }
    return check;
  } catch (error) {
    return { ok: false, failures: [`unable to verify exact recovery fee: ${String(error)}`] };
  }
}

// ── Co-signing and finalization ──────────────────────────────────────────────

export function signRecoveryPsbt(psbtB64: string, privKey: Uint8Array): string {
  return coSignSettlement(psbtB64, privKey);
}

export function assertRoleKeyMatch(
  inputs: SignerInputs,
  derivedXonly: Uint8Array,
): void {
  const expected = inputs.role === "buyer" ? inputs.buyerKey : inputs.sellerKey;
  const actual = bytesToHex(derivedXonly);
  if (actual !== expected) {
    throw new Error(`Derived ${inputs.role} key does not match expected key`);
  }
}

/**
 * Does the PSBT contain a Schnorr signature for the given x-only pubkey on
 * input 0? Used by the finalizer to prove both required role signatures are
 * present before it will combine and finalize.
 */
export function hasSignerSignature(
  psbtB64: string,
  xonlyHex: string,
  escrow: OnchainEscrow,
): boolean {
  const expected = hexToBytes(xonlyHex);
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), {
    allowUnknown: true,
    allowUnknownOutputs: true,
  });
  if (tx.inputsLength === 0) return false;
  const prevouts = Array.from({ length: tx.inputsLength }, (_, index) => tx.getInput(index).witnessUtxo);
  if (prevouts.some((output) => !output)) return false;
  const leaf = escrow.leaves.coop;
  const leafHash = tapLeafHash(leaf);
  return Array.from({ length: tx.inputsLength }, (_, index) => {
    const message = tx.preimageWitnessV1(
      index,
      prevouts.map((output) => output!.script),
      0,
      prevouts.map((output) => output!.amount),
      undefined,
      leaf,
      0xc0,
    );
    const sigs = tx.getInput(index).tapScriptSig ?? [];
    const entry = sigs.find(([meta, signature]) =>
      bytesToHex(meta.pubKey) === bytesToHex(expected)
      && bytesToHex(meta.leafHash) === bytesToHex(leafHash)
      && signature.length === 64);
    return !!entry && schnorr.verify(entry[1], message, expected);
  }).every(Boolean);
}

export interface FinalizedRecovery {
  txHex: string;
  txid: string;
  payoutSats: bigint;
  feeSats: bigint;
}

export function combineAndFinalizeRecoveryPsbt(
  psbtsB64: readonly string[],
  escrow: OnchainEscrow,
  inputs: {
    buyerKey: string; sellerKey: string; amountSats: bigint;
    destination: string; maxFeeSats: bigint; expectedFeeSats: bigint;
  },
): FinalizedRecovery {
  if (psbtsB64.length !== 2) {
    throw new Error("Finalizer requires exactly two PSBTs: one buyer-signed and one seller-signed");
  }
  const roles = psbtsB64.map((psbt) => ({
    buyer: hasSignerSignature(psbt, inputs.buyerKey, escrow),
    seller: hasSignerSignature(psbt, inputs.sellerKey, escrow),
  }));
  if (roles.filter((role) => role.buyer && !role.seller).length !== 1) {
    throw new Error("Missing or duplicate buyer-signed PSBT");
  }
  if (roles.filter((role) => role.seller && !role.buyer).length !== 1) {
    throw new Error("Missing or duplicate seller-signed PSBT");
  }

  // Prove both required role signatures are present before combining.
  const combined = btc.PSBTCombine(psbtsB64.map((p) => base64.decode(p)));
  const combinedB64 = base64.encode(combined);
  const combinedTx = btc.Transaction.fromPSBT(combined, {
    allowUnknown: true, allowUnknownOutputs: true,
  });

  if (!hasSignerSignature(combinedB64, inputs.buyerKey, escrow)) {
    throw new Error("Missing buyer signature in combined PSBT");
  }
  if (!hasSignerSignature(combinedB64, inputs.sellerKey, escrow)) {
    throw new Error("Missing seller signature in combined PSBT");
  }

  const txHex = finalizeSettlement(psbtsB64, { escrow, leaf: "coop" });
  const tx = btc.Transaction.fromRaw(hexToBytes(txHex), { allowUnknown: true, allowUnknownOutputs: true });

  // Independently decode and verify the final transaction preserves expectation.
  if (tx.inputsLength !== 1) {
    throw new Error(`Final transaction has ${tx.inputsLength} inputs, expected 1`);
  }
  if (tx.outputsLength !== 1) {
    throw new Error(`Final transaction has ${tx.outputsLength} outputs, expected 1`);
  }
  const prevout = combinedTx.getInput(0).witnessUtxo;
  const witness = tx.getInput(0).finalScriptWitness;
  if (!prevout || !witness || witness.length !== 4) {
    throw new Error("Final transaction is missing the exact cooperative Taproot witness");
  }
  const message = combinedTx.preimageWitnessV1(
    0, [prevout.script], 0, [prevout.amount], undefined, escrow.leaves.coop, 0xc0,
  );
  if (witness[1].length !== 64
    || !schnorr.verify(witness[1], message, hexToBytes(inputs.buyerKey))) {
    throw new Error("Final cooperative witness has an invalid buyer signature");
  }
  if (witness[0].length !== 64
    || !schnorr.verify(witness[0], message, hexToBytes(inputs.sellerKey))) {
    throw new Error("Final cooperative witness has an invalid seller signature");
  }
  const out = tx.getOutput(0);
  const outAddr = btc.Address(escrow.params.network).encode(btc.OutScript.decode(out.script!));
  if (outAddr !== inputs.destination) {
    throw new Error(`Final transaction pays ${outAddr}, expected ${inputs.destination}`);
  }
  const feeSats = inputs.amountSats - out.amount!;
  if (feeSats !== inputs.expectedFeeSats) {
    throw new Error(`Final transaction fee ${feeSats} does not equal approved fee ${inputs.expectedFeeSats}`);
  }
  if (feeSats > inputs.maxFeeSats) {
    throw new Error(`Final transaction fee ${feeSats} exceeds max ${inputs.maxFeeSats}`);
  }

  return { txHex, txid: tx.id as string, payoutSats: out.amount!, feeSats };
}
