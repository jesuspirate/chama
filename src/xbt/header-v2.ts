// ═══════════════════════════════════════════════════════════════════════════
// XBT (Bitcoin BLAKE2b) — block header v2
// ═══════════════════════════════════════════════════════════════════════════
//
// The XBT chain is the Bitcoin Knots hard fork that moved proof of work from
// SHA256d to BLAKE2b at mainnet height 961,640. From that height on, block
// headers are 164 bytes, not 80, and the block hash is no longer SHA256d of
// the header.
//
// Pure functions only: no network, no storage, no clock. Nothing in the app
// calls this module yet. It exists so that anything later built for XBT — a
// federation's peg-in proofs, an explorer probe, a light client — starts from
// a header parser that is checked against the reference vectors and against
// real mainnet blocks (see ./tests.ts), rather than from a guess.
//
// Wire layout (164 bytes, all integers little-endian):
//
//   off  len  field
//     0    4  version | 0x80000000       top bit marks a v2 header
//     4   32  previous block hash        internal (reversed) byte order
//    36   32  merkle root
//    68    4  time on wire               = time - time_offset when flags & 4
//    72    4  bits
//    76    4  nonce
//    80    4  nonce2
//    84    4  nonce3
//    88   16  extranonce
//   104    4  time_offset
//   108    2  tx_count
//   110    1  flags                      bits 0-1 ASIC profile, bit 2 time offset
//   111    1  xor_key_mask_clear_bits
//   112   16  xor_key
//   128    4  height                     signed
//   132   32  mm_rhs                     merge-mining hook, reserved
//
// Reference: Bitcoin Knots `primitives/block.cpp` (CBlockHeader::GetHash), as
// mirrored by bitcoin-blake/electrum-xbt `electrum/blake.py`.

import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const LEGACY_HEADER_SIZE = 80;
export const HEADER_V2_SIZE = 164;
export const VERSION_HEADER_V2_FLAG = 0x80000000;
const FLAG_USE_TIME_OFFSET = 4;

/** A decoded v2 header. Hash-like fields keep their WIRE byte order; use
 *  `displayHex` to print one the way a node or explorer does. */
export interface HeaderV2 {
  /** Block version WITHOUT the v2 marker bit. */
  version: number;
  prevBlockHash: Uint8Array;
  merkleRoot: Uint8Array;
  /** Block time in seconds, with the time offset already applied. */
  time: number;
  bits: number;
  nonce: number;
  nonce2: number;
  nonce3: number;
  extranonce: Uint8Array;
  timeOffset: number;
  txCount: number;
  flags: number;
  xorKeyMaskClearBits: number;
  xorKey: Uint8Array;
  /** The height the header claims for itself. A verifier must compare it
   *  with the height it expects; the claim alone proves nothing. */
  height: number;
  mmRhs: Uint8Array;
}

export interface HeaderV2Hash {
  /** Block hash as a node prints it (big-endian hex). */
  blockHash: string;
  /** Every intermediate, for comparison with the reference vectors. */
  xorKeyHash: Uint8Array;
  h1: Uint8Array;
  h2: Uint8Array;
  blake2b1: Uint8Array;
  blake2b2: Uint8Array;
  mask: Uint8Array;
  asicProfile: number;
  asicInput: Uint8Array;
}

/** Reverse a hash between wire order and display order. */
export function displayHex(wire: Uint8Array): string {
  return bytesToHex(wire.slice().reverse());
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

/** Bitcoin's tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg). */
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(t, t, msg));
}

function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

/** True when raw header bytes carry the v2 marker (top bit of version). */
export function isHeaderV2(raw: Uint8Array): boolean {
  return raw.length >= 4 && (raw[3] & 0x80) !== 0;
}

/** Decode exactly 164 bytes. Throws on any other length or a missing marker:
 *  a header that is not plainly v2 must never be half-accepted. */
export function parseHeaderV2(raw: Uint8Array): HeaderV2 {
  if (raw.length !== HEADER_V2_SIZE) {
    throw new Error(`header v2 must be ${HEADER_V2_SIZE} bytes, got ${raw.length}`);
  }
  if (!isHeaderV2(raw)) throw new Error("not a v2 header (version top bit clear)");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const timeOnWire = view.getUint32(68, true);
  const timeOffset = view.getUint32(104, true);
  const flags = raw[110];
  return {
    version: (view.getUint32(0, true) & ~VERSION_HEADER_V2_FLAG) >>> 0,
    prevBlockHash: raw.slice(4, 36),
    merkleRoot: raw.slice(36, 68),
    time: flags & FLAG_USE_TIME_OFFSET ? (timeOnWire + timeOffset) >>> 0 : timeOnWire,
    bits: view.getUint32(72, true),
    nonce: view.getUint32(76, true),
    nonce2: view.getUint32(80, true),
    nonce3: view.getUint32(84, true),
    extranonce: raw.slice(88, 104),
    timeOffset,
    txCount: view.getUint16(108, true),
    flags,
    xorKeyMaskClearBits: raw[111],
    xorKey: raw.slice(112, 128),
    height: view.getInt32(128, true),
    mmRhs: raw.slice(132, 164),
  };
}

function timeOnWire(h: HeaderV2): number {
  return h.flags & FLAG_USE_TIME_OFFSET ? (h.time - h.timeOffset) >>> 0 : h.time >>> 0;
}

function wireVersion(h: HeaderV2): Uint8Array {
  return u32((VERSION_HEADER_V2_FLAG | h.version) >>> 0);
}

function checkLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) throw new Error(`${name} must be ${length} bytes, got ${bytes.length}`);
}

function checkHeader(h: HeaderV2): void {
  checkLength("prevBlockHash", h.prevBlockHash, 32);
  checkLength("merkleRoot", h.merkleRoot, 32);
  checkLength("extranonce", h.extranonce, 16);
  checkLength("xorKey", h.xorKey, 16);
  checkLength("mmRhs", h.mmRhs, 32);
}

export function serializeHeaderV2(h: HeaderV2): Uint8Array {
  checkHeader(h);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint16(0, h.txCount, true);
  tail[2] = h.flags & 0xff;
  tail[3] = h.xorKeyMaskClearBits & 0xff;
  const height = new Uint8Array(4);
  new DataView(height.buffer).setInt32(0, h.height, true);
  return concatBytes(
    wireVersion(h), h.prevBlockHash, h.merkleRoot,
    u32(timeOnWire(h)), u32(h.bits), u32(h.nonce), u32(h.nonce2), u32(h.nonce3),
    h.extranonce, u32(h.timeOffset), tail, h.xorKey, height, h.mmRhs,
  );
}

/** The full hash pipeline, with every intermediate exposed. */
export function hashHeaderV2Detailed(h: HeaderV2): HeaderV2Hash {
  checkHeader(h);
  const prevDisplay = h.prevBlockHash.slice().reverse();
  const xorKeyHash = taggedHash("Bitcoin block hash PoW XOR key", h.xorKey);

  // The mask is zero for a null key. Otherwise its leading `clearBits` bits
  // (the most significant ones of the displayed hash) are cleared, so the mask
  // never touches the bits proof of work is measured on.
  const mask = new Uint8Array(32);
  if (h.xorKey.some(b => b !== 0)) {
    mask.set(taggedHash("Bitcoin block hash PoW XOR mask", h.xorKey));
    const clearBits = h.xorKeyMaskClearBits & 0xff;
    const clearBytes = clearBits >> 3;
    for (let i = 0; i < Math.min(clearBytes, 32); i++) mask[i] = 0;
    if (clearBytes < 32) mask[clearBytes] &= 0xff >> (clearBits & 7);
  }

  const prevHidden = taggedHash("Bitcoin prevblock header, hashed", prevDisplay);

  const h1 = taggedHash("Bitcoin block header 1", concatBytes(
    wireVersion(h), prevDisplay, u32(h.height), h.merkleRoot,
    u32(timeOnWire(h)), new Uint8Array(1), u32(h.bits), u32(h.txCount),
    Uint8Array.of(h.flags & 0xff, h.xorKeyMaskClearBits & 0xff), xorKeyHash,
  ));
  const h2 = taggedHash("Merge-mining hook", concatBytes(h1, new Uint8Array(32), h.mmRhs));
  const blake2b1 = blake2b256(concatBytes(u32(0), h2, h.extranonce));

  const nonce = u32(h.nonce), nonce2 = u32(h.nonce2), nonce3 = u32(h.nonce3), offset = u32(h.timeOffset);
  const nonces = concatBytes(nonce, nonce2, offset, nonce3);
  const asicProfile = h.flags & 3;
  let asicInput: Uint8Array;
  if (asicProfile === 0) {
    asicInput = concatBytes(new Uint8Array(6), prevHidden.slice(6), nonces, blake2b1);
  } else if (asicProfile === 1) {
    asicInput = concatBytes(nonce, nonce2, nonce3, offset, blake2b1, h2);
  } else if (asicProfile === 2) {
    asicInput = concatBytes(new Uint8Array(48), h2, nonces, blake2b1);
  } else {
    asicInput = concatBytes(new Uint8Array(80), h2, nonces, blake2b1);
  }
  const blake2b2 = blake2b256(asicInput);
  const hash = blake2b2.map((b, i) => b ^ mask[i]);
  return {
    blockHash: bytesToHex(hash),
    xorKeyHash, h1, h2, blake2b1, blake2b2, mask, asicProfile, asicInput,
  };
}

/** Block hash of a decoded v2 header, as a node prints it. */
export function hashHeaderV2(h: HeaderV2): string {
  return hashHeaderV2Detailed(h).blockHash;
}

/** Block hash of 164 raw header bytes, as a node prints it. */
export function hashRawHeaderV2(raw: Uint8Array): string {
  return hashHeaderV2(parseHeaderV2(raw));
}

/** The previous-block hash a header commits to, as a node prints it. */
export function prevBlockHashHex(h: HeaderV2): string {
  return displayHex(h.prevBlockHash);
}

export function headerV2FromHex(hex: string): HeaderV2 {
  return parseHeaderV2(hexToBytes(hex));
}
