// ══════════════════════════════════════════════════════════════════════════
// Chama — settling an on-chain escrow (Tier 2.1, S4/S5)
// ══════════════════════════════════════════════════════════════════════════
//
// Two parties (or a party plus the arbiter) co-sign one transaction that pays
// the winner. Nobody can move the money alone; the money moves when the right
// two agree.
//
// ⭐⭐ THE CHECKLIST IS THE SECURITY, NOT THE MULTISIG MATH.
//
// This is the single most important idea in the file, and it is the same lesson
// `verifyReturnPsbt` already encodes for bonds. A 2-of-2 leaf guarantees that
// two signatures are needed. It guarantees NOTHING about what those signatures
// authorise. A malicious counterparty sends you a perfectly valid PSBT that
// spends the escrow to their own fresh address; you sign it because "it's
// 2-of-2, it's safe"; the money is gone and Bitcoin agrees it was legitimate.
//
// So every field is verified against LOCALLY KNOWN values — the destination we
// resolved ourselves, the escrow script we recomputed ourselves, the amount we
// already knew — and never against values read out of the PSBT being checked.
// A PSBT is a request, not a source of truth.
//
// PURE: builds, verifies, signs, finalizes. No relays, no broadcast, no wallet.

import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as btc from "@scure/btc-signer";
import { NUMS_INTERNAL_KEY, SIGNET, type BtcNetwork, type BondUtxo } from "./multisig.js";
import { P2TR_DUST_SATS } from "./commitment-bond.js";
import { LEAF_SPEND_VSIZE, leafWitnessFor, type OnchainEscrow } from "./onchain-escrow.js";

/** Which branch a settlement spends. */
export type SettlementLeaf = "coop" | "dispute" | "refund";

/** Sequence value that enables nLockTime but disables BIP68 relative locktime.
 *  Correct for the coop and refund leaves; WRONG for a CSV dispute leaf. */
export const SEQUENCE_FINAL_MINUS_ONE = 0xfffffffe;

/** BIP68 disable flag. When bit 31 is SET, relative locktime is ignored — which
 *  is exactly what `0xfffffffe` does. */
const BIP68_DISABLE_FLAG = 1 << 31;
/** BIP68 type flag. Clear = the value counts BLOCKS; set = 512-second units. */
const BIP68_SECONDS_FLAG = 1 << 22;

/**
 * ⭐ The input `sequence` for spending a given leaf.
 *
 * ⚠ THIS IS A REAL CONSENSUS TRAP, and S4 had it wrong. Every input was given
 * `0xfffffffe`, which is right for CLTV (it enables nLockTime) — but bit 31 of
 * that value is the BIP68 DISABLE flag, so relative locktime is switched off
 * entirely. A CSV dispute leaf spent with `0xfffffffe` does not "wait for the
 * window", it fails outright: the script demands a relative age the transaction
 * has declared it is not asserting.
 *
 * For a block-based CSV the sequence is simply the block count, with both the
 * disable flag and the seconds flag clear. Requires tx version ≥ 2 (@scure
 * defaults to 2).
 */
export function sequenceForLeaf(leaf: SettlementLeaf, csvBlocks = 0): number {
  if (leaf !== "dispute" || csvBlocks <= 0) return SEQUENCE_FINAL_MINUS_ONE;
  if (!Number.isInteger(csvBlocks) || csvBlocks > 0xffff) {
    throw new Error("csvBlocks must be a positive integer ≤ 65535 (BIP68 block domain)");
  }
  // Disable flag clear, seconds flag clear, value = blocks.
  return csvBlocks & 0xffff;
}

/** True when a sequence value actually asserts a relative-block age (rather
 *  than silently disabling the check). Exists so a test — and a reviewer — can
 *  assert the trap above is not re-introduced. */
export function assertsRelativeBlockAge(sequence: number): boolean {
  return (sequence & BIP68_DISABLE_FLAG) === 0 && (sequence & BIP68_SECONDS_FLAG) === 0;
}

export type DisputeWindow =
  | { open: true }
  | { open: false; blocksRemaining: number; opensAtHeight: number };

/**
 * Is the dispute leaf spendable yet?
 *
 * The appeal window is `csvBlocks` after the escrow's funding CONFIRMED, and
 * consensus enforces it whether or not any client agrees. This function exists
 * so the app can say WHEN it opens rather than letting a user broadcast a
 * transaction the network will simply reject.
 *
 * Unknown heights ⇒ CLOSED. An unknown that reported "open" would invite a
 * broadcast that fails; an unknown that reports "closed" costs a refresh.
 */
export function disputeWindow(params: {
  fundingHeight?: number | null;
  tipHeight?: number | null;
  csvBlocks: number;
}): DisputeWindow {
  if (params.csvBlocks <= 0) return { open: true };
  const { fundingHeight, tipHeight } = params;
  if (typeof fundingHeight !== "number" || typeof tipHeight !== "number") {
    return { open: false, blocksRemaining: params.csvBlocks, opensAtHeight: 0 };
  }
  const opensAtHeight = fundingHeight + params.csvBlocks;
  const confirmations = tipHeight - fundingHeight + 1;
  if (confirmations >= params.csvBlocks) return { open: true };
  return { open: false, blocksRemaining: opensAtHeight - tipHeight, opensAtHeight };
}

function taprootFor(escrow: OnchainEscrow) {
  return btc.p2tr(
    NUMS_INTERNAL_KEY,
    [
      { script: escrow.leaves.coop },
      { script: escrow.leaves.dispute },
      { script: escrow.leaves.refund },
    ] as never,
    escrow.params.network,
    true,
  );
}

/** Build the settlement transaction as a PSBT for co-signing.
 *
 *  Sweeps EVERY confirmed output at the escrow address, not just one: a funder
 *  who sent in two transactions has two UTXOs, and settling only the largest
 *  would strand the rest at an address whose other exits are a dispute or a
 *  30-day timeout. */
export function buildSettlementPsbt(params: {
  escrow: OnchainEscrow;
  utxos: readonly BondUtxo[];
  /** The winner's own address, resolved locally by the builder. */
  destination: string;
  feeSats: bigint;
  /** Which branch this settlement spends. Decides the input `sequence`, which
   *  is consensus-critical for the CSV dispute leaf (see sequenceForLeaf).
   *  Defaults to "coop" so existing callers are unchanged. */
  leaf?: SettlementLeaf;
  /** Required for the refund leaf (CLTV); ignored otherwise. */
  lockTime?: number;
  /** Block the escrow's funding confirmed in, and the current tip. Required for
   *  the dispute leaf so the appeal window can be checked BEFORE building. */
  fundingHeight?: number | null;
  tipHeight?: number | null;
}): string {
  const { escrow, utxos, destination, feeSats } = params;
  if (utxos.length === 0) throw new Error("No escrow UTXOs to settle");
  const total = utxos.reduce((sum, u) => sum + u.amountSats, 0n);
  if (feeSats < 0n || feeSats >= total) throw new Error("Bad fee");
  const payout = total - feeSats;
  if (payout < P2TR_DUST_SATS) {
    throw new Error(
      `Settlement output would be dust (${payout} sats < ${P2TR_DUST_SATS}) — unrelayable`,
    );
  }
  // ⚠ Refuse to build a dispute settlement the network would reject. Consensus
  // enforces the window regardless, but a broadcast that fails leaves a user
  // staring at an error with no idea whether their money moved. Say "opens in N
  // blocks" instead — the one thing the failure would not tell them.
  if ((params.leaf ?? "coop") === "dispute") {
    const csv = escrow.params.disputeCsvBlocks ?? 0;
    const win = disputeWindow({
      fundingHeight: params.fundingHeight, tipHeight: params.tipHeight, csvBlocks: csv,
    });
    if (!win.open) {
      throw new Error(
        `The appeal window is still open — this escrow cannot be settled by arbitration for another ${win.blocksRemaining} block(s).`,
      );
    }
  }
  const spend = taprootFor(escrow);
  const tx = new btc.Transaction({
    allowUnknown: true,
    allowUnknownOutputs: true,
    ...(params.lockTime !== undefined ? { lockTime: params.lockTime } : {}),
  });
  for (const u of utxos) {
    tx.addInput({
      txid: hexToBytes(u.txid),
      index: u.index,
      witnessUtxo: { script: spend.script, amount: u.amountSats },
      // ⚠ Leaf-dependent, and not a detail: `0xfffffffe` enables nLockTime for
      // the refund leaf's CLTV but DISABLES BIP68, so it silently breaks a CSV
      // dispute spend. sequenceForLeaf picks the right one.
      sequence: sequenceForLeaf(
        params.leaf ?? "coop",
        escrow.params.disputeCsvBlocks ?? 0,
      ),
      ...spend,
    });
  }
  tx.addOutputAddress(destination, payout, escrow.params.network);
  return base64.encode(tx.toPSBT());
}

/** Add one signature. Preserves existing partial signatures so the two parties
 *  can sign sequentially, in any order, over an unreliable transport. */
export function coSignSettlement(psbtB64: string, privKey: Uint8Array): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), {
    allowUnknown: true, allowUnknownOutputs: true,
  });
  for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(privKey, i);
  return base64.encode(tx.toPSBT());
}

/** Combine partial signatures and finalize to broadcastable hex.
 *  THROWS below threshold — the same refusal Bitcoin would give at broadcast,
 *  delivered earlier and more legibly. */
export function finalizeSettlement(
  psbtsB64: readonly string[],
  /** Required once a leaf carries CSV/CLTV — @scure cannot finalize those, so
   *  the witness is hand-assembled. Omit only for a plain coop leaf. */
  opts?: { escrow: OnchainEscrow; leaf: SettlementLeaf },
): string {
  if (psbtsB64.length === 0) throw new Error("No PSBTs to combine");
  const combined = btc.PSBTCombine(psbtsB64.map((p) => base64.decode(p)));
  const tx = btc.Transaction.fromPSBT(combined, { allowUnknown: true, allowUnknownOutputs: true });
  if (opts) {
    // ⚠ Hand-finalize. A CSV dispute leaf and a CLTV refund leaf are both
    // scripts @scure has no coder for; calling tx.finalize() on either throws
    // "Unknown tapLeafScript". Assembling the witness ourselves is the same
    // pattern the shipped bond reclaim uses.
    for (let i = 0; i < tx.inputsLength; i++) {
      tx.updateInput(i, {
        finalScriptWitness: leafWitnessFor(opts.escrow, tx, i, opts.leaf),
      });
    }
    return bytesToHex(tx.extract());
  }
  tx.finalize(); // throws below threshold — the same refusal, delivered earlier
  return bytesToHex(tx.extract());
}

// ── ⭐ The checklist ───────────────────────────────────────────────────────

export interface SettlementExpectation {
  escrow: OnchainEscrow;
  /** Every UTXO the settlement is allowed to spend, known locally. */
  utxos: readonly BondUtxo[];
  /** The winner's address, resolved locally from the trade's outcome — NEVER
   *  read from the PSBT. This single check is what stops a blind co-sign from
   *  paying a counterparty's own fresh address. */
  destination: string;
  /** Refuse a fee above this. Stops a griefer burning the escrow to miners. */
  maxFeeSats: bigint;
  network?: BtcNetwork;
  /** Expected spending branch. Dispute wire traffic must prove the exact
   *  block-based BIP68 sequence; an honest builder is not enough. */
  leaf?: "coop" | "dispute";
}

export interface SettlementCheck {
  ok: boolean;
  failures: string[];
}

/**
 * ⭐ Verify a settlement PSBT before signing it. A party MUST refuse to sign
 * unless this returns ok.
 *
 * Every check compares the PSBT against something the verifier already knew.
 * Nothing here is taken on the PSBT's word.
 */
export function verifySettlementPsbt(
  psbtB64: string,
  expect: SettlementExpectation,
): SettlementCheck {
  const network = expect.network ?? expect.escrow.params.network ?? SIGNET;
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), {
      allowUnknown: true, allowUnknownOutputs: true,
    });
  } catch (e) {
    return { ok: false, failures: [`unparseable PSBT: ${(e as Error).message}`] };
  }

  // ── Inputs: exactly our escrow's UTXOs, nothing smuggled in ──
  const known = new Map(expect.utxos.map((u) => [`${u.txid}:${u.index}`, u]));
  const escrowScript = bytesToHex(expect.escrow.script);
  let inSum = 0n;
  if (tx.inputsLength === 0) fail("no inputs");
  const seen = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const key = `${inp.txid ? bytesToHex(inp.txid) : ""}:${inp.index}`;
    const match = known.get(key);
    if (!match) { fail(`input ${i} (${key}) is not one of this escrow's UTXOs`); continue; }
    if (seen.has(key)) { fail(`input ${i} duplicates ${key}`); continue; }
    seen.add(key);
    // Amount checked against what WE observed on-chain, not the PSBT's claim —
    // a lied-about input amount would let the fee check be gamed.
    if (inp.witnessUtxo?.amount !== match.amountSats) {
      fail(`input ${i} amount ${inp.witnessUtxo?.amount} != known ${match.amountSats}`);
    }
    if (!inp.witnessUtxo?.script || bytesToHex(inp.witnessUtxo.script) !== escrowScript) {
      fail(`input ${i} is not the escrow output script`);
    }
    // ⚠ SIGHASH_DEFAULT only. SINGLE / NONE / ANYONECANPAY are blank cheques:
    // they let the other party add or reorder inputs and outputs AFTER you
    // signed, so what you approved is not what gets broadcast.
    if (inp.sighashType !== undefined && inp.sighashType !== 0) {
      fail(`input ${i} sighashType ${inp.sighashType} — only SIGHASH_DEFAULT (0) is allowed`);
    }
    if (expect.leaf === "dispute") {
      const required = sequenceForLeaf("dispute", expect.escrow.params.disputeCsvBlocks ?? 0);
      const sequence = inp.sequence ?? 0xffffffff;
      if (!assertsRelativeBlockAge(sequence) || sequence !== required) {
        fail(`input ${i} sequence ${inp.sequence} does not assert the required dispute CSV ${required}`);
      }
    }
    inSum += match.amountSats;
  }

  // ── Outputs: exactly one, to the locally-resolved winner ──
  if (tx.outputsLength !== 1) {
    fail(`expected exactly 1 output (the winner), got ${tx.outputsLength}`);
  }
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    outSum += out.amount ?? 0n;
    let addr = "(undecodable)";
    try { addr = btc.Address(network).encode(btc.OutScript.decode(out.script!)); } catch { /* keep */ }
    if (addr !== expect.destination) {
      fail(`output ${i} pays ${addr}, not the winner (${expect.destination})`);
    }
  }

  // ── Fee ──
  const fee = inSum - outSum;
  if (fee < 0n) fail("outputs exceed inputs (negative fee)");
  else if (fee > expect.maxFeeSats) fail(`fee ${fee} exceeds max ${expect.maxFeeSats}`);

  return { ok: failures.length === 0, failures };
}

/** A sane fee ceiling for a settlement: the leaf's real spend size at the given
 *  rate, times a tolerance for rate movement between build and sign.
 *
 *  Exists so `maxFeeSats` is a computed number rather than a guess a caller
 *  types in — a ceiling set by vibes is either so loose it permits griefing or
 *  so tight it blocks honest settlements when fees rise. */
export function settlementFeeCeilingSats(
  leaf: SettlementLeaf,
  feeRateSatsPerVb: bigint,
  numInputs = 1,
  tolerance = 3n,
): bigint {
  // ⚠ max(0, ...) not max(1, ...): the leaf's measured vsize ALREADY includes
  // the first input, so only additional ones cost extra. The off-by-one made a
  // one-input and a two-input ceiling identical, which is how a wrong constant
  // announces itself.
  const extraInputs = BigInt(Math.max(0, numInputs - 1)) * 58n; // each extra P2TR input ≈ 58 vB
  return (BigInt(LEAF_SPEND_VSIZE[leaf]) + extraInputs) * feeRateSatsPerVb * tolerance;
}
