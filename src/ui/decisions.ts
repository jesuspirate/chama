// ══════════════════════════════════════════════════════════════════════════
// Chama — Pure UI decision helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Decisions that the UI shell needs to make about routing/rendering, factored
// out as pure functions so they can be unit-tested without React, the
// fedimint client, or relays in scope. The shell consumes them and dispatches
// the relevant side-effects (state updates, action calls, modal toggles).
//
// Both are domain-pure: no DOM, no React. Imports are limited to registry
// data + invite constants.

import {
  getCommunityBySlug,
  communityForInvite,
  DEFAULT_COMMUNITY_SLUG,
} from "../communities/registry.js";
import {
  BP_FEDERATION_INVITE,
  CURATED_PRESETS,
  effectiveCreateFederationId,
  expectedFederationIdForInvite,
} from "../fedimint/federation-config.js";
import { balanceBlocksFederationSwitch, MATERIAL_RECOVERY_MIN_SATS } from "../payments/lightning-fees.js";
import {
  type EscrowState,
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
  TERMINAL_STATES,
  getEffectiveParticipantsAt,
} from "../escrow-engine/types.js";
import { arbiterVotePriority, substitutionEligibleAt } from "../escrow-engine/arbiter-substitution.js";
import { translate, getCurrentLang } from "../i18n/index.js";
import { payoutRecipientFor } from "../escrow-engine/recipients.js";
import { pendingOnchainArbiterPubkey } from "../notifications/trade-notifications.js";
import type { AggregateRatings } from "../reputation/ratings.js";
import { isWorkListing } from "./work-resume.js";

// One dust line, defined in the payments layer so the UI decision code and the
// data-layer switch guards can't drift apart (see balanceBlocksFederationSwitch).
export const MAIN_SURFACE_RECOVERY_MIN_SATS = MATERIAL_RECOVERY_MIN_SATS;

function hasMainSurfaceRecoveryBalance(balanceMsats: number): boolean {
  return balanceBlocksFederationSwitch(balanceMsats);
}

// ──────────────────────────────────────────────────────────────────────────
// Community-pill tap → identity + federation effect
// ──────────────────────────────────────────────────────────────────────────
//
// Per PHILOSOPHY.md §2.3, communities are the user's identity layer.
// v0.1.85 update: tapping a community is also THE join — there is no
// "stage identity then commit via picker" intermediate step. The pills
// are the primary first-time join surface; the picker is a Sandbox-only
// power-user escape hatch.
//
// Tapping a community pill must:
//   1. Update the user's chama_community localStorage
//   2. Filter Browse to that community
//   3. Switch (or first-time init) the backing federation client
//
// The target federation is the community's pinned invite (or BP if the
// registry entry has federationInvite === null). We deliberately bypass
// the user's pasted-custom-invite override here: tapping a community is
// a direct identity choice that should take precedence over an earlier
// sandbox-mode override.
//
// v0.1.87: the synthetic "All communities" pill (and the filter-only
// effect kind it produced) was removed. Per Pillar 2.1 every user has
// a home community, so there is no community-less state to filter from.
//
// Effect kinds:
//   - identity-only    — currentInvite === targetInvite (already on the
//                        right fed; just update community + filter)
//   - switch-silent    — needs to (re-)init/switch the client. Used for
//                        first-time-join AND returning-user-different-fed
//                        with balance == 0. Caller dispatches init vs
//                        switch based on whether a fed is already loaded.
//   - destroy-confirm  — returning user with balance > 0 trying to switch
//                        away from a fed that holds sats; surface the
//                        existing fund-loss-guard modal.

export type CommunityTapEffect =
  | { kind: "identity-only"; slug: string }
  | {
      kind: "switch-silent";
      slug: string;
      targetInvite: string;
      displayName: string;
    }
  | {
      kind: "destroy-confirm";
      slug: string;
      targetInvite: string;
      displayName: string;
      balanceMsats: number;
      currentInvite: string;
    }
  | {
      kind: "blocked-active-commitment";
      slug: string;
      displayName: string;
      activeCommitmentCount: number;
    };

export interface CommunityTapInputs {
  slug: string;
  /** The OPFS-bound invite the wallet currently lives on. `null` means
   *  the user has never joined a federation. */
  currentInvite: string | null;
  /** Live balance from fedimint state. */
  balanceMsats: number;
  /** V3 #72: count of live buyer/seller commitments (open escrows the user
   *  must stay reachable for). Balance alone is blind here — during LOCKED
   *  the wallet shows 0 (ecash spent into SSS shares) while the user is at
   *  their MOST committed. Optional so legacy callers/tests read as 0. */
  activeCommitmentCount?: number;
}

export function decideCommunityTapEffect(inputs: CommunityTapInputs): CommunityTapEffect {
  const community = getCommunityBySlug(inputs.slug);
  // Community-tap honors the community's pinned invite (or BP fallback).
  // We bypass any custom-invite override on purpose.
  const targetInvite = community?.federationInvite ?? BP_FEDERATION_INVITE;
  const displayName = community?.displayName ?? inputs.slug;

  // Already on the right fed — pure identity update, no client work.
  if (inputs.currentInvite === targetInvite) {
    return { kind: "identity-only", slug: inputs.slug };
  }

  // First-time user (no current invite) — silent INIT. No balance check
  // needed: a wallet that doesn't exist yet can't hold funds.
  if (!inputs.currentInvite) {
    return { kind: "switch-silent", slug: inputs.slug, targetInvite, displayName };
  }

  // V3 #72: a live buyer/seller commitment outranks EVERYTHING — including
  // the destroy-confirm below. Switching feds mid-trade can't steal the sats
  // (the escrow lives on Nostr + its fed), but it CAN make the user miss
  // votes, claims, and dispute windows. And the balance guard can't catch
  // this: during LOCKED the wallet correctly shows 0. Hard block with honest
  // copy — no destructive override is offered while a trade is live.
  // ("Switch anytime BETWEEN trades, never during one.")
  if ((inputs.activeCommitmentCount ?? 0) > 0) {
    return {
      kind: "blocked-active-commitment",
      slug: inputs.slug,
      displayName,
      activeCommitmentCount: inputs.activeCommitmentCount ?? 0,
    };
  }

  // Returning user, fed differs. Only a MATERIAL recoverable balance should
  // block the switch — the SAME dust line every other recovery surface uses
  // (hasMainSurfaceRecoveryBalance: >= MAIN_SURFACE_RECOVERY_MIN_SATS AND
  // Lightning-withdrawable). The old bare hasLightningWithdrawableBalance check
  // fired for any balance that could withdraw even 1 sat (~4 sats total), so a
  // switch blocked over ~1 sat the app ITSELF treats as dust — it won't even
  // nudge you to recover it via the banner. Aligning the two so dust never
  // blocks a switch while a real balance still surfaces the destroy guard.
  if (!hasMainSurfaceRecoveryBalance(inputs.balanceMsats)) {
    return { kind: "switch-silent", slug: inputs.slug, targetInvite, displayName };
  }

  return {
    kind: "destroy-confirm",
    slug: inputs.slug,
    targetInvite,
    displayName,
    balanceMsats: inputs.balanceMsats,
    currentInvite: inputs.currentInvite,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Auto-init target on app load (sticky-community routing)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.1's "every user has a home" doctrine: every user — first-
// time or returning — gets dropped on a real federation at boot. The
// decision tree (priority order):
//
//   1. In-flight trade with balance > 0 → use-active
//      (Funds at stake; preserve the fed they live on. Refresh during
//      an active trade is a recovery scenario, not a navigation one.)
//
//   2. Home community known (with or without active invite) → use-home
//      (Sticky-community: even if the user session-time-switched to
//      another fed via listing-tap, refresh re-anchors to home. If
//      hasCurrentEscrow is true but balance is zero, the trade
//      post-claimed or recovered out-of-band — preserving the active
//      fed in that case strands the user on something they no longer
//      need.)
//
//   3. v0.2.0 first-time-npub auto-init → use-default
//      No home AND no active invite means a truly fresh npub (first
//      sign-in). Pre-v0.2.0 this fell to "skip" and the user landed
//      in "No Chama" limbo, which violates Pillar 2.1. v0.2.0 assigns
//      BLF + Global USD silently so the user lands on Browse with a
//      working federation; they can switch communities anytime via
//      the pills, after which sticky-community takes over.
//
//   4. Else (active invite without home community — sandbox-style
//      power-user setup) → skip. We don't auto-default these because
//      we don't know which community the user intended; manual
//      reconnect via Sandbox or a community-pill tap is the right
//      path.
//
// Pure: the helper reads no localStorage and no fedimint state. The
// shell collects the inputs and dispatches based on the result.

export type AutoInitTarget =
  | { kind: "skip" }
  | { kind: "use-active"; invite: string }
  | { kind: "use-home"; invite: string; slug: string }
  | {
      kind: "use-default";
      invite: string;
      defaultCommunity: string;
      reason: "first-time-npub" | "active-invite-without-home";
    };

export interface AutoInitInputs {
  /** chama_active_invite — the OPFS-bound invite, or `null` if none. */
  activeInvite: string | null;
  /** chama_community — the user's home community slug, or `null` for
   *  a truly first-time user. */
  homeCommunity: string | null;
  /** True iff the user is a participant (buyer or seller) in a
   *  non-terminal escrow per the local replay. Arbiter-only
   *  participation does not count for this gate. */
  hasCurrentEscrow: boolean;
  /** Live OPFS balance from fedimint state. */
  balanceMsats: number;
}

export function decideAutoInitTarget(inputs: AutoInitInputs): AutoInitTarget {
  if (
    inputs.hasCurrentEscrow
    && inputs.balanceMsats > 0
    && inputs.activeInvite
  ) {
    return { kind: "use-active", invite: inputs.activeInvite };
  }

  if (inputs.homeCommunity) {
    const community = getCommunityBySlug(inputs.homeCommunity);
    // Honor the community's pinned invite (or BP fallback) — bypass
    // any pasted-custom-invite override the user might have set in
    // Sandbox. Sticky-community is intentionally rigid: refresh =
    // come home.
    const homeInvite = community?.federationInvite ?? BP_FEDERATION_INVITE;
    return { kind: "use-home", invite: homeInvite, slug: inputs.homeCommunity };
  }

  // First-time-npub: no home AND no active. Assign BLF + Global USD
  // silently. Active-known-without-home is the same repair path when
  // the invite maps to a visible community: every user needs a scoped
  // home, and refresh must not preserve a route with no identity pill.
  const inferredCommunity = inputs.activeInvite
    ? inferCommunitySlugForInvite(inputs.activeInvite)
    : DEFAULT_COMMUNITY_SLUG;
  if (inferredCommunity) {
    const defaultCommunity = getCommunityBySlug(inferredCommunity);
    const defaultInvite = defaultCommunity?.federationInvite ?? BP_FEDERATION_INVITE;
    return {
      kind: "use-default",
      invite: defaultInvite,
      defaultCommunity: inferredCommunity,
      reason: inputs.activeInvite ? "active-invite-without-home" : "first-time-npub",
    };
  }

  // Unknown custom invite without a home remains Sandbox-style: manual
  // reconnect / community-pill tap is the right path because no visible
  // community identity can be inferred.
  return { kind: "skip" };
}

function inferCommunitySlugForInvite(invite: string | null): string | null {
  const trimmed = invite?.trim();
  if (!trimmed) return null;

  const defaultCommunity = getCommunityBySlug(DEFAULT_COMMUNITY_SLUG);
  if (defaultCommunity?.federationInvite === trimmed) {
    return DEFAULT_COMMUNITY_SLUG;
  }

  return communityForInvite(trimmed)?.slug ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime-support announcement banner
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.7 (educate at every opportunity). v1.1.0 reframes this
// from a browser-specific note to a production-path note: Fedi, Tauri,
// and APK are the supported real-sats shells. It still fires once per
// account regardless of whether the user has committed to a federation.
//
// Render only when ALL of:
//   - the user hasn't dismissed the banner before (one-time-per-account)

export interface BrowserBannerInputs {
  /** Kept for older callsites/tests. v1.1.0 shows this in every real runtime. */
  isBrowser?: boolean;
  dismissed: boolean;
  /** v0.4.2: sim mode swaps the WASM Fedimint client for a localStorage
   *  mock, so the real-runtime announcement is moot. The copy
   *  directly contradicts the SIM MODE pill if shown alongside it.
   *  Hide unconditionally when sim mode is on. */
  simModeOn?: boolean;
}

export function shouldShowBrowserSupportBanner(inputs: BrowserBannerInputs): boolean {
  if (inputs.simModeOn) return false;
  if (inputs.dismissed) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Counterparty display name
// ──────────────────────────────────────────────────────────────────────────
//
// Used by the v0.2.0 recovery banner ("Your trade with [counterparty]
// didn't finish") and the arbiter-attention warning copy ("Trade
// between [npub-A] and [npub-B]"). Pure function — given the raw npub
// + a "fetch counterparty kind:0" toggle state + the kind:0 name (if
// any), it returns the right string for the surface.
//
// Privacy default: truncated npub. The full name only appears when the
// user has explicitly opted into kind:0 fetching (Me → Nostr Profile,
// v0.2.0) AND the counterparty has self-published a kind:0 with a name
// field. Both conditions must hold; either alone falls back to the
// truncated npub. This honors the buyer/seller's right to use Chama
// without surfacing their broader Nostr identity to other Chama
// participants who haven't asked to fetch it.
//
// The kind:0 fetcher itself ships in v0.2.1 — for v0.2.0 the helper is
// callable with `kind0Name: null` and renders truncated npubs across
// the board. Wiring the fetcher in later doesn't change this contract.

const TRUNCATED_NPUB_HEAD = 8;
const TRUNCATED_NPUB_TAIL = 4;

export interface CounterpartyDisplayInputs {
  /** The counterparty's hex pubkey or bech32 npub (string is opaque to
   *  this helper — we just take the head/tail for truncation). */
  npub: string;
  /** Whether the user has enabled "fetch counterparty kind:0" in Me →
   *  Nostr Profile. v0.2.0 surfaces this toggle but doesn't fetch yet;
   *  v0.2.1 wires the fetcher. */
  fetchKind0Enabled: boolean;
  /** The counterparty's self-published kind:0 name, if known. `null`
   *  when fetch is disabled, when the counterparty hasn't published
   *  kind:0, or when their kind:0 lacks a name field. */
  kind0Name: string | null;
}

export function displayCounterpartyName(inputs: CounterpartyDisplayInputs): string {
  if (
    inputs.fetchKind0Enabled
    && typeof inputs.kind0Name === "string"
    && inputs.kind0Name.trim().length > 0
  ) {
    return inputs.kind0Name.trim();
  }
  // Truncated npub fallback. The 8/4 split is wide enough that two
  // distinct npubs are visually distinguishable in the recovery banner
  // and arbiter warnings without leaking more than necessary.
  if (inputs.npub.length <= TRUNCATED_NPUB_HEAD + TRUNCATED_NPUB_TAIL + 1) {
    return inputs.npub;
  }
  return (
    inputs.npub.slice(0, TRUNCATED_NPUB_HEAD)
    + "…"
    + inputs.npub.slice(-TRUNCATED_NPUB_TAIL)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Subscription-mode graduation gate (item 7)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.6 (reputation as backbone primitive): subscription /
// recurring-payments is a graduated capability earned via positive-
// rating accumulation, mirroring the auto-assigned → manual-pickable →
// community-elected progression for arbiters. The toggle is invisible
// to users who haven't earned it; they learn it exists by seeing other
// users use it.
//
// v1 placeholder threshold (per the addendum): 5+ positive ratings,
// 0 negative. Documented in PHILOSOPHY.md §State 8 / Recurring as a
// v1 default; the real threshold will emerge from observed seller
// behavior post-launch.
//
// In v0.2.0 with no rating events being published yet, the aggregator
// returns null for every npub and this gate returns false universally.
// That's correct behavior — nobody has graduated, nobody sees the
// toggle. When ratings ship in v0.2.1+, the gate naturally opens for
// qualifying sellers without any further wiring.

// AggregateRatings is owned by the reputation layer (reputation/ratings.ts);
// re-exported here so existing consumers (MeScreen, App) keep their import path.
export type { AggregateRatings };

const SUBSCRIPTION_MIN_POSITIVE = 5;
const SUBSCRIPTION_MAX_NEGATIVE = 0;

export function canOfferSubscription(inputs: {
  ratings: AggregateRatings | null;
}): boolean {
  if (!inputs.ratings) return false;
  return (
    inputs.ratings.positive >= SUBSCRIPTION_MIN_POSITIVE
    && inputs.ratings.negative <= SUBSCRIPTION_MAX_NEGATIVE
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Active-trade detection (v0.6.5 — informational, not a gate)
// ──────────────────────────────────────────────────────────────────────────
//
// History: through v0.6.4 these helpers backed a hard "one trade at a
// time" gate on Create + Fund. v0.6.5 retires that gate. With Option B
// fully wired (BOLT11 IN → mint → spendNotes → LOCK → OPFS drains to 0),
// the wallet sits at zero between trades; ecash exists only for the
// milliseconds spanning runFundAndLock. There is no architectural
// reason a seller can't serve three buyers, or a buyer can't browse
// for the next trade while a previous one is in LOCKED/voting/approved.
//
// What blocks now: one *funding operation* at a time (isMidFunding
// below). The AtomicFundingModal is already an exclusive modal, so the
// UI guarantees this in practice; isMidFunding is the programmatic
// backstop that protects the shared OPFS wallet from two concurrent
// spendNotes calls racing.
//
// hasActiveBuyerSellerCommitment + findActiveTrade survive as display
// helpers: ChamaBar's "X sats in escrow" pill and the ActiveTradePill
// strip both need to know about live money-moving commitments. CREATED
// listings stay in Browse/Me as inventory; they should not light up the
// global purple attention banner until LOCK moves sats into escrow.

function isPastEscrowDeadline(e: EscrowState, nowSec: number): boolean {
  return typeof e.expiresAt === "number" && e.expiresAt > 0 && nowSec > e.expiresAt;
}

/** True when a RESOLVED trade's payout belongs to someone other than the
 *  viewer: the viewer's part is DONE (vote cast, share envelope carried) and
 *  the remaining work — claiming — is entirely the winner's. The locker who
 *  released shouldn't keep an orange "in escrow" pill for money that is no
 *  longer theirs; the trade stays in history for chat + rebroadcast. */
function resolvedForSomeoneElse(e: EscrowState, viewerPubkey: string | undefined): boolean {
  if (!viewerPubkey || !e.resolvedOutcome) return false;
  const winner = payoutRecipientFor(e, e.resolvedOutcome);
  return !!winner && winner.pubkey !== viewerPubkey;
}

function isLiveBuyerSellerCommitment(e: EscrowState, nowSec: number, viewerPubkey?: string): boolean {
  if (TERMINAL_STATES.has(e.status)) return false;
  // Resolved in someone else's favor → my commitment is over; only the
  // winner's claim remains. Releases the locker at RESOLVE, not at CLAIM.
  if (e.status === EscrowStatus.APPROVED && resolvedForSomeoneElse(e, viewerPubkey)) return false;
  // CLAIMED means the trade has left the live escrow phase. Successful
  // claims move on to COMPLETED; locally failed redemptions stay visible on
  // the detail screen as "Claim failed", but should not keep the global
  // ActiveTradePill alive.
  if (e.status === EscrowStatus.CLAIMED) return false;
  // Open listings are public inventory, not active money movement. They
  // remain browsable and visible in Me, including JOINed-but-not-LOCKED
  // holds, but the global active-trade pill is reserved for LOCKED and
  // APPROVED flows where sats are already in escrow or ready to claim.
  if (e.status === EscrowStatus.CREATED) return false;
  if (e.status !== EscrowStatus.LOCKED && e.status !== EscrowStatus.APPROVED) return false;
  if (isPastEscrowDeadline(e, nowSec)) {
    return false;
  }
  return true;
}

function isEffectiveBuyerOrSeller(e: EscrowState, userPubkey: string, nowSec: number): boolean {
  const p = getEffectiveParticipantsAt(e, nowSec);
  return p.buyer === userPubkey || p.seller === userPubkey;
}

export function hasActiveBuyerSellerCommitment(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): boolean {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec, inputs.userPubkey)) continue;
    return true;
  }
  return false;
}

/**
 * v0.6.5: how many live buyer/seller commitments the user is in. Drives
 * the plural-aware ActiveTradePill copy ("1 active trade" vs "3 active
 * trades") now that multiple concurrent trades are allowed.
 */
export function countActiveBuyerSellerCommitments(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let n = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec, inputs.userPubkey)) continue;
    n += 1;
  }
  return n;
}

/**
 * v0.6.5: total msats across all live buyer/seller commitments the
 * user is in. Drives the ActiveTradePill's amount headline.
 *
 * Distinct from `activeCommittedMsats` (which sums only LOCKED +
 * APPROVED - money *actually* in escrow). This sums every live
 * trade's amountMsats for LOCKED + APPROVED flows only. Open listings
 * are inventory and stay off the attention banner. Two surfaces, two
 * truthful readings:
 *   ActiveTradePill   → "what's the gravitational weight of my live
 *                        trade activity right now?"     (this helper)
 *   ChamaBar in-trade → "how many sats are actually locked in
 *                        escrow?"                       (activeCommittedMsats)
 */
export function sumActiveBuyerSellerTradeMsats(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let sum = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec, inputs.userPubkey)) continue;
    sum += e.amountMsats;
  }
  return sum;
}

// ══════════════════════════════════════════════════════════════════════════
// Part ① — "needs you" attention set (Me-tab badge + the loud attention pill)
// ══════════════════════════════════════════════════════════════════════════
//
// A de-duplicated, urgency-ordered list of the trades/listings that need the
// user to ACT right now. Pure so both the bottom-nav badge count and the pill's
// "N waiting · tap to act" (routing to the most urgent) read from one source of
// truth. Mirrors MeScreen's tradeNeedsUser (vote/claim owed) and adds the two
// liquidity signals a seller must not miss: a live child ORDER to deliver
// (covered by the LOCKED-no-vote branch) and a buyer WAITING on a pre-lock
// listing (a live JOIN hold). Each trade counts at most once.

/** Higher = more urgent; drives both the ordering and the pill's tap target. */
const NEEDS_YOU_RANK = {
  claim: 4,   // APPROVED and I'm the winner — sats ready to claim
  dispute: 3, // I'm the arbiter and a dispute is open, my ruling owed
  vote: 2,    // LOCKED and I'm buyer/seller without my vote (incl. an order to deliver)
  "arbiter-key": 1, // a buyer joined an on-chain trade; funding needs my key
  waiting: 1, // my CREATED listing has a live buyer hold — respond / lock it
} as const;

function samePk(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The attention reason (if any) this trade needs the user to act on, or null. */
function needsYouReason(
  e: EscrowState,
  userPubkey: string,
  nowSec: number,
): keyof typeof NEEDS_YOU_RANK | null {
  const p = getEffectiveParticipantsAt(e, nowSec);
  const isBuyer = samePk(p.buyer, userPubkey);
  const isSeller = samePk(p.seller, userPubkey);
  const isAssignedArbiter = samePk(p.arbiter, userPubkey);
  const isPoolArbiter = e.communityArbiters?.some((a) => samePk(a, userPubkey)) ?? false;

  // Claim owed — resolved in my favor, the payout is mine to take.
  if (e.status === EscrowStatus.APPROVED) {
    const winner = payoutRecipientFor(e, e.resolvedOutcome ?? Outcome.RELEASE);
    return winner && samePk(winner.pubkey, userPubkey) ? "claim" : null;
  }

  if (e.status === EscrowStatus.LOCKED) {
    // Vote / deliver owed — my turn on a live trade (a live child order to
    // deliver lands here for the seller until they vote release).
    if ((isBuyer || isSeller) && e.votes[getRoleKey(isBuyer)] === undefined) return "vote";
    // Arbiter ruling owed — a buyer↔seller dispute is open and my vote isn't in.
    const bV = e.votes[Role.BUYER];
    const sV = e.votes[Role.SELLER];
    const dispute = bV !== undefined && sV !== undefined && bV !== sV;
    if ((isAssignedArbiter || isPoolArbiter) && dispute && e.votes[Role.ARBITER] === undefined) {
      return "dispute";
    }
    return null;
  }

  if (e.status === EscrowStatus.CREATED) {
    // A pre-lock CHILD order is a buyer-created draft on my storefront: the
    // buyer is seated directly (no JOIN hold), so the hold-based branch below
    // never fires and the seller got no persistent signal — only a live OS
    // buzz that can't catch up on cold boot. Surface it as "waiting" so a
    // reserved-but-unfunded order lands in the seller's Me-tab attention set
    // (and the pill), the same pull a single-listing JOIN gives. Seller-only,
    // and dropped once the child passes its own deadline.
    if (
      e.parent !== undefined
      && isSeller
      && !isPastEscrowDeadline(e, nowSec)
    ) return "waiting";

    const hold = e.joinHolds?.[Role.BUYER];
    if (hold && hold.expiresAt > nowSec) {
      // The exact deterministic arbiter already targeted by the OS/DM alert
      // must also see the in-app yellow attention path. Keep this tied to the
      // live buyer hold and the missing key: an expired reservation or an
      // arbiter who already acted must immediately leave the queue.
      const pendingArbiter = pendingOnchainArbiterPubkey(e);
      if (
        pendingArbiter
        && samePk(pendingArbiter, userPubkey)
        && !(e.escrowKeys ?? {})[Role.ARBITER]
      ) return "arbiter-key";

      // Buyer waiting on my open listing — a live JOIN hold I should respond to.
      if (isSeller) return "waiting";
    }
  }
  return null;
}

function getRoleKey(isBuyer: boolean): Role {
  return isBuyer ? Role.BUYER : Role.SELLER;
}

/**
 * The trades needing the user's action, most-urgent first (claim → dispute →
 * vote → waiting), de-duplicated by id. Pure. Drives the Me-tab badge count and
 * the attention pill's headline + tap target.
 */
export function selectNeedsYouTrades(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): EscrowState[] {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  const ranked: { trade: EscrowState; rank: number }[] = [];
  const seen = new Set<string>();
  for (const e of inputs.escrows) {
    if (seen.has(e.id)) continue;
    const reason = needsYouReason(e, inputs.userPubkey, nowSec);
    if (!reason) continue;
    seen.add(e.id);
    ranked.push({ trade: e, rank: NEEDS_YOU_RANK[reason] });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  return ranked.map((r) => r.trade);
}

/** Add confirmed, still-unspent on-chain winner outputs to the same attention
 * queue as claim/vote work. Chain scanning owns the truth about whether an
 * output remains spendable; this helper only merges that verified result into
 * the UI queue and keeps the newest completed payout first. */
export function mergeOnchainPayoutAttention(inputs: {
  needsYou: readonly EscrowState[];
  escrows: Iterable<EscrowState>;
  pendingEscrowIds: ReadonlySet<string>;
}): EscrowState[] {
  const activityAt = (trade: EscrowState): number => Math.max(
    trade.createdAt || 0,
    ...trade.eventChain.map(event => event.timestamp || 0),
    ...(trade.settlements ?? []).map(event => event.timestamp || 0),
  );
  const pending = [...inputs.escrows]
    .filter(trade => inputs.pendingEscrowIds.has(trade.id))
    .sort((a, b) => activityAt(b) - activityAt(a) || b.id.localeCompare(a.id));
  const seen = new Set(pending.map(trade => trade.id));
  return [...pending, ...inputs.needsYou.filter(trade => !seen.has(trade.id))];
}

/**
 * A seller's untouched parent listing opens in inventory management. Once a
 * buyer has a live reservation, however, that same CREATED parent is an active
 * order room: the seller must see the buyer/cart/countdown, not edit/cancel.
 */
export function shouldOpenSellerListingManagement(inputs: {
  escrow: EscrowState;
  viewerPubkey: string | null | undefined;
  nowSec?: number;
}): boolean {
  const { escrow, viewerPubkey } = inputs;
  if (
    escrow.status !== EscrowStatus.CREATED
    || escrow.initiator.role !== Role.SELLER
    || !samePk(escrow.initiator.pubkey, viewerPubkey)
    || escrow.parent
  ) return false;

  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  const buyerHold = escrow.joinHolds?.[Role.BUYER];
  return !buyerHold || buyerHold.expiresAt <= nowSec;
}

/** The urgency reason (if any) a trade needs the user to act on — the public
 *  accessor over the private needsYouReason so the attention hero can render a
 *  one-line "what's owed" WITHOUT reimplementing the urgency logic. Returns
 *  one of "claim" | "dispute" | "vote" | "arbiter-key" | "waiting", or null. */
export function needsYouReasonFor(
  e: EscrowState,
  userPubkey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): "claim" | "dispute" | "vote" | "arbiter-key" | "waiting" | null {
  return needsYouReason(e, userPubkey, nowSec);
}

/** Count of trades needing the user's action — the Me-tab red badge. */
export function countNeedsYou(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  return selectNeedsYouTrades(inputs).length;
}

/**
 * Browse is the public market surface, not only "things I am not in".
 * A listing remains browsable while it is CREATED, including:
 *   - the seller's own freshly-created listing
 *   - a buyer/arbiter JOIN ACK that has not produced LOCK yet
 *
 * LOCK is the actual money-moving transition. Once LOCK lands, the trade
 * leaves Browse and lives on the active-trade/detail surfaces. Expired
 * CREATED listings are hidden while the sentinel catches up and publishes
 * CANCEL.
 */
export function shouldShowOnBrowse(inputs: {
  escrow: EscrowState;
  browseCategory: string;
  nowSec?: number;
  /** #7 Stage 3: derived sold-out flag for a multi-unit parent (the caller
   *  computes it from the parent's children via isSoldOut). A sold-out
   *  storefront drops off Browse. Absent / false for single-unit listings. */
  isSoldOut?: boolean;
}): boolean {
  const { escrow, browseCategory } = inputs;
  if (escrow.status !== EscrowStatus.CREATED) return false;
  // Once PLAN_START freezes the participants, this CREATE is the persistent
  // parent room/manifest—not an offer another buyer can take.
  if (escrow.tranchePlan) return false;
  // #7 Stage 3: a CHILD purchase escrow (carries `parent`) is a trade, not a
  // listing — it lives in Me / loadable by id, never as its own Browse card.
  if (escrow.parent !== undefined) return false;
  if (isPastEscrowDeadline(escrow, inputs.nowSec ?? Math.floor(Date.now() / 1000))) {
    return false;
  }
  // #7 Stage 3: a sold-out multi-unit parent stops showing as buyable.
  if (inputs.isSoldOut) return false;
  if (browseCategory === "all") return true;
  if (browseCategory === "subscription") return escrow.subscription !== null;
  if (browseCategory === "work") return isWorkListing(escrow);
  if (browseCategory === "marketplace") {
    return escrow.category === "marketplace" && !isWorkListing(escrow);
  }
  return escrow.category === browseCategory;
}

/**
 * v0.6.5 funding-operation gate. True while runFundAndLock is mid-flight
 * (between creating-invoice and the locked/lock-failed/expired/aborted
 * terminal phases). The only condition that should disable a second
 * Fund tap.
 *
 * This is a UI-layer concern, not a state-machine concern: each trade's
 * event chain is independent. The gate exists because the Fedimint WASM
 * client shares one OPFS wallet, and two concurrent spendNotes calls on
 * that wallet could race.
 *
 * Accepts either `fundAndLockInProgress` (literal brief name) or
 * `fundingInProgress` (the state-field name used in useEscrow) so
 * callers don't need to translate.
 */
export function isMidFunding(inputs: {
  fundAndLockInProgress?: boolean;
  fundingInProgress?: boolean;
}): boolean {
  return inputs.fundAndLockInProgress ?? inputs.fundingInProgress ?? false;
}

/**
 * v0.4.2 hotfix round 3: msats the user has committed to active escrows
 * as buyer or seller. Returns the SUM across all active funded
 * commitments (LOCKED / APPROVED). Used by decideChamaBarLabel to drive
 * the "X sats in escrow" pill during LOCKED state when the wallet
 * balance is correctly 0 (the user has SPENT the ecash into SSS shares).
 *
 * Why this matters: the previous decision read only wallet balance,
 * which is correctly 0 after LOCK (the seller's ecash got split into
 * encrypted shares on Nostr — none of it sits in the local wallet).
 * The pill went silent at exactly the moment users most need to see
 * "your money is committed." Pillar 2.1 Option B.
 *
 * Status set:
 *   CREATED  → 0 (no commitment yet — the listing exists but no money moved)
 *   LOCKED   → amountMsats (sats are in escrow as SSS shares)
 *   APPROVED → amountMsats (still in escrow until claim+redeem completes)
 *   CLAIMED  → 0 (winner has redeemed; commitment over, balance reflects it)
 *   COMPLETED/CANCELLED → 0 (terminal, no commitment)
 *   EXPIRED  → 0 (healing transient — the commitment is already resolving
 *                 via auto-refund; not load-bearing for the pill)
 */
export function activeCommittedMsats(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let sum = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (e.status !== EscrowStatus.LOCKED && e.status !== EscrowStatus.APPROVED) continue;
    if (e.status === EscrowStatus.LOCKED && isPastEscrowDeadline(e, nowSec)) continue;
    // Resolved for someone else → these sats are the winner's claim now, not
    // the viewer's escrow. The locker is released at RESOLVE.
    if (e.status === EscrowStatus.APPROVED && resolvedForSomeoneElse(e, inputs.userPubkey)) continue;
    sum += e.amountMsats;
  }
  return sum;
}

// ── ChamaBar label decision (v0.3.0 Phase 5 + v0.3.1 Phase 3) ─────────────
//
// Four states the top-bar's right-side surface can be in:
//   - unreachable : bootProbeState === "failed" (v0.3.1 Phase 3 —
//                   federation joined but unreachable; "⚠ Chama
//                   unreachable · Reconnect →"; tappable). Wins over
//                   all other states because reachability is the
//                   floor for any other meaningful state.
//   - in-trade    : user has a LOCKED/APPROVED buyer/seller commitment
//                   ("Active funds in escrow: N sats")
//   - stranded    : material balance AND no active commitment (failure-mode;
//                   tappable → opens RecoveryPayoutModal directly)
//   - ready       : balance == 0 OR only tiny post-payout dust
//                   (neutral, "Chama: ready")
//
// Per Phase 5 reminder #3: arbiter-only commitments do NOT count as
// active. Arbiters mid-arbitration see "Chama: ready" because the
// balance, if any, isn't theirs to commit. The predicate
// hasActiveBuyerSellerCommitment is the same one Q3 of v0.2.0 locked
// in for Create-blocking.
//
// v0.3.1 Phase 3 ordering rationale: unreachable wins over stranded
// and in-trade because if the user can't reach the federation, they
// also can't recover stranded sats or progress an in-trade flow —
// the actionable next step is Reconnect, not Recover or Vote. The
// "pending" bootProbeState does NOT override the existing kinds; it's
// a transient state between initFedimint resolving and probe1 result,
// and the UI is fine with the (brief) optimistic rendering during it.

export type ChamaBarLabel =
  | { kind: "ready" }
  | { kind: "in-trade"; sats: number; activeTradeCount: number }
  | { kind: "stranded"; sats: number }
  | { kind: "unreachable" };

export function decideChamaBarLabel(opts: {
  balanceMsats: number;
  hasActiveBuyerSellerCommitment: boolean;
  /** v0.3.1 Phase 3 — when "failed", overrides all other kinds and
   *  returns `{ kind: "unreachable" }`. "pending" and "ok" pass
   *  through to the existing three-state decision. Optional/defaulted
   *  for backwards compatibility — pre-Phase-3 callsites continue to
   *  render the three-state surface as if probe is ok. */
  bootProbeState?: "pending" | "ok" | "failed";
  /** v0.4.2 hotfix round 3: msats committed to active LOCKED/APPROVED
   *  trades as buyer or seller. When the wallet balance is 0 but this
   *  is > 0, the pill reflects the escrowed amount instead of going
   *  silent. Pillar 2.1 Option B: "your money is in escrow" must be
   *  visible during the LOCKED state, where balance is correctly 0
   *  (ecash was spent into SSS shares). Pure helper above:
   *  `activeCommittedMsats`. Optional for backwards compatibility. */
  activeCommittedMsats?: number;
  /** v0.6.5: count of live buyer/seller commitments. Drives plural-
   *  aware in-trade pill copy ("1 active trade" vs "3 active trades").
   *  Optional/defaulted to 1 for backwards compatibility. */
  activeTradeCount?: number;
  /** Phase 1: true when the app is in sim mode. The "stranded" pill is the
   *  same recovery alarm as shouldShowRecoveryBanner — a real-stranded-funds
   *  cry-wolf that must not fire on intentional, fake sim manual-fund
   *  balances. In sim ONLY the stranded branch is skipped (falls through to
   *  "ready"); "unreachable", "in-trade", "ready" and the priority ordering
   *  are all unchanged. Optional/defaulted falsy → production is
   *  byte-identical. */
  simModeOn?: boolean;
  /** #37: same suppressor as shouldShowRecoveryBanner — the stranded pill
   *  one-taps into the drain modal, which must not fire while the balance
   *  belongs to a recoverable lock attempt. Only the stranded branch is
   *  skipped. Optional/defaulted falsy → byte-identical. */
  hasPendingNativeLock?: boolean;
  /** Stranded-payout recovery: same suppressor as shouldShowRecoveryBanner
   *  — while an unfinished claim payout explains the balance, the stranded
   *  pill must not offer the drain. Only the stranded branch is skipped.
   *  Optional/defaulted falsy → byte-identical. */
  hasPendingClaimPayout?: boolean;
}): ChamaBarLabel {
  if (opts.bootProbeState === "failed") return { kind: "unreachable" };
  const activeTradeCount = Math.max(1, opts.activeTradeCount ?? 1);
  // Floor to whole sats — the bar always speaks in sats, never msats.
  const sats = Math.floor(opts.balanceMsats / 1000);
  // If there's an active LOCKED/APPROVED commitment, surface that ledger
  // amount as the in-trade pill. CREATED listings are intentionally not
  // enough to explain a wallet balance: no money has moved yet.
  const committedSats = Math.floor((opts.activeCommittedMsats ?? 0) / 1000);
  if (committedSats > 0) return { kind: "in-trade", sats: committedSats, activeTradeCount };
  if (
    !opts.simModeOn &&
    !opts.hasPendingNativeLock &&
    !opts.hasPendingClaimPayout &&
    sats > 0 &&
    sats >= MAIN_SURFACE_RECOVERY_MIN_SATS
  ) return { kind: "stranded", sats };
  return { kind: "ready" };
}

/** The most-recent active buyer/seller trade. Used by the shell to
 *  drive the "go to active trade" pill's tap target. Returns null if
 *  no active trade exists. */
export function findActiveTrade(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): EscrowState | null {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let best: EscrowState | null = null;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec, inputs.userPubkey)) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Recovery banner (item 2; v0.6.5 narrowing)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.1's "no sats stranded, ever" promise: when the user's
// OPFS holds a material Lightning-withdrawable balance but they have no
// active trade, that's a recovery state. Tiny post-payout dust may
// accumulate quietly in Me; the main-flow banner reappears once the
// aggregate balance is large enough to deserve interrupting the user.
//
// v0.6.5: also suppress while expected-transient flows hold a balance
// briefly — mid-runFundAndLock (the ecash that's about to be SSS-split)
// and mid-claim-payout (winnings between redemption and outbound LN
// sweep). Either of those firing the banner would race with the flow
// that's about to drain the balance.

export function shouldShowRecoveryBanner(inputs: {
  balanceMsats: number;
  /** v0.6.5 preferred name. Callers should pass true only for an actual
   *  LOCKED/APPROVED commitment that can explain local OPFS balance.
   *  CREATED listings do not count because no money has moved yet. The
   *  pre-v0.6.5 alias `hasCurrentEscrow` is still honored for callers
   *  that haven't migrated. */
  hasAnyActiveEscrow?: boolean;
  /** Deprecated alias for `hasAnyActiveEscrow`. Kept so older callers
   *  (and tests) continue to work without touching every site. */
  hasCurrentEscrow?: boolean;
  /** v0.6.5: true while runFundAndLock is between creating-invoice and
   *  a terminal phase. Suppresses the banner — the atomic flow owns
   *  the balance. Optional/defaulted for backwards compatibility. */
  fundingInProgress?: boolean;
  /** v0.6.5: true while runClaimAndPayout is between claim and the
   *  outbound LN send. Suppresses the banner — the claim flow owns
   *  the balance. Optional/defaulted for backwards compatibility. */
  claimPayoutInProgress?: boolean;
  /** Phase 1: true when the app is in sim mode. The recovery banner is a
   *  PRODUCTION real-stranded-funds alarm; sim manual-fund balances are
   *  intentional and fake, so the banner must never fire on them.
   *  Optional/defaulted falsy → the production path stays byte-identical. */
  simModeOn?: boolean;
  /** #37: true while the pending-native-locks stash holds an actionable
   *  entry (a lock attempt mid-recovery, or a fresh funding intent). The
   *  balance then belongs to a KNOWN trade whose correct next step is
   *  "finish the lock" — the drain banner would advise abandoning a live
   *  trade at a fee. Bounded upstream (summarizeNativeLocksForUi): stale
   *  intents and attempt-exhausted entries stop suppressing. Optional/
   *  defaulted falsy → existing callers byte-identical. */
  hasPendingNativeLock?: boolean;
  /** Stranded-payout recovery: true while a CLAIMED trade the user won
   *  still owes its outbound payout (summarizePendingPayoutsForUi). The
   *  balance then belongs to a KNOWN claim whose correct next step is
   *  "finish the payout" (the trade's own guarded RETRY CLAIM) — not the
   *  generic drain alarm. Bounded upstream: entries age out after
   *  PENDING_PAYOUT_SUPPRESS_MAX_MS so unrelated stranded balance can't
   *  hide forever. Optional/defaulted falsy → existing callers
   *  byte-identical. */
  hasPendingClaimPayout?: boolean;
}): boolean {
  if (inputs.simModeOn) return false;
  if (!hasMainSurfaceRecoveryBalance(inputs.balanceMsats)) return false;
  const hasActiveEscrow = inputs.hasAnyActiveEscrow ?? inputs.hasCurrentEscrow ?? false;
  if (hasActiveEscrow) return false;
  if (inputs.fundingInProgress) return false;
  if (inputs.claimPayoutInProgress) return false;
  if (inputs.hasPendingNativeLock) return false;
  if (inputs.hasPendingClaimPayout) return false;
  return true;
}

export interface StrandedEcashSource {
  escrowId: string;
  /** The other non-self participant in the trade (buyer/seller, NOT
   *  arbiter). When the user IS the arbiter (rare for a stranded-
   *  ecash scenario), falls back to whichever party is present. */
  counterpartyPubkey: string;
  /** The user's role in that trade. */
  role: Role;
  /** Trade amount (msats) for the banner's withdraw CTA. */
  amountMsats: number;
  /** Trade description for the banner's identity card. */
  description: string;
}

/** Walk the local event replay to find the most recent CLAIM event
 *  signed by the user. The escrow that CLAIM lives on is the source
 *  of the stranded ecash; the counterparty is the other non-self
 *  participant. Returns null if no CLAIM event exists locally — the
 *  shell falls back to "Trade with unknown counterparty" copy + a
 *  generic withdraw flow. */
export function identifyStrandedEcashSource(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
}): StrandedEcashSource | null {
  let best: { escrow: EscrowState; claimAt: number } | null = null;
  for (const e of inputs.escrows) {
    for (const evt of e.eventChain) {
      if (
        evt.kind === EscrowEventKind.CLAIM
        && evt.pubkey === inputs.userPubkey
      ) {
        if (!best || evt.timestamp > best.claimAt) {
          best = { escrow: e, claimAt: evt.timestamp };
        }
      }
    }
  }
  if (!best) return null;

  const e = best.escrow;
  let role: Role;
  let counterparty: string;
  if (e.participants.buyer === inputs.userPubkey) {
    role = Role.BUYER;
    counterparty = e.participants.seller ?? "";
  } else if (e.participants.seller === inputs.userPubkey) {
    role = Role.SELLER;
    counterparty = e.participants.buyer ?? "";
  } else {
    // User claimed but isn't buyer/seller — defensive fallback.
    role = Role.ARBITER;
    counterparty = e.participants.buyer ?? e.participants.seller ?? "";
  }
  return {
    escrowId: e.id,
    counterpartyPubkey: counterparty,
    role,
    amountMsats: e.amountMsats,
    description: e.description,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Pending claim payouts (stranded-payout recovery — the claim-side analog
// of #37's pending-native-locks summary)
// ──────────────────────────────────────────────────────────────────────────
//
// In P2P Exchange the winner CLAIMs the sats into their own wallet and the
// orchestrator immediately pays them out; COMPLETE is deferred until the
// payout actually sends (claim-and-payout.ts). So a CLAIMED-not-COMPLETED
// trade the user won means the claimed ecash is (or should be) sitting in
// the wallet with an outbound payout still owed. That balance is EXPLAINED
// — the correct next step is the trade's own guarded RETRY CLAIM, not the
// generic drain alarm. Without this summary the recovery banner fired the
// instant a trade settled+claimed (activeCommittedMsats counts only
// LOCKED/APPROVED) and mis-attributed the sweep to the single most-recent
// CLAIM regardless of amount.
//
// Bounded suppression, mirroring summarizeNativeLocksForUi (#37 F1/F14/F17):
//   • other-fed trades never suppress (they can't explain THIS fed's balance)
//   • entries age out after PENDING_PAYOUT_SUPPRESS_MAX_MS — after that the
//     banner story resumes. That escalation is SAFE here: the trade is
//     settled and no live escrow backs the claimed balance, so the drain
//     merely completes the stalled payout (opposite of the #37 harmful case).
//   • a "finish" entry only speaks when the balance could actually hold the
//     claim (a claim-pending trade whose redeem never landed tells no false
//     "your sats are back" story — though opening the trade is still the
//     correct action there too, via the retry's cover check).

export interface PendingClaimPayout {
  escrowId: string;
  /** Trade amount (msats) — what the claim credited to the wallet. */
  amountMsats: number;
  /** Trade description for the card. */
  description: string;
  /** finish     — no payout-journal record: the payout was never sent or
   *               definitively failed. The trade's RETRY CLAIM (double-pay
   *               guarded) is the correct, safe next step.
   *  confirming — journal `submitted`: a payout is in flight / unknown.
   *               reattachPayout resolves it; never invite a re-pay. */
  kind: "finish" | "confirming";
  /** Timestamp (Unix seconds) of the user's latest CLAIM on the trade. */
  claimAtSec: number;
}

export interface PendingPayoutUiSummary {
  /** Suppress the drain-shaped recovery surfaces while an actionable
   *  finish/confirming story exists (bounded — see module comment). */
  suppressRecovery: boolean;
  /** The entry the "Finish your payout" card should show (newest), or null. */
  card: PendingClaimPayout | null;
  entries: PendingClaimPayout[];
}

/** Suppression age bound: after this, an unfinished payout stops hiding the
 *  recovery banner (same doctrine + horizon as #37's
 *  NATIVE_LOCK_SUPPRESS_MAX_MS — suppression must be bounded so unrelated
 *  stranded balance can't stay invisible forever). */
export const PENDING_PAYOUT_SUPPRESS_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Latest CLAIM event the user signed on this escrow (Unix seconds), or
 *  null when the user never claimed it (not the winner). */
function latestUserClaimAtSec(e: EscrowState, userPubkey: string): number | null {
  let latest: number | null = null;
  for (const evt of e.eventChain) {
    if (evt.kind === EscrowEventKind.CLAIM && evt.pubkey === userPubkey) {
      if (latest === null || evt.timestamp > latest) latest = evt.timestamp;
    }
  }
  return latest;
}

/** The trade's stamped federation id (CREATE payload `fed`), normalized.
 *  Same read App's browse matcher uses; null for legacy/unstamped trades. */
function escrowFedId(e: EscrowState): string | null {
  const fed = (e.eventChain[0]?.payload as { fed?: string } | undefined)?.fed;
  return normalizeFedId(fed ?? null);
}

export function summarizePendingPayoutsForUi(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  /** Bound to payments/payout-journal getPayoutRecord by the caller —
   *  kept as an input so this stays pure/testable. V7: an `intent` record
   *  (pre-send breadcrumb, payment may never have been dispatched) is
   *  treated exactly like NO record — the "finish" bucket, balance-gated;
   *  the claim retry's own guard reconciles by escrow before re-paying. */
  getPayoutRecord: (escrowId: string) => { status: "intent" | "submitted" | "settled" } | null;
  balanceMsats: number;
  nowMs: number;
  /** The wallet's CURRENT federation. When provided, trades stamped with a
   *  different fed neither suppress nor card — their claim can't explain
   *  THIS fed's balance. Unstamped (legacy) trades pass through. */
  currentFederationId?: string | null;
}): PendingPayoutUiSummary {
  const entries: PendingClaimPayout[] = [];
  const currentFed = normalizeFedId(inputs.currentFederationId ?? null);
  for (const e of inputs.escrows) {
    // CLAIMED only: COMPLETED means the payout confirmed (or a prior
    // reattach short-circuited) — leftover balance after COMPLETED is the
    // generic-residue story, not a payout to finish.
    if (e.status !== EscrowStatus.CLAIMED) continue;
    const claimAtSec = latestUserClaimAtSec(e, inputs.userPubkey);
    if (claimAtSec === null) continue;
    const tradeFed = escrowFedId(e);
    if (currentFed && tradeFed && tradeFed !== currentFed) continue;
    if (inputs.nowMs - claimAtSec * 1000 > PENDING_PAYOUT_SUPPRESS_MAX_MS) continue;
    const record = inputs.getPayoutRecord(e.id);
    // settled ⇒ the payout went out and the sats left the wallet; the
    // reattach sweep publishes the missing COMPLETE. Nothing to card,
    // nothing to suppress.
    if (record?.status === "settled") continue;
    if (record?.status === "submitted") {
      // In flight / unknown outcome. No balance gate: if it settles the
      // balance drains (card resolves via reattach); if it refunded, the
      // returned sats are exactly what this entry explains.
      entries.push({
        escrowId: e.id,
        amountMsats: e.amountMsats,
        description: e.description,
        kind: "confirming",
        claimAtSec,
      });
      continue;
    }
    // No record: payout never sent, or definitively failed (the journal
    // clears on confirmed failure so RETRY CLAIM stays live). Only speak
    // when the balance could actually hold the claim.
    if (inputs.balanceMsats >= e.amountMsats) {
      entries.push({
        escrowId: e.id,
        amountMsats: e.amountMsats,
        description: e.description,
        kind: "finish",
        claimAtSec,
      });
    }
  }
  entries.sort((a, b) => b.claimAtSec - a.claimAtSec);
  return {
    suppressRecovery: entries.length > 0,
    card: entries[0] ?? null,
    entries,
  };
}

/** CLAIMED trades the user won that hold ANY payout-journal record
 *  (submitted OR settled). Each is a safe reattachPayout target: reattach
 *  only re-attaches to the existing operationId / publishes the missing
 *  COMPLETE — it structurally never re-pays. The boot sweep runs these so
 *  a stuck "payout confirming" resolves without the user re-opening the
 *  trade (the V6 symptom). No age bound: reconciling an old record is
 *  always correct. */
export function selectPayoutReattachTargets(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  getPayoutRecord: (escrowId: string) => { status: "intent" | "submitted" | "settled" } | null;
}): string[] {
  const targets: string[] = [];
  for (const e of inputs.escrows) {
    if (e.status !== EscrowStatus.CLAIMED) continue;
    if (latestUserClaimAtSec(e, inputs.userPubkey) === null) continue;
    if (!inputs.getPayoutRecord(e.id)) continue;
    targets.push(e.id);
  }
  return targets;
}

/** Attribution honesty for the recovery banner's trade identity card: the
 *  named claim explains the sweep only when the balance doesn't materially
 *  EXCEED the trade amount (2% + 50-sat tolerance for lock
 *  overpay-by-denomination and fee dust). A ₿1,570 card must never front a
 *  ₿2,462 sweep — when other residue is mixed in, the banner drops the
 *  card and says "residual balance" instead. One-sided by design: a balance
 *  SMALLER than the claim (partial recovery, post-payout reserve dust) is
 *  still honestly "from this trade". */
export function strandedSourceExplainsBalance(
  amountMsats: number,
  balanceMsats: number,
): boolean {
  return balanceMsats <= amountMsats * 1.02 + 50_000;
}

// ──────────────────────────────────────────────────────────────────────────
// Listing-tap effect (items 1 + 4 — federation-follows-listing dispatch)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.3 ("federation follows the listing"): when a user taps
// a listing whose federation differs from their current OPFS-bound
// fed, the client silently re-inits against the listing's fed before
// the detail screen renders. Per Jetty's Q1 confirmation: the re-init
// happens at LISTING-TAP time, not at Fund-CTA time — the detail
// screen always opens on the right fed, so every render is coherent
// regardless of whether Fund is tapped.
//
// Effect kinds:
//   - matching         — listing's fed === current; render State A
//                        immediately, no client work
//   - switch-silent    — listing's fed differs and balance is 0 OR
//                        no current invite; the shell tears down +
//                        re-inits, then renders State B (past-tense
//                        narration: "Running on BLF · we switched
//                        you in for this trade")
//   - destroy-confirm  — listing's fed differs and balance > 0; the
//                        existing fund-loss-guard modal surfaces
//                        before any switch happens
//
// State C (cross-fed with non-zero balance + auto-route) was
// explicitly abandoned during v0.1.85 design — the destroy-confirm
// path is the only way to handle non-zero balances.

export type ListingTapEffect =
  | { kind: "matching" }
  | { kind: "switch-silent"; targetInvite: string; displayName: string }
  | {
      kind: "destroy-confirm";
      targetInvite: string;
      displayName: string;
      balanceMsats: number;
      currentInvite: string;
    }
  | {
      kind: "blocked-active-commitment";
      displayName: string;
      activeCommitmentCount: number;
    };

export interface ListingTapInputs {
  /** The listing's CREATE-event-derived fed identity. After PR A's
   *  item 9 fix, every listing carries both mintUrl and community.
   *  Pre-v0.1.87 listings may have stale/missing mintUrl; community
   *  is the more reliable source there. */
  listing: { mintUrl: string; community: string | null; fedId?: string | null };
  /** chama_active_invite — null if the user has no fed loaded. */
  currentInvite: string | null;
  /** Live OPFS balance. */
  balanceMsats: number;
  /** V3 #72: live buyer/seller commitments — same guard as the community
   *  tap. A foreign-listing tap silently switches the wallet's fed, which
   *  must never happen out from under a live trade. Optional → 0. */
  activeCommitmentCount?: number;
  /** v4.1 D (cross-chama continuation): active buyer/seller commitments on
   *  feds OTHER than this listing's target fed. When provided, it — not the
   *  fed-agnostic `activeCommitmentCount` — drives the switch-away block, so a
   *  user can switch TOWARD the fed where their OWN live trade lives to
   *  continue it (safe + necessary) while still being blocked from switching
   *  AWAY from a fed that holds a live trade (the load-bearing invariant).
   *  Omitted ⇒ falls back to `activeCommitmentCount` (legacy behavior — the
   *  current call site does NOT pass this, so runtime is unchanged until the
   *  wiring is reviewed). */
  activeCommitmentCountElsewhere?: number;
}

function inviteForFederationId(fedId: string | null | undefined): string | null {
  const normalized = normalizeFedId(fedId);
  if (!normalized) return null;
  return CURATED_PRESETS.find(
    (preset) => normalizeFedId(preset.federationId) === normalized,
  )?.inviteCode ?? null;
}

function resolveListingInvite(listing: {
  mintUrl: string;
  community: string | null;
  fedId?: string | null;
}): string {
  const effectiveFedId = effectiveCreateFederationId({
    fed: listing.fedId,
    mintUrl: listing.mintUrl,
    community: listing.community,
  });
  const fedInvite = inviteForFederationId(effectiveFedId);
  if (fedInvite) return fedInvite;
  if (listing.mintUrl && listing.mintUrl.startsWith("fed1")) {
    return listing.mintUrl;
  }
  if (listing.community) {
    const c = getCommunityBySlug(listing.community);
    if (c?.federationInvite) return c.federationInvite;
  }
  return BP_FEDERATION_INVITE;
}

export interface ListingRouteMatchInputs {
  listingMintUrl: string;
  listingFedId?: string | null;
  listingCommunity?: string | null;
  activeInvite: string | null;
  activeFedId?: string | null;
}

function normalizeFedId(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

export function listingMatchesActiveRoute(inputs: ListingRouteMatchInputs): boolean {
  const listingFedId = effectiveCreateFederationId({
    fed: inputs.listingFedId,
    mintUrl: inputs.listingMintUrl,
    community: inputs.listingCommunity,
  });
  const activeFedId = normalizeFedId(inputs.activeFedId)
    ?? normalizeFedId(expectedFederationIdForInvite(inputs.activeInvite));

  if (listingFedId) {
    return !!activeFedId && listingFedId === activeFedId;
  }

  if (!inputs.activeInvite) return false;
  if (inputs.listingMintUrl === inputs.activeInvite) return true;

  // Legacy / cross-device listings may have a stale or missing mintUrl
  // while still carrying the community slug. If the slug resolves to
  // the user's active invite, keep the card in the matching section
  // instead of incorrectly tinting it as "other routes".
  const community = inputs.listingCommunity ? getCommunityBySlug(inputs.listingCommunity) : null;
  return community?.federationInvite === inputs.activeInvite;
}

export function resolveCreateMintUrl(inputs: {
  activeInvite: string | null;
  community: string | null;
}): string {
  if (inputs.activeInvite?.startsWith("fed1")) {
    return inputs.activeInvite;
  }
  return resolveListingInvite({ mintUrl: "", community: inputs.community });
}

export function decideListingTapEffect(inputs: ListingTapInputs): ListingTapEffect {
  const targetInvite = resolveListingInvite(inputs.listing);
  const community = inputs.listing.community ? getCommunityBySlug(inputs.listing.community) : null;
  const displayName = community?.displayName
    ?? translate(getCurrentLang(), "app.fallbackListingCommunity");

  if (inputs.currentInvite === targetInvite) {
    return { kind: "matching" };
  }
  // V3 #72 (same invariant as the community tap): a foreign-listing tap
  // dispatches a silent fed switch — never while a live trade needs the
  // user on the current fed. Matching listings above are unaffected.
  //
  // v4.1 D: the block is keyed on commitments that switching AWAY would
  // strand — i.e. live trades on a fed OTHER than the target. When the caller
  // supplies `activeCommitmentCountElsewhere` it is authoritative (so a user
  // can switch TOWARD the fed holding their own live trade to continue it);
  // otherwise we fall back to the fed-agnostic count (unchanged legacy guard).
  const blockingCommitmentCount =
    inputs.activeCommitmentCountElsewhere ?? inputs.activeCommitmentCount ?? 0;
  if (inputs.currentInvite && blockingCommitmentCount > 0) {
    return {
      kind: "blocked-active-commitment",
      displayName,
      activeCommitmentCount: blockingCommitmentCount,
    };
  }
  // Same material-balance dust line as decideCommunityTapEffect: dust never
  // blocks a listing-fed switch; only a recoverable-worth balance guards.
  if (!inputs.currentInvite || !hasMainSurfaceRecoveryBalance(inputs.balanceMsats)) {
    return { kind: "switch-silent", targetInvite, displayName };
  }
  return {
    kind: "destroy-confirm",
    targetInvite,
    displayName,
    balanceMsats: inputs.balanceMsats,
    currentInvite: inputs.currentInvite,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Trade detail framing — State A vs State B (item 1, listing-detail half)
// ──────────────────────────────────────────────────────────────────────────
//
// When a user taps a listing, the shell silently re-inits to that
// listing's fed before the detail screen renders (per Q1). The detail
// screen then chooses framing based on whether the listing's fed
// matches the user's HOME community's fed:
//
//   - state-a: listing's fed === home's fed. Standard "runs on
//     [name] · same as your Chama" narration. CTA: "Fund trade".
//
//   - state-b: listing's fed differs from home's fed. The user
//     session-switched on tap; the narration is past-tense:
//     "Running on [listing-fed] · we switched you in for this
//     trade. Your home is on [home-fed]." CTA: "Fund trade".
//
// Same CTA in both states: by the time detail renders, the silent
// switch has already happened, so the user is funding from the
// listing's fed regardless. State B's job is to NARRATE the
// transition honestly (Pillar 2.7), not to dispatch it.

export type DetailFraming =
  | { kind: "state-a"; sameFedSameCommunity: boolean }
  | {
      kind: "state-b";
      listingCommunityName: string;
      listingFlagEmoji: string;
      homeCommunityName: string;
      homeFlagEmoji: string;
    };

export interface DetailFramingInputs {
  /** Listing's mintUrl (fed1 invite) from the CREATE event. */
  listingMintUrl: string;
  /** Listing's community slug (may be null for pre-registry listings). */
  listingCommunity: string | null;
  /** User's home community slug (chama_community), or null for first-
   *  time-npub edge case (handled defensively). */
  homeCommunity: string | null;
}

export function decideTradeDetailFraming(inputs: DetailFramingInputs): DetailFraming {
  const homeCom = inputs.homeCommunity ? getCommunityBySlug(inputs.homeCommunity) : null;
  const homeFedInvite = homeCom?.federationInvite ?? BP_FEDERATION_INVITE;
  const sameFed = inputs.listingMintUrl === homeFedInvite;

  if (sameFed) {
    const sameCommunity = inputs.listingCommunity === inputs.homeCommunity;
    return { kind: "state-a", sameFedSameCommunity: sameCommunity };
  }

  const listingCom = inputs.listingCommunity ? getCommunityBySlug(inputs.listingCommunity) : null;
  return {
    kind: "state-b",
    listingCommunityName: listingCom?.displayName
      ?? translate(getCurrentLang(), "app.fallbackAnotherCommunity"),
    listingFlagEmoji: listingCom?.flagEmoji ?? "🌐",
    homeCommunityName: homeCom?.displayName
      ?? translate(getCurrentLang(), "app.fallbackYourCommunity"),
    homeFlagEmoji: homeCom?.flagEmoji ?? "🌐",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Vote prompt turn-gate (v0.7.0)
// ──────────────────────────────────────────────────────────────────────────
//
// Protocol stays permissive: the state machine still accepts buyer/seller
// votes in either order. This helper is the UI safety layer that prevents
// the happy-path counterparty from seeing high-stakes vote buttons before
// their turn.
//
// Category order:
//   - p2p-trade / bill-pay / lending: buyer first
//   - marketplace: seller first
//
// Once either buyer or seller votes, the other participant gets their
// buttons. Arbiter remains observer-only until buyer and seller both vote
// and disagree.

export type VotePrompt =
  | { kind: "none"; reason: string }
  | { kind: "waiting"; waitingOn: Role | "dispute"; message: string }
  | {
      kind: "buttons";
      role: Role;
      outcomes: Outcome[];
      /** True for the FIRST happy-path voter while zero buyer/seller votes
       *  exist. At that moment there is no real duality: the voter has ONE
       *  task (attest the off-chain deed) plus a back-out hatch. The UI
       *  renders a single primary button + a demoted "cancel this trade"
       *  link instead of two co-equal vote buttons. Vote #2 and disputes
       *  keep the dual buttons (a genuine confirm-or-deny decision). */
      firstVote?: boolean;
    };

function samePubkey(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function participantRoleForPubkey(
  state: EscrowState,
  pubkey: string,
  participants: EscrowState["participants"] = state.participants,
): Role | null {
  if (samePubkey(participants[Role.BUYER], pubkey)) return Role.BUYER;
  if (samePubkey(participants[Role.SELLER], pubkey)) return Role.SELLER;
  if (samePubkey(participants[Role.ARBITER], pubkey)) return Role.ARBITER;
  return null;
}

/** Who votes first on the happy path: the OFF-CHAIN DEED-DOER. Market: the
 *  seller ships/delivers. Bill Pay: the VOLUNTEER (buyer role) pays the
 *  owner's bill off-chain — the bill owner (seller role) only confirms.
 *  Exchange: the buyer sends the fiat. Lending: the borrower acknowledges the
 *  disbursement. The other side responds, which is where real vote duality
 *  begins. (3.5.1 fix: bill-pay was grouped seller-first, inverting the
 *  volunteer↔owner roles vs the sats routing; the deed-doer is the buyer.) */
function firstHappyPathVoter(state: EscrowState): Role {
  return state.category === "marketplace"
    ? Role.SELLER
    : Role.BUYER;
}

function waitingForFirstVoteCopy(state: EscrowState, role: Role): string {
  const lang = getCurrentLang();
  if (role === Role.SELLER) {
    if (state.category === "bill-pay") return translate(lang, "app.waitBillOwnerConfirm");
    if (state.category !== "marketplace") return translate(lang, "app.waitSellerConfirm");
    if (state.fulfillment === "digital") return translate(lang, "app.waitSellerDeliverFile");
    if (state.fulfillment === "service") return translate(lang, "app.waitSellerDeliverService");
    return translate(lang, "app.waitSellerShip");
  }
  if (state.category === "bill-pay") return translate(lang, "app.waitVolunteerPayBill");
  if (state.category === "lending") return translate(lang, "app.waitBuyerLoanArrived");
  return translate(lang, "app.waitBuyerPaymentSent");
}

/** Human countdown for the backup-arbiter floor: "in ~2h 10m" / "in ~8m". */
export function formatStepInCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return translate(getCurrentLang(), "app.countdownUnderMinute");
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return h > 0
    ? translate(getCurrentLang(), "app.countdownHoursMinutes", { h, m })
    : translate(getCurrentLang(), "app.countdownMinutes", { m });
}

export function decideVotePrompt(
  state: EscrowState,
  pubkey: string,
  participants: EscrowState["participants"] = state.participants,
  nowSec: number = Math.floor(Date.now() / 1000),
): VotePrompt {
  if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) {
    return { kind: "none", reason: "not-votable-state" };
  }
  // Healing includes LOCKED-past-deadline: the reducer only flips to EXPIRED
  // when an event arrives, so a quiet dead trade still reads LOCKED on every
  // client. Judge by the clock (mirrors canVote/handleVote semantics).
  const isHealingState = state.status === EscrowStatus.EXPIRED
    || (state.expiresAt > 0 && nowSec > state.expiresAt);

  const role = participantRoleForPubkey(state, pubkey, participants);
  if (!role) {
    // HEALING substitution: an expired, unresolved pooled-share trade can be
    // rescued by ANY pool backup — REFUND only, no floor (the disputed-expiry
    // limbo fix). The reducer enforces all of it.
    if (
      isHealingState
      && state.lock.arbiterPoolShare
      && (arbiterVotePriority(state, pubkey) ?? 0) > 0
      && !state.eventChain.some((ve) => ve.kind === EscrowEventKind.RESOLVE)
    ) {
      const votedAlready = state.eventChain.some(
        (ve) => ve.kind === EscrowEventKind.VOTE && ve.pubkey === pubkey,
      );
      if (votedAlready) return { kind: "none", reason: "already-voted" };
      return { kind: "buttons", role: Role.ARBITER, outcomes: [Outcome.REFUND] };
    }
    // Arbiter substitution: an eligible pool backup gets the arbiter's vote
    // surface on a pooled-share lock — a countdown while the assigned arbiter
    // still has the floor, buttons once it opens. Mirrors the engine's gates
    // (the reducer re-enforces everything).
    if (
      state.status === EscrowStatus.LOCKED
      && !isHealingState
      && state.lock.arbiterPoolShare
      && (arbiterVotePriority(state, pubkey) ?? 0) > 0
    ) {
      const buyerVote = state.votes[Role.BUYER];
      const sellerVote = state.votes[Role.SELLER];
      const disputeLive = buyerVote !== undefined && sellerVote !== undefined && buyerVote !== sellerVote;
      if (!disputeLive) return { kind: "none", reason: "not-participant" };
      const votedAlready = state.eventChain.some(
        (ve) => ve.kind === EscrowEventKind.VOTE && ve.pubkey === pubkey,
      );
      if (votedAlready) return { kind: "none", reason: "already-voted" };
      const eligibleAt = substitutionEligibleAt(state);
      if (eligibleAt !== null && nowSec < eligibleAt) {
        return {
          kind: "waiting",
          waitingOn: "dispute",
          message: translate(getCurrentLang(), "app.backupArbiterStepIn", {
            countdown: formatStepInCountdown(eligibleAt - nowSec),
          }),
        };
      }
      return { kind: "buttons", role: Role.ARBITER, outcomes: [Outcome.RELEASE, Outcome.REFUND] };
    }
    return { kind: "none", reason: "not-participant" };
  }
  // Already-voted is per PUBKEY for the arbiter on a pooled lock: a backup may
  // hold the slot while the ASSIGNED arbiter is still entitled to vote and
  // retake it (priority 0 wins on replay).
  if (role === Role.ARBITER && state.lock.arbiterPoolShare) {
    const votedAlready = state.eventChain.some(
      (ve) => ve.kind === EscrowEventKind.VOTE && ve.pubkey === pubkey,
    );
    if (votedAlready) return { kind: "none", reason: "already-voted" };
  } else if (state.votes[role] !== undefined) {
    return { kind: "none", reason: "already-voted" };
  }

  // Expiry healing votes should only drive REFUND. Ordering is deliberately
  // skipped here, matching the state-machine's healing path. Includes
  // LOCKED-past-deadline (see isHealingState above).
  if (isHealingState) {
    return { kind: "buttons", role, outcomes: [Outcome.REFUND] };
  }

  const buyerVote = state.votes[Role.BUYER];
  const sellerVote = state.votes[Role.SELLER];
  const buyerSellerBothVoted = buyerVote !== undefined && sellerVote !== undefined;
  const standardOutcomes = state.subscription
    ? [Outcome.REFUND]
    : [Outcome.RELEASE, Outcome.REFUND];

  if (role === Role.ARBITER) {
    if (!buyerSellerBothVoted) {
      return {
        kind: "waiting",
        waitingOn: "dispute",
        message: translate(getCurrentLang(), "app.arbiterWaitingBothVotes"),
      };
    }
    if (buyerVote === sellerVote) {
      return {
        kind: "waiting",
        waitingOn: "dispute",
        message: translate(getCurrentLang(), "app.arbiterNoActionNeeded"),
      };
    }
    return { kind: "buttons", role, outcomes: standardOutcomes };
  }

  if (buyerSellerBothVoted) return { kind: "none", reason: "buyer-seller-voted" };

  const noBuyerSellerVotes = buyerVote === undefined && sellerVote === undefined;
  if (noBuyerSellerVotes) {
    const firstRole = firstHappyPathVoter(state);
    if (role !== firstRole) {
      return {
        kind: "waiting",
        waitingOn: firstRole,
        message: waitingForFirstVoteCopy(state, firstRole),
      };
    }
  }

  return {
    kind: "buttons",
    role,
    outcomes: standardOutcomes,
    // Zero votes + this voter is the deed-doer ⇒ single-primary moment.
    firstVote: noBuyerSellerVotes && !state.subscription,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Arbiter attention warning (item 10)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the Q3 evolution: arbiter status does NOT hard-block Create.
// Instead, fire one of two warnings at Create time:
//
//   - soft (informational, equal-weight buttons): user is arbiter on
//     a LOCKED escrow with no votes-in-disagreement yet. Happy-path
//     trade may never need them, but their attention could be
//     required quickly.
//
//   - hard (conflict-explicit, asymmetric CTA): user is arbiter on
//     a LOCKED escrow where buyer and seller voted differently. The
//     arbiter's tiebreaker decides where the sats go — splitting
//     attention here can cost someone real money.
//
// Why warn but not block: arbitration on a happy-path trade is
// light-touch (you may never act). The protocol doesn't have a
// backup-arbiter swap mechanism at v1, so awareness is the safety
// net. Pillar 2.7: teach the weight of the role through the surface,
// every time.
//
// Multi-arbitration tiebreaking: hard > soft (any hard wins). Within
// tier, most recent escrow by createdAt desc is the displayed one.

export type ArbiterWarning =
  | { kind: "none" }
  | {
      kind: "soft";
      escrowId: string;
      counterpartyA: string;
      counterpartyB: string;
      createdAt: number;
    }
  | {
      kind: "hard";
      escrowId: string;
      counterpartyA: string;
      counterpartyB: string;
      createdAt: number;
    };

export interface ArbiterWarningInputs {
  userPubkey: string;
  escrows: Iterable<EscrowState>;
}

export function decideArbiterWarning(inputs: ArbiterWarningInputs): ArbiterWarning {
  const arbitered: EscrowState[] = [];
  for (const e of inputs.escrows) {
    if (e.participants.arbiter !== inputs.userPubkey) continue;
    if (e.status !== EscrowStatus.LOCKED) continue;
    arbitered.push(e);
  }
  if (arbitered.length === 0) return { kind: "none" };

  const isHard = (e: EscrowState): boolean => {
    const buyerVote = e.votes[Role.BUYER];
    const sellerVote = e.votes[Role.SELLER];
    return !!buyerVote && !!sellerVote && buyerVote !== sellerVote;
  };

  const hard = arbitered
    .filter(isHard)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (hard.length > 0) {
    const e = hard[0];
    return {
      kind: "hard",
      escrowId: e.id,
      counterpartyA: e.participants.buyer ?? "",
      counterpartyB: e.participants.seller ?? "",
      createdAt: e.createdAt,
    };
  }

  const soft = [...arbitered].sort((a, b) => b.createdAt - a.createdAt);
  const e = soft[0];
  return {
    kind: "soft",
    escrowId: e.id,
    counterpartyA: e.participants.buyer ?? "",
    counterpartyB: e.participants.seller ?? "",
    createdAt: e.createdAt,
  };
}
