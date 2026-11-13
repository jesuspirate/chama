// ═══════════════════════════════════════════════════════════════════════════
// XBT (Bitcoin BLAKE2b) — chain parameters and proof-of-work arithmetic
// ═══════════════════════════════════════════════════════════════════════════
//
// XBT shares Bitcoin's genesis block and address formats. Nothing about an
// address or the genesis hash tells the two chains apart; the facts below do.
//
// Pure functions only. Reference: Bitcoin Knots `pow.cpp`
// (ApplyBlake2bTargetShift) and PR 419 (long coinbase maturity), as mirrored
// by bitcoin-blake/electrum-xbt.

import {
  HEADER_V2_SIZE, LEGACY_HEADER_SIZE, hashHeaderV2, isHeaderV2, parseHeaderV2, prevBlockHashHex,
  type HeaderV2,
} from "./header-v2.js";

export interface XbtChainParams {
  /** First height whose header is v2 and whose hash is BLAKE2b. */
  forkHeight: number;
  /** Hash of the block at `forkHeight`. The cheapest fact that is on XBT and
   *  not on Bitcoin; `null` where no pinned value is known. */
  forkBlockHash: string | null;
  /** The first BLAKE2b block's target is the SHA256d target shifted left by
   *  this many bits, because one BLAKE2b hash is a different amount of work. */
  blake2bTargetShift: number;
  /** Knots PR 419: [start, release, depth]. */
  longCoinbaseMaturity: readonly [start: number, release: number, depth: number];
}

export const XBT_MAINNET: XbtChainParams = {
  forkHeight: 961_640,
  forkBlockHash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb",
  blake2bTargetShift: 22,
  longCoinbaseMaturity: [973_440, 979_920, 6_480],
};

export const XBT_TESTNET4: XbtChainParams = {
  forkHeight: 150_308,
  forkBlockHash: null,
  blake2bTargetShift: 22,
  longCoinbaseMaturity: [151_406, 158_111, 6_705],
};

const STANDARD_COINBASE_MATURITY = 100;

/** Bitcoin's proof-of-work limit (compact 0x1d00ffff). */
export const MAX_TARGET = 0xffffn << 208n;

/** Compact "bits" to a 256-bit target (arith_uint256::SetCompact). Throws on
 *  a negative or overflowing encoding. */
export function bitsToTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) throw new Error(`bits must be a uint32, got ${bits}`);
  const size = bits >>> 24;
  const mantissa = BigInt(bits & 0x7fffff);
  const target = size <= 3 ? mantissa >> BigInt(8 * (3 - size)) : mantissa << BigInt(8 * (size - 3));
  if (target !== 0n && (bits & 0x800000) !== 0) throw new Error("target cannot be negative");
  if (target !== 0n && (size > 34 || (size > 33 && mantissa > 0xffn) || (size > 32 && mantissa > 0xffffn))) {
    throw new Error("target has overflown");
  }
  return target;
}

/** A 256-bit target to compact "bits" (arith_uint256::GetCompact). */
export function targetToBits(target: bigint): number {
  if (target < 0n || target >= 1n << 256n) throw new Error("target must be a uint256");
  let size = 0;
  for (let t = target; t > 0n; t >>= 8n) size++;
  let mantissa = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (mantissa & 0x800000) {
    mantissa >>= 8;
    size++;
  }
  return ((size << 24) | mantissa) >>> 0;
}

/** The target of the first BLAKE2b block, from the last SHA256d target. */
export function applyBlake2bTargetShift(target: bigint, params: XbtChainParams = XBT_MAINNET): bigint {
  const shift = BigInt(params.blake2bTargetShift);
  const shifted = target > MAX_TARGET >> shift ? MAX_TARGET : target << shift;
  return bitsToTarget(targetToBits(shifted));
}

/** True when a block hash (as a node prints it) satisfies the header's own
 *  `bits`. This does NOT prove `bits` is the difficulty the chain required at
 *  that height; that needs the retarget history, which a caller must supply
 *  separately. */
export function hashMeetsTarget(blockHashHex: string, bits: number): boolean {
  if (!/^[0-9a-f]{64}$/.test(blockHashHex)) return false;
  let target: bigint;
  try { target = bitsToTarget(bits); } catch { return false; }
  if (target === 0n || target > MAX_TARGET) return false;
  return BigInt(`0x${blockHashHex}`) <= target;
}

export type HeaderCheck =
  | { ok: true; header: HeaderV2; blockHash: string }
  | { ok: false; reason: string };

/**
 * Check one raw header that is claimed to sit at `expectedHeight` on XBT.
 *
 * Fail-closed: anything that is not plainly a well-formed, self-consistent
 * post-fork header is refused with a reason. Checks, in order: the height is
 * at or after the fork; the bytes are a 164-byte v2 header; the header's own
 * height claim matches; it links to `expectedPrevHash` when one is given; the
 * hash meets the header's `bits`; and at the fork height, the hash is the
 * pinned fork block.
 *
 * NOT checked: that `bits` is the required difficulty, median-time rules, or
 * anything about the block body. One header passing this is evidence about
 * that header, not about chain tip or finality.
 */
export function checkXbtHeader(
  raw: Uint8Array,
  expectedHeight: number,
  opts: { expectedPrevHash?: string; params?: XbtChainParams } = {},
): HeaderCheck {
  const params = opts.params ?? XBT_MAINNET;
  if (!Number.isInteger(expectedHeight) || expectedHeight < params.forkHeight) {
    return { ok: false, reason: `height ${expectedHeight} is before the fork at ${params.forkHeight}` };
  }
  if (raw.length === LEGACY_HEADER_SIZE || !isHeaderV2(raw)) {
    return { ok: false, reason: "legacy header after the fork: this is not the XBT chain" };
  }
  if (raw.length !== HEADER_V2_SIZE) {
    return { ok: false, reason: `header v2 must be ${HEADER_V2_SIZE} bytes, got ${raw.length}` };
  }
  const header = parseHeaderV2(raw);
  if (header.height !== expectedHeight) {
    return { ok: false, reason: `header claims height ${header.height}, expected ${expectedHeight}` };
  }
  if (opts.expectedPrevHash !== undefined && prevBlockHashHex(header) !== opts.expectedPrevHash.toLowerCase()) {
    return { ok: false, reason: "header does not link to the expected previous block" };
  }
  const blockHash = hashHeaderV2(header);
  if (!hashMeetsTarget(blockHash, header.bits)) {
    return { ok: false, reason: "block hash does not meet the header's target" };
  }
  if (expectedHeight === params.forkHeight && params.forkBlockHash && blockHash !== params.forkBlockHash) {
    return { ok: false, reason: "fork-height block is not the pinned XBT fork block" };
  }
  return { ok: true, header, blockHash };
}

/**
 * Earliest heights at which a coinbase mined at `blockHeight` can be spent:
 * by consensus, and by node policy (which decides whether the spend relays).
 *
 * Knots PR 419: inside the window [start, release) a coinbase mined at or
 * after `start` needs `depth` confirmations by consensus; once the window
 * closes, 100 again. Policy asks `depth` of every coinbase.
 */
export function coinbaseMaturityHeights(
  blockHeight: number,
  params: XbtChainParams = XBT_MAINNET,
): { consensus: number; policy: number } {
  const [start, release, depth] = params.longCoinbaseMaturity;
  const standard = blockHeight + STANDARD_COINBASE_MATURITY;
  const policy = blockHeight + depth;
  if (blockHeight < start) return { consensus: standard, policy };
  return { consensus: Math.min(blockHeight + depth, Math.max(release, standard)), policy };
}
