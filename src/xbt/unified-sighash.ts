// ═══════════════════════════════════════════════════════════════════════════
// XBT (Bitcoin BLAKE2b) — SIGHASH_UNIFIED
// ═══════════════════════════════════════════════════════════════════════════
//
// SIGHASH_UNIFIED (flag 0x20) is the one opt-in signature hash the XBT fork
// added, for every input type. Setting the bit changes WHICH MESSAGE is signed
// and nothing else: signatures are still made and verified the usual way for
// the script type. The message is BIP341-shaped and the digest is
// TaggedHash("UnifiedSighash", message).
//
// Why it matters for money: XBT and Bitcoin share history and addresses, so a
// transaction signed the old way can be valid on BOTH chains. A signature that
// opts in commits to a message Bitcoin does not know, so it cannot be replayed
// there. The protection is one-way and per-signature: it exists only for
// inputs whose signer set the bit.
//
// Pure functions only; nothing here signs or holds a key. Reference: Bitcoin
// Knots `doc/unified-sighash.md`, as mirrored by bitcoin-blake/electrum-xbt
// `electrum/unified.py`. Checked against the reference's 166 vectors in
// ./tests.ts.

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { taggedHash } from "./header-v2.js";

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_UNIFIED = 0x20;
export const SIGHASH_ANYONECANPAY = 0x80;

/** ALL | UNIFIED. The only hash type an XBT money path should produce: it
 *  commits to every input, every amount and every output, and it cannot be
 *  replayed on Bitcoin. */
export const SIGHASH_ALL_UNIFIED = SIGHASH_ALL | SIGHASH_UNIFIED;

export const UnifiedScriptType = {
  /** Bare or P2SH. */
  LEGACY: 0,
  WITNESS_V0: 1,
  /** Taproot key path. */
  TAPROOT: 2,
  TAPSCRIPT: 3,
} as const;
export type UnifiedScriptType = (typeof UnifiedScriptType)[keyof typeof UnifiedScriptType];

const NO_CODESEPARATOR = 0xffffffff;
const TAPROOT_LEAF_TAPSCRIPT = 0xc0;
const TAPROOT_BASE_TYPES = new Set([0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);

/** The parts of a transaction the digest needs. */
export interface SighashTx {
  /** The 4 raw version bytes as serialized. */
  version: Uint8Array;
  locktime: number;
  inputs: { /** 36 bytes: txid (wire order) + output index. */ prevout: Uint8Array; sequence: number }[];
  /** Each output as serialized: 8-byte value, compact-size script length, script. */
  outputs: Uint8Array[];
}

export interface SpentOutput {
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface UnifiedSighashArgs {
  tx: SighashTx;
  /** The output each input spends, in input order. All of them are required
   *  even to sign one input: the digest commits to every amount and script. */
  spentOutputs: SpentOutput[];
  inputIndex: number;
  hashType: number;
  scriptType: UnifiedScriptType;
  /** LEGACY and WITNESS_V0 only. */
  scriptCode?: Uint8Array;
  /** TAPROOT and TAPSCRIPT only; without its compact-size prefix. */
  annex?: Uint8Array;
  /** TAPSCRIPT only. */
  leafHash?: Uint8Array;
  codeSeparatorPosition?: number;
}

function compactSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad compact size ${n}`);
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  const out = new Uint8Array(9);
  out[0] = 0xff;
  new DataView(out.buffer).setBigUint64(1, BigInt(n), true);
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

function i64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, n, true);
  return out;
}

function withLength(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes);
}

export function tapLeafHash(script: Uint8Array, leafVersion: number = TAPROOT_LEAF_TAPSCRIPT): Uint8Array {
  return taggedHash("TapLeaf", concatBytes(Uint8Array.of(leafVersion), withLength(script)));
}

/** The message a signature over an opted-in input commits to. Throws when the
 *  hash type does not opt in, or the inputs are inconsistent: a digest must
 *  never be produced for a transaction the caller has described wrongly. */
export function unifiedSighashMessage(args: UnifiedSighashArgs): Uint8Array {
  const { tx, spentOutputs, inputIndex, hashType, scriptType } = args;
  if (!Number.isInteger(hashType) || hashType < 0 || hashType > 0xff) throw new Error(`bad hash type ${hashType}`);
  if (!(hashType & SIGHASH_UNIFIED)) throw new Error("hash type does not opt in to SIGHASH_UNIFIED");
  const taproot = scriptType === UnifiedScriptType.TAPROOT || scriptType === UnifiedScriptType.TAPSCRIPT;
  if (taproot && !TAPROOT_BASE_TYPES.has(hashType & ~SIGHASH_UNIFIED)) {
    throw new Error(`hash type 0x${hashType.toString(16)} is not defined for taproot`);
  }
  if (tx.version.length !== 4) throw new Error("version must be the 4 serialized bytes");
  if (spentOutputs.length !== tx.inputs.length) {
    throw new Error(`need the spent output of every input: ${spentOutputs.length} for ${tx.inputs.length} inputs`);
  }
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`input index ${inputIndex} out of range`);
  }
  for (const input of tx.inputs) {
    if (input.prevout.length !== 36) throw new Error("prevout must be 36 bytes");
  }

  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const base = hashType & 0x1f;
  const parts: Uint8Array[] = [
    Uint8Array.of(0),                      // epoch
    Uint8Array.of(hashType),
    tx.version,
    u32(tx.locktime), Uint8Array.of(0),    // locktime, widened to 5 bytes
  ];
  if (!anyoneCanPay) {
    parts.push(
      sha256(concatBytes(...tx.inputs.map(i => i.prevout))),
      sha256(concatBytes(...spentOutputs.map(o => i64(o.value)))),
      sha256(concatBytes(...spentOutputs.map(o => withLength(o.scriptPubKey)))),
      sha256(concatBytes(...tx.inputs.map(i => u32(i.sequence)))),
    );
  }
  if (base !== SIGHASH_NONE && base !== SIGHASH_SINGLE) {
    parts.push(sha256(concatBytes(...tx.outputs)));
  }
  parts.push(Uint8Array.of(scriptType));
  if (anyoneCanPay) {
    const spent = spentOutputs[inputIndex];
    parts.push(
      tx.inputs[inputIndex].prevout, i64(spent.value), withLength(spent.scriptPubKey),
      u32(tx.inputs[inputIndex].sequence),
    );
  } else {
    parts.push(u32(inputIndex));
  }
  if (!taproot) {
    parts.push(withLength(args.scriptCode ?? new Uint8Array(0)));
  } else if (args.annex !== undefined) {
    parts.push(Uint8Array.of(1), sha256(withLength(args.annex)));
  } else {
    parts.push(Uint8Array.of(0));
  }
  if (base === SIGHASH_SINGLE) {
    if (inputIndex >= tx.outputs.length) throw new Error("SIGHASH_SINGLE without a corresponding output");
    parts.push(sha256(tx.outputs[inputIndex]));
  }
  if (scriptType === UnifiedScriptType.TAPSCRIPT) {
    if (!args.leafHash || args.leafHash.length !== 32) throw new Error("tapscript spend needs its 32-byte leaf hash");
    parts.push(args.leafHash, Uint8Array.of(0), u32(args.codeSeparatorPosition ?? NO_CODESEPARATOR));
  }
  return concatBytes(...parts);
}

/** The 32-byte digest a signature over an opted-in input commits to. */
export function unifiedSighash(args: UnifiedSighashArgs): Uint8Array {
  return taggedHash("UnifiedSighash", unifiedSighashMessage(args));
}

/**
 * Does this serialized signature opt in to SIGHASH_UNIFIED?
 *
 * `ecdsa`: a DER signature followed by one hash-type byte (legacy, segwit v0).
 * `schnorr`: 64 bytes means SIGHASH_DEFAULT, which CANNOT opt in; 65 bytes
 * carries the hash type last.
 *
 * This reads the flag only. It does not verify the signature, and it says
 * nothing about a transaction's other inputs.
 */
export function signatureOptsInToUnified(signature: Uint8Array, kind: "ecdsa" | "schnorr"): boolean {
  if (kind === "schnorr") {
    return signature.length === 65 && (signature[64] & SIGHASH_UNIFIED) !== 0;
  }
  // Shortest DER signature is 8 bytes; plus the hash-type byte.
  if (signature.length < 9 || signature[0] !== 0x30) return false;
  return (signature[signature.length - 1] & SIGHASH_UNIFIED) !== 0;
}

/** Decode just enough of a serialized transaction (with or without witness
 *  data) to compute sighashes. Throws on truncated or trailing bytes. */
export function decodeTxForSighash(raw: Uint8Array): SighashTx {
  let pos = 0;
  const take = (n: number): Uint8Array => {
    if (pos + n > raw.length) throw new Error("transaction is truncated");
    const out = raw.slice(pos, pos + n);
    pos += n;
    return out;
  };
  const readU32 = (): number => {
    const b = take(4);
    return new DataView(b.buffer).getUint32(0, true);
  };
  const readCompact = (): number => {
    const first = take(1)[0];
    if (first < 0xfd) return first;
    const b = take(first === 0xfd ? 2 : first === 0xfe ? 4 : 8);
    const view = new DataView(b.buffer);
    if (first === 0xfd) return view.getUint16(0, true);
    if (first === 0xfe) return view.getUint32(0, true);
    const n = view.getBigUint64(0, true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("compact size too large");
    return Number(n);
  };

  const version = take(4);
  let inputCount = readCompact();
  let segwit = false;
  if (inputCount === 0) {
    // Segwit marker (0x00) and flag (0x01).
    if (take(1)[0] !== 1) throw new Error("unknown transaction flag");
    segwit = true;
    inputCount = readCompact();
  }
  const inputs: SighashTx["inputs"] = [];
  for (let i = 0; i < inputCount; i++) {
    const prevout = take(36);
    take(readCompact());                   // scriptSig
    inputs.push({ prevout, sequence: readU32() });
  }
  const outputCount = readCompact();
  const outputs: Uint8Array[] = [];
  for (let i = 0; i < outputCount; i++) {
    const start = pos;
    take(8);
    take(readCompact());
    outputs.push(raw.slice(start, pos));
  }
  if (segwit) {
    for (let i = 0; i < inputCount; i++) {
      const items = readCompact();
      for (let j = 0; j < items; j++) take(readCompact());
    }
  }
  const locktime = readU32();
  if (pos !== raw.length) throw new Error("trailing bytes after transaction");
  return { version, locktime, inputs, outputs };
}
