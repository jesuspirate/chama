// ══════════════════════════════════════════════════════════════════════════
// Chama — the bond LINEAGE WALK (A1: tenure across renewals)
// ══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM. A commitment bond is a CLTV output. Renewing one spends the old
// output into a fresh bond under a newly derived key, which means the new bond
// is a brand-new UTXO with a brand-new funding height. So "bonded N days",
// measured off the current UTXO alone, RESETS TO ZERO on every renewal — it
// under-reports exactly the arbiters it exists to reward. Jetty's own ~1-month
// commitment read as 6 days.
//
// THE FIX. The announcement carries its ancestry (bond-announcement.ts,
// `BondLineage`), and this module PROVES it hop by hop against the chain.
//
// ⭐ RECOMPUTE-DON'T-TRUST, same as the announcement itself. For each hop we:
//   1. REBUILD the hop's bond address locally from (fromXonly, fromLockUntil).
//      A fabricated ancestor cannot survive this — you'd need a preimage of the
//      taproot output to name an address you don't control.
//   2. Read the hop's funding transaction and find the output paying that
//      recomputed address. `vout` is DERIVED here, never taken from the wire.
//   3. Check that output's spend, and require the spender to be the very
//      transaction that funded the NEXT bond along the chain.
//
// Step 3 is what makes the whole thing hard to lie about: an unbroken chain of
// spends is a claim Bitcoin either backs or refuses. You cannot graft someone
// else's old bond onto your history, because their output was not spent into
// your funding transaction.
//
// FAIL-SHORT, NEVER FAIL-LONG. Any hop that cannot be proven ENDS the walk, and
// tenure is computed from what was proven up to that point. Every failure mode —
// a broken link, an Esplora hiccup, a malformed claim — therefore makes tenure
// SHORTER. The one direction this must never fail in is "longer than the truth",
// because tenure gates capacity (exposure.ts) and a Sybil's whole goal is to
// look older than it is.
//
// BOUNDED. At most 2 Esplora reads per hop, MAX_LINEAGE_HOPS hops. Results are
// cached by the caller (see arbiters/bonded-pool-cache.ts).

import { buildCommitmentBond } from "./commitment-bond.js";
import { esploraOutspend, type EsploraFetch } from "./fund-watcher.js";
import { MAX_LINEAGE_HOPS, type BondLineage, type VerifiedBond } from "./bond-announcement.js";
import { type BtcNetwork } from "./multisig.js";

/** Why a walk stopped. Every value means "tenure is at most what we proved". */
export type LineageStopReason =
  /** Every announced hop was proven. */
  | "complete"
  /** A hop's funding tx had no output paying its recomputed address. */
  | "address_mismatch"
  /** A hop's funding output was never spent — it cannot be an ancestor. */
  | "unspent"
  /** Spent, but NOT into the next bond along. Someone else's bond, or a lie. */
  | "wrong_spender"
  /** Esplora could not be read. Says nothing about the claim's truth. */
  | "unreadable"
  /** The announced chain hit the payload bound. */
  | "hop_limit";

export interface ProvenLineage {
  /** Hops proven on-chain, oldest-inclusive. Never exceeds the claim. */
  provenHops: number;
  /** Hops the announcement claimed, for an honest "3 of 5 verified" readout. */
  claimedHops: number;
  /** Block height of the OLDEST proven bond's funding transaction — the real
   *  start of tenure. Undefined when nothing could be proven. */
  rootFundedAtHeight?: number;
  /** Txid of the oldest proven funding transaction, so a human can check it in
   *  a block explorer instead of taking the app's word for it. */
  rootTxid?: string;
  stoppedBecause: LineageStopReason;
}

/** No ancestry claimed, or none provable. Tenure falls back to the current bond. */
export const NO_LINEAGE: ProvenLineage = {
  provenHops: 0,
  claimedHops: 0,
  stoppedBecause: "complete",
};

interface EsploraTxOut { scriptpubkey_address?: string; value?: number }
interface EsploraTx { vout?: EsploraTxOut[]; status?: { block_height?: number } }

/** ⭐ Walk an announced lineage backwards, proving each hop on-chain.
 *
 *  `currentFundingTxid` is the funding txid of the bond doing the announcing —
 *  the transaction that hop 0 must have been spent into. Without it the first
 *  hop is unanchored (anyone could claim any bond as their parent), so a missing
 *  one yields NO_LINEAGE rather than an unverified chain. */
export async function verifyBondLineage(params: {
  lineage: BondLineage | undefined;
  currentFundingTxid: string | undefined;
  network: BtcNetwork;
  fetchJson: EsploraFetch;
  maxHops?: number;
}): Promise<ProvenLineage> {
  const claimed = params.lineage?.hops ?? [];
  if (claimed.length === 0 || !params.currentFundingTxid) return NO_LINEAGE;

  const limit = Math.max(0, Math.min(params.maxHops ?? MAX_LINEAGE_HOPS, MAX_LINEAGE_HOPS));
  const result: ProvenLineage = {
    provenHops: 0,
    claimedHops: claimed.length,
    stoppedBecause: "complete",
  };

  // Each hop must have been spent INTO the bond that follows it. Walking
  // newest-first, the expected spender starts as the announcing bond's own
  // funding tx and becomes each proven hop in turn.
  let expectedSpender = params.currentFundingTxid.toLowerCase();

  for (let i = 0; i < claimed.length; i++) {
    if (i >= limit) { result.stoppedBecause = "hop_limit"; break; }
    const hop = claimed[i];

    let recomputed: string;
    try {
      recomputed = buildCommitmentBond(hexToBytes32(hop.fromXonly), hop.fromLockUntil, params.network).address;
    } catch {
      result.stoppedBecause = "address_mismatch";
      break;
    }

    let tx: EsploraTx;
    try {
      tx = await params.fetchJson(`/tx/${hop.fromTxid}`);
    } catch {
      result.stoppedBecause = "unreadable";
      break;
    }
    if (!tx || !Array.isArray(tx.vout)) { result.stoppedBecause = "unreadable"; break; }

    // DERIVE the vout — never accept an index from the wire. If the claimed
    // ancestor's transaction pays nothing to the recomputed bond address, the
    // hop is fabricated.
    const vout = tx.vout.findIndex((o) => o?.scriptpubkey_address === recomputed);
    if (vout < 0) { result.stoppedBecause = "address_mismatch"; break; }

    let spend: { spent: boolean; txid?: string };
    try {
      spend = await esploraOutspend(params.fetchJson, hop.fromTxid, vout);
    } catch {
      result.stoppedBecause = "unreadable";
      break;
    }
    if (!spend.spent) { result.stoppedBecause = "unspent"; break; }
    if (!spend.txid || spend.txid.toLowerCase() !== expectedSpender) {
      // Spent into something that is not the next bond along. This is the check
      // that stops one arbiter adopting another's history.
      result.stoppedBecause = "wrong_spender";
      break;
    }

    result.provenHops = i + 1;
    result.rootTxid = hop.fromTxid;
    const height = tx.status?.block_height;
    // An unconfirmed or height-less ancestor still counts as a proven LINK, but
    // contributes no tenure clock — keep the last known height rather than
    // inventing one.
    if (typeof height === "number" && Number.isFinite(height)) result.rootFundedAtHeight = height;
    expectedSpender = hop.fromTxid.toLowerCase();
  }

  return result;
}

function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("not a 32-byte hex key");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The block a bond's tenure actually starts at: the oldest PROVEN ancestor's
 *  funding height, else this bond's own. Pure.
 *
 *  Deliberately ignores an unproven claim entirely — a bond that says "I am a
 *  year old" and cannot show it is treated as exactly as old as its current
 *  UTXO, which is all anyone can verify. */
export function tenureStartHeight(
  bond: Pick<VerifiedBond, "fundedAtHeight">,
  lineage?: ProvenLineage | null,
): number | undefined {
  const own = bond.fundedAtHeight;
  const root = lineage && lineage.provenHops > 0 ? lineage.rootFundedAtHeight : undefined;
  if (typeof root !== "number") return own;
  if (typeof own !== "number") return root;
  // Older wins, but never accept an ancestor that post-dates the bond it
  // supposedly funded — that ordering is impossible on-chain, so treat it as
  // corrupt data and fall back to the verifiable value.
  return root < own ? root : own;
}

/** True when the announcement claimed more ancestry than the chain backed. The
 *  UI should say "3 of 5 renewals verified" rather than silently showing 3 —
 *  a claim that does not check out is information, not noise. */
export function lineageIsPartial(lineage: ProvenLineage | null | undefined): boolean {
  return !!lineage && lineage.claimedHops > lineage.provenHops;
}
