// ══════════════════════════════════════════════════════════════════════════
// Chama — tranching: bound the worst case to a number you chose
// ══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM IT ANSWERS. A Chama lock is 2-of-3 against the arbiter and the
// counterparty, and not against the funder — they know the bearer-note string
// and can reissue it (escrow-engine/lock-custody.ts). Nothing can probe a
// hollowed escrow: `verifyClaim` is dead code, `parseNotes` is offline, and the
// counterparty holds one share so cannot reconstruct the notes to test them. So
// a drained escrow is invisible until the winner's claim fails — after the fiat
// was sent or the goods shipped.
//
// Tranching does not fix that. It does two things that no other mechanism here
// does:
//
//   1. BOUNDS the loss. A trade of A becomes N sequential escrows of ~A/N, so
//      the worst any single corrupt adjudication — or any single funder walking
//      — can take is one tranche. The user picked N, so the worst case is a
//      number they chose rather than one someone else's honesty decides.
//
//   2. Creates DETECTION where none exists. ⭐ The key property, and it falls
//      out for free: the exposed party IS the claimant. The exposed party is the
//      non-locker, and RELEASE always pays the non-locker (p2p-trade → buyer,
//      marketplace → seller). So the person carrying the risk is the person who
//      claims — and their own claim on tranche k either credits or does not,
//      BEFORE they perform the off-platform leg of tranche k+1. A total silent
//      loss becomes a bounded, observed one.
//
// ⚠ THE GATE IS THE WHOLE MECHANISM. Tranche k+1 must not begin until tranche k
// has actually settled for the exposed party. Fund them in parallel, or let a
// client auto-advance on an unproven signal, and you have rebuilt the single
// large escrow with extra steps.
//
// ⚠ A PUBLISHED CLAIM IS NOT PROOF OF CREDIT. v5.4 field evidence: three
// completed trades whose CLAIM published and whose sats never landed. So the
// gate keys on the claimant's OWN observed credit, never on a chain status
// anyone can publish.
//
// NO PROTOCOL CHANGE. Each tranche is an ordinary escrow with an ordinary
// CREATE, carrying a descriptor the reducer stores and never reasons about
// (same posture as `billType` / `workCategory`). Because every tranche is a
// distinct escrow id, each draws its own arbiter through the existing
// deterministic pick — independent panels for free.
//
// LIMITS, STATED. Only divisible value can be tranched: exchange, remittance,
// recurring bills, lending. A single physical item cannot be, and for those the
// only real answer is holding the value somewhere no single party can reach.
//
// PURE: no relays, no money, no reducer logic.

import { EscrowStatus, Role, type EscrowState } from "./types.js";

/** Bounds on N. Two is the minimum that bounds anything; the ceiling keeps a
 *  trade from becoming an unusable number of round trips, which is its own kind
 *  of failure — an abandoned trade helps nobody. */
export const MIN_TRANCHES = 2;
export const MAX_TRANCHES = 12;

/** The descriptor a tranche's CREATE carries. Informational only.
 *
 *  ⭐ SELF-DESCRIBING ON PURPOSE. It carries the whole plan's shape, not just
 *  this slice's position, so any client holding any single tranche can rebuild
 *  the entire plan — the split, the remaining amount, which index comes next.
 *  A local "plan store" would have been smaller, and would have stranded a user
 *  who switched devices mid-plan, or lost the plan to a storage wipe while real
 *  money sat in the middle of it. */
export interface TrancheRef {
  /** Groups the tranches of one logical trade. Client-generated, opaque. */
  planId: string;
  /** 0-based position in the sequence. */
  index: number;
  /** How many tranches the plan has in total. */
  total: number;
  /** The FULL trade amount the plan splits, in msats. Lets any client recompute
   *  the identical split — including which slice each index gets. */
  totalMsats: number;
}

/** Split `totalMsats` into `count` tranches.
 *
 *  The remainder lands on the LAST tranche, deliberately: the early tranches are
 *  the ones a victim uses to discover they are being robbed, so they should be
 *  the small, round, predictable ones. Never produces a zero or negative
 *  tranche — a zero tranche would settle trivially and hand a false green to the
 *  exact gate that is supposed to catch a theft. */
export function planTrancheAmounts(totalMsats: number, count: number): number[] {
  if (!Number.isFinite(totalMsats) || totalMsats <= 0) return [];
  const n = Math.max(MIN_TRANCHES, Math.min(MAX_TRANCHES, Math.floor(count)));
  const base = Math.floor(totalMsats / n);
  if (base <= 0) return [totalMsats]; // too small to split — one tranche, honestly
  const amounts = new Array(n).fill(base);
  amounts[n - 1] = totalMsats - base * (n - 1);
  return amounts;
}

/** The most a user can lose to one bad tranche, given a plan. This is the
 *  number the whole feature exists to let them choose, so it is computed rather
 *  than described. */
export function plannedMaxLossMsats(totalMsats: number, count: number): number {
  const amounts = planTrancheAmounts(totalMsats, count);
  return amounts.length === 0 ? 0 : Math.max(...amounts);
}

/** ⚠ Floor on a single slice, in sats.
 *
 *  NOT the dust limit — dust is what the network relays, and this is about
 *  whether splitting HELPS. Every slice is a whole trade: its own funding, its
 *  own lock, its own settle, its own round trip with a counterparty. Below this,
 *  a user is buying twelve conversations to protect a sum that was never at
 *  meaningful risk, and the feature makes their life worse while looking like
 *  safety. Set at the unbonded floor: beneath it a trade already needs no bond,
 *  which is this codebase's existing definition of "small".
 *
 *  The bug this fixes: with a 1-sat minimum, a 1,000-sat trade offered TWELVE
 *  slices of ~83 sats each. */
export const MIN_TRANCHE_SATS = 10_000;

/** How many tranches a total can usefully be split into.
 *
 *  ⚠ Returns 0 or 1 when splitting does not make sense, and the caller must
 *  hide the control rather than offering the minimum. An earlier version forced
 *  `Math.max(MIN_TRANCHES, …)`, which meant EVERY trade — including a 1,000-sat
 *  one — was told it could be split in two. A floor that cannot be honoured is
 *  not a floor. */
export function maxUsefulTranches(
  totalMsats: number,
  minTrancheMsats: number = MIN_TRANCHE_SATS * 1000,
): number {
  if (minTrancheMsats <= 0) return MAX_TRANCHES;
  const fits = Math.floor(totalMsats / minTrancheMsats);
  if (fits < MIN_TRANCHES) return fits <= 0 ? 0 : 1;
  return Math.min(MAX_TRANCHES, fits);
}

/** Is splitting worth offering at all for this amount? */
export function trancheSplitAvailable(totalMsats: number): boolean {
  return maxUsefulTranches(totalMsats) >= MIN_TRANCHES;
}

/** The msats a specific index gets under the plan's split. Recomputed rather
 *  than stored per-tranche, so every client agrees on the shape and a tampered
 *  amount on one tranche is visible against the plan it claims to belong to. */
export function trancheAmountAt(totalMsats: number, count: number, index: number): number {
  const amounts = planTrancheAmounts(totalMsats, count);
  return amounts[index] ?? 0;
}

/** The fiat price a specific slice asks for.
 *
 *  ⚠ Sliced the SAME WAY as the sats — even split, remainder on the last — and
 *  deliberately NOT scaled by that slice's share of the msats. Scaling looks
 *  more precise and is worse: because the sats split carries its own remainder,
 *  proportional fiat slices come out as 24.98 / 25.07 and do not sum back to
 *  the agreed total. A buyer who agreed to 100 must be asked for exactly 100
 *  across the plan, in amounts a person can read. Computed in integer cents so
 *  the sum is exact rather than nearly exact. */
export function trancheFiatAt(totalFiat: number, count: number, index: number): number | undefined {
  if (!Number.isFinite(totalFiat) || totalFiat <= 0) return undefined;
  const n = planTrancheAmounts(Math.round(totalFiat * 100), count).length;
  if (n === 0) return undefined;
  const cents = planTrancheAmounts(Math.round(totalFiat * 100), count);
  const slice = cents[index];
  return slice === undefined ? undefined : slice / 100;
}

/** Sats still to come after the tranches proven settled so far. The number a
 *  user actually wants when deciding whether to continue. */
export function outstandingMsats(ref: TrancheRef, settled: number): number {
  const amounts = planTrancheAmounts(ref.totalMsats, ref.total);
  return amounts.slice(Math.max(0, settled)).reduce((sum, n) => sum + n, 0);
}

export type TrancheOutcome =
  /** Not started — no escrow published for this index yet. */
  | "pending"
  /** Published and in flight (created, locked, voted, resolved). */
  | "live"
  /** COMPLETED, and the exposed party observed their credit. Only this
   *  advances the plan. */
  | "settled"
  /** COMPLETED on-chain, but the claimant has NOT observed credit. Treated as
   *  UNPROVEN, never as success — this is the v5.4 failure mode. */
  | "unproven"
  /** Cancelled, expired, or refunded — the plan stops. */
  | "failed";

/** Every tranche of one plan, ordered by index. Ignores states carrying a
 *  different planId, and de-dupes a repeated index (a re-publish) by keeping
 *  the FURTHEST-ALONG state, never the newest — a fresh CREATE must not be able
 *  to mask a failure at the same index. */
export function tranchesForPlan(
  planId: string,
  states: Iterable<EscrowState>,
): EscrowState[] {
  const byIndex = new Map<number, EscrowState>();
  for (const s of states) {
    const ref = s.tranche;
    if (!ref || ref.planId !== planId) continue;
    const prior = byIndex.get(ref.index);
    if (!prior || statusRank(s.status) > statusRank(prior.status)) byIndex.set(ref.index, s);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

/** Precedence when two escrows claim the same index.
 *
 *  ⚠ FAILURES OUTRANK EVERYTHING IN FLIGHT, and that ordering is the point. A
 *  first pass ranked EXPIRED below CREATED as "not progress", which meant a
 *  re-published CREATE at a failed index silently masked the failure — handing
 *  the gate a green on exactly the index where something went wrong. Whoever
 *  caused the failure is also the party best placed to re-publish over it.
 *
 *  A settled COMPLETED still wins, because retrying a failed tranche and
 *  succeeding is a legitimate history and the credit check still applies to it. */
function statusRank(status: EscrowStatus): number {
  switch (status) {
    case EscrowStatus.COMPLETED: return 5;
    case EscrowStatus.EXPIRED:
    case EscrowStatus.CANCELLED: return 4; // a stop, and it must stay visible
    case EscrowStatus.CLAIMED: return 3;
    case EscrowStatus.APPROVED: return 2;
    case EscrowStatus.LOCKED: return 1;
    default: return 0; // CREATED
  }
}

/** Classify one tranche.
 *
 *  `creditObserved` is supplied by the caller from the claimant's OWN wallet
 *  evidence. It is a separate argument precisely so that no chain status can be
 *  mistaken for it. */
export function trancheOutcome(
  state: EscrowState | undefined,
  creditObserved: boolean,
): TrancheOutcome {
  if (!state) return "pending";
  if (state.status === EscrowStatus.CANCELLED || state.status === EscrowStatus.EXPIRED) return "failed";
  if (state.status !== EscrowStatus.COMPLETED) return "live";
  return creditObserved ? "settled" : "unproven";
}

export interface TrancheGate {
  /** May the exposed party safely begin the next tranche? */
  canProceed: boolean;
  /** The index they would begin. Null once the plan is finished or stopped. */
  nextIndex: number | null;
  /** Tranches proven settled so far. */
  settled: number;
  total: number;
  /** True when a tranche failed or completed without credit — the plan stops
   *  and the user is told, rather than being nudged onward. */
  stopped: boolean;
}

/**
 * ⭐ THE GATE. Decides whether it is safe to start the next tranche.
 *
 * Fails CLOSED in every ambiguous case: a live tranche, an unproven completion,
 * a failure, or a gap in the sequence all stop the plan. The cost of a wrong
 * "stop" is a user who has to look at their trade; the cost of a wrong
 * "proceed" is the loss this whole feature exists to bound.
 */
export function trancheGate(params: {
  planId: string;
  total: number;
  states: Iterable<EscrowState>;
  /** Did the exposed party observe credit for this tranche? Wallet evidence
   *  only — never a published CLAIM or COMPLETED status. */
  creditObserved: (state: EscrowState) => boolean;
}): TrancheGate {
  const found = tranchesForPlan(params.planId, params.states);
  const byIndex = new Map(found.map((s) => [s.tranche!.index, s]));

  let settled = 0;
  for (let i = 0; i < params.total; i++) {
    const outcome = trancheOutcome(byIndex.get(i), byIndex.has(i) ? params.creditObserved(byIndex.get(i)!) : false);
    if (outcome === "settled") { settled++; continue; }
    if (outcome === "pending") {
      // The next unstarted index — safe to begin only if everything before it
      // settled, which the loop has just established by not breaking earlier.
      return { canProceed: true, nextIndex: i, settled, total: params.total, stopped: false };
    }
    // live / unproven / failed → stop. An unproven completion is deliberately
    // NOT progress: that is the exact shape of a drained escrow.
    return {
      canProceed: false,
      nextIndex: null,
      settled,
      total: params.total,
      stopped: outcome !== "live",
    };
  }
  return { canProceed: false, nextIndex: null, settled, total: params.total, stopped: false };
}

/** True when every tranche settled with observed credit. */
export function planIsComplete(gate: TrancheGate): boolean {
  return gate.settled === gate.total && gate.total > 0;
}

/** The idempotency key for automatic ON-CHAIN continuation, or null when the
 * plan must not advance automatically.
 *
 * On-chain slices have already removed the ecash custody ambiguity that made
 * an explicit continue tap useful. Once the same fail-closed tranche gate has
 * proved the previous slice settled, publishing the next ordinary CREATE is
 * safe and should happen immediately. Ecash deliberately keeps its manual
 * checkpoint. */
export function autoAdvanceOnchainTrancheKey(params: {
  state: EscrowState;
  gate: TrancheGate;
  viewerCanAdvance: boolean;
}): string | null {
  const { state, gate } = params;
  if ((state.escrowMode ?? "ecash") !== "onchain") return null;
  if (!params.viewerCanAdvance || !gate.canProceed || gate.nextIndex === null) return null;
  if (!state.tranche) return null;
  return `${state.tranche.planId}:${gate.nextIndex}`;
}

/**
 * The arbiter pool to stamp on the NEXT tranche's CREATE, excluding arbiters
 * who already served on this plan.
 *
 * ⚠ Not a consensus change: the pool is a per-trade, creator-stamped field, and
 * the reducer picks deterministically from whatever pool the CREATE carries. So
 * narrowing it for a later tranche is ordinary CREATE construction.
 *
 * Forcing a fresh arbiter each time is most of tranching's value against
 * collusion — an attacker must corrupt N distinct arbiters instead of hoping
 * the same one is drawn twice. But it FAILS OPEN: if excluding prior arbiters
 * would leave the pool empty, the full pool is returned. A trade that cannot
 * seat an arbiter is a stranded trade, and stranding the victim to spite the
 * attacker is the wrong trade — the same never-empty doctrine as the OG
 * fallback.
 */
/** Build the CREATE params for the NEXT tranche from a prior one.
 *
 *  Same trick renewal uses (`buildRenewCreateParams`): a tranche is an ordinary
 *  listing, so the next one is the previous one with a new amount, a new index,
 *  and a pool that excludes arbiters who already served. Terms cannot drift
 *  mid-plan, because they are copied rather than re-entered — and a plan whose
 *  price changed under the user between slices would defeat the point of
 *  agreeing to a total up front.
 *
 *  Returns null when the plan should not advance; the caller must have
 *  consulted `trancheGate` first, and this is the belt to that braces. */
export function buildNextTrancheParams(
  prior: EscrowState,
  nextIndex: number,
  priorTranches: readonly EscrowState[],
  rebuild: (state: EscrowState) => Record<string, unknown>,
  /** The PLAN's full fiat price, when the trade carries one. Must be the
   *  whole-plan figure: passing a slice's own fiat would quarter it again on
   *  every hop until it vanished. */
  planTotalFiat?: number,
): Record<string, unknown> | null {
  const ref = prior.tranche;
  if (!ref || nextIndex >= ref.total || nextIndex < 0) return null;
  const amountMsats = trancheAmountAt(ref.totalMsats, ref.total, nextIndex);
  if (amountMsats <= 0) return null;
  const base = rebuild(prior);
  return {
    ...base,
    amountMsats,
    // A continuation stays on the substrate the parties agreed to. Dropping
    // this silently turned slice 2 into ecash after an on-chain slice 1.
    ...(prior.escrowMode === "onchain" ? { escrowMode: "onchain" } : {}),
    // Relay routing only: make the continuation discoverable to both existing
    // principals without pretending they signed or consented to a new seat.
    continuationPubkeys: [
      prior.participants[Role.BUYER],
      prior.participants[Role.SELLER],
    ].filter((pk): pk is string => !!pk),
    // Fiat is per-slice too, or every slice of a 4-way split would ask for the
    // full price. Reconstructed from the PLAN's total fiat, not from this
    // slice's own — otherwise each slice would be a quarter of the last one.
    ...(planTotalFiat !== undefined
      ? { fiatAmount: trancheFiatAt(planTotalFiat, ref.total, nextIndex) }
      : {}),
    tranche: { ...ref, index: nextIndex },
    communityArbiters: poolForNextTranche(prior.communityArbiters ?? [], priorTranches),
  };
}

export function poolForNextTranche(
  fullPool: readonly string[],
  priorTranches: readonly EscrowState[],
): string[] {
  const used = new Set<string>();
  for (const s of priorTranches) {
    const arbiter = s.participants[Role.ARBITER];
    if (arbiter) used.add(arbiter.toLowerCase());
  }
  const fresh = fullPool.filter((pk) => !used.has(pk.toLowerCase()));
  return fresh.length > 0 ? fresh : [...fullPool];
}
