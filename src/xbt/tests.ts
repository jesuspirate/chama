// XBT primitives — regression suite.
//
// Three independent sources of truth, none of them written here:
//   • fixtures/knots-block-header-v2.json   — Bitcoin Knots' header vectors
//   • fixtures/knots-unified-sighash.json   — Bitcoin Knots' 166 sighash vectors
//   • fixtures/mainnet-headers.json         — real XBT mainnet headers across the fork
// The first two were copied unmodified from bitcoin-blake/electrum-xbt (commit
// cd0436e), which carries them from Knots' src/test/data.

import assert from "node:assert/strict";
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import {
  HEADER_V2_SIZE, displayHex, hashHeaderV2Detailed, hashRawHeaderV2, isHeaderV2, parseHeaderV2,
  prevBlockHashHex, serializeHeaderV2, type HeaderV2,
} from "./header-v2.js";
import {
  MAX_TARGET, XBT_MAINNET, XBT_TESTNET4, applyBlake2bTargetShift, bitsToTarget, checkXbtHeader,
  coinbaseMaturityHeights, hashMeetsTarget, targetToBits,
} from "./chain-params.js";
import {
  SIGHASH_ALL_UNIFIED, UnifiedScriptType, decodeTxForSighash, signatureOptsInToUnified, tapLeafHash,
  unifiedSighash, type SpentOutput,
} from "./unified-sighash.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const wire = (displayed: string) => hexToBytes(displayed).reverse();
let checks = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); checks++; };
const eq = <T>(a: T, b: T, msg: string) => { assert.deepEqual(a, b, msg); checks++; };
const throws = (fn: () => unknown, pattern: RegExp, msg: string) => { assert.throws(fn, pattern, msg); checks++; };

// ── Header v2: Knots vectors ────────────────────────────────────────────────
{
  const vectors = fixture("knots-block-header-v2.json").headers;
  eq(vectors.length, 5, "all five Knots header vectors are present");
  const profiles = new Set<number>();
  for (const t of vectors) {
    const f = t.fields;
    const header: HeaderV2 = {
      version: f.nVersion, prevBlockHash: wire(f.hashPrevBlock), merkleRoot: wire(f.hashMerkleRoot),
      time: f.nTime, bits: f.nBits, nonce: f.nNonce, nonce2: f.m_nonce2, nonce3: f.m_nonce3,
      extranonce: wire(f.m_extranonce), timeOffset: f.m_time_offset, txCount: f.m_txcount, flags: f.m_flags,
      xorKeyMaskClearBits: f.m_xor_key_mask_clear_bits, xorKey: wire(f.m_xor_key), height: f.m_height,
      mmRhs: wire(f.m_mm_rhs),
    };
    const raw = serializeHeaderV2(header);
    eq(raw.length, HEADER_V2_SIZE, `${t.name}: serializes to 164 bytes`);
    eq(bytesToHex(raw), t.serialized, `${t.name}: serialization matches Knots`);
    ok(isHeaderV2(raw), `${t.name}: carries the v2 marker`);

    const decoded = parseHeaderV2(hexToBytes(t.serialized));
    eq(decoded.time, f.nTime, `${t.name}: time offset is applied on decode`);
    eq(decoded.version, f.nVersion, `${t.name}: version is reported without the marker bit`);
    eq(decoded.height, f.m_height, `${t.name}: height decodes`);
    eq(displayHex(decoded.prevBlockHash), f.hashPrevBlock, `${t.name}: previous hash decodes`);
    eq(bytesToHex(serializeHeaderV2(decoded)), t.serialized, `${t.name}: decode then encode is the identity`);

    const d = hashHeaderV2Detailed(header);
    eq(bytesToHex(d.xorKeyHash), t.xor_key_hash, `${t.name}: xor key hash`);
    eq(bytesToHex(d.h1), t.h1, `${t.name}: h1`);
    eq(bytesToHex(d.h2), t.h2, `${t.name}: h2`);
    eq(bytesToHex(d.blake2b1), t.blake2b_1, `${t.name}: first BLAKE2b`);
    eq(d.asicProfile, t.asic_profile, `${t.name}: ASIC profile`);
    eq(bytesToHex(d.asicInput), t.asic_input, `${t.name}: ASIC input`);
    eq(bytesToHex(d.blake2b2), t.blake2b_2, `${t.name}: second BLAKE2b`);
    eq(bytesToHex(d.mask), t.mask, `${t.name}: XOR mask`);
    eq(d.blockHash, t.block_hash, `${t.name}: block hash`);
    eq(hashRawHeaderV2(raw), t.block_hash, `${t.name}: block hash from raw bytes`);
    profiles.add(d.asicProfile);
  }
  eq([...profiles].sort(), [0, 1, 2, 3], "the vectors exercise all four ASIC profiles");
}

// ── Header v2: malformed input is refused, never half-read ──────────────────
{
  const good = hexToBytes(fixture("knots-block-header-v2.json").headers[0].serialized);
  throws(() => parseHeaderV2(good.slice(0, 163)), /164 bytes/, "a short header is refused");
  throws(() => parseHeaderV2(concatBytes(good, Uint8Array.of(0))), /164 bytes/, "a long header is refused");
  const unmarked = good.slice();
  unmarked[3] &= 0x7f;
  throws(() => parseHeaderV2(unmarked), /not a v2 header/, "164 bytes without the marker are refused");
  ok(!isHeaderV2(new Uint8Array(80)), "an 80-byte legacy header is not v2");
  throws(() => serializeHeaderV2({ ...parseHeaderV2(good), xorKey: new Uint8Array(15) }), /xorKey/, "a wrong-length field is refused on encode");
}

// ── Real XBT mainnet headers across the fork ────────────────────────────────
{
  const main = fixture("mainnet-headers.json");
  const raw = (height: number) => hexToBytes(main.headers[String(height)]);
  const FORK = XBT_MAINNET.forkHeight;
  eq(FORK, 961_640, "mainnet fork height");
  eq(XBT_MAINNET.forkBlockHash, main.forkBlockHash, "pinned fork block matches the fixture's recorded hash");

  // The last SHA256d block. Its hash is plain double-SHA256, and the first
  // BLAKE2b block must link to it.
  const last = raw(FORK - 1);
  eq(last.length, 80, "the block before the fork has a legacy 80-byte header");
  const lastHash = displayHex(sha256(sha256(last)));
  const lastBits = new DataView(last.buffer).getUint32(72, true);
  eq(lastBits, 0x1702353d, "bits of the last SHA256d block");
  ok(hashMeetsTarget(lastHash, lastBits), "the last SHA256d block meets its own target");

  const fork = checkXbtHeader(raw(FORK), FORK, { expectedPrevHash: lastHash });
  ok(fork.ok, `the real fork block passes: ${fork.ok ? "" : fork.reason}`);
  if (fork.ok) {
    eq(fork.blockHash, main.forkBlockHash, "fork block hash matches mainnet");
    eq(fork.header.bits, 0x1a008d4f, "fork block bits");
    eq(targetToBits(applyBlake2bTargetShift(bitsToTarget(lastBits))), fork.header.bits,
      "fork block bits are the last SHA256d bits shifted by 22");
  }

  // Three consecutive real blocks chain by hash.
  let prev = main.forkBlockHash as string;
  for (const height of [FORK + 1, FORK + 2]) {
    const r = checkXbtHeader(raw(height), height, { expectedPrevHash: prev });
    ok(r.ok, `block ${height} links to its parent and meets its target`);
    if (r.ok) prev = r.blockHash;
  }
  // Later real blocks, including both sides of two retargets.
  for (const height of [963_647, 963_648, 965_663, 965_664, 967_000]) {
    const r = checkXbtHeader(raw(height), height);
    ok(r.ok, `real mainnet block ${height} passes`);
    if (r.ok) eq(prevBlockHashHex(r.header).length, 64, `block ${height} has a previous hash`);
  }
  const a = checkXbtHeader(raw(965_663), 965_663), b = checkXbtHeader(raw(965_664), 965_664);
  if (a.ok && b.ok) {
    eq(prevBlockHashHex(b.header), a.blockHash, "block 965,664 links to 965,663 across a retarget");
    eq([a.header.bits, b.header.bits], [0x1a00f0b5, 0x193c2d40], "bits on each side of the retarget");
  }

  // Refusals. Each names its reason; none throws.
  const reason = (r: ReturnType<typeof checkXbtHeader>) => (r.ok ? "accepted" : r.reason);
  ok(/legacy header/.test(reason(checkXbtHeader(last, FORK))), "an 80-byte header at the fork height is refused: that is Bitcoin, not XBT");
  ok(/before the fork/.test(reason(checkXbtHeader(raw(FORK), FORK - 1))), "a pre-fork height is refused");
  ok(/claims height/.test(reason(checkXbtHeader(raw(FORK + 1), FORK + 2))), "a header at the wrong height is refused");
  ok(/does not link/.test(reason(checkXbtHeader(raw(FORK + 2), FORK + 2, { expectedPrevHash: main.forkBlockHash }))),
    "a header that skips its parent is refused");
  ok(/164 bytes/.test(reason(checkXbtHeader(concatBytes(raw(FORK), Uint8Array.of(0)), FORK))), "a padded header is refused");

  const tampered = raw(FORK + 1);
  tampered[76] ^= 1; // nonce
  ok(/does not meet/.test(reason(checkXbtHeader(tampered, FORK + 1))), "a header with a changed nonce no longer meets its target");

  // A valid-work header presented AS the fork block is not the fork block.
  const impostor = parseHeaderV2(raw(FORK + 1));
  ok(/claims height/.test(reason(checkXbtHeader(serializeHeaderV2(impostor), FORK))), "another block cannot stand in for the fork block");
  ok(!hashMeetsTarget(main.forkBlockHash, 0x1702353d), "the fork block does not meet the pre-fork SHA256d difficulty");
  ok(!hashMeetsTarget("zz", 0x1d00ffff) && !hashMeetsTarget(main.forkBlockHash, 0), "junk hash and zero target are refused");
}

// ── Compact target arithmetic ───────────────────────────────────────────────
{
  eq(bitsToTarget(0x1d00ffff), MAX_TARGET, "proof-of-work limit");
  for (const bits of [0x1d00ffff, 0x1702353d, 0x1a008d4f, 0x1a00f0b5, 0x193c2d40, 0x03123456, 0x01120000]) {
    eq(targetToBits(bitsToTarget(bits)), bits, `bits 0x${bits.toString(16)} round-trip`);
  }
  eq(targetToBits(applyBlake2bTargetShift(MAX_TARGET)), 0x1d00ffff, "a target at the limit stays at the limit");
  throws(() => bitsToTarget(0x1d800001), /negative/, "a negative target is refused");
  throws(() => bitsToTarget(0x23000001), /overflown/, "an overflowing target is refused");
  eq(bitsToTarget(0), 0n, "zero bits is a zero target");
}

// ── Coinbase maturity (Knots PR 419) ────────────────────────────────────────
{
  const m = (h: number, p = XBT_MAINNET) => { const r = coinbaseMaturityHeights(h, p); return [r.consensus, r.policy]; };
  eq(m(970_198), [970_298, 976_678], "pre-window: 100 by consensus, 6,480 by policy");
  eq(m(973_439), [973_539, 979_919], "last pre-window height");
  eq(m(973_440), [979_920, 979_920], "first in-window height: both at release");
  eq(m(974_010), [979_920, 980_490], "in-window: released when the window closes");
  eq(m(979_900), [980_000, 986_380], "near release: 100 by consensus once the window closes");
  eq(m(150_371, XBT_TESTNET4), [150_471, 157_076], "testnet4 pre-window");
  eq(m(151_406, XBT_TESTNET4), [158_111, 158_111], "testnet4 window start");
  eq(m(152_000, XBT_TESTNET4), [158_111, 158_705], "testnet4 in-window");
}

// ── SIGHASH_UNIFIED: Knots vectors ──────────────────────────────────────────
{
  const rows = fixture("knots-unified-sighash.json");
  const columns: string[] = rows[0];
  eq(columns, ["scriptCode", "rawTx", "inIdx", "hashType", "scriptType", "spentOutputs", "sighash"], "vector columns");
  eq(rows.length - 1, 166, "all 166 Knots sighash vectors are present");
  const seenTypes = new Set<number>();
  let passed = 0;
  for (const row of rows.slice(1)) {
    const [scriptCodeHex, rawTx, inIdx, hashType, scriptType, spent, expected] = row;
    for (const [value] of spent) assert.ok(Number.isSafeInteger(value), "vector amounts are exact in JSON");
    const scriptCode = hexToBytes(scriptCodeHex);
    const spentOutputs: SpentOutput[] = spent.map(([value, spk]: [number, string]) => ({ value: BigInt(value), scriptPubKey: hexToBytes(spk) }));
    const digest = unifiedSighash({
      tx: decodeTxForSighash(hexToBytes(rawTx)), spentOutputs, inputIndex: inIdx, hashType, scriptType,
      scriptCode,
      leafHash: scriptType === UnifiedScriptType.TAPSCRIPT ? tapLeafHash(scriptCode) : undefined,
    });
    assert.equal(bytesToHex(digest), expected, `scriptType ${scriptType} hashType 0x${hashType.toString(16)} input ${inIdx}`);
    seenTypes.add(scriptType);
    passed++;
  }
  eq(passed, 166, "every Knots sighash vector matches");
  eq([...seenTypes].sort(), [0, 1, 2, 3], "the vectors cover legacy, segwit v0, taproot and tapscript");
}

// ── SIGHASH_UNIFIED: what the digest commits to, and refusals ───────────────
{
  const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const pub = secp256k1.getPublicKey(priv, true);
  // A 2-input, 2-output spend of two P2WSH outputs: the shape a federation
  // wallet signs. Script and amounts are arbitrary but fixed.
  const witnessScript = concatBytes(Uint8Array.of(0x51, 0x21), pub, Uint8Array.of(0x51, 0xae)); // 1-of-1 multisig
  const spk = concatBytes(Uint8Array.of(0x00, 0x20), sha256(witnessScript));
  const out = (sats: bigint, script: Uint8Array) => {
    const v = new Uint8Array(8);
    new DataView(v.buffer).setBigUint64(0, sats, true);
    return concatBytes(v, Uint8Array.of(script.length), script);
  };
  const prevout = (fill: number, index: number) => concatBytes(new Uint8Array(32).fill(fill), Uint8Array.of(index, 0, 0, 0));
  const tx = {
    version: Uint8Array.of(2, 0, 0, 0), locktime: 0,
    inputs: [{ prevout: prevout(0xaa, 0), sequence: 0xfffffffd }, { prevout: prevout(0xbb, 1), sequence: 0xfffffffd }],
    outputs: [out(150_000n, spk), out(40_000n, spk)],
  };
  const spentOutputs: SpentOutput[] = [{ value: 100_000n, scriptPubKey: spk }, { value: 95_000n, scriptPubKey: spk }];
  const base = { tx, spentOutputs, inputIndex: 0, hashType: SIGHASH_ALL_UNIFIED, scriptType: UnifiedScriptType.WITNESS_V0, scriptCode: witnessScript };
  const digest = unifiedSighash(base);
  eq(SIGHASH_ALL_UNIFIED, 0x21, "the federation hash type is ALL | UNIFIED");
  eq(digest.length, 32, "digest is 32 bytes");

  const differs = (other: Uint8Array, msg: string) => ok(bytesToHex(other) !== bytesToHex(digest), msg);
  differs(unifiedSighash({ ...base, inputIndex: 1 }), "each input signs a different digest");
  differs(unifiedSighash({ ...base, spentOutputs: [spentOutputs[0], { ...spentOutputs[1], value: 95_001n }] }),
    "the digest commits to the amount of an input the signer is NOT signing");
  differs(unifiedSighash({ ...base, spentOutputs: [{ ...spentOutputs[0], value: 100_001n }, spentOutputs[1]] }),
    "the digest commits to the signed input's own amount");
  differs(unifiedSighash({ ...base, tx: { ...tx, outputs: [out(150_000n, spk), out(40_001n, spk)] } }),
    "the digest commits to every output");
  differs(unifiedSighash({ ...base, tx: { ...tx, locktime: 1 } }), "the digest commits to the locktime");
  differs(unifiedSighash({ ...base, scriptType: UnifiedScriptType.LEGACY }), "the digest commits to the script type");
  differs(unifiedSighash({ ...base, hashType: 0xa1 }), "the digest commits to the hash type");

  // A signature made the usual way over the unified digest verifies; the same
  // key's signature over any other message does not.
  const sig = secp256k1.sign(digest, priv, { prehash: false });
  ok(secp256k1.verify(sig, digest, pub, { prehash: false }), "an ECDSA signature over the unified digest verifies");
  ok(!secp256k1.verify(sig, unifiedSighash({ ...base, inputIndex: 1 }), pub, { prehash: false }),
    "that signature does not verify for another input");

  throws(() => unifiedSighash({ ...base, hashType: 0x01 }), /does not opt in/, "plain SIGHASH_ALL is refused: no digest without the flag");
  throws(() => unifiedSighash({ ...base, spentOutputs: [spentOutputs[0]] }), /every input/, "a missing spent output is refused");
  throws(() => unifiedSighash({ ...base, inputIndex: 2 }), /out of range/, "an input index past the end is refused");
  throws(() => unifiedSighash({ ...base, hashType: 0x23, inputIndex: 1, tx: { ...tx, outputs: [tx.outputs[0]] } }),
    /SIGHASH_SINGLE/, "SINGLE with no matching output is refused");
  throws(() => unifiedSighash({ ...base, scriptType: UnifiedScriptType.TAPROOT, hashType: 0x20 }), /not defined for taproot/,
    "a taproot hash type with no base is refused");
  throws(() => unifiedSighash({ ...base, scriptType: UnifiedScriptType.TAPSCRIPT }), /leaf hash/, "tapscript without a leaf hash is refused");
  throws(() => unifiedSighash({ ...base, tx: { ...tx, version: Uint8Array.of(2) } }), /version/, "a malformed version is refused");
}

// ── Reading the opt-in flag off a signature ─────────────────────────────────
{
  const der = hexToBytes("3006020101020101"); // minimal DER shape
  ok(signatureOptsInToUnified(concatBytes(der, Uint8Array.of(0x21)), "ecdsa"), "ECDSA with 0x21 opts in");
  ok(signatureOptsInToUnified(concatBytes(der, Uint8Array.of(0xa3)), "ecdsa"), "ECDSA with 0xa3 opts in");
  ok(!signatureOptsInToUnified(concatBytes(der, Uint8Array.of(0x01)), "ecdsa"), "ECDSA with plain ALL does not: replayable");
  ok(!signatureOptsInToUnified(concatBytes(der, Uint8Array.of(0x81)), "ecdsa"), "ECDSA with ALL|ANYONECANPAY does not");
  ok(!signatureOptsInToUnified(new Uint8Array(0), "ecdsa"), "an empty signature does not");
  ok(!signatureOptsInToUnified(Uint8Array.of(0x21), "ecdsa"), "a bare hash-type byte is not a signature");
  ok(!signatureOptsInToUnified(new Uint8Array(64), "schnorr"), "a 64-byte Schnorr signature is SIGHASH_DEFAULT: replayable");
  ok(signatureOptsInToUnified(concatBytes(new Uint8Array(64), Uint8Array.of(0x21)), "schnorr"), "65-byte Schnorr with 0x21 opts in");
  ok(!signatureOptsInToUnified(concatBytes(new Uint8Array(64), Uint8Array.of(0x01)), "schnorr"), "65-byte Schnorr with plain ALL does not");
  ok(!signatureOptsInToUnified(new Uint8Array(66), "schnorr"), "a wrong-length Schnorr signature does not");
}

// ── Transaction decoding ────────────────────────────────────────────────────
{
  // A segwit transaction and its witness-stripped form describe the same
  // inputs and outputs.
  const legacy = hexToBytes("0200000001" + "11".repeat(32) + "00000000" + "00" + "fdffffff" + "01" + "a086010000000000" + "0151" + "07000000");
  const segwit = hexToBytes("02000000" + "0001" + "01" + "11".repeat(32) + "00000000" + "00" + "fdffffff" + "01" + "a086010000000000" + "0151" + "01" + "02abcd" + "07000000");
  const a = decodeTxForSighash(legacy), b = decodeTxForSighash(segwit);
  eq(a, b, "witness data does not change what is signed");
  eq([a.locktime, a.inputs.length, a.inputs[0].sequence, bytesToHex(a.outputs[0])], [7, 1, 0xfffffffd, "a0860100000000000151"], "fields decode");
  throws(() => decodeTxForSighash(legacy.slice(0, -1)), /truncated/, "a truncated transaction is refused");
  throws(() => decodeTxForSighash(concatBytes(legacy, Uint8Array.of(0))), /trailing/, "trailing bytes are refused");
}

console.log(`✅ XBT primitives: ${checks} checks passed (Knots header + sighash vectors, real mainnet headers)`);
