// ══════════════════════════════════════════════════════════════════════════
// Chama — commitment-bond ANNOUNCEMENT: on-chain check
// ══════════════════════════════════════════════════════════════════════════
//
// The wire format (build, parse, select) is protocol core and is re-exported
// here so existing callers keep one import. This module adds the part that
// needs a block explorer: verifyBondAnnouncement.

export * from "../protocol/core/bond-announcement.js";
import { networkLabel, type BondLineage, type BondRole, type ParsedBondAnnouncement } from "../protocol/core/bond-announcement.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { buildCommitmentBond } from "./commitment-bond.js";
import { findBondFundingUtxos, defaultMinConfs, type EsploraFetch } from "./fund-watcher.js";
import type { BtcNetwork } from "./multisig.js";
import type { NostrEvent } from "../escrow-engine/types.js";

export interface VerifiedBond {
  signedEvent?: NostrEvent;
  npub: string;
  community: string;
  /** The LOCALLY-recomputed address (never the wire's). */
  address: string;
  lockUntil: number;
  /** ACTUAL confirmed sats at the address (chain truth, not the claim). */
  actualSats: bigint;
  claimedSats: bigint;
  /** True ⇒ the recomputed address holds a real confirmed deposit. */
  funded: boolean;
  /** True ⇒ still locked (tip < lockUntil) — an active commitment. */
  active: boolean;
  /** Block the EARLIEST deposit confirmed in — the start of this bond's tenure.
   *  Undefined when Esplora didn't report a height (never inferred). */
  fundedAtHeight?: number;
  /** Funding outpoint txid, so a human can check the claim in a block explorer
   *  instead of taking the app's word for it. */
  fundingTxid?: string;
  /** What the announcer declared this bond licenses. Populated by
   *  `verifyBondAnnouncement`; OPTIONAL because a bond can also arrive from a
   *  cache entry written before A0. Read it through `declaresArbiterRole`,
   *  which treats absent as the arbiter default — never as a merchant opt-out. */
  roles?: BondRole[];
  /** The announcer's renewal claim, structurally valid but NOT yet walked.
   *  A1 turns this into proven tenure; until then it is a claim. */
  lineage?: BondLineage;
  /** A1: the block tenure actually starts at, after walking the lineage on-chain
   *  — the oldest PROVEN ancestor's funding height, else this bond's own. Absent
   *  when the walk has not been run. Read it through `bondTenureBlocks`, which
   *  falls back to `fundedAtHeight` so an unwalked bond still reports honestly
   *  (just shorter). */
  tenureFromHeight?: number;
  /** A1: how much of the announced ancestry the chain actually backed, so the
   *  UI can say "3 of 5 renewals verified" instead of silently showing 3. */
  lineageProven?: { provenHops: number; claimedHops: number };
  /** ⭐ Tier 2.1: the arbiter's BOND key, x-only hex.
   *
   *  Carried onto the verified bond so an on-chain escrow can name an arbiter
   *  who never JOINed. An auto-seated arbiter publishes no JOIN, so without this
   *  their escrow key would never exist and the address could never be computed
   *  — the trade would sit at "waiting for the arbiter" forever.
   *
   *  ⚠ Key reuse across contexts, stated rather than hidden: this key also
   *  signs the bond's own CLTV reclaim. The scripts and sighashes differ, so
   *  there is no nonce-reuse hazard, but it does link an arbiter's escrow
   *  participation to their public bond. Acceptable because a bond IS public and
   *  a seated arbiter is already named on the trade. The clean fix is a
   *  dedicated escrow key in a future 38135 field; this is the version that
   *  works with bonds already announced. */
  ownerXonly?: string;
  /** A1: when the announcement was signed (event `created_at`). NOT tenure —
   *  tenure is chain-proven and this is merely when they said so. It exists for
   *  cohort context: which bonds were announced in the same week. */
  announcedAt?: number;
}

/** ⭐ Chain-verify a parsed announcement: REBUILD the address from (ownerXonly,
 *  lockUntil, network) and read the recomputed address on-chain. Returns the funded
 *  status + the ACTUAL sats + whether it's still active (tip < lockUntil). Rejects
 *  (null) on a network-domain mismatch or an un-decodable key — an announcement whose
 *  claimed `address` doesn't reproduce is simply reported with the recomputed one. */
export async function verifyBondAnnouncement(
  parsed: ParsedBondAnnouncement,
  ctx: { network: BtcNetwork; fetchJson: EsploraFetch; tipHeight?: number },
): Promise<VerifiedBond | null> {
  if (parsed.network !== networkLabel(ctx.network)) return null; // don't cross networks
  let ownerXonly: Uint8Array;
  try { ownerXonly = hexToBytes(parsed.ownerXonly); } catch { return null; }
  const recomputed = buildCommitmentBond(ownerXonly, parsed.lockUntil, ctx.network).address;
  const utxos = await findBondFundingUtxos({
    address: recomputed,
    fetchJson: ctx.fetchJson,
    minConfs: defaultMinConfs(ctx.network),
  });
  const actualSats = utxos.reduce((s, u) => s + u.utxo.amountSats, 0n);
  const tip = ctx.tipHeight;
  // Tenure starts at the EARLIEST confirmed deposit: topping a bond up later
  // must never look like starting over, and must never look older either.
  const heights = utxos
    .map((u) => u.blockHeight)
    .filter((h): h is number => typeof h === "number");
  const fundedAtHeight = heights.length > 0 ? Math.min(...heights) : undefined;
  const earliest = utxos.find((u) => u.blockHeight === fundedAtHeight) ?? utxos[0];
  return {
    signedEvent: parsed.signedEvent,
    npub: parsed.npub,
    community: parsed.community,
    address: recomputed,
    lockUntil: parsed.lockUntil,
    actualSats,
    claimedSats: parsed.claimedSats,
    funded: actualSats > 0n,
    active: typeof tip === "number" ? tip < parsed.lockUntil : true,
    fundedAtHeight,
    fundingTxid: earliest?.utxo.txid,
    roles: parsed.roles,
    ownerXonly: parsed.ownerXonly,
    ...(parsed.lineage ? { lineage: parsed.lineage } : {}),
    announcedAt: parsed.createdAt,
  };
}
