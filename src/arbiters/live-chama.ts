// ══════════════════════════════════════════════════════════════════════════
// Chama — the "Live chama" liveness score
// ══════════════════════════════════════════════════════════════════════════
//
// How alive is a community? Computed from CHAIN-VERIFIED commitment bonds
// (bond-announcement.ts) + arbiter ratings — never a hardcoded "Kenya is green".
// The commitment bond democratized arbiter-hood, so every community earns its
// liveness from the ground up (chama-live-chama-signal-brief.md, Jetty's Q3):
//
//   liveness ≈ (# bonded arbiters) × (their combined ratings) × (bond size × duration)
//
// Each factor: coverage (unity/redundancy), reputation (proven trust), and
// commitment ("how much × how long" — PHILOSOPHY §2.11). This module is PURE +
// tunable; the weights/constants are exported so tuning never means editing logic.
// It NEVER auto-lists a single OG arbiter as "the answer" — it reports a count, so
// thin coverage reads as *opportunity* (apply!) not sufficiency.

import type { VerifiedBond } from "../bond-multisig/bond-announcement.js";

export interface RatingSummary { count: number; positive: number; negative: number; }

export interface ChamaLiveness {
  community: string;
  /** ≥1 funded + still-active bonded arbiter. */
  isLive: boolean;
  /** Distinct funded + active bonded arbiters. */
  arbiterCount: number;
  /** Σ actual on-chain sats across live bonds (chain truth). */
  totalBondSats: bigint;
  /** Σ sats × remaining-term-blocks — the "how much × how long" commitment. */
  bondWeightSatBlocks: bigint;
  /** Sat-weighted average remaining term, in blocks. */
  avgRemainingBlocks: number;
  ratings: { count: number; positive: number; negative: number; positiveRate: number };
  /** 0–100 headline strength (a tunable composite of coverage/commitment/reputation). */
  score: number;
}

export interface LivenessWeights { coverage: number; commitment: number; reputation: number; }
/** Tunable weights (sum ~1). Reputation and commitment lead; coverage rewards unity. */
export const DEFAULT_LIVENESS_WEIGHTS: LivenessWeights = { coverage: 0.3, commitment: 0.4, reputation: 0.3 };

/** Arbiter count that saturates the coverage term (more still helps the readout). */
export const COVERAGE_SATURATES_AT = 3;
/** Reference bond-weight (sats × remaining-blocks) that anchors the commitment
 *  term's mid-scale — a ~100k-sat bond held ~10,000 blocks. Chosen so realistic
 *  bonds spread across 0–1 rather than saturating; ~10× the reference ≈ full credit.
 *  Tunable (the exact number is a product knob, not logic). */
export const COMMITMENT_REF_SATBLOCKS = 100_000 * 10_000;

/** Compute a community's liveness from its chain-verified bonds + arbiter ratings.
 *  `tipHeight` sets remaining-term (lockUntil − tip). Only FUNDED + ACTIVE bonds
 *  count — an unfunded claim or an expired bond contributes nothing. */
export function computeChamaLiveness(
  community: string,
  bonds: readonly VerifiedBond[],
  ratingsByNpub: ReadonlyMap<string, RatingSummary>,
  tipHeight: number,
  weights: LivenessWeights = DEFAULT_LIVENESS_WEIGHTS,
): ChamaLiveness {
  // One live bond per arbiter (newest already selected upstream); dedup defensively.
  const byArbiter = new Map<string, VerifiedBond>();
  for (const b of bonds) {
    if (!b.funded || !b.active) continue;
    const cur = byArbiter.get(b.npub);
    if (!cur || b.actualSats > cur.actualSats) byArbiter.set(b.npub, b);
  }
  const live = [...byArbiter.values()];
  const arbiterCount = live.length;

  const totalBondSats = live.reduce((s, b) => s + b.actualSats, 0n);
  const bondWeightSatBlocks = live.reduce(
    (s, b) => s + b.actualSats * BigInt(Math.max(0, b.lockUntil - tipHeight)),
    0n,
  );
  const avgRemainingBlocks = totalBondSats > 0n ? Number(bondWeightSatBlocks / totalBondSats) : 0;

  let rc = 0, rp = 0, rn = 0;
  for (const b of live) {
    const r = ratingsByNpub.get(b.npub);
    if (r) { rc += r.count; rp += r.positive; rn += r.negative; }
  }
  const positiveRate = rc > 0 ? rp / rc : 0;

  // ── Composite (0–100), each term normalized to 0–1 ────────────────────────
  const coverage = Math.min(1, arbiterCount / COVERAGE_SATURATES_AT);
  // Log-scaled commitment: diminishing returns, ~1.0 at 10× the reference weight.
  const commitment = bondWeightSatBlocks > 0n
    ? Math.min(1, Math.log10(1 + Number(bondWeightSatBlocks) / COMMITMENT_REF_SATBLOCKS) / Math.log10(11))
    : 0;
  // Bayesian-smoothed positive rate (5 pseudo-votes at 50%) so a 1-rating arbiter
  // isn't a raw 0% or 100%.
  const reputation = (rp + 2.5) / (rc + 5);
  const raw = weights.coverage * coverage + weights.commitment * commitment + weights.reputation * reputation;

  return {
    community,
    isLive: arbiterCount > 0,
    arbiterCount,
    totalBondSats,
    bondWeightSatBlocks,
    avgRemainingBlocks,
    ratings: { count: rc, positive: rp, negative: rn, positiveRate },
    score: arbiterCount === 0 ? 0 : Math.round(100 * raw),
  };
}

/** The distinct npubs assignable as arbiters from a set of chain-verified bonds
 *  for a community — funded + still-active only (an unfunded claim or an expired
 *  bond enrolls no one). This is the permissionless bond → arbiter pool source
 *  (S1 of chama-bond-arbiter-enrollment-brief.md): the bond IS the trust, so a
 *  chain-verified bonded npub can be seated without a steward sign-off. Pure +
 *  governance-neutral — wiring it into the assignable pool is a later, gated step. */
export function bondedArbitersForCommunity(bonds: readonly VerifiedBond[]): string[] {
  const set = new Set<string>();
  for (const b of bonds) {
    // A0: a bond may declare itself a MERCHANT license only — a storefront that
    // renews without its holder being conscripted as a judge. `roles` defaults
    // to ["arbiter"], so every bond announced before A0 is unaffected.
    if (b.funded && b.active && declaresArbiterRole(b)) set.add(b.npub.toLowerCase());
  }
  return [...set];
}

/** True when the bond licenses dispute arbitration. Tolerates a bond that
 *  predates `roles` (undefined ⇒ arbiter), so an older cache entry or an older
 *  announcement can never silently unseat a real arbiter. */
export function declaresArbiterRole(bond: Pick<VerifiedBond, "roles">): boolean {
  return !bond.roles || bond.roles.length === 0 || bond.roles.includes("arbiter");
}

// ── A1 (5.8) COHORT CONTEXT ─────────────────────────────────────────────────
//
// A Sybil operator does not post one bond, they post several, and they tend to
// post them together. That leaves a signature no individual bond can show:
// a cluster of announcements in one community in one week.
//
// ⚠ RULE (locked with Jetty): PUBLISH THE NUMBER, DO NOT DRAW THE CONCLUSION.
// This is not a detector and must never be rendered as an accusation. Seven
// bonds in one week is what a Sybil looks like AND what a successful community
// recruitment drive looks like — those are indistinguishable from here, and the
// people in the community can tell them apart while an algorithm cannot. So we
// state the fact beside the arbiter and stop talking.

/** A week, in seconds — the cohort bucket. Wide enough to catch a batch posted
 *  over a few days, narrow enough that an ordinary community rarely fills one. */
export const COHORT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export interface BondCohort {
  /** Other bonds announced in this community within the window. Excludes the
   *  subject, and counts each npub once (a re-announcement is not a peer). */
  peerCount: number;
  windowSeconds: number;
}

/** Count the subject's announcement cohort. Pure; takes the parsed
 *  announcements the caller already fetched for the community. */
export function bondCohort(
  subject: { npub: string; createdAt: number },
  communityAnnouncements: readonly { npub: string; createdAt: number }[],
  windowSeconds: number = COHORT_WINDOW_SECONDS,
): BondCohort {
  const subjectNpub = subject.npub.toLowerCase();
  const peers = new Set<string>();
  for (const a of communityAnnouncements) {
    const npub = a.npub.toLowerCase();
    if (npub === subjectNpub) continue;
    if (Math.abs(a.createdAt - subject.createdAt) <= windowSeconds) peers.add(npub);
  }
  return { peerCount: peers.size, windowSeconds };
}

/** Human readout for the onboarding chip — "3 arbiters · 96% · ~60-day bonds".
 *  `blocksPerDay` maps remaining-term blocks to days (signet ~2880, mainnet ~144).
 *  Never names a single arbiter — a bare count keeps scarcity reading as opportunity. */
export function formatLivenessReadout(l: ChamaLiveness, blocksPerDay = 144): string {
  if (l.arbiterCount === 0) return "No bonded arbiters yet — be the first";
  const parts = [`${l.arbiterCount} arbiter${l.arbiterCount === 1 ? "" : "s"}`];
  if (l.ratings.count > 0) parts.push(`${Math.round(l.ratings.positiveRate * 100)}%`);
  if (l.avgRemainingBlocks > 0) {
    const days = Math.max(1, Math.round(l.avgRemainingBlocks / blocksPerDay));
    parts.push(`~${days}-day bond${days === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

// ── Bond tenure (5.7 arbiter card) ───────────────────────────────────────
//
// The unforgeable half of an arbiter's standing. Sats can be borrowed for an
// afternoon; TIME cannot. A fresh npub can post 30,000 sats in ten minutes and
// can never post eight months of history — only waiting produces that, which
// is the same asymmetry that makes proof-of-work honest: expensive to produce,
// instant to verify (one block height, from a call the verifier already makes).
//
// Deliberately DESCRIPTIVE, never a virtue claim. "Bonded 6 months" is a fact
// anyone can check in a block explorer; "trusted arbiter" would be Chama
// vouching for a person, and the day one of them cheats that is Chama's
// reputation, not theirs.

/** Blocks a bond has been funded for, or null when the height is unknown. */
export function bondTenureBlocks(
  fundedAtHeight: number | null | undefined,
  tipHeight: number | null | undefined,
): number | null {
  if (typeof fundedAtHeight !== "number" || typeof tipHeight !== "number") return null;
  if (!Number.isFinite(fundedAtHeight) || !Number.isFinite(tipHeight)) return null;
  return Math.max(0, tipHeight - fundedAtHeight);
}

/** A1: a bond's tenure INCLUDING proven renewals. `tenureFromHeight` is stamped
 *  by the lineage walk; without it this is byte-identical to measuring the
 *  current UTXO, so an unwalked bond under-reports rather than over-reports. */
export function verifiedBondTenureBlocks(
  bond: Pick<VerifiedBond, "fundedAtHeight" | "tenureFromHeight">,
  tipHeight: number | null | undefined,
): number | null {
  return bondTenureBlocks(bond.tenureFromHeight ?? bond.fundedAtHeight, tipHeight);
}

/** Coarse tenure tiers. Few, widely spaced — a dozen badges mean nothing, and
 *  the label is always the duration itself, never a judgement. */
export type TenureTier = "new" | "month" | "half-year" | "year";

export function tenureTier(blocks: number | null, blocksPerDay: number): TenureTier {
  if (blocks === null || blocksPerDay <= 0) return "new";
  const days = blocks / blocksPerDay;
  if (days >= 365) return "year";
  if (days >= 180) return "half-year";
  if (days >= 30) return "month";
  return "new";
}

/** Whole days a bond has stood, for display. Null when unknown — never guessed. */
export function tenureDays(blocks: number | null, blocksPerDay: number): number | null {
  if (blocks === null || blocksPerDay <= 0) return null;
  return Math.floor(blocks / blocksPerDay);
}
