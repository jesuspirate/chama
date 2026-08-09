// ══════════════════════════════════════════════════════════════════════════
// useEscrow — React hook connecting UI to the Nostr escrow engine
// ══════════════════════════════════════════════════════════════════════════

// ── localStorage helpers for escrow ID persistence ────────────────────────
const LEGACY_STORAGE_KEY = "chama_escrow_ids";
const MAX_SAVED_ESCROW_IDS = 50;
// Re-fire active discovery this long after the connected-relay set last grew.
// A slow webview brings relays up staggered; the timer resets on each new
// connection, so a burst coalesces into ONE re-discovery once things settle.
const RELAY_GROWTH_DEBOUNCE_MS = 1_500;
// The first connected relay is the signal to START discovery, not a reason to
// wait. RelayManager's fetchOnce still quorum-gates the actual REQ, so an
// immediate first run cannot resolve from a partial single-relay history.
// Later relay arrivals retain the debounce above to coalesce staggered growth.
const INITIAL_DISCOVERY_DELAY_MS = 0;
// Soft-gate readiness wait (relay-connect resilience). A user action that lands
// during the connect→init handshake window waits this long for ≥1 relay (and a
// signer) instead of hard-failing with "Not connected"; if it never goes ready
// the action surfaces a retriable error rather than a dead-end.
const READY_WAIT_MS = 5_000;
const READY_POLL_MS = 250;
// Fund moves sats — a slightly longer in-window wait covers a wallet that is
// finishing (re)join, but on timeout we STILL fail (fresh tap required); we
// never queue a deferred payment. One tap = one intent.
const FUND_READY_WAIT_MS = 6_000;
const FEDIMINT_WALLET_NOT_READY =
  "Chama wallet disconnected. Tap Reconnect and try again.";
const FEDI_ECASH_UNAVAILABLE =
  "Fedi wallet ecash funding is not available in this Fedi build. Chama did not create a Lightning invoice. Update Fedi, or use the Android APK/Tauri for this trade.";

// ── A1: resolve tenure across renewals ──────────────────────────────────────
//
// Stamps each bond's PROVEN tenure start by walking its announced lineage
// on-chain (bond-lineage.ts). Costs nothing for a bond that claims no ancestry,
// which today is every bond — so this is free until renewals start appearing,
// then bounded.
//
// Two budgets, because this runs on the CREATE path where latency is a real
// cost: at most LINEAGE_BONDS_PER_FETCH bonds get walked, each capped at
// LINEAGE_HOPS_PER_BOND hops. Exceeding a budget UNDER-reports tenure, which
// is the safe direction — a bond that looks younger than it is seats smaller
// trades, and its owner can see why on the card.
const LINEAGE_BONDS_PER_FETCH = 8;
const LINEAGE_HOPS_PER_BOND = 8;

async function resolveLineageTenure(
  bonds: VerifiedBond[],
  fetchJson: EsploraFetch,
): Promise<void> {
  let walked = 0;
  for (const bond of bonds) {
    if (!bond.lineage || walked >= LINEAGE_BONDS_PER_FETCH) continue;
    walked++;
    try {
      const proven = await verifyBondLineage({
        lineage: bond.lineage,
        currentFundingTxid: bond.fundingTxid,
        network: BOND_NETWORK,
        fetchJson,
        maxHops: LINEAGE_HOPS_PER_BOND,
      });
      bond.tenureFromHeight = tenureStartHeight(bond, proven);
      bond.lineageProven = { provenHops: proven.provenHops, claimedHops: proven.claimedHops };
    } catch (e) {
      // Fail-soft, and fail SHORT: an unwalkable claim leaves tenure measured
      // from the current UTXO, exactly as it was before A1.
      console.warn("[chama] lineage walk failed; tenure falls back to this bond's own age:", e);
    }
  }
}

function describeError(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {}
  }
  return fallback;
}

function isFediMiniAppRuntime(): boolean {
  if (typeof window !== "undefined" && Boolean((window as any).fediInternal)) return true;
  if (typeof navigator === "undefined") return false;
  return /\bFedi\b/i.test(navigator.userAgent || "");
}

function escrowStorageKey(pubkey?: string | null): string {
  return pubkey ? `${LEGACY_STORAGE_KEY}:${pubkey}` : LEGACY_STORAGE_KEY;
}

function parseSavedEscrowIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function getSavedEscrowIds(pubkey?: string | null): string[] {
  try {
    return parseSavedEscrowIds(localStorage.getItem(escrowStorageKey(pubkey)));
  } catch { return []; }
}

function saveEscrowId(id: string, pubkey?: string | null) {
  try {
    const ids = getSavedEscrowIds(pubkey);
    if (!ids.includes(id)) {
      ids.unshift(id); // newest first
      localStorage.setItem(escrowStorageKey(pubkey), JSON.stringify(ids.slice(0, MAX_SAVED_ESCROW_IDS)));
    }

    // Once a scoped user touches the trade, remove that ID from the old
    // global bucket so multi-npub browsers do not briefly resurrect past
    // active-trade pills for the wrong signer on reload.
    if (pubkey) {
      const legacy = parseSavedEscrowIds(localStorage.getItem(LEGACY_STORAGE_KEY))
        .filter(savedId => savedId !== id);
      if (legacy.length > 0) {
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy.slice(0, MAX_SAVED_ESCROW_IDS)));
      } else {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  } catch {}
}

function removeEscrowId(id: string, pubkey?: string | null) {
  try {
    for (const key of new Set([escrowStorageKey(pubkey), LEGACY_STORAGE_KEY])) {
      const ids = parseSavedEscrowIds(localStorage.getItem(key)).filter(i => i !== id);
      if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
      else localStorage.removeItem(key);
    }
  } catch {}
}

const EXPIRED_UNFUNDED_KEY_PREFIX = "chama_expired_unfunded_v1:";

function getExpiredUnfundedIds(pubkey: string): Set<string> {
  try {
    return new Set(parseSavedEscrowIds(localStorage.getItem(EXPIRED_UNFUNDED_KEY_PREFIX + pubkey)));
  } catch { return new Set(); }
}

function rememberExpiredUnfundedId(id: string, pubkey: string): void {
  try {
    const ids = [...getExpiredUnfundedIds(pubkey)];
    if (!ids.includes(id)) ids.unshift(id);
    localStorage.setItem(EXPIRED_UNFUNDED_KEY_PREFIX + pubkey, JSON.stringify(ids.slice(0, 200)));
    removeEscrowId(id, pubkey);
  } catch {}
}

// Forgotten-trade denylist lives in its own testable module (storage/
// forgotten-trades.ts).

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getForgottenEscrowIds,
  addForgottenEscrowId,
  unforgetEscrowId,
} from "../storage/forgotten-trades.js";
import {
  EscrowClient,
  type LoadFailure,
  type EscrowClientConfig,
  type EscrowClientCallbacks,
  type Signer,
  detectSigner,
  NIP07Signer,
} from "../escrow-engine/index.js";
import {
  type EscrowState,
  type ParsedEscrowEvent,
  type ChatPayload,
  type ChatImageAttachment,
  type SelectedMenuItem,
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
} from "../escrow-engine/types.js";
import { recordTradeToIndex, removeTradeFromIndex } from "../escrow-engine/trade-index.js";
import {
  canManuallyRenewListing,
  buildRenewCreateParams,
  isSellerOwnedListing,
} from "../escrow-engine/listing-renewal.js";
import { retireListing } from "../escrow-engine/listing-renewal-ledger.js";
import { MIN_TRANCHE_SATS, trancheGate, tranchesForPlan, buildNextTrancheParams } from "../escrow-engine/tranche.js";
import { assertTrancheFundingAddressAllowed, syncPrivateTrancheChildren } from "../escrow-engine/tranche-plan.js";
import { defaultCreditObserver, recordClaimCredit } from "../payments/claim-credit-ledger.js";
import {
  canEditListing,
  editsAreMeaningful,
  buildEditCreateParams,
  type ListingEdits,
} from "../escrow-engine/listing-edit.js";
import {
  FedimintClient,
  EscrowFedimintBridge,
  resolveFederationForCommunity,
  setCustomFederationInvite,
  hasCustomFederation,
  BP_FEDERATION_NAME,
  getOrCreateSeed,
  clearSeedCache,
  isTestnetMode,
  preloadRealWalletRuntime,
  resetLocalFedimintWallet,
  drainPendingRedemptions,
  stashPendingFunding,
  clearPendingFunding,
  drainPendingFundings,
  clearPendingNativeLockIfIntent,
  drainPendingNativeLocks,
  getPendingNativeLock,
  stashNativeLockIntent,
  hashNotes,
  checkAndMaybeRepublishSeed,
  getActiveInvite,
  setActiveInvite,
  clearActiveInvite,
  shouldReconcileFederation,
  federationNameForInvite,
  deriveCreateFedTags,
  effectiveCreateFederationId,
  expectedFederationIdForInvite,
  arbiterFederationStorageScope,
  getArbiterFederationRoute,
  listArbiterFederationRoutes,
  rememberArbiterFederationRoute,
  generateFediEcash,
  receiveFediEcash,
  hasFediInternalEcash,
  hasFediInternalGenerateEcash,
} from "../fedimint/index.js";
import { Capacitor } from "@capacitor/core";
import type { InvoiceGatewayInfo, LnReceiveStateKind, OnchainInfo } from "../fedimint/index.js";
import { clearPendingRedemption } from "../fedimint/pending-redemptions.js";
import { isNativeBridgeModeOn } from "../fedimint/native-bridge-adapter.js";
// ── Arbiter bond (sealed v1: single-key timelock COMMITMENT) ──────────────────
import * as btcSigner from "@scure/btc-signer";
import { findBondFundingUtxos, esploraFetcher, defaultEsploraBase, defaultMinConfs, esploraTipHeight, esploraBroadcast, esploraOutspend, esploraRecommendedFeeRate, type EsploraFetch } from "../bond-multisig/fund-watcher.js";
import { verifyBondLineage, tenureStartHeight } from "../bond-multisig/bond-lineage.js";
import { deriveEscrowSigningKey, resolveFundingPlan, verifyFunding, buildOnchainLockTerms } from "../bond-multisig/onchain-escrow-funding.js";
import { DISPUTE_CSV_BLOCKS, REFUND_CLTV_BLOCKS, ESCROW_NETWORK, ESCROW_NETWORK_LABEL, buildOnchainEscrow } from "../bond-multisig/onchain-escrow.js";
import { buildSettlementPsbt, coSignSettlement, disputeWindow, verifySettlementPsbt, settlementFeeCeilingSats, type SettlementCheck } from "../bond-multisig/onchain-escrow-settle.js";
import { aggregateOnchainPayoutBalance, buildOnchainPayoutSweep, payoutCandidatesFor, scanOnchainPayout, type OnchainPayout } from "../bond-multisig/onchain-payout-wallet.js";
import { getWinner } from "../escrow-engine/state-machine.js";
import { adoptedExpectedSettlementTxid, adoptedSettlementTxid, finalArbiterSettlementProof, finalCoopSettlementProof, finalizableArbiterSettlement, finalizableCoopSettlement, hasValidSettlementSignatureForRole, selectVerifiedArbiterSettlement, selectVerifiedCoopSettlement, settlementBuildFeeSats, settlementUnsignedId, signingKeyMatchesRole } from "../escrow-engine/onchain-settlement-transport.js";
import {
  buildCommitmentBond,
  buildBondRolloverTx,
  buildReclaimTx,
  buildKeyPathSweepTx,
  deriveBondSigningKey,
  estimateReclaimFeeSats,
  estimateKeyPathSweepFeeSats,
  resolveReclaimDestination,
  MIN_COMMITMENT_TERM_BLOCKS,
  DEFAULT_RECLAIM_FEE_RATE,
  type CommitmentReclaimDestination,
  type ReclaimDestinationChoice,
} from "../bond-multisig/commitment-bond.js";
import { buildBondAnnouncementEvent, selectLatestAnnouncements, groupLatestAnnouncementsByCommunity, verifyBondAnnouncement, ARBITER_BOND_ANNOUNCEMENT_KIND, MAX_LINEAGE_HOPS, type BondLineage, type BondLineageHop, type BondRole, type VerifiedBond } from "../bond-multisig/bond-announcement.js";
import {
  ARBITER_FAULT_KIND,
  excludedArbitersNow,
  parseArbiterFaultEvent,
  selectArbiterFaultPairs,
} from "../arbiters/arbiter-fault.js";

/** Bound on chain fetches triggered by one fault-attestation read, so a flood
 *  of fabricated escrow ids can't turn a CREATE into a hundred loads. */
const FAULT_VERIFY_TRADE_CAP = 12;
import { readCachedCommunityBonds, writeCachedCommunityBonds } from "../arbiters/bonded-pool-cache.js";
import { bondedArbitersForCommunity } from "../arbiters/live-chama.js";
import { getCommitmentBond, upsertCommitmentBond, listCommitmentBonds, newBondId, reconstructBondRecord } from "../bond-multisig/commitment-store.js";
import { BOND_NETWORK } from "../bond-multisig/bond-network.js";
import { hexToBytes, bytesToHex as msBytesToHexLocal } from "@noble/hashes/utils.js";
import { computeChamaLiveness, type ChamaLiveness, type RatingSummary as LivenessRatingSummary } from "../arbiters/live-chama.js";
import {
  getPayoutRecord,
  recordPayoutIntent,
  recordPayoutSubmitted,
  markPayoutSettled,
  clearPayoutRecord,
  assertPayoutJournalWritable,
  PAY_RECONCILE_SINCE_MARGIN_MS,
} from "../payments/payout-journal.js";
import {
  getUserCommunitySlug,
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
  setLastHomeHint,
} from "../communities/storage.js";
import { getCommunityBySlug, type Community } from "../communities/registry.js";
import {
  sendCommunityRequestToGlobalArbiters,
  type CommunityRequestInput,
  type CommunityRequestSendResult,
} from "../communities/community-request.js";
import {
  buildArbiterRosterEvent,
  fetchAndCacheCommunityRoster,
  resolveRosterAuthority,
  writeCachedRosterEvent,
} from "../arbiters/roster.js";
import {
  ARBITER_APPLICATION_KIND,
  buildArbiterApplicationEvent,
  collectArbiterApplications,
} from "../arbiters/applications.js";
import { maybeNotifyTransition, maybeNotifyChatMessage, maybeNotifyBuyerInterest, maybeNotifyNewListing, maybeSendTradeDms } from "../notifications/notify-service.js";
import {
  RATING_KIND,
  buildRatingEvent,
  parseRatingEvent,
  aggregateVerifiedRatings,
  type RatingThumb,
  type AggregateRatings,
} from "../reputation/ratings.js";
import { DEFAULT_RELAYS } from "../escrow-engine/default-relays.js";
import {
  recordHydrateRun,
  type HydrateIdDiag,
} from "../escrow-engine/discovery-diagnostics.js";
import { isSimModeOn } from "../sim/simMode.js";
import { addOrTouchPayoutDestination } from "../payments/payout-destinations.js";
import { payInvoiceWithNwc } from "../payments/nwc.js";
import { balanceBlocksFederationSwitch } from "../payments/lightning-fees.js";

/** Test/sandbox-only CREATE expiry override (see the createEscrow call site).
 *  Returns null unless chama_create_expiry_seconds holds a sane number. */
function readCreateExpiryOverride(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem("chama_create_expiry_seconds");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 300 && n <= 30 * 86400 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

/** v2.3 power-user substitution-grace override (parallels the CREATE expiry
 *  override). Committed into the LOCK so it's consensus-safe — every client
 *  replays the same eligibility moment. Returns null unless
 *  chama_substitution_grace_seconds holds a value in [0, 4h]; the reducer
 *  clamps again, so this is just the device-side sanity gate. Lets a tester
 *  drive short backup floors without waiting hours. */
function readSubstitutionGraceOverride(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem("chama_substitution_grace_seconds");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 4 * 3600 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}
import { buildChamaOperationMeta, type ChamaOperationMeta } from "../payments/sats-trace.js";
import {
  computeArbiterPremium,
  hasOwnPremiumNote,
  selectPremiumProbeLoads,
  PREMIUM_SPEND_TRY_CANCEL_SECS,
} from "../arbiters/arbiter-premium.js";
import {
  hasPremiumOutboxRecord,
  recordPremiumSending,
  recordPremiumPaid,
  clearPremiumSending,
  isEarningSettled,
  recordEarningRedeemed,
  recordEarningAttemptFailed,
} from "../arbiters/arbiter-earnings.js";
import { syncArbiterEarnings } from "../arbiters/arbiter-earnings-sync.js";
import {
  MIN_REAL_ATOMIC_FUNDING_MSATS,
  minimumAtomicFundingMessage,
} from "../payments/funding-limits.js";
import { setLocalStorageUserScope } from "../storage/user-scope.js";
import { reconcileIdentity } from "../storage/identity-pin.js";
import { extractNostrProfileName, type NostrProfileNameMap } from "../ui/nostr-profiles.js";

function isExpiredUnfundedEscrow(escrowState: EscrowState, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return (
    escrowState.status === EscrowStatus.CREATED
    && typeof escrowState.expiresAt === "number"
    && escrowState.expiresAt > 0
    && nowSec > escrowState.expiresAt
  );
}

/** Max simultaneous loadEscrow re-heals. The Fedi webview enforces a low
 *  per-connection subscription cap; a flood of ~12 concurrent #d fetches trips
 *  it and most come back null/partial (field-proven). A small pool keeps every
 *  fetch under the cap; paired with the EOSE-quorum (~300ms/fetch) it still
 *  clears a dozen trades in ~1–2s. */
const HEAL_CONCURRENCY = 3;

/** Run `worker` over `items` with at most `limit` in flight at once, returning
 *  results in input order. A bounded alternative to Promise.all for work that
 *  would otherwise flood a constrained transport (the Fedi webview's WS sub
 *  cap). `limit` lanes each pull the next index and process sequentially. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return results;
}

/**
 * Active relay discovery → hydrate. Asks the relays for every escrow ID this
 * npub took part in (EscrowClient.discoverMyEscrowIds: events it authored ∪
 * events tagging it), then loadEscrow()s each *new* one so "My Trades"
 * rebuilds itself from relays even after a localStorage wipe or on a fresh
 * install. Union-only: discovered IDs are ADDED to the saved list, never
 * pruned — a relay briefly missing an event must never delete a known trade.
 * The forgotten-denylist still hides what the user hid. Returns how many new
 * trades were hydrated. Best-effort throughout — one bad relay/ID can't blank
 * the list. Used by connect() (background) and the manual refresh action.
 */
async function discoverAndLoadMyTrades(
  client: EscrowClient,
  pubkey: string,
  forgottenIds: Set<string>,
): Promise<number> {
  let added = 0;
  try {
    const ids = await client.discoverMyEscrowIds(pubkey);
    const known = new Set(getSavedEscrowIds(pubkey));
    const expiredUnfunded = getExpiredUnfundedIds(pubkey);

    // Round 3b fix (a): RE-HEAL, don't just hydrate-new. The old code only
    // loaded brand-new ids (`fresh = !known && !forgotten`), so a KNOWN trade
    // stuck at a stale LOCKED/EXPIRED state never re-fetched its
    // RESOLVE/COMPLETE tail — Refresh couldn't help it (the bug round 3 found:
    // 15 ids discovered, 0 healed). Now we re-loadEscrow every discovered,
    // non-forgotten id that isn't SETTLED (see isSettledStatus — COMPLETED /
    // CANCELLED only; EXPIRED, LOCKED, APPROVED, CLAIMED all re-fetch).
    // loadEscrow's isPartialReplayDowngrade guard (escrow-client.ts) makes the
    // re-fetch safe: a partial relay history can't downgrade a good cached
    // state, and a terminal incoming (COMPLETED) always wins — so a stuck
    // EXPIRED/LOCKED trade heals to COMPLETED while settled trades skip for
    // efficiency.
    const idDiags: HydrateIdDiag[] = [];
    let knownCount = 0;
    let forgottenCount = 0;
    let freshCount = 0;
    const toHeal: { id: string; wasKnown: boolean }[] = [];
    for (const id of ids) {
      const wasKnown = known.has(id);
      if (expiredUnfunded.has(id)) {
        idDiags.push({ id, cls: wasKnown ? "known" : "fresh", outcome: "expired-unfunded (skipped)", discarded: true, terminal: true });
        continue;
      }
      if (forgottenIds.has(id)) {
        forgottenCount++;
        idDiags.push({ id, cls: "forgotten", outcome: "(forgotten — skipped)" });
        continue;
      }
      if (wasKnown) knownCount++; else freshCount++;
      const st = client.getState(id);
      if (st && isSettledStatus(st.status)) {
        // Settled — nothing to heal. Skip the fetch.
        idDiags.push({
          id, cls: wasKnown ? "known" : "fresh",
          outcome: `settled:${st.status} (skipped)`, terminal: true,
        });
      } else {
        toHeal.push({ id, wasKnown });
      }
    }

    if (toHeal.length === 0) {
      recordHydrateRun({
        at: Date.now(), pubkey, discovered: ids.length,
        knownCount, forgottenCount, freshCount, added: 0, ids: idDiags,
      });
      return 0;
    }

    const capped = toHeal.slice(0, MAX_SAVED_ESCROW_IDS);
    const overCap = toHeal.slice(MAX_SAVED_ESCROW_IDS);
    // Persist pointers first (union-only, idempotent via saveEscrowId's dedup)
    // so a heal that races a slow relay still survives to the next open.
    for (const { id } of capped) saveEscrowId(id, pubkey);
    console.log(`[chama] discovery: healing ${capped.length} non-terminal trade(s) (${freshCount} new) of ${ids.length} discovered`);

    // BOUNDED concurrency — NOT an unbounded Promise.all. Field-proven: a
    // Promise.all flood of ~12 loadEscrow (= ~12 simultaneous #d fetches) trips
    // the Fedi webview's per-connection subscription limits, so most fetches
    // come back null/partial (the same trade that returns a full 9-event chain
    // solo was load-null at 12-at-once). Now that the EOSE-quorum makes each
    // fetchEscrowEvents ~300ms instead of 8s, a small pool of HEAL_CONCURRENCY
    // clears a dozen trades in ~1–2s with zero flood. Stragglers that still
    // land partial self-heal via loadEscrow's completeness retry.
    const results = await mapPool(capped, HEAL_CONCURRENCY, async ({ id, wasKnown }) => {
      const cls: HydrateIdDiag["cls"] = wasKnown ? "known" : "fresh";
      try {
        const loaded = await client.loadEscrow(id);
        if (loaded && isExpiredUnfundedEscrow(loaded)) {
          // Genuinely never-funded + past expiry (status CREATED) — drop it.
          // A stuck EXPIRED/LOCKED trade is NOT CREATED, so this never eats a
          // real trade being healed. `done` — nothing to retry.
          (client as any).states?.delete?.(id);
          (client as any).rawEvents?.delete?.(id);
          rememberExpiredUnfundedId(id, pubkey);
          return {
            id, wasKnown, done: true,
            diag: { id, cls, outcome: `discarded:expired-unfunded (was ${loaded.status})`, discarded: true, terminal: isHydrateTerminal(loaded.status) } as HydrateIdDiag,
          };
        }
        if (loaded) {
          // `done` only when truly settled; a non-settled load may be a
          // contention-truncated chain → eligible for the sequential tail.
          return {
            id, wasKnown, done: isSettledStatus(loaded.status),
            diag: { id, cls, outcome: `loaded:${loaded.status}`, terminal: isHydrateTerminal(loaded.status) } as HydrateIdDiag,
          };
        }
        return { id, wasKnown, done: false, diag: { id, cls, outcome: "load-null" } as HydrateIdDiag };
      } catch (e) {
        console.debug(`[chama] discovery: could not load ${id}:`, e);
        return {
          id, wasKnown, done: false,
          diag: { id, cls, outcome: `load-failed:${((e as any)?.message || String(e)).slice(0, 60)}` } as HydrateIdDiag,
        };
      }
    });
    // Index each id's diag row so the sequential tail can rewrite a straggler.
    const diagIndex = new Map<string, number>();
    for (const r of results) {
      diagIndex.set(r.id, idDiags.length);
      idDiags.push(r.diag);
    }

    // Sequential tail (round 3b step 3): the pool still truncates some #d
    // fetches under contention. Re-load every trade STILL non-truly-terminal
    // ONE AT A TIME — by here the pool has drained, so each fetch is fully
    // uncontended and pulls the complete chain (proven: a solo #d probe returns
    // the full chain → COMPLETED where the parallel batch dropped it). Each
    // reload also gets loadEscrow's (now relay-count-independent) completeness
    // retry. Discards + already-settled trades are `done` and skipped.
    for (const r of results) {
      if (r.done) continue;
      try {
        const reloaded = await client.loadEscrow(r.id);
        const cls: HydrateIdDiag["cls"] = r.wasKnown ? "known" : "fresh";
        const expiredUnfunded = !!reloaded && isExpiredUnfundedEscrow(reloaded);
        if (expiredUnfunded) {
          (client as any).states?.delete?.(r.id);
          (client as any).rawEvents?.delete?.(r.id);
          rememberExpiredUnfundedId(r.id, pubkey);
        }
        const updated: HydrateIdDiag = !reloaded
          ? { id: r.id, cls, outcome: "load-null [seq]" }
          : expiredUnfunded
            ? { id: r.id, cls, outcome: `discarded:expired-unfunded (was ${reloaded.status}) [seq]`, discarded: true, terminal: isHydrateTerminal(reloaded.status) }
            : { id: r.id, cls, outcome: `loaded:${reloaded.status} [seq]`, terminal: isHydrateTerminal(reloaded.status) };
        const idx = diagIndex.get(r.id);
        if (idx !== undefined) idDiags[idx] = updated;
      } catch (e) {
        console.debug(`[chama] discovery: sequential reload failed ${r.id}:`, e);
      }
      // Give rendering/input a turn between historical replay jobs. Without
      // this, a large recovered account can monopolize Chrome's main thread
      // long enough to trigger its "Page Unresponsive" dialog.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    for (const { id, wasKnown } of overCap) {
      idDiags.push({ id, cls: wasKnown ? "known" : "fresh", outcome: "(over cap — not attempted)" });
    }
    // `added` = genuinely-new (fresh) trades that ended up loaded after BOTH
    // passes, for the "Found N from relays" toast. Computed from final diags so
    // a fresh trade that only came in on the sequential tail still counts.
    added = idDiags.filter(d => d.cls === "fresh" && d.outcome.startsWith("loaded:")).length;
    recordHydrateRun({
      at: Date.now(), pubkey, discovered: ids.length,
      knownCount, forgottenCount, freshCount, added, ids: idDiags,
    });
  } catch (e) {
    console.debug("[chama] discovery failed:", e);
  }
  return added;
}

/** Round 3b fix (a) heal gate: a trade is SETTLED — nothing left to heal —
 *  only when COMPLETED or CANCELLED. EXPIRED is deliberately NOT settled: a
 *  trade stuck at EXPIRED whose RESOLVE/COMPLETE tail lived on a relay we
 *  hadn't fetched must re-load. This is intentionally NARROWER than the
 *  engine's isTerminalStatus (which counts EXPIRED as terminal) — that breadth
 *  is exactly what kept these trades from ever re-healing. */
function isSettledStatus(status: EscrowStatus): boolean {
  return status === EscrowStatus.COMPLETED || status === EscrowStatus.CANCELLED;
}

/** Mirror of EscrowClient.isTerminalStatus (COMPLETED / CANCELLED / EXPIRED) —
 *  used only to set the hydrate diagnostic's `terminal` flag for display. */
function isHydrateTerminal(status: EscrowStatus): boolean {
  return status === EscrowStatus.COMPLETED
    || status === EscrowStatus.CANCELLED
    || status === EscrowStatus.EXPIRED;
}

// ── Hook state ────────────────────────────────────────────────────────────

/**
 * Phases of a claim operation as seen by the UI.
 *
 * `submitted`  — user tapped claim, the bridge call is running.
 * `watching`   — the bridge call rejected with a probably-transient error,
 *                but the federation may still be processing. We're polling
 *                balance for up to 120s to see if sats actually arrive.
 * `success`    — either the bridge resolved cleanly, or the watchdog saw
 *                the balance go up by the expected amount.
 * `timeout`    — 120s elapsed during watching and balance didn't move
 *                enough. The sats may still arrive later; we just stopped
 *                watching. Not a red-toast failure.
 * `failure`    — a genuine hard error (hash mismatch, state precondition
 *                failed, etc.). Safe to show as red.
 */
export type ClaimPhase =
  | { phase: "submitted"; escrowId: string }
  | { phase: "watching"; escrowId: string; reason: string }
  | { phase: "success"; escrowId: string; deltaMsats: number; viaWatchdog: boolean }
  | { phase: "timeout"; escrowId: string }
  | { phase: "failure"; escrowId: string; reason: string };

export interface FedimintState {
  /** Wallet initialized (WASM loaded, transport ready) */
  initialized: boolean;
  /** Joined a federation */
  joined: boolean;
  /** Active federation ID (hex) */
  federationId: string | null;
  /** Human-friendly federation name for display */
  federationName: string;
  /** Whether the user is on a custom (non-default) federation */
  isCustom: boolean;
  /** Balance in msats */
  balanceMsats: number;
  /** True while init/join/fund operations are in flight */
  busy: boolean;
  /** Latest Fedimint error (separate from escrow error) */
  error: string | null;
  /**
   * PR 5: cached federation health probe result.
   * `true`  = last probe succeeded (or last join/switch succeeded — that
   *           also proves reachability).
   * `false` = last probe failed; receive operations should refuse until
   *           a fresh probe succeeds.
   * `null`  = no probe yet (e.g. just after fresh init, before first
   *           receive). Receive ops trigger a fresh probe in this case.
   */
  lastHealthOk: boolean | null;
  /** PR 5: ms-since-epoch of the last probe. Used for the 30s cache TTL. */
  lastHealthAt: number | null;
  /**
   * v0.3.1 Phase 3: cold-boot federation probe state.
   *
   * Starts after a successful init/switch without delaying navigation.
   * Runs once per init and eliminates the
   * "compose-then-fail-at-lock" UX where the user only discovers fed
   * unreachability after 90 seconds of trade composition.
   *
   *   "pending" — probe1 has not yet completed. Initial state on app
   *                load; brief transient state between initFedimint
   *                resolving and probe1 result. Action surfaces are
   *                NOT gated on pending (only on failed).
   *   "ok"      — probe1 succeeded this session. Lock + Claim actions
   *                are unblocked.
   *   "failed"  — probe1 threw. ChamaBar surfaces "⚠ Chama unreachable
   *                · Reconnect →"; Fund + Claim buttons render
   *                disabled with the "Federation unreachable" subtitle.
   *
   * Reset to "pending" at the start of each initFedimint() call; set
   * to "ok"/"failed" after the post-init probe resolves. The Phase 1
   * probeFederation() action also updates this state, so the
   * claim-bridge-threw Try-Again flow naturally unblocks the boot
   * gate on a successful retry.
   *
   * If initFedimint() itself throws (init failed), the probe never
   * runs and bootProbeState stays "pending" — but fedimint.joined is
   * false in that case, so the existing not-joined Reconnect surface
   * in ChamaBar handles UX, not the new unreachable variant.
   */
  bootProbeState: "pending" | "ok" | "failed";
}

export interface UseEscrowState {
  /** Whether the client is connected to relays */
  connected: boolean;
  /** User's Nostr pubkey (hex) */
  pubkey: string | null;
  /** All loaded escrow states */
  escrows: Map<string, EscrowState>;
  /** Relay connection statuses */
  relayStatuses: Map<string, string>;
  /** Number of connected relays */
  connectedRelays: number;
  /** Latest error */
  error: string | null;
  /** Loading state */
  loading: boolean;
  /** Browse has connected but is still verifying public listing chains. */
  publicListingsLoading: boolean;
  /** Increments when the local earnings view changes or relay receipts merge. */
  earningsRevision: number;
  /** Fedimint wallet state */
  fedimint: FedimintState;
  /**
   * v0.6.5: true while runFundAndLock is mid-flight (between
   * creating-invoice and a terminal phase). Drives the funding-
   * operation gate that replaces the old one-trade-at-a-time block:
   * Fund taps grey out, but Create + Browse remain open. Suppresses
   * the recovery banner so the atomic flow owns the transient balance.
   */
  fundingInProgress: boolean;
  /**
   * v0.6.5: true while runClaimAndPayout is between claim and the
   * outbound LN send. Suppresses the recovery banner — the claim
   * flow owns the redeemed balance until the sweep completes.
   */
  claimPayoutInProgress: boolean;
}

export interface UseEscrowActions {
  /** Connect to relays and initialize signer */
  connect: () => Promise<void>;
  /** Return the active local signer's recovery key only when that signer
   * explicitly supports export. NIP-07/NIP-46/Fedi signers return null. */
  exportActiveRecoveryKey: () => Promise<string | null>;
  /** Disconnect from relays */
  disconnect: () => void;
  /** Force-reconnect backed-off/abandoned relays and re-arm My-Trades
   *  discovery — the recovery lever behind the in-app "Reconnect" control. */
  recoverRelays: () => void;
  /** Create a new escrow trade */
  createEscrow: (params: {
    description: string;
    imageDataUrl?: string;
    imageUrls?: string[];
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    category: string;
    mintUrl: string;
    paymentMethods?: string[];
    items?: Parameters<EscrowClient["createEscrow"]>[0]["items"];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
    communityArbiters?: string[];
  }) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Create a NIP-98 Authorization header for the authenticated photo host. */
  authorizeImageUpload: (url: string, method: "POST") => Promise<string>;
  /** Join an existing escrow as buyer or arbiter; menu buyers can later
   *  re-publish JOIN with selectedItems to save their order. */
  joinEscrow: (
    escrowId: string,
    role: Role,
    opts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean },
  ) => Promise<EscrowState>;
  /**
   * Lock ecash into 2-of-3 SSS escrow.
   * Atomic-funding flow: triggered as a side-effect of payment landing.
   *   spendNotes → Shamir split → NIP-44 encrypt shares → publish LOCK
   * The LOCK event self-describes buyer + arbiter; no prior READY ceremony.
   *
   * PR 3: optional savedHandleId names which of the seller's saved
   * payment handles to reveal in the LOCK payload. Bridge resolves
   * to cleartext at lock time. Omit for non-fiat trades.
   */
  lockAndPublish: (escrowId: string, opts?: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
  }) => Promise<EscrowState>;
  /** Cast a vote */
  vote: (escrowId: string, outcome: Outcome) => Promise<EscrowState>;
  /**
   * Claim ecash as the winner — leaves sats in the user's Chama wallet.
   * Runs the full real-Fedimint flow:
   *   decrypt shares → Shamir combine → verify hash → redeemEcash → publish CLAIM
   *
   * v0.3.0: production code paths must use claimAndPayout, which
   * additionally dispatches an outbound Lightning payment to a
   * user-chosen destination. claimAndRedeem leaves sats orphaned in
   * the user's local Chama (Pillar 2.1 Option B violation). It stays
   * exported as a building block for claimAndPayout and for Sandbox-
   * mode testing. Phase 5 will demote this to Sandbox-only by gating
   * its production callsites; do NOT add new direct callers.
   */
  claimAndRedeem: (escrowId: string) => Promise<EscrowState>;
  /**
   * v0.3.0 Phase 3 — atomic claim-and-payout. Composes
   *   claimAndRedeem → wait-for-balance → payInvoice → optional handle save
   * into one user-facing flow. The user picks a destination via
   * DestinationPicker; this action carries it through to settlement.
   * The user never holds an intermediate balance (Pillar 2.1 Option B,
   * send side).
   *
   * Resolves with the terminal kind — never throws. Failure modes are
   * split for the recovery banner UX:
   *   claim-failed   — claim threw hard; no orphan
   *   claim-pending  — claim returned but balance hasn't landed in 60s;
   *                    pending redemption stash remains for boot retry
   *   payout-failed  — claim landed but LN send failed; orphan balance
   *                    (recovery banner is the next stop)
   *   done           — payout sent
   */
  claimAndPayout: (
    escrowId: string,
    args: {
      bolt11?: string;
      onchainAddress?: string;
      expectedDeltaMsats: number;
      saveAfter: boolean;
      addressUsed?: string;
      onPhase: (phase: import("../payments/claim-and-payout.js").ClaimAndPayoutPhase) => void;
    },
  ) => Promise<import("../payments/claim-and-payout.js").ClaimAndPayoutTerminal>;
  /** R3-1b: re-attach to a submitted payout and complete the trade if it
   *  settled (no re-pay). For re-opening a trade stuck on CLAIMED. */
  reattachPayout: (escrowId: string) => Promise<void>;
  /** Task #53 E1: pay my 0.25% arbiter-insurance premium on a COMPLETED
   *  trade with a bonded seated arbiter. Idempotent (durable outbox
   *  record, V7-style pre-spend intent), respects the decline record;
   *  sim/testnet no-op. Fail-soft — never throws. */
  payArbiterPremium: (escrowId: string) => Promise<void>;
  /** Task #53 E1 arbiter side: decrypt + redeem any premium notes on this
   *  trade addressed to me; records the earnings ledger. Fail-soft. */
  redeemArbiterPremiums: (escrowId: string) => Promise<void>;
  /** Task #62 arbiter redeem-probe: relay-probe kind-38113 premiums
   *  #p-tagged to me, loadEscrow the trades whose notes aren't loaded (a
   *  settled trade is unwatched + discovery-skipped, so a premium
   *  published after settlement never reaches a passive arbiter's state
   *  otherwise), then redeem. Fail-soft; sim/testnet no-op. */
  probeArbiterPremiums: () => Promise<void>;
  /** Release a subscription period */
  releasePeriod: (escrowId: string, periodIndex: number) => Promise<EscrowState>;
  /** Send a chat message */
  sendChat: (
    escrowId: string,
    message: string | { message: string; attachments?: ChatImageAttachment[] },
  ) => Promise<void>;
  /** Cancel a trade (initiator only, pre-lock) */
  cancel: (escrowId: string, reason?: string) => Promise<EscrowState>;
  /** Load an escrow from relays by ID. `repairFromCache` is for EXPLICIT opens
   *  only (an archived-trade tap, a deep link): it lets a chain the relays
   *  can't complete be rebuilt from this device's durable cache, at the cost
   *  of an IndexedDB read + a second replay pass. Never pass it from boot
   *  discovery or background sweeps. */
  loadEscrow: (
    escrowId: string,
    opts?: { repairFromCache?: boolean },
  ) => Promise<EscrowState | null>;
  /** Why the last loadEscrow of this id returned null (null when it didn't). */
  getLoadFailure: (escrowId: string) => LoadFailure | null;
  /** Heal a trade in BOTH directions: pull the latest chain in from relays
   *  (re-fetch + merge + replay, so a stale local state catches up to a
   *  counterparty's RESOLVE/COMPLETE), then re-broadcast our cached chain out
   *  so a counterparty missing our events recovers too. Returns how many of
   *  our cached events landed. */
  rebroadcastEscrow: (escrowId: string) => Promise<{ published: number; total: number }>;
  /** Manually re-run active relay discovery for the signed-in npub and hydrate
   *  any of its trades missing from the local list (the same self-healing path
   *  that runs at connect). Returns how many trades were added. */
  refreshMyTrades: () => Promise<number>;
  /** INSTRUMENT-FIRST (Fedi round 3): pubkey-independent transport control —
   *  fetch one known escrow by `#d` over the same fetch path discovery uses
   *  and return the per-relay probe anatomy. Used by the on-device debug card
   *  to separate a wrong query key (candidate 1) from blocked transport
   *  (candidate 2) without touching the signer. */
  probeFetchById: (escrowId: string) => Promise<import("../escrow-engine/discovery-diagnostics.js").FetchLegDiag>;
  /** Forget a trade locally (drop saved pointer + hide from the list). Safe:
   *  money stays in escrow and the trade is re-loadable by ID. */
  forgetEscrow: (escrowId: string) => void;
  /** #7 multi-unit storefront: spawn a CHILD purchase escrow for `quantity`
   *  units of a multi-unit parent listing and return it (the buyer then locks
   *  the child via the normal flow). */
  purchaseFromListing: (parent: EscrowState, quantity: number) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Store permanence (#49) Tier 1: re-publish an identical CREATE (fresh 24h
   *  window) for the caller's OWN listing that lapsed WITHOUT ever being funded.
   *  Throws if the listing isn't renewable (not owned / ever funded / not yet
   *  lapsing). Moves no sats — Option B: renewal re-publishes, never transfers. */
  renewListing: (escrowId: string) => Promise<{ escrowId: string; state: EscrowState }>;
  /** A3: edit a live listing by REPLACING it — publish a fresh CREATE with the
   *  new terms, then CANCEL the old. There is no edit event by design (see
   *  listing-edit.ts). Moves no sats; refuses a funded listing or one a buyer
   *  is currently holding. */
  editListing: (
    escrowId: string,
    edits: ListingEdits,
  ) => Promise<{ escrowId: string; state: EscrowState; oldCancelled: boolean }>;
  /** Tranching: publish the next slice of a plan. Re-checks the safety gate
   *  itself — never trusts the UI's copy of it. */
  startNextTranche: (fromEscrowId: string) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Parent/child tranche protocol: freeze the already-seated parent and fan
   *  out deterministic private children. This is deliberately separate from
   *  the legacy public-slice mechanism above. */
  startPrivateTranchePlan: (
    parentId: string,
    sliceCount: number,
  ) => Promise<{ parent: EscrowState; children: EscrowState[] }>;
  /** Re-fetch a frozen parent's private children, persist their local recovery
   *  pointers, and publish this participant's per-child on-chain keys when
   *  needed. Safe to run repeatedly and after relaunch. */
  syncPrivateTranchePlan: (parentId: string) => Promise<EscrowState[]>;
  /** Tier 2.1 — the on-chain escrow plumbing. Every one recomputes the address
   *  locally; none of them trusts a wire-supplied one. */
  myEscrowKey: (escrowId: string) => Promise<{ priv: Uint8Array; xonly: Uint8Array; path: string }>;
  onchainFundingPlan: (escrowId: string) => ReturnType<typeof resolveFundingPlan>;
  checkOnchainFunding: (escrowId: string) => Promise<{
    plan: ReturnType<typeof resolveFundingPlan>;
    verdict: ReturnType<typeof verifyFunding> | null;
  }>;
  publishOnchainLock: (escrowId: string) => Promise<EscrowState>;
  /** Build (if absent), publish, and locally verify the cooperative PSBT. */
  prepareOnchainSettlement: (escrowId: string) => Promise<{ psbt: string; check: SettlementCheck; signedByMe: boolean }>;
  /** Re-verify, add this participant's signature, and publish the revision. */
  signOnchainSettlement: (escrowId: string) => Promise<{ psbt: string; check: SettlementCheck }>;
  /** Finalize/broadcast once two signatures exist, or adopt an observed spend. */
  finalizeOnchainSettlement: (escrowId: string) => Promise<{ status: "waiting" | "broadcast" | "adopted"; txid?: string }>;
  /** Rebuild every winner address from known trades and total its confirmed,
   *  unspent outputs. Survives restarts because addresses derive from trade IDs. */
  scanMyOnchainPayouts: () => Promise<{ payouts: OnchainPayout[]; balanceSats: bigint }>;
  /** Sweep one trade's confirmed winner outputs to a user-selected address. */
  sweepOnchainPayout: (escrowId: string, destination: string) => Promise<{
    txid: string; sentSats: bigint; feeSats: bigint;
  }>;
  /** Monthly CBP recurrence: re-publish an identical CREATE for the caller's own
   *  bill-pay listing (bill-pay only, no bond, home-community inherited). Unlike
   *  renewListing it works on funded/settled priors too. Moves no sats. */
  repostRecurringCbp: (escrowId: string) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Fetch self-published kind:0 profile names for visible participants. */
  fetchNostrProfiles: (pubkeys: string[]) => Promise<NostrProfileNameMap>;
  /** Trigger haptic feedback */
  vibrate: (pattern?: number | number[]) => void;

  // ── Fedimint actions ───────────────────────────────────────────────────
  /**
   * Initialize the Fedimint WASM wallet and join a federation.
   * If no invite code is provided, uses the stored custom invite (if any)
   * or falls back to the community-default (which falls back to BP).
   * Idempotent: safe to call multiple times.
   *
   * v0.1.82+: throws `RECONCILE_REFUSED_NONZERO_BALANCE` if the OPFS-bound
   * federation differs from the desired one AND the local wallet holds a
   * Lightning-withdrawable balance (or the balance can't be verified). The
   * UI must surface a destroy-confirm modal before retrying with
   * `{ force: true }`.
   */
  initFedimint: (inviteCode?: string, options?: { force?: boolean; persistCustom?: boolean }) => Promise<void>;
  /**
   * Persist a custom federation invite code for future sessions.
   * Pass empty string to clear and revert to the default.
   * Does NOT automatically re-join — call initFedimint() after if you
   * want to switch federations immediately.
   */
  setCustomInvite: (inviteCode: string) => void;
  /**
   * Create a Lightning invoice to fund the Fedimint wallet.
   * Returns the BOLT11 string for the user to pay from another wallet.
   *
   * v0.6.5: `onReceiveState` (optional) fires on every state
   * transition of the underlying LN receive operation
   * (`created` → `funded` → `awaiting_funds` → `claimed`). The
   * atomic-funding orchestrator uses this to advance the modal UI
   * the moment the gateway acknowledges the HTLC, instead of waiting
   * for the 5s balance poll to notice. v0.6.4 production logs prove
   * this state machine is the source of truth for "did the payment
   * land?" — balance polling is the LOCK-readiness gate, the watch
   * is the UX gate.
   */
  createFundingInvoice: (
    amountMsats: number,
    description?: string,
    onReceiveState?: (kind: LnReceiveStateKind) => void,
    meta?: ChamaOperationMeta,
    /** Reports which Lightning gateway minted the invoice, so the funding UI
     *  can name the route the payer must use. */
    onGateway?: (gateway: InvoiceGatewayInfo) => void,
  ) => Promise<string>;
  /**
   * v0.3.0 atomic funding: compose createFundingInvoice → balance-watcher
   * → lockAndPublish into one user-facing flow. The user pays a BOLT11
   * for exactly the trade amount; the moment ecash mints, LOCK fires
   * automatically. The user never holds an intermediate wallet balance
   * (Pillar 2.1 Option B). AtomicFundingModal renders phase events for
   * granular UI updates; the action resolves with the terminal phase.
   *
   * Resolves with the terminal kind — never throws. Callers branch on
   * the returned kind for post-modal navigation. Per-phase UI lives in
   * the modal via opts.onPhase.
   */
  fundAndLock: (
    escrowId: string,
    opts: {
      amountMsats: number;
      /** E1.1: arbiter-insurance msats folded into the invoice only. */
      premiumMsats?: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc";
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: import("../payments/fund-and-lock.js").FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ) => Promise<import("../payments/fund-and-lock.js").FundAndLockTerminal>;
  payInvoice: (bolt11: string, meta?: ChamaOperationMeta) => Promise<string | undefined>;
  /** R3-1: re-attach to a submitted payout and report its terminal outcome
   *  without paying again (recovery-path double-pay guard). */
  awaitPayoutOutcome: (operationId: string) => Promise<"settled" | "refunded" | "unknown">;
  spendNotes: (amountMsats: number, meta?: ChamaOperationMeta) => Promise<string>;
  redeemEcash: (oobNotes: string, meta?: ChamaOperationMeta) => Promise<void>;
  /** Read federation wallet-module onchain fees and confirmation policy. */
  getOnchainInfo: () => Promise<OnchainInfo>;
  /**
   * v0.3.1 Phase 1: explicit federation probe. Returns
   * `{ ok: true }` if the federation responds to the standard probe,
   * `{ ok: false, error: msg }` otherwise. Used by the
   * ClaimPayoutModal's retry path on the `claim-bridge-threw`
   * terminal — re-probe before re-dispatch so the user gets a clean
   * "Chama reachable → claim retried" sequence rather than "retry →
   * same error instantly". Never throws.
   */
  probeFederation: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Quietly warm the Fedimint/WASM path before a likely funding action. */
  prewarmFunding: () => Promise<void>;
  /** Refresh the current balance from the wallet */
  refreshBalance: () => Promise<void>;
  /** Read and store the current wallet balance. */
  getBalance: () => Promise<number>;
  /** V3 roster keystone: fetch + verify + cache the community's signed
   *  kind:38120 arbiter roster. No-op when the community has no authority
   *  anchor or no client. Safe to fire-and-forget on community changes. */
  refreshCommunityRoster: (community: string) => Promise<void>;
  /** Steward path: build, sign, publish, and cache this community's roster.
   *  Throws when not connected. Authority is enforced by VERIFIERS — an
   *  unauthorized publish is simply ignored by every other client. */
  publishCommunityRoster: (community: string, arbiters: string[]) => Promise<void>;
  /** V3 #74: publish a signed arbiter application (kind:38121) for a
   *  community. Anyone signed-in may apply; the steward reviews. */
  applyAsArbiter: (community: string, statement: string) => Promise<void>;
  /** ⭐ The SEALED v1 bond (single-key timelock COMMITMENT). Post one: derive the
   *  arbiter's OWN bond key, set the term (blocks from the current tip, min
   *  MIN_COMMITMENT_TERM_BLOCKS), build the one-leaf CLTV address, persist. No
   *  cabinet, no custody. Returns the address to fund + the unlock height. */
  createCommitmentBond: (params: { amountSats: bigint; termBlocks: number }) =>
    Promise<{ bondId: string; address: string; lockUntil: number; amountSats: bigint; tipAtCreate: number }>;
  /** Re-scan the bond address for confirmed deposits (ANY amount, every call — a
   *  deposit landing after the first is still recorded) → mark/keep it LOCKED with
   *  the full UTXO set. { locked:false } = nothing confirmed yet, keep waiting. */
  checkCommitmentFunding: (bondId: string) => Promise<{ locked: boolean; txid?: string; lockedSats?: bigint; deposits?: number }>;
  getCommitmentReclaimQuote: (bondId: string) => Promise<{ finalityDelay: number; minimumDepositSats: number; pegInFeeSats: number; minerFeeSats: bigint; estimatedNetSats: bigint } | null>;
  /** Spend a mature bond directly into a fresh owner-only CLTV bond. The new
   * record stays pending until the normal on-chain confirmation gate promotes it. */
  renewCommitmentBond: (bondId: string, termBlocks: number) => Promise<{
    bondId: string; txid: string; amountSats: bigint; feeSats: bigint; lockUntil: number; pending: boolean;
  }>;
  /** After the term (tip ≥ lockUntil), sweep EVERY UTXO at the bond address back to
   *  the arbiter's own key and broadcast. ⚠ moves the arbiter's OWN sats. Consensus
   *  is the authority: a too-early attempt is rejected by the network and surfaced
   *  calmly. Recovers an already-swept bond (lost state / other device) by adopting
   *  the on-chain spend as the reclaim. */
  reclaimCommitmentBond: (bondId: string, destination?: ReclaimDestinationChoice) => Promise<{
    txid: string;
    alreadyReclaimed?: boolean;
    creditedToChama?: boolean;
    creditOperationId?: string;
    returnAddress?: string;
    destinationAddress?: string;
    reclaimDestination?: CommitmentReclaimDestination;
  }>;
  /** Sweep an already-reclaimed bond's plain on-chain return UTXO into Chama's
   *  Fedimint wallet so it becomes visible in the balance. */
  creditReclaimedCommitmentBond: (bondId: string) => Promise<{
    txid: string;
    operationId?: string;
    amountSats?: bigint;
    alreadyCredited?: boolean;
  }>;
  /** Current chain tip height (for the locked screen's live unlock countdown). */
  getBondChainTip: () => Promise<number>;
  /** Announce a funded+locked bond to a community (kind 38135) so its liveness is
   *  publicly computable + chain-verifiable. The event is signed by the arbiter's
   *  Nostr key; verification recomputes the address + reads it on-chain. */
  publishBondAnnouncement: (bondId: string, community: string, roles?: readonly BondRole[]) => Promise<{ community: string; address: string }>;
  /** Cross-device bond recovery: rebuild local bond records from the user's own
   *  kind-38135 announcements + seed, so a bond posted on one device shows + reclaims
   *  on another with the same npub. Returns how many were newly recovered. */
  recoverMyBonds: () => Promise<{ recovered: number }>;
  /** Fetch every arbiter's current bond announcement for a community, chain-verified
   *  (the data source for the live-chama liveness score). */
  fetchCommunityBonds: (community: string) => Promise<VerifiedBond[]>;
  /** Arbiters currently excluded by a verified dual-signed fault attestation.
   *  Preference-only and fail-open — see the implementation. */
  fetchFaultExcludedArbiters: (candidates: readonly string[]) => Promise<string[]>;
  /** #77: the signed-in npub's OWN chain-verified bond announcements (kind 38135,
   *  authored by this pubkey, across every community). Lets the Dashboard show a
   *  bond cross-device (a fresh install has no local commitment record). Fail-soft:
   *  a relay/esplora hiccup returns [] rather than throwing into render. */
  fetchMyBonds: () => Promise<VerifiedBond[]>;
  /** Compute a community's live-chama liveness score: chain-verified bonds +
   *  arbiter ratings → coverage/commitment/reputation composite. Pure roll-up over
   *  fetchCommunityBonds; never a hardcoded "Kenya is green". */
  getChamaLiveness: (community: string, signal?: AbortSignal) => Promise<ChamaLiveness>;
  /** The country-LIST companion to getChamaLiveness: ONE batched kind-38135 read
   *  (no `#d`) → per-community count of chain-verified FUNDED+ACTIVE bonded
   *  arbiters (slug → count; zero-count communities omitted). ADDITIVE over the
   *  registry tiers — it can only light rows up, never darken them. Cheap by
   *  construction: only communities that actually announced cost a chain read. */
  fetchBondedArbiterCounts: () => Promise<Record<string, number>>;
  /** V3 #74 steward review: fetch + verify a community's applications,
   *  newest per applicant, already-rostered keys excluded. */
  fetchArbiterApplications: (
    community: string,
    excludePubkeys?: string[],
  ) => Promise<{ applicant: string; statement: string; createdAt: number }[]>;
  /** Publish a community report ("no Chama here yet — make one") captured
   *  during pre-login onboarding, now that a signer exists. Uses the active
   *  signer (the globe picker had none), so the deferred report can finally
   *  be signed + sent to the global arbiters. */
  publishCommunityReport: (
    input: CommunityRequestInput,
  ) => Promise<CommunityRequestSendResult>;
  /** Ratings (kind:38123): publish a one-tap 👍/👎 about a counterparty of a
   *  settled trade. Additive — old clients never query it. */
  rateCounterparty: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  /** Aggregate VERIFIED ratings about a pubkey ({count, positive, negative}),
   *  each checked against the settled trade THIS client knows. */
  fetchRatingSummary: (ratee: string) => Promise<AggregateRatings>;
  /** The (trade, ratee) the signed-in user has already rated, newest thumb per
   *  slot — drives "already rated" vs an active one-tap on the capture surfaces. */
  fetchMyGivenRatings: () => Promise<Array<{ tradeId: string; ratee: string; thumb: RatingThumb; ratedAt?: number }>>;
  /**
   * Wipe the local Fedimint wallet's IndexedDB and reset in-memory state.
   * Use this to recover from a "No modification allowed" seed-mismatch error
   * or any other stuck-state issue. Destructive to *local* state only — the
   * Nostr-backed seed survives and will be re-installed on next initFedimint().
   */
  resetLocalWallet: () => Promise<void>;
  /**
   * Switch the Fedimint wallet to a different federation. Atomically:
   *   1. Cleans up the in-memory FedimintClient (terminates worker)
   *   2. Wipes the current OPFS file + rotates to a fresh filename
   *   3. Re-initializes with the new invite code
   *
   * Destructive: any ecash held in the previous federation becomes
   * stranded until you switch back. The v0.1.76 balance guard refuses
   * the switch if the current balance is Lightning-withdrawable unless
   * `{ force: true }` is passed, which the UI must only do after explicit
   * user confirmation. The Nostr-backed seed survives — trade history,
   * escrows, and signer are unaffected.
   */
  switchFederation: (inviteCode: string, options?: { force?: boolean; persistCustom?: boolean }) => Promise<void>;
  /** (Re-)start the Browse feed subscription for public listings. */
  watchPublicListings: (since?: number) => void;
  /**
   * v0.6.5: subscribe to live updates for a specific escrow. Idempotent —
   * a label-keyed map de-duplicates per escrow id. Used by Browse to
   * re-attach a sub for every visible listing on mount/reload, so JOIN
   * events flow live even when the listing was hydrated in a prior
   * session and the cold-start path skipped the implicit
   * loadEscrow→watchEscrow chain.
   */
  watchEscrow: (escrowId: string) => void;
  /** PR 2: read the user's selected community slug (always returns
   *  a valid slug from the registry — defaults to us-blf / Global USD). */
  getCommunity: () => string;
  /** PR 2: persist the user's community choice. Pass empty string to
   *  clear and revert to default. Does NOT auto re-init the wallet —
   *  call initFedimint() afterward to switch federations immediately. */
  setCommunity: (slug: string) => void;
}

// ── Haptic feedback ───────────────────────────────────────────────────────
//
// Web: navigator.vibrate, which honours pattern arrays natively.
//
// Native (Capacitor/Android): navigator.vibrate is gated behind a FRESH
// WebView user-activation, so the boot "Chama ready" buzz was silently
// dropped — on the no-gesture auto-login path it can never fire, and on
// tap-to-connect the relay handshake routinely outlives the ~5s sticky
// activation window (the v2.1 "lost my vibration" regression). The
// native Haptics plugin calls the system vibrator straight through the
// Capacitor bridge with no activation requirement, so on-device we route
// there and FAITHFULLY REPLAY the same pattern every existing call site
// passes — one native pulse per "on" segment — so [50,30,50] et al. feel
// identical to the web version, and no call site changes.

function vibrate(pattern: number | number[] = 50) {
  if (typeof Capacitor !== "undefined" && Capacitor.isNativePlatform()) {
    nativeHapticPattern(pattern);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {}
  }
}

/** Replay a web-style vibration pattern through the native Haptics
 *  plugin. Web patterns are [on, off, on, off, …] ms; we schedule a
 *  native vibrate for each ON (even-index) segment at its cumulative
 *  time offset so the felt rhythm matches the browser exactly. The
 *  plugin is lazy-imported so it never loads on web or under the
 *  Node/esbuild test runtime (isNativePlatform() is false there, so the
 *  import is never reached). */
function nativeHapticPattern(pattern: number | number[]) {
  const segments = typeof pattern === "number" ? [pattern] : pattern;
  void import("@capacitor/haptics")
    .then(({ Haptics }) => {
      let offset = 0;
      for (let i = 0; i < segments.length; i++) {
        const ms = Math.max(0, Math.floor(segments[i] ?? 0));
        if (i % 2 === 0 && ms > 0) {
          const at = offset;
          setTimeout(() => {
            Haptics.vibrate({ duration: ms }).catch(() => {});
          }, at);
        }
        offset += ms;
      }
    })
    .catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════
// HOOK
// ══════════════════════════════════════════════════════════════════════════

/**
 * Config accepted by useEscrow. Extends EscrowClientConfig (relays, fees, etc.)
 * with UI-facing callbacks that let the hook communicate multi-phase events
 * back to the UI without the UI having to drive complex promise chains.
 */
export interface UseEscrowConfig extends Partial<EscrowClientConfig> {
  /** Called at each phase of a claim operation — see ClaimPhase. */
  onClaimProgress?: (phase: ClaimPhase) => void;
}

export function useEscrow(config?: UseEscrowConfig): [UseEscrowState, UseEscrowActions] {
  const clientRef = useRef<EscrowClient | null>(null);
  // Synchronous connection gate. React state (`loading`) does not update until
  // the next render, so concurrent auto-login/tap callers could previously all
  // pass the UI guard, create independent EscrowClients, and leak every client
  // except the last one assigned to clientRef. Each leak kept six relay sockets
  // and a public-listings subscription alive. This ref closes that race for
  // every caller, including callers outside App's auto-login effect.
  const connectInFlightRef = useRef(false);
  // Coalesce boot discovery triggers. Relay growth and connect's post-saved-ID
  // heal can overlap; sharing one in-flight run avoids duplicate REQs and
  // loadEscrow work while still allowing a later settled-relay re-heal.
  const discoveryInFlightRef = useRef<Promise<number> | null>(null);
  const publicListingsSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publicListingHydrationsPendingRef = useRef(0);
  const fedimintRef = useRef<FedimintClient | null>(null);
  const bridgeRef = useRef<EscrowFedimintBridge | null>(null);
  const signerRef = useRef<Signer | null>(null);
  // Forgotten-trade denylist, in memory. Loaded at connect from the persistent
  // store with the RELIABLE pubkey (the local `pubkey` var) so updateEscrow can
  // honor it the instant Browse events arrive — before `state.pubkey` has even
  // re-rendered. Kept in sync by forgetEscrow / loadEscrow.
  const forgottenIdsRef = useRef<Set<string>>(new Set());
  const hiddenExpiredIdsRef = useRef<Set<string>>(new Set());
  // Liquidity/attention notifications: the second this signed-in session went
  // live. Buyer-interest + new-listing buzzes use it as their backlog guard (the
  // analogue of the transition core's prev-must-be-non-null rule) so a cold-boot
  // replay of old listings/holds never storms. Set at connect; read in
  // updateEscrow, which is a []-dep callback with no access to the closure.
  const notifyLiveSinceRef = useRef<number>(Math.floor(Date.now() / 1000));
  // PR 5: federation health cache. Mirrored into React state for the UI;
  // the ref is the source of truth read inside createFundingInvoice so
  // we don't depend on the latest closure of `state`.
  const healthRef = useRef<{ ok: boolean | null; at: number | null }>({ ok: null, at: null });
  // PR 5: latest state mirror. Lets callbacks read current values
  // (e.g. federationName for error copy) without re-creating the
  // callback on every state change.
  const stateRef = useRef<UseEscrowState | null>(null);
  // v0.6.5: synchronous mirrors of the in-progress flags. setState
  // updates are async — without these refs, two near-simultaneous Fund
  // taps could both pass the gate before React's next render. The ref
  // is the authoritative read at entry; the setState call drives the UI.
  //
  // v0.6.5 follow-up: fundingInProgressRef holds the AbortSignal of
  // the live run (or null when idle), not just a boolean. React
  // StrictMode double-mounts effects in dev: first mount starts run#1
  // and aborts it, then second mount synchronously starts run#2.
  // Between those two, run#1's finally hasn't fired (the awaited
  // promise sits in the microtask queue past the abort), so a
  // boolean ref still reads "in progress" and the second mount
  // gets a false-positive lock-failed. By checking signal.aborted
  // on the held ref, we can let run#2 proceed when run#1 is already
  // dead, while still blocking a real concurrent user Fund tap.
  const fundingInProgressRef = useRef<AbortSignal | null>(null);
  const claimPayoutInProgressRef = useRef(false);
  // High-water mark of the connected-relay count at the last discovery re-fire
  // (see the relay-growth effect). Reset on disconnect so a reconnect within
  // the same hook instance re-discovers from scratch.
  const lastDiscoveryRelayCountRef = useRef(0);

  const [state, setState] = useState<UseEscrowState>({
    connected: false,
    pubkey: null,
    escrows: new Map(),
    relayStatuses: new Map(),
    connectedRelays: 0,
    error: null,
    loading: false,
    publicListingsLoading: false,
    earningsRevision: 0,
    fundingInProgress: false,
    claimPayoutInProgress: false,
    fedimint: {
      initialized: false,
      joined: false,
      federationId: null,
      federationName: hasCustomFederation() ? "External route" : BP_FEDERATION_NAME,
      isCustom: hasCustomFederation(),
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
      // v0.3.1 Phase 3: cold-boot probe state. Starts "pending" until
      // initFedimint runs probe1 sequentially after a successful init.
      bootProbeState: "pending",
    },
  });

  const updateFedimint = useCallback((partial: Partial<FedimintState>) => {
    setState(prev => ({ ...prev, fedimint: { ...prev.fedimint, ...partial } }));
  }, []);

  // PR 5: keep stateRef in sync with state on every render so callbacks
  // can read the latest values without taking `state` as a dependency.
  stateRef.current = state;

  // ── State updater helpers ───────────────────────────────────────────────

  const updateEscrow = useCallback((escrowId: string, escrowState: EscrowState) => {
    // A locally-forgotten ghost stays gone: don't let the Browse/public-
    // listings feed (or any re-delivery) re-add it after a restart. The ref is
    // loaded at connect with the reliable pubkey, so this works even before
    // state.pubkey re-renders. Loading it by ID un-forgets it (see loadEscrow).
    if (forgottenIdsRef.current.has(escrowId)) return;
    // Durable trade-history index: remember every trade the user is a party to
    // from this central chokepoint, so My Trades survives relay eviction / a
    // chain that can't rehydrate (loss-proof history). No-op for non-parties;
    // never blocks the state update. Recorded BEFORE the expired-unfunded hide
    // so an expired listing still shows in history (it's the user's own).
    try { recordTradeToIndex(escrowState, stateRef.current?.pubkey ?? null); } catch {}
    if (isExpiredUnfundedEscrow(escrowState)) {
      setState(prev => {
        if (!prev.escrows.has(escrowId)) return prev;
        const next = new Map(prev.escrows);
        next.delete(escrowId);
        return { ...prev, escrows: next };
      });
      const notifyPubkey = stateRef.current?.pubkey;
      if (notifyPubkey) rememberExpiredUnfundedId(escrowId, notifyPubkey);
      if (!hiddenExpiredIdsRef.current.has(escrowId)) {
        hiddenExpiredIdsRef.current.add(escrowId);
        console.info(`[chama] Hid expired unfunded escrow ${escrowId} from local state`);
      }
      return;
    }

    // #88: buzz the user on a meaningful state transition. stateRef mirrors the
    // committed `state`, so at call time it holds the PRIOR state of this escrow
    // — exactly the prev→next we compare. Fire-and-forget: maybeNotifyTransition
    // is deduped, enable-gated, and permission-gated internally, so it never
    // double-fires (even under StrictMode re-invokes) or blocks the update.
    const priorEscrow = stateRef.current?.escrows.get(escrowId);
    const notifyPubkey = stateRef.current?.pubkey;
    maybeNotifyTransition(priorEscrow, escrowState, notifyPubkey, notifyLiveSinceRef.current);

    // Liquidity/attention (Part ①.3 + Part ②): pull the seller back the moment a
    // buyer shows interest (a pre-lock child order / a JOIN hold on their
    // listing), and buzz opted-in users on a fresh home-chama listing. Both are
    // enable-gated, opt-in-gated, backlog-guarded (notifyLiveSinceRef), and
    // deduped internally, so they never block the update or double-fire.
    maybeNotifyBuyerInterest(priorEscrow, escrowState, notifyPubkey, notifyLiveSinceRef.current);
    maybeNotifyNewListing(priorEscrow, escrowState, notifyPubkey, notifyLiveSinceRef.current);

    // #79: Nostr-native "email alert" — when THIS client caused a trade-critical
    // transition, DM the counterparty so their external Nostr client (Damus/
    // Amethyst) surfaces it. The decider's single-sender rule + the persisted
    // per-(trade,transition) dedup keep it to exactly one send network-wide.
    // Sim is always synthetic. Signet on-chain field runs, however, use real
    // Nostr identities and need the same responder alerts as mainnet; suppressing
    // them is exactly how the assigned arbiter remained invisible in testing.
    if (!isSimModeOn()
        && (!isTestnetMode() || (escrowState.escrowMode ?? "ecash") === "onchain")) {
      const dmClient = clientRef.current;
      if (dmClient) {
        void maybeSendTradeDms(
          priorEscrow,
          escrowState,
          notifyPubkey,
          (pk, msg) => dmClient.sendTradeAlertDM(pk, msg),
        );
      }
    }

    setState(prev => {
      const next = new Map(prev.escrows);
      next.set(escrowId, escrowState);
      return { ...prev, escrows: next };
    });
  }, []);

  const updateRelayStatus = useCallback((relayUrl: string, status: string) => {
    setState(prev => {
      const next = new Map(prev.relayStatuses);
      next.set(relayUrl, status);
      const connected = [...next.values()].filter(s => s === "connected").length;
      return { ...prev, relayStatuses: next, connectedRelays: connected };
    });
  }, []);

  const runDiscovery = useCallback((client: EscrowClient, pubkey: string): Promise<number> => {
    const existing = discoveryInFlightRef.current;
    if (existing) return existing;
    const run = discoverAndLoadMyTrades(client, pubkey, forgottenIdsRef.current);
    discoveryInFlightRef.current = run;
    void run.finally(() => {
      if (discoveryInFlightRef.current === run) discoveryInFlightRef.current = null;
    });
    return run;
  }, []);

  // ── Connect ─────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (connectInFlightRef.current || clientRef.current) return;
    connectInFlightRef.current = true;
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // Detect signer (NIP-07 extension or Fedi runtime)
      let signer: Signer;
      try {
        // Check for pre-connected NIP-46 signer (set by App component)
        if ((window as any).__chama_nip46_signer) {
          signer = (window as any).__chama_nip46_signer;
          delete (window as any).__chama_nip46_signer;
        }
        // Check for nsec login
        else if ((window as any).__chama_connect_nsec) {
          const nsec = (window as any).__chama_connect_nsec;
          delete (window as any).__chama_connect_nsec;
          const { NsecSigner } = await import("../escrow-engine/nsec-signer.js");
          signer = new NsecSigner(nsec);
        }
        // Default: NIP-07 extension
        else {
          signer = detectSigner();
        }
      } catch {
        // Fallback: try NIP-07 with a delay (extensions sometimes load late)
        await new Promise(r => setTimeout(r, 500));
        try {
          signer = detectSigner();
        } catch (e) {
          throw new Error("No Nostr signer found. Use the Signer QR option, paste an nsec, or install a NIP-07 extension.");
        }
      }

      const pubkey = await signer.getPublicKey();
      signerRef.current = signer;
      // Stable identity. A fresh signer is built on every connect(), and on the
      // Fedi/browser path the npub comes straight from window.nostr with no
      // app-side persistence (shouldPersistNsecInShell() is false there). The
      // signer already rejects garbage reads (normalizeSignerPubkey); this pins
      // the last-seen identity so a *valid but different* npub is treated as a
      // deliberate, CLEAN re-scope rather than a silent blend of two identities'
      // trades — the "role pill flips between sign-ins" symptom.
      const { changed: identityChanged, previous: previousIdentity } = reconcileIdentity(pubkey);
      if (identityChanged) {
        console.warn(
          `[chama] active identity changed ${previousIdentity?.slice(0, 8)}… → ${pubkey.slice(0, 8)}… — ` +
            `re-scoping cleanly. Fedi/browser identity is provided by window.nostr, not app-side ` +
            `persistence; if this was unexpected, the Fedi runtime isn't deterministically restoring ` +
            `one stored key (the upstream cause).`,
        );
      }
      setLocalStorageUserScope(pubkey);
      // v4.3 auth-first RETIRED the v3.5.1 pre-signer pick stash: the globe
      // picker now runs POST-connect and writes the npub scope directly
      // (handleSelectCommunity), so there is nothing to defer-commit here.
      // Drop any stale pre-4.3 stash so an old un-applied pick can never
      // silently claim a future npub on shared storage.
      try { localStorage.removeItem("chama_pending_community"); } catch { /* no-op */ }
      // v3.5.1 #6: refresh the unscoped pre-signin "last home" hint from THIS
      // npub's now-resolvable scoped home, so a web reload (no auto-login)
      // keeps the user past the first-run globe. Covers users whose home was
      // set before the hint existed. Skipped when the npub has no pick yet
      // (fresh npub ⇒ globe is correct).
      {
        const resolvedHome = getUserCommunitySlugRaw();
        if (resolvedHome) setLastHomeHint(resolvedHome);
      }
      // Hydrate the forgotten-trade denylist NOW, with the reliable pubkey, so
      // the Browse feed (which starts below, before state.pubkey re-renders)
      // can't re-add a ghost the user forgot on a prior run.
      forgottenIdsRef.current = new Set(getForgottenEscrowIds(pubkey));

      // When this signed-in session went live. Inbound chat older than this is
      // backlog (cold-boot / heal replay) and must stay silent; only messages
      // arriving live buzz — the analogue of the transition core's prev-must-be-
      // non-null guard, for a stream that has no "prev".
      const chatNotifyLiveSince = Math.floor(Date.now() / 1000);
      // Same live-since powers the buyer-interest + new-listing backlog guards,
      // read from updateEscrow (a []-dep callback outside this closure).
      notifyLiveSinceRef.current = chatNotifyLiveSince;

      const callbacks: EscrowClientCallbacks = {
        onStateUpdate: (id, s) => updateEscrow(id, s),
        onChatMessage: (id, msg) => {
          // Chat messages are embedded in escrow state via the engine.
          // Force React re-render with the updated chatMessages.
          updateEscrow(id, client.getState(id)!);
          vibrate([20, 30, 20]);
          // OS-buzz the inbound message per the DM preference (auto = arbiters
          // only). The pure decision + delivery live in notify-service.
          const s = client.getState(id);
          if (s) maybeNotifyChatMessage(s, msg, pubkey, chatNotifyLiveSince);
        },
        onValidationError: (id, error, eventId) => {
          console.debug(`[escrow] Validation error on ${id}: ${error} (event: ${eventId})`);
        },
        onRelayStatus: (url, status) => updateRelayStatus(url, status),
        onPublicListingHydration: (pending) => {
          publicListingHydrationsPendingRef.current = pending;
          if (pending > 0) {
            setState(prev => ({ ...prev, publicListingsLoading: true }));
            return;
          }
          if (publicListingsSettleTimerRef.current) {
            clearTimeout(publicListingsSettleTimerRef.current);
            publicListingsSettleTimerRef.current = null;
          }
          setState(prev => ({ ...prev, publicListingsLoading: false }));
        },
        onPublicListingsSettled: () => {
          // EOSE quorum means the initial public query has a complete-enough
          // relay reading. Give already-delivered CREATE handlers one brief
          // turn to register their full-chain hydration, then settle an empty
          // feed immediately instead of waiting out the 10s safety fallback.
          if (publicListingsSettleTimerRef.current) {
            clearTimeout(publicListingsSettleTimerRef.current);
          }
          publicListingsSettleTimerRef.current = setTimeout(() => {
            publicListingsSettleTimerRef.current = null;
            if (publicListingHydrationsPendingRef.current === 0) {
              setState(prev => ({ ...prev, publicListingsLoading: false }));
            }
          }, 250);
        },
      };

      const client = new EscrowClient(signer, {
        relays: config?.relays || DEFAULT_RELAYS,
        defaultPlatformFeeBps: config?.defaultPlatformFeeBps ?? 50,
        platformFeePubkey: config?.platformFeePubkey,
        defaultExpirySeconds: config?.defaultExpirySeconds ?? 86_400,
        trancheCreditObserved: defaultCreditObserver(),
        ...config,
      }, callbacks);

      client.connect();
      clientRef.current = client;
      if ((import.meta as any).env?.VITE_CHAMA_PROFILE_RELAY) {
        (globalThis as any).__CHAMA_PROFILE_CLIENT__ = client;
      }

      // Start Browse feed — subscribe to public CREATE events from the last 7 days.
      // These flow through the same onStateUpdate callback and land in `escrows`;
      // the UI filters by "am I a participant" to split Browse from My trades.
      client.watchPublicListings();

      // Identity-wide accounting: recover self-encrypted premium receipts from
      // relays, then backfill receipts for legacy local-only redemptions. This
      // is history synchronization only; bearer ecash stays device-local.
      void syncArbiterEarnings(client)
        .then(() => setState(prev => ({ ...prev, earningsRevision: prev.earningsRevision + 1 })))
        .catch(() => { /* fail-soft; the next boot/reconnect retries */ });

      // A public CREATE is intentionally hidden until its complete chain has
      // been quorum-verified (otherwise a stale completed offer can flash as
      // OPEN). During that bounded verification window, tell Browse the truth
      // instead of briefly claiming there are no offers. An actually-empty
      // community settles after the same cold-start budget.
      if (publicListingsSettleTimerRef.current) clearTimeout(publicListingsSettleTimerRef.current);
      publicListingsSettleTimerRef.current = setTimeout(() => {
        publicListingsSettleTimerRef.current = null;
        // No CREATE arrived: the initial public query is genuinely empty. If a
        // chain is still in flight, its completion callback owns settlement.
        if (publicListingHydrationsPendingRef.current === 0) {
          setState(prev => ({ ...prev, publicListingsLoading: false }));
        }
      }, 10_000);

      setState(prev => ({
        ...prev,
        connected: true,
        pubkey,
        loading: false,
        publicListingsLoading: true,
        // Clean re-scope on a changed identity: drop the prior npub's escrows
        // so the role/pill can never be computed against the wrong identity.
        // The saved-ID reload + active discovery below repopulate for the new
        // npub. (Same-identity reconnects keep their in-memory map.)
        ...(identityChanged ? { escrows: new Map() } : {}),
      }));

      vibrate([50, 30, 50]); // Connected haptic

      // Start periodic balance refresh — every 30 seconds
      const balanceInterval = setInterval(() => {
        refreshBalanceRef.current?.().catch(() => {});
      }, 30_000);

      // Start periodic expiry checker — every 60 seconds, check all loaded escrows
      // v0.1.65: periodic heal — also scan EXPIRED so stuck chains get
      // healed by any online participant, not just those who happened
      // to open the specific trade. The client-side guard inside
      // maybeAutoRefundExpired filters by role + vote-state, so this
      // is safe to call broadly.
      const expiryInterval = setInterval(async () => {
        if (!clientRef.current) return;
        const escrowClient = clientRef.current;
        const now = Math.floor(Date.now() / 1000);
        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          const isStuckLocked =
            escrowState.status === "LOCKED" && now > escrowState.expiresAt;
          const isStuckExpired =
            escrowState.status === "EXPIRED" &&
            !escrowState.eventChain?.some?.((e: any) => e.kind === 38104);
          if (isStuckLocked || isStuckExpired) {
            try {
              await (escrowClient as any).maybeAutoRefundExpired?.(escrowId);
            } catch {}
            // Belt-and-suspenders for the resolve-starvation gap: if the
            // healing votes already meet 2-of-3 but the RESOLVE never landed,
            // publish it from here too (its guards no-op safely otherwise).
            try {
              await (escrowClient as any).maybeAutoResolve?.(escrowId);
            } catch {}
          }
        }
      }, 60_000);
      // Store interval for cleanup
      (clientRef as any)._expiryInterval = expiryInterval;

      // ── v0.1.67: Mechanism B sentinel ─────────────────────────────
      //
      // Background heal for stuck trades the user is a participant in.
      // Two heals: stuck-LOCKED-past-expiry (publish my REFUND vote)
      // and stuck-FUNDED-past-expiry as initiator (publish CANCEL).
      // COMPLETE is deliberately not auto-healed here: it is a money
      // statement and must wait for the claim balance to actually land.
      //
      // In-memory dedup prevents retrying the same heal every tick.
      // Accepts duplicates across clients (state machine dedupes at
      // replay via ALREADY_VOTED / TERMINAL_STATE / INVALID_STATE).
      //
      // Scope: escrowClient.states where the user's pubkey appears in
      // state.participants. Ground-truth filter — independent of
      // savedIds localStorage state.
      const sentinelDedup = new Map<string, Set<string>>();
      const markAttempted = (escrowId: string, healKind: string) => {
        const set = sentinelDedup.get(escrowId) ?? new Set<string>();
        set.add(healKind);
        sentinelDedup.set(escrowId, set);
      };
      const alreadyAttempted = (escrowId: string, healKind: string): boolean =>
        sentinelDedup.get(escrowId)?.has(healKind) ?? false;

      const sentinelInterval = setInterval(async () => {
        if (!mountedRef.current) return;
        if (!clientRef.current || !signerRef.current) return;
        const escrowClient = clientRef.current;
        let myPubkey: string;
        try {
          myPubkey = await signerRef.current.getPublicKey();
        } catch {
          // Signer not ready — skip this tick silently.
          return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        let scanned = 0;
        let heals = 0;

        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          scanned++;

          // Determine my role in this trade, if any. If I'm not a
          // participant, skip entirely — this is the scope guard.
          const p = escrowState.participants;
          let myRole: Role | null = null;
          if (p.buyer === myPubkey) myRole = Role.BUYER;
          else if (p.seller === myPubkey) myRole = Role.SELLER;
          else if (p.arbiter === myPubkey) myRole = Role.ARBITER;
          if (!myRole) continue;

          // ── Heal #1: LOCKED past expiry, I haven't voted REFUND ──
          if (
            escrowState.status === "LOCKED" &&
            nowSec > escrowState.expiresAt &&
            escrowState.votes?.[myRole] === undefined &&
            !alreadyAttempted(escrowId, "refund-vote")
          ) {
            markAttempted(escrowId, "refund-vote");
            try {
              await escrowClient.vote(escrowId, Outcome.REFUND);
              heals++;
              console.log(`[chama] sentinel: published REFUND vote on ${escrowId}`);
            } catch (e) {
              console.debug(`[chama] sentinel: REFUND vote on ${escrowId} suppressed:`, (e as Error)?.message);
            }
            continue;
          }

          // ── Heal #2: CREATED past expiry, no LOCK, I'm the initiator ──
          // Atomic-funding model: trades sit in CREATED until LOCK fires.
          // If a buyer never paid by the deadline, the initiator cancels.
          const isInitiator = escrowState.initiator?.pubkey === myPubkey;
          if (
            escrowState.status === "CREATED" &&
            nowSec > escrowState.expiresAt &&
            isInitiator &&
            !alreadyAttempted(escrowId, "cancel")
          ) {
            markAttempted(escrowId, "cancel");
            try {
              await escrowClient.cancel(escrowId, "never_locked_past_expiry");
              heals++;
              console.log(`[chama] sentinel: published CANCEL on ${escrowId} (stuck CREATED past expiry)`);
            } catch (e) {
              console.debug(`[chama] sentinel: CANCEL on ${escrowId} suppressed:`, (e as Error)?.message);
            }
          }
        }

        console.log(`[chama] sentinel: scanned ${scanned} escrows, ${heals} heals`);
      }, 5 * 60_000);
      (clientRef as any)._sentinelInterval = sentinelInterval;

      // Auto-reload saved escrows — wait for relays to connect first
      const savedIds = getSavedEscrowIds(pubkey);
      if (savedIds.length > 0) {
        // Wait for at least 2 relays to connect (up to 5 seconds)
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...(client as any).relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 2) break;
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        const finalConnected = [...(client as any).relayManager.relays.values()]
          .filter((r: any) => r.status === "connected").length;
        console.log(`[chama] Reloading ${savedIds.length} saved escrow(s) with ${finalConnected} relays connected...`);
        // v0.1.66.32: cap raised 10 → 50 to match save cap.
        // Users with >10 saved trades were silently having older
        // escrows skipped on cold start, causing stale-forever state.
        let savedReloadIndex = 0;
        for (const id of savedIds.slice(0, 50)) {
          try {
            const loaded = await client.loadEscrow(id);
            if (loaded && isExpiredUnfundedEscrow(loaded)) {
              (client as any).states?.delete?.(id);
              (client as any).rawEvents?.delete?.(id);
              rememberExpiredUnfundedId(id, pubkey);
            }
          } catch (e) {
            console.debug(`[chama] Could not reload ${id}:`, e);
          }
          savedReloadIndex += 1;
          if (savedReloadIndex % 3 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
      }

      // ── Active relay discovery (self-healing My Trades) ────────────────
      // Don't let My Trades depend on a wipeable localStorage ID list:
      // rebuild it from relays (events this npub authored ∪ events tagging
      // it). Background/non-blocking — fired after sign-in completes, like
      // openEscrow's refetch — so it never delays connect. Union-only and
      // denylist-aware (see discoverAndLoadMyTrades). Runs on every client;
      // a fresh APK install or any wiped cache benefits identically.
      void runDiscovery(client, pubkey);
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      connectInFlightRef.current = false;
    }
  }, [config, updateEscrow, updateRelayStatus, runDiscovery]);

  // ── Disconnect ──────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    if (publicListingsSettleTimerRef.current) {
      clearTimeout(publicListingsSettleTimerRef.current);
      publicListingsSettleTimerRef.current = null;
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    fedimintRef.current?.cleanup().catch((e) =>
      console.debug("[chama] fedimint cleanup error:", e)
    );
    fedimintRef.current = null;
    bridgeRef.current = null;
    signerRef.current = null;
    fundingInProgressRef.current = null;
    claimPayoutInProgressRef.current = false;
    lastDiscoveryRelayCountRef.current = 0;
    discoveryInFlightRef.current = null;
    publicListingHydrationsPendingRef.current = 0;
    setLocalStorageUserScope(null);
    clearSeedCache();
    setState({
      connected: false,
      pubkey: null,
      escrows: new Map(),
      relayStatuses: new Map(),
      connectedRelays: 0,
      error: null,
      loading: false,
      publicListingsLoading: false,
      earningsRevision: 0,
      fundingInProgress: false,
      claimPayoutInProgress: false,
      fedimint: {
        initialized: false,
        joined: false,
        federationId: null,
        federationName: hasCustomFederation() ? "External route" : BP_FEDERATION_NAME,
        isCustom: hasCustomFederation(),
        balanceMsats: 0,
        busy: false,
        error: null,
        lastHealthOk: null,
        lastHealthAt: null,
        // v0.3.1 Phase 3: matches the primary initial state above.
        // disconnect() resets to pre-init shape; bootProbeState resets
        // with it.
        bootProbeState: "pending",
      },
    });
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  //
  // v0.1.66.34: mountedRef is the kill-switch for long-lived async polls
  // (the claim watchdog in particular). setTimeout-driven polls hold
  // closures over fedimintRef/updateFedimint, and firing those after
  // unmount produces React "state update on unmounted component" warnings
  // — worse, calling updateFedimint() on a stale instance can race a
  // freshly-mounted hook's state and clobber a real balance update with
  // a stale read.

	  const mountedRef = useRef(true);

	  useEffect(() => {
	    mountedRef.current = true;
	    return () => {
	      mountedRef.current = false;
	      clientRef.current?.disconnect();
	      clientRef.current = null;
	      if ((import.meta as any).env?.DEV && (import.meta as any).hot) {
	        console.debug("[chama] preserving live Fedimint session across Vite hot reload cleanup; relay sockets closed");
	        return;
	      }
	      const fedimint = fedimintRef.current;
	      fedimint?.cleanup().catch(() => {});
	      if (fedimintRef.current === fedimint) fedimintRef.current = null;
	      if (bridgeRef.current) bridgeRef.current = null;
      setLocalStorageUserScope(null);
    };
  }, []);

  // ── Re-fire discovery as the connected-relay set grows ──────────────────
  // On a slow webview the initial discovery + saved-ID reload at connect can
  // run before all relays are up. Even with the relay-manager's quorum gate,
  // the connect budget can elapse with a partial set. As more relays come
  // online, re-run active discovery (union-only, denylist-aware) so a list
  // built off a partial set heals to the full one. The FIRST growth starts
  // immediately (fetchOnce itself still waits for relay quorum). Later growth
  // retains the debounce so staggered connects coalesce into one settled pass.
  useEffect(() => {
    if (!state.connected || !state.pubkey) return;
    const client = clientRef.current;
    if (!client) return;
    if (state.connectedRelays <= lastDiscoveryRelayCountRef.current) return;
    const pk = state.pubkey;
    const grewTo = state.connectedRelays;
    const delay = lastDiscoveryRelayCountRef.current === 0
      ? INITIAL_DISCOVERY_DELAY_MS
      : RELAY_GROWTH_DEBOUNCE_MS;
    const t = setTimeout(() => {
      lastDiscoveryRelayCountRef.current = grewTo;
      void runDiscovery(client, pk);
      // The connect-time earnings sync can begin before a slow Android WebView
      // has any usable relay socket. Retry as the relay set comes alive so a
      // legacy v5.3 local premium (first opened under v5.4) is actually
      // backfilled instead of waiting for another app restart.
      void syncArbiterEarnings(client)
        .then(() => setState(prev => ({ ...prev, earningsRevision: prev.earningsRevision + 1 })))
        .catch(() => {});
    }, delay);
    return () => clearTimeout(t);
  }, [state.connected, state.pubkey, state.connectedRelays, runDiscovery]);

  // ── Trade actions ───────────────────────────────────────────────────────

  const requireClient = (): EscrowClient => {
    if (!clientRef.current) {
      // Tag the throw so callers can tell a transient handshake window
      // (connect() dispatched, sockets still coming up) apart from a genuine
      // signed-out state, and show "Connecting…/retry" vs a dead-end. The
      // message is unchanged so existing string-based catches still match.
      const err: any = new Error("Not connected — call connect() first");
      err.code = stateRef.current?.loading ? "RELAYS_CONNECTING" : "NOT_CONNECTED";
      throw err;
    }
    return clientRef.current;
  };

  // ── Readiness gates (relay-connect resilience) ──────────────────────────
  // "Ready" = a live client + signer + ≥1 actually-open relay. We read the
  // client's live relayManager (not React state) to avoid the connected-flips-
  // -true-synchronously skew the init path documents.
  const isRelayReady = (): boolean => {
    const client: any = clientRef.current;
    if (!client || !signerRef.current) return false;
    try {
      const connected = [...client.relayManager.relays.values()]
        .filter((r: any) => r.status === "connected").length;
      return connected >= 1;
    } catch {
      return false;
    }
  };

  /**
   * Resolve once the relay layer is usable, or after `waitMs`. Returns true if
   * ready. When not ready and a client exists, fires a one-shot forceReconnectAll
   * to expedite recovery of any backed-off/abandoned relays, then polls. With no
   * client/signer at all (signed out) it returns false immediately — waiting
   * can't help. This is the soft-gate behind Create/Join: never a dead-end throw
   * during the handshake window.
   */
  const ensureRelayReady = async (waitMs = READY_WAIT_MS): Promise<boolean> => {
    if (isRelayReady()) return true;
    if (!clientRef.current || !signerRef.current) return false;
    try { clientRef.current.forceReconnectAll(); } catch {}
    let waited = 0;
    while (waited < waitMs) {
      await new Promise(r => setTimeout(r, READY_POLL_MS));
      waited += READY_POLL_MS;
      if (isRelayReady()) return true;
    }
    return isRelayReady();
  };

  /**
   * Wait (bounded) for the Fedimint wallet to be init+joined. Funding can't run
   * without it; init in turn needs relays, so we nudge the relay layer once.
   * On timeout the caller STILL fails (no deferred payment) — one tap = one
   * intent — but if the wallet finished (re)joining inside the window, the
   * original Fund tap proceeds.
   */
  const ensureFedimintReady = async (waitMs = FUND_READY_WAIT_MS): Promise<boolean> => {
    const ok = () => {
      const f = fedimintRef.current;
      return !!(f && f.isInitialized() && f.isJoined());
    };
    if (ok()) return true;
    try { clientRef.current?.forceReconnectAll(); } catch {}
    let waited = 0;
    while (waited < waitMs) {
      await new Promise(r => setTimeout(r, READY_POLL_MS));
      waited += READY_POLL_MS;
      if (ok()) return true;
    }
    return ok();
  };

  /**
   * Explicit recovery lever for the in-app "Reconnect" control. Re-probes every
   * backed-off/abandoned relay (the per-relay backoff gives up after
   * MAX_RETRY_COUNT and won't recover on its own), and re-arms My-Trades
   * discovery (whose growth gate latches a high-water mark) so the resulting
   * reconnects reload each trade's chain + chat.
   */
  const recoverRelays = useCallback(() => {
    try { clientRef.current?.forceReconnectAll(); } catch {}
    lastDiscoveryRelayCountRef.current = 0;
  }, []);

  // ⚠ The refund leaf's CLTV is an ABSOLUTE height, so it must be resolved from
  // a live tip. Held in a ref (not state) because it feeds a pure recompute, and
  // a re-render mid-derivation must never change the address under a user who is
  // looking at it. Zero until a tip is read, which reads as "bad-refund-height"
  // — a blocker, not a wrong address.
  const onchainRefundHeightRef = useRef(0);
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    void esploraTipHeight(esploraFetcher(defaultEsploraBase(ESCROW_NETWORK), { network: ESCROW_NETWORK }))
      .then((tip) => { if (!cancelled && tip > 0) onchainRefundHeightRef.current = tip + REFUND_CLTV_BLOCKS; })
      .catch(() => { /* no tip ⇒ no on-chain address; the blocker says so */ });
    return () => { cancelled = true; };
  }, [state.connected]);

  const myEscrowKey = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const signer = signerRef.current;
    if (!signer) throw new Error("Not connected");
    const words = await getOrCreateSeed(client, signer);
    return deriveEscrowSigningKey(
      Array.isArray(words) ? words.join(" ") : String(words),
      escrowId,
      { network: ESCROW_NETWORK },
    );
  }, []);

  const createEscrow = useCallback(async (params: Parameters<EscrowClient["createEscrow"]>[0]) => {
    // Soft-gate (relay resilience): if relays are still handshaking, wait briefly
    // and auto-retry instead of dead-ending with "Not connected". Instant when
    // already ready. Create moves no sats, so proceeding once ready is safe.
    if (!(await ensureRelayReady())) {
      const err: any = new Error("Couldn't reach the network — check your connection and try again.");
      err.code = clientRef.current ? "RELAYS_CONNECTING" : "NOT_CONNECTED";
      throw err;
    }
    const client = requireClient();

    // v0.4.4: CREATE no longer probes the federation. Pillar 2.3
    // ("federation follows the listing") only requires the `fed` tag
    // (federation ID), which the running client always knows from
    // init — no roundtrip needed. The legacy fedPrefix tag is no
    // longer emitted (probeResult is always null here), so new CREATE
    // events carry only the fed-ID. Buyers gate JOIN on fed-ID
    // equality (useEscrow.joinEscrow) and the LOCK bridge gates on
    // the same fed-ID, so the prefix path is structurally dead.
    //
    // deriveCreateFedTags handles probeResult: null cleanly: it emits
    // `fed` from cachedFedId alone and omits `fedPrefix`.
    const cachedFedId = fedimintRef.current?.getFederationId() ?? null;
    const fedTags = deriveCreateFedTags({ cachedFedId, probeResult: null });

    // Sandbox/test lever: override the default trade expiry for CREATEs made
    // on THIS device. Consensus-safe by construction — expirySeconds becomes
    // committed wire data in the CREATE event, so every client derives the
    // same expiry and the same arbiter-substitution floor (min(4h, half the
    // remaining life)) from it. Example: localStorage.setItem(
    // "chama_create_expiry_seconds", "1800") → 30-minute trades whose
    // backup-arbiter floor opens after ~15 minutes. Remove the key for the
    // 24h default. Clamped to [5 minutes, 30 days].
    const expiryOverride = readCreateExpiryOverride();
    const result = await client.createEscrow({
      ...params,
      ...(params.expirySeconds === undefined && expiryOverride !== null
        ? { expirySeconds: expiryOverride }
        : {}),
      fedPrefix: fedTags.fedPrefix,
      fed: fedTags.fed,
      // Tier 2.1: derive the creator's escrow key from the REAL escrow id, which
      // only exists inside createEscrow. Per-trade keys, no commingling.
      ...((params as { escrowMode?: string }).escrowMode === "onchain"
        ? {
            escrowKeyFor: async (id: string) => {
              try { return msBytesToHexLocal((await myEscrowKey(id)).xonly); }
              catch { return undefined; }
            },
          }
        : {}),
    });
    saveEscrowId(result.escrowId, stateRef.current?.pubkey ?? null);
    vibrate([40, 20, 40, 20, 80]); // Celebratory haptic
    return result;
  }, [myEscrowKey]);

  const joinEscrow = useCallback(async (
    escrowId: string,
    role: Role,
    opts: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean } = {},
  ) => {
    // Soft-gate (relay resilience): wait briefly for the relay handshake rather
    // than dead-ending. JOIN itself moves no sats (the fund step does), so
    // proceeding once ready on the user's tap is safe.
    if (!(await ensureRelayReady())) {
      const err: any = new Error("Couldn't reach the network — check your connection and try again.");
      err.code = clientRef.current ? "RELAYS_CONNECTING" : "NOT_CONNECTED";
      throw err;
    }
    const client = requireClient();

    // v0.4.4 federation gate (fed-ID equality) ─────────────────────────
    // Pre-flight: if the trade's CREATE event carries a `fed` tag
    // (federation ID hex), compare it to the joiner's wallet federation.
    // Refuse the join on mismatch BEFORE any money operation.
    //
    // The v0.1.72-era fedPrefix gate spent 1 sat as a probe to extract
    // a 10-char identifier — incompatible with v0.1.76 Option B
    // ("wallets always at 0 between trades"). The fed-ID is captured
    // from the running client at init and surfaced into CREATE via
    // deriveCreateFedTags; no spend needed.
    //
    // Legacy trades without payload.fed: allow the join. The LOCK gate
    // (escrow-bridge.lockAndPublish) remains the load-bearing
    // money-move defense — it gates on the same fed-ID.
    const state = client.getState(escrowId);
    const createEvent = state?.eventChain?.[0];
    const expectedFed = effectiveCreateFederationId(createEvent?.payload as any);

    // Sim mode has fake federations (SIM_FEDERATION_ID) that never equal a
    // trade's real stamped fed — this guard is a real-money protection, so
    // skipping it in sim is what lets a full sim trade (join → lock → settle)
    // complete end-to-end. #35: sim e2e was silently broken here.
    if (expectedFed && fedimintRef.current && !isSimModeOn()) {
      const walletFed = fedimintRef.current.getFederationId();
      if (walletFed && walletFed !== expectedFed) {
        const err: any = new Error(
          `This trade lives in a different Chama than your wallet is on. ` +
            `Switch to the trade's Chama to continue — your sats stay safe.`
        );
        err.code = "FED_MISMATCH";
        err.expected = expectedFed;
        err.got = walletFed;
        throw err;
      }
    }

    try {
      // Tier 2.1: an on-chain trade needs every party's escrow key before its
      // address can exist — including the arbiter's, which is exactly why they
      // must JOIN before funding. Fails SOFT: a key we cannot derive leaves a
      // named blocker on the funding screen rather than breaking the JOIN.
      let escrowXonly: string | undefined;
      const joinState = client.getState(escrowId);
      if ((joinState?.escrowMode ?? "ecash") === "onchain") {
        try {
          escrowXonly = msBytesToHexLocal((await myEscrowKey(escrowId)).xonly);
        } catch (e) {
          console.warn("[chama] couldn't derive an escrow key for this JOIN:", e);
        }
      }
      const result = await client.joinEscrow(escrowId, role, {
        ...opts,
        ...(escrowXonly ? { escrowXonly } : {}),
      });
      saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
      vibrate([30, 20, 30]);
      return result;
    } catch (e: any) {
      // Swallow known duplicate/stale errors — they fire when a user reloads
      // a trade they already joined and the state has advanced past OPEN.
      // Engine strings: "Cannot JOIN in state <x>" and
      // same-role duplicate JOIN echoes. Opposite-role self-joins must
      // surface as real errors; otherwise a seller can tap "Join as Buyer"
      // and see a false-success path on their own listing.
      const msg = e?.message || "";
      const latest = client.getState(escrowId);
      const currentPubkey = stateRef.current?.pubkey ?? null;
      const alreadyInRequestedRole =
        !!currentPubkey && latest?.participants?.[role] === currentPubkey;
      if (msg.includes("Cannot JOIN") || msg.includes("TERMINAL") ||
          ((e?.code === "ALREADY_PARTICIPANT" || msg.includes("already a participant")) &&
            alreadyInRequestedRole)) {
        console.debug("[chama] Join suppressed:", msg);
        saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, [myEscrowKey]);

	  const requireBridge = (): EscrowFedimintBridge => {
	    if (!bridgeRef.current && clientRef.current && fedimintRef.current && signerRef.current) {
	      const fedimint = fedimintRef.current;
	      if (fedimint.isInitialized() && fedimint.isJoined()) {
	        console.debug("[chama] Rebuilding missing Fedimint bridge from live wallet refs");
	        bridgeRef.current = new EscrowFedimintBridge(
	          clientRef.current,
	          fedimint,
	          signerRef.current,
	        );
	      }
	    }
	    if (!bridgeRef.current) {
	      throw new Error(
	        "Fedimint wallet not ready — join a federation before locking or claiming"
	      );
	    }
    return bridgeRef.current;
  };

  const lockAndPublishAction = useCallback(async (
    escrowId: string,
    opts: { savedHandleId?: string; selectedItems?: SelectedMenuItem[]; buyerPubkey?: string } = {},
  ) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      // v2.3: fold in the consensus-safe substitution-grace override (if the
      // power-user card set one) so it rides into the signed LOCK. Absent ⇒
      // legacy 4h default.
      const graceOverride = readSubstitutionGraceOverride();
      // §0.3: hand the bridge a chain-verified bonded set so it does not have
      // to trust the creator's CREATE stamp. This is the SYNCHRONOUS 12h pool
      // cache — deliberately not a network fetch, because nothing may block or
      // fail the money path for a preference check. No cache ⇒ null ⇒ the
      // bridge ignores the stamp and uses the legacy deterministic pick.
      const lockState = client.getState(escrowId);
      const verifiedBondedArbiters = lockState?.community
        ? bondedArbitersForCommunity(readCachedCommunityBonds(lockState.community) ?? [])
        : null;
      const result = await bridge.lockAndPublish(escrowId, {
        ...opts,
        ...(graceOverride !== null ? { substitutionGraceSeconds: graceOverride } : {}),
        ...(verifiedBondedArbiters && verifiedBondedArbiters.length > 0
          ? { verifiedBondedArbiters }
          : {}),
      });
      vibrate([60, 30, 60, 30, 120]);
      // Refresh balance after spending ecash
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("Cannot LOCK") || msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  const lockAndPublishWithEcashAction = useCallback(async (
    escrowId: string,
    oobNotes: string,
    opts: { savedHandleId?: string; selectedItems?: SelectedMenuItem[]; buyerPubkey?: string } = {},
  ) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      const graceOverride = readSubstitutionGraceOverride();
      const result = await bridge.lockAndPublishWithEcash(escrowId, oobNotes, {
        ...opts,
        ...(graceOverride !== null ? { substitutionGraceSeconds: graceOverride } : {}),
      });
      vibrate([60, 30, 60, 30, 120]);
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("Cannot LOCK") || msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  // Hard-failure signatures — errors we treat as red-toast worthy.
  // These mean the claim will NEVER succeed; retrying won't help.
  // Anything NOT on this list is assumed transient (federation may settle later).
  const isHardClaimFailure = (msg: string): boolean => {
    return msg.includes("not the winner") ||
           msg.includes("not APPROVED") ||
           msg.includes("Not enough shares") ||
           msg.includes("No lock data") ||
           msg.includes("hash mismatch") ||
           msg.includes("Notes hash mismatch") ||
           msg.includes("shares may be corrupted") ||
           msg.includes("You are not");
  };

  // Stale-state signatures — these mean the action was a no-op because state
  // already advanced. Suppress silently (same behavior as pre-v0.1.62).
  //
  // v0.1.66.34: tightened from substring matches on "already"/"Cannot"
  // to specific state-machine error signatures. The previous predicate
  // matched JavaScript TypeErrors like "Cannot read properties of
  // undefined" — those are real bugs we want surfaced, not staleness.
  const isStaleClaim = (msg: string): boolean => {
    return msg.includes("already claimed") ||
           msg.includes("Cannot claim in state") ||
           msg.includes("Cannot CLAIM") ||
           msg.includes("TERMINAL_STATE");
  };

  /**
   * Poll the wallet balance, watching for an inbound delta that looks like
   * the claim settling. Runs for ~120 seconds or until we see it.
   *
   * Resolves once with either "success" (if balance grew by expected amount)
   * or "timeout" (if it didn't). Never rejects — this is a best-effort check.
   */
  const startClaimWatchdog = useCallback((
    escrowId: string,
    balanceBefore: number,
    expectedDeltaMsats: number,
  ): Promise<"success" | "timeout"> => {
    return new Promise((resolve) => {
      const fedimint = fedimintRef.current;
      if (!fedimint) { resolve("timeout"); return; }

      // Tolerance: accept any delta >= 90% of expected. Fedimint settles can
      // have tiny variances from fee routing, and we'd rather false-positive
      // a success than false-negative it into timeout territory.
      const threshold = Math.floor(expectedDeltaMsats * 0.9);
      const maxTicks = 24;       // 24 * 5s = 120s
      const tickMs = 5_000;
      let ticks = 0;

      const check = async () => {
        // v0.1.66.34: bail out if the hook unmounted while we were
        // asleep. Resolving as "timeout" keeps the promise chain in
        // the claim action sane without leaking state updates into a
        // stale component.
        if (!mountedRef.current) { resolve("timeout"); return; }
        ticks++;
        try {
          const now = await fedimint.getBalance();
          if (!mountedRef.current) { resolve("timeout"); return; }
          updateFedimint({ balanceMsats: now });
          const delta = now - balanceBefore;
          if (delta >= threshold) {
            resolve("success");
            return;
          }
        } catch (e) {
          console.debug("[chama] watchdog getBalance threw:", e);
        }
        if (ticks >= maxTicks) {
          resolve("timeout");
          return;
        }
        setTimeout(check, tickMs);
      };

      setTimeout(check, tickMs);
    });
  }, [updateFedimint]);

  const claimAndRedeemAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const bridge = requireBridge();
    const fedimint = fedimintRef.current;
    // v0.1.66.31: wrap notify so phase:success triggers COMPLETE publish.
    // Best-effort — errors are swallowed (COMPLETE is advisory; the
    // reconciliation hook in loadEscrow will retry on next app reload).
    const userNotify = config?.onClaimProgress;
    const notify = (progress: ClaimPhase) => {
      userNotify?.(progress);
      if (progress.phase === "success") {
        clientRef.current?.complete(progress.escrowId).catch(e =>
          console.debug("[chama] post-claim COMPLETE publish failed:", (e as Error)?.message || e)
        );
      }
    };

    // Snapshot balance before we touch anything, so the watchdog knows
    // what "before" meant. If we can't read balance, the watchdog just
    // times out and the user sees the neutral info toast. No drama.
    let balanceBefore = 0;
    try {
      if (fedimint) balanceBefore = await fedimint.getBalance();
    } catch {}

    // Expected amount back: current Fedi/ecash claims settle the whole
    // reconstructed token. Fee fields remain part of the protocol record,
    // but must not reduce this expectation until actual payout fan-out can
    // split proceeds safely.
    const state = client.getState(escrowId);
    const expectedDeltaMsats = state ? state.amountMsats : 0;

    const finishWhenBalanceConfirms = (viaWatchdog: boolean) => {
      startClaimWatchdog(escrowId, balanceBefore, expectedDeltaMsats).then(
        (outcome) => {
          if (outcome === "success") {
            vibrate([100, 50, 100, 50, 200]);
            refreshBalanceRef.current?.().catch(() => {});
            notify?.({
              phase: "success",
              escrowId,
              deltaMsats: expectedDeltaMsats,
              viaWatchdog,
            });
          } else {
            notify?.({ phase: "timeout", escrowId });
          }
        },
        (err) => {
          console.warn("[chama] watchdog rejected unexpectedly:", err);
          notify?.({ phase: "timeout", escrowId });
        },
      );
    };

    notify?.({ phase: "submitted", escrowId });

    try {
      const result = await bridge.claimAndRedeem(escrowId);
      // The bridge can resolve as soon as redeemEcash is accepted, before
      // the wallet balance stream has fully caught up. Keep legacy callers
      // from auto-publishing COMPLETE until the same watchdog sees money.
      refreshBalanceRef.current?.().catch(() => {});
      notify?.({
        phase: "watching",
        escrowId,
        reason: "Waiting for federation balance confirmation",
      });
      finishWhenBalanceConfirms(false);
      return result;
    } catch (e: any) {
      const msg = e?.message || String(e);

      // A published CLAIM is not proof that the wallet received the ecash.
      // The bridge marks terminal mint outcomes separately; propagate those
      // so the payout orchestrator can run its absolute-balance cover check
      // and, when no matching credit exists, show the honest terminal error.
      // The unresolved redemption record remains available for recovery.
      if (e?.claimPublished && e?.settlementFailed) {
        console.error(
          "[chama] Claim published, but wallet settlement was not confirmed:",
          msg,
        );
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // v0.1.63: partial-success claim — chain correct, redeem in flight
      // ─────────────────────────────────────────────────────────────────
      // The bridge publishes CLAIM before calling redeemWithRetry. If the
      // redeem throws after CLAIM is on relays, the bridge wraps the error
      // with {claimPublished: true}. Treat this as "watching" — the chain
      // is correct, and the balance watchdog will either see the sats
      // land or time out gracefully. No red toast.
      if (e?.claimPublished) {
        console.warn(
          "[chama] Claim published, redeem failed — starting balance watchdog:",
          msg,
        );
        notify?.({ phase: "watching", escrowId, reason: msg });
        finishWhenBalanceConfirms(true);
        return client.getState(escrowId)!;
      }

      // Stale state (escrow already past APPROVED from a relay echo, etc.)
      // — silently return the current local state. No toast.
      if (isStaleClaim(msg)) {
        console.debug("[chama] Claim suppressed (stale):", msg);
        return client.getState(escrowId)!;
      }

      // Hard failure — notify, then re-throw for the UI to red-toast.
      if (isHardClaimFailure(msg)) {
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // v0.3.1 Phase 1: typed bridge errors propagate. FED_PROBE_FAILED
      // (federation unreachable at probe time) and FED_MISMATCH (wallet
      // is on a different fed than the trade's notes) are structural
      // bridge failures, not network hiccups. They have a clean retry
      // semantic — once the fed is reachable / the user switches feds,
      // the same claim works. Propagating them as throws lets
      // claim-and-payout route them to the new `claim-bridge-threw`
      // terminal with a Try-again affordance, instead of silently
      // dropping into the in-flight watchdog (which is useless here
      // because the bridge bailed before any redeem happened).
      if (e?.code === "FED_PROBE_FAILED" || e?.code === "FED_MISMATCH") {
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // Probably transient (worker timeout, RPC hiccup, "fetch failed", etc.)
      // The federation very likely IS processing the redeem. Start watching
      // balance instead of throwing.
      console.warn(
        "[chama] Claim bridge threw — treating as in-flight, watching balance.",
        msg,
      );
      notify?.({ phase: "watching", escrowId, reason: msg });

      // Kick the watchdog off, but return immediately so the UI doesn't hang.
      // When watchdog resolves, we notify success/timeout.
      finishWhenBalanceConfirms(true);

      // Return the local state so the UI doesn't show an error state.
      // The state will update naturally as the CLAIM event echoes back
      // from relays (if the bridge managed to publish it before the
      // timeout) or from the next loadEscrow.
      return client.getState(escrowId)!;
    }
  }, [config?.onClaimProgress, startClaimWatchdog]);

  // Forward-reference refreshBalance from within lock/claim actions
  const refreshBalanceRef = useRef<(() => Promise<void>) | null>(null);

  const voteAction = useCallback(async (escrowId: string, outcome: Outcome) => {
    const client = requireClient();
    try {
      const result = await client.vote(escrowId, outcome);
      vibrate(outcome === Outcome.RELEASE ? [80, 40, 80] : [60, 30, 60, 30, 60]);
      return result;
    } catch (e: any) {
      // v1.2.2 vote-freeze fix: previously this branch silently
      // returned the current state on duplicate/stale errors, which
      // fired the App's success toast as if the tap had published
      // a vote — leaving sellers staring at the same screen wondering
      // if anything happened. Now we re-throw a typed error so the
      // App's onVote handler can show an info toast distinct from a
      // real publish error. State-machine semantics are unchanged:
      // the duplicate/stale event was rejected, and the caller can
      // still recover the current state via getState if needed.
      const msg = e?.message || "";
      if (msg.includes("already voted") || msg.includes("Cannot vote") ||
          msg.includes("TERMINAL") || msg.includes("not LOCKED")) {
        console.debug("[chama] Vote suppressed:", msg);
        const swallowed = new Error(
          msg.includes("already voted")
            ? "Vote already recorded for this trade."
            : msg.includes("not LOCKED")
              ? "Trade is no longer accepting votes."
              : msg.includes("TERMINAL")
                ? "Trade has already settled — no further votes accepted."
                : "This vote can no longer be cast.",
        ) as Error & { voteSuppressed?: true; code?: string; originalMessage?: string; currentState?: EscrowState | null };
        swallowed.voteSuppressed = true;
        swallowed.code = "VOTE_SUPPRESSED";
        swallowed.originalMessage = msg;
        swallowed.currentState = client.getState(escrowId);
        throw swallowed;
      }
      throw e;
    }
  }, []);

  const sendChat = useCallback(async (
    escrowId: string,
    message: string | { message: string; attachments?: ChatImageAttachment[] },
  ) => {
    const client = requireClient();
    await client.sendChat(escrowId, message);
    vibrate(15); // Subtle tap
  }, []);

  const cancelAction = useCallback(async (escrowId: string, reason?: string) => {
    const client = requireClient();
    const result = await client.cancel(escrowId, reason);
    vibrate([50, 100]);
    return result;
  }, []);

  const loadEscrow = useCallback(async (
    escrowId: string,
    opts: { repairFromCache?: boolean } = {},
  ) => {
    const client = requireClient();
    // Loading a trade by ID is a deliberate "bring it back" — clear any
    // forgotten-denylist entry so it can surface and persist again.
    unforgetEscrowId(escrowId, stateRef.current?.pubkey ?? null);
    forgottenIdsRef.current.delete(escrowId);
    setState(prev => ({ ...prev, loading: true }));
    try {
      const result = await client.loadEscrow(escrowId, opts);
      if (result) saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
      setState(prev => ({ ...prev, loading: false }));
      return result;
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      return null;
    }
  }, []);

  /** Why the last loadEscrow for this id came back empty — so a caller can
   *  tell "this history is gone" apart from "the relays returned a chain with
   *  holes". Sync + fail-soft (no client ⇒ null). */
  const getLoadFailure = useCallback((escrowId: string): LoadFailure | null => {
    try {
      return clientRef.current?.getLastLoadFailure(escrowId) ?? null;
    } catch {
      return null;
    }
  }, []);

  const rebroadcastEscrow = useCallback(async (escrowId: string) => {
    const client = requireClient();
    // Heal in BOTH directions. The old behavior only PUSHED the cached chain
    // out — so a client stuck on a stale state (e.g. Fedi showing LOCKED while
    // the counterparty already published RESOLVE/COMPLETE) never pulled the
    // missing tail IN, and the heal silently no-op'd. Pull first (loadEscrow
    // re-fetches from relays, merges with cache, replays to current), THEN push
    // our cache out so a counterparty missing OUR events heals too. Converges
    // whichever side is behind. A heal is an explicit user action, so the pull
    // may rebuild from the durable cache (unlike background discovery).
    try {
      await client.loadEscrow(escrowId, { repairFromCache: true });
    } catch (e) {
      console.debug(`[chama] heal: pull for ${escrowId} failed; pushing cache anyway`, e);
    }
    return client.rebroadcastEscrow(escrowId);
  }, []);

  /** Manually re-run active relay discovery for the signed-in npub and hydrate
   *  any of its trades missing from the local list. Returns how many were
   *  added. Same union-only, denylist-aware path that runs at connect — exposed
   *  for an on-demand "refresh my trades" pull. */
  const refreshMyTrades = useCallback(async (): Promise<number> => {
    const client = requireClient();
    const pk = stateRef.current?.pubkey;
    if (!pk) return 0;
    setState(prev => ({ ...prev, loading: true }));
    try {
      return await discoverAndLoadMyTrades(client, pk, forgottenIdsRef.current);
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  }, []);

  /** INSTRUMENT-FIRST (Fedi round 3): run the pubkey-independent `#d`
   *  transport control. Thin pass-through to the client so the Advanced
   *  debug card can probe one known escrow id without the signer. */
  const probeFetchById = useCallback(async (escrowId: string) => {
    return requireClient().probeFetchById(escrowId);
  }, []);

  const purchaseFromListing = useCallback(async (parent: EscrowState, quantity: number) => {
    const client = requireClient();
    const result = await client.purchaseFromListing(parent, quantity);
    saveEscrowId(result.escrowId, stateRef.current?.pubkey ?? null);
    return result;
  }, []);

  const syncPrivateTranchePlan = useCallback(async (parentId: string): Promise<EscrowState[]> => {
    const client = requireClient();
    const pubkey = stateRef.current?.pubkey ?? null;
    const parent = client.getState(parentId) ?? await client.loadEscrow(parentId);
    if (!parent?.tranchePlan) return [];

    // PLAN_START necessarily reaches subscribers before the coordinator has
    // finished publishing every child CREATE. Subscribe first, then retry the
    // bounded relay query instead of permanently latching the first empty
    // result. The seller can also resume an interrupted fan-out by re-entering
    // the idempotent engine method with the frozen plan's exact parameters.
    const children = await syncPrivateTrancheChildren({
      parent,
      pubkey,
      watchChildren: id => client.watchChildren(id),
      loadChildren: id => client.loadChildren(id),
      resumePlan: async (id, maximumChildMsats, bitcoinNetwork) =>
        (await client.startTranchePlan(id, maximumChildMsats, bitcoinNetwork)).children,
    });
    for (const child of children) {
      saveEscrowId(child.id, pubkey);
      client.watchEscrow(child.id);
      if (!pubkey || child.trancheChild?.bitcoinNetwork === undefined) continue;
      const role = child.participants[Role.BUYER] === pubkey ? Role.BUYER
        : child.participants[Role.SELLER] === pubkey ? Role.SELLER
        : child.participants[Role.ARBITER] === pubkey ? Role.ARBITER
        : null;
      if (!role || child.childKeys?.[role]) continue;
      const xOnlyPubkey = msBytesToHexLocal((await myEscrowKey(child.id)).xonly);
      await client.publishChildKey(child.id, role, xOnlyPubkey);
    }
    return children.map(child => client.getState(child.id) ?? child);
  }, [myEscrowKey]);

  const startPrivateTranchePlan = useCallback(async (
    parentId: string,
    sliceCount: number,
  ): Promise<{ parent: EscrowState; children: EscrowState[] }> => {
    const client = requireClient();
    const parent = client.getState(parentId) ?? await client.loadEscrow(parentId);
    if (!parent) throw new Error("Parent trade not found.");
    if ((parent.escrowMode ?? "ecash") !== "onchain") {
      throw new Error("Private slice plans require on-chain escrow.");
    }
    const count = Math.floor(sliceCount);
    if (count < 2 || count > 12) throw new Error("Choose between 2 and 12 slices.");
    const minimumMsats = MIN_TRANCHE_SATS * 1000;
    if (Math.floor(parent.amountMsats / count) < minimumMsats) {
      throw new Error(`Each slice must be at least ${MIN_TRANCHE_SATS.toLocaleString()} sats.`);
    }
    // ceil(total/count) produces exactly `count` deterministic rows while the
    // engine keeps the final remainder honest.
    const maximumChildMsats = Math.ceil(parent.amountMsats / count);
    const trancheNetwork = ESCROW_NETWORK_LABEL === "mainnet" ? "mainnet" : "signet";
    const started = await client.startTranchePlan(parentId, maximumChildMsats, trancheNetwork);
    saveEscrowId(parentId, stateRef.current?.pubkey ?? null);
    for (const child of started.children) saveEscrowId(child.id, stateRef.current?.pubkey ?? null);
    const children = await syncPrivateTranchePlan(parentId);
    return { parent: client.getState(parentId) ?? started.parent, children };
  }, [syncPrivateTranchePlan]);

  // ── Tier 2.1: the on-chain escrow plumbing ────────────────────────────────
  //
  // Three actions, in the order a trade uses them:
  //   myEscrowKey    — derive + publish this party's key (address needs all 3)
  //   onchainFunding — recompute the address, ask the chain if it is funded
  //   publishOnchainLock — LOCK once the deposit is confirmed
  //
  // Every one of them recomputes locally. Nothing here trusts a wire-supplied
  // address, because funding is irreversible.

  /** This user's escrow key for a trade, derived from the seed. */
  /** Recompute the escrow address from the keys published so far.
   *
   *  ⚠ Returns blockers rather than an address when a key is missing — most
   *  often the arbiter's, who must JOIN before an on-chain trade can be funded
   *  at all. Never guesses, never invents an address. */
  const onchainFundingPlan = useCallback((escrowId: string) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Escrow not loaded");
    // A frozen parent is a manifest only. Never render a deposit address for
    // it: publishLock rejects it later, but showing the address first could
    // strand an irreversible payment before that guard gets a chance to run.
    assertTrancheFundingAddressAllowed(state);
    // A normal trade collects keys through CREATE/JOIN (`escrowKeys`). A
    // private tranche child is pre-seated from the signed parent snapshot, so
    // its participants publish CHILD_KEY events instead (`childKeys`). Both
    // are reducer-verified role maps and feed the exact same address builder.
    const keys = state.trancheChild ? (state.childKeys ?? {}) : (state.escrowKeys ?? {});

    // ⭐ An AUTO-SEATED arbiter never publishes a JOIN, so they never publish an
    // escrow key — and without it the address can never be computed and the
    // trade waits forever. Their BOND key is already public, already
    // chain-verified, and already something they can sign with, so it stands in.
    // Consequence, stated plainly: an on-chain escrow requires a BONDED arbiter.
    // That is a reasonable bar for a 100k+ trade and matches the bond's role
    // everywhere else as the licence to arbitrate.
    let arbiterXonly = keys[Role.ARBITER] ?? null;
    const seatedArbiter = state.participants[Role.ARBITER];
    if (!state.trancheChild && !arbiterXonly && seatedArbiter && state.community) {
      const cached = readCachedCommunityBonds(state.community) ?? [];
      const theirs = cached.find(
        (b) => b.npub.toLowerCase() === seatedArbiter.toLowerCase() && b.funded && b.active,
      );
      arbiterXonly = theirs?.ownerXonly ?? null;
    }

    return resolveFundingPlan({
      buyerXonly: keys[Role.BUYER] ?? null,
      sellerXonly: keys[Role.SELLER] ?? null,
      arbiterXonly,
      funder: state.category === "marketplace" ? "buyer" : "seller",
      refundLockUntil: state.lock.onchain?.refundLockUntil
        ?? (onchainRefundHeightRef.current || 0),
      disputeCsvBlocks: DISPUTE_CSV_BLOCKS,
      network: ESCROW_NETWORK,
    });
  }, []);

  /** Ask the chain whether the escrow is funded, at OUR recomputed address. */
  const checkOnchainFunding = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Escrow not loaded");
    const plan = onchainFundingPlan(escrowId);
    if (!plan.ready) return { plan, verdict: null as null | ReturnType<typeof verifyFunding> };
    const fetchJson = esploraFetcher(defaultEsploraBase(ESCROW_NETWORK), { network: ESCROW_NETWORK });
    const found = await findBondFundingUtxos({
      address: plan.address,
      fetchJson,
      minConfs: defaultMinConfs(ESCROW_NETWORK),
    });
    const verdict = verifyFunding({
      utxos: found.map((f) => f.utxo),
      expectedSats: BigInt(Math.floor(state.amountMsats / 1000)),
      minConfs: defaultMinConfs(ESCROW_NETWORK),
    });
    return { plan, verdict };
  }, [onchainFundingPlan]);

  /** Publish the on-chain LOCK once the deposit is confirmed.
   *
   *  ⚠ Re-verifies the funding itself rather than trusting a caller's "it's
   *  funded" — a LOCK published against an unfunded address tells a counterparty
   *  their money is safe when it is not, which is the worst lie this system can
   *  tell. */
  const publishOnchainLock = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Escrow not loaded");
    if ((state.escrowMode ?? "ecash") !== "onchain") {
      throw new Error("This trade is not an on-chain escrow.");
    }
    const { plan, verdict } = await checkOnchainFunding(escrowId);
    if (!plan.ready) throw new Error("The escrow address isn't ready — a key is still missing.");
    if (!verdict?.funded) {
      throw new Error(
        verdict?.reason === "underfunded"
          ? `The escrow holds ${verdict.amountSats} sats, less than the trade's ${verdict.expectedSats}.`
          : verdict?.reason === "unconfirmed"
            ? "The deposit is still confirming."
            : "No confirmed deposit at the escrow address yet.",
      );
    }
    const terms = buildOnchainLockTerms(plan, verdict, ESCROW_NETWORK_LABEL);
    const buyerPubkey = state.participants[Role.BUYER];
    const arbiterPubkey = state.participants[Role.ARBITER];
    if (!buyerPubkey || !arbiterPubkey) throw new Error("Buyer and arbiter must both have joined.");
    return client.lockEscrow(escrowId, {
      notesHash: "",
      shares: [],
      onchain: terms,
      sellerReceivesMsats: state.amountMsats - state.fees.arbiterMsats,
      arbiterFeeMsats: state.fees.arbiterMsats,
      buyerPubkey,
      arbiterPubkey,
    });
  }, [checkOnchainFunding]);

  /** Recompute every security-sensitive settlement input locally. */
  const onchainSettlementContext = useCallback(async (escrowId: string, leaf: "coop" | "dispute" = "coop") => {
    const client = requireClient();
    const trade = client.getState(escrowId);
    if (!trade?.lock.onchain) throw new Error("This trade has no on-chain lock terms.");
    if (trade.status !== EscrowStatus.APPROVED && trade.status !== EscrowStatus.CLAIMED
      && trade.status !== EscrowStatus.COMPLETED) {
      throw new Error("Settlement is available only after the outcome is approved.");
    }
    const t = trade.lock.onchain;
    const escrow = buildOnchainEscrow({
      buyerXonly: hexToBytes(t.buyerXonly), sellerXonly: hexToBytes(t.sellerXonly),
      arbiterXonly: hexToBytes(t.arbiterXonly), funder: t.funder,
      refundLockUntil: t.refundLockUntil, disputeCsvBlocks: t.disputeCsvBlocks,
      network: ESCROW_NETWORK,
    });
    if (escrow.address !== t.address) throw new Error("On-chain lock address failed local recomputation.");
    const winner = getWinner(trade);
    if (!winner) throw new Error("No approved payout winner.");
    const winnerXonly = winner.role === Role.BUYER ? t.buyerXonly : t.sellerXonly;
    const destination = btcSigner.p2tr(hexToBytes(winnerXonly), undefined, ESCROW_NETWORK).address!;
    const fetchJson = esploraFetcher(defaultEsploraBase(ESCROW_NETWORK), { network: ESCROW_NETWORK });
    const found = await findBondFundingUtxos({
      address: escrow.address, fetchJson, minConfs: defaultMinConfs(ESCROW_NETWORK),
    });
    const utxos = found.map(f => f.utxo);
    if (utxos.length === 0) throw new Error("No confirmed escrow outputs are available to settle.");
    const feeRate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: 2n });
    let fundingHeight: number | undefined;
    let tipHeight: number | undefined;
    if (leaf === "dispute") {
      if (found.some(f => typeof f.blockHeight !== "number")) {
        throw new Error("The dispute window cannot be verified because a funding height is unknown.");
      }
      fundingHeight = Math.max(...found.map(f => f.blockHeight!));
      tipHeight = await esploraTipHeight(fetchJson);
      const window = disputeWindow({ fundingHeight, tipHeight, csvBlocks: t.disputeCsvBlocks });
      if (!window.open) throw new Error(`The appeal window is still open — arbitration unlocks in ${window.blocksRemaining} block(s).`);
    }
    return {
      client, trade, escrow, utxos, destination,
      fundingHeight, tipHeight, leaf,
      base: defaultEsploraBase(ESCROW_NETWORK), fetchJson,
      feeSats: settlementBuildFeeSats(feeRate, utxos.length, leaf),
      expectation: {
        escrow, utxos, destination,
        maxFeeSats: settlementFeeCeilingSats(leaf, feeRate, utxos.length),
        network: ESCROW_NETWORK, leaf,
      },
    };
  }, []);

  const prepareOnchainSettlement = useCallback(async (escrowId: string) => {
    const initial = requireClient().getState(escrowId);
    const arbitrated = !!initial?.resolvedMajority?.includes(Role.ARBITER);
    const leaf = arbitrated ? "dispute" : "coop";
    const wireLeaf = arbitrated ? "arbiter" : "coop";
    const ctx = await onchainSettlementContext(escrowId, leaf);
    const winner = getWinner(ctx.trade);
    let psbt = (arbitrated
      ? selectVerifiedArbiterSettlement(ctx.trade.settlements ?? [], ctx.expectation)
      : selectVerifiedCoopSettlement(ctx.trade.settlements ?? [], ctx.expectation)) ?? undefined;
    if (!psbt) {
      psbt = buildSettlementPsbt({
        escrow: ctx.escrow, utxos: ctx.utxos, destination: ctx.destination,
        feeSats: ctx.feeSats, leaf,
        fundingHeight: ctx.fundingHeight, tipHeight: ctx.tipHeight,
      });
      const pubkey = await ctx.client.getPubkey();
      const role = Object.values(Role).find(r => ctx.trade.participants[r] === pubkey);
      const eligible = arbitrated
        ? role === Role.ARBITER || role === winner?.role
        : role === Role.BUYER || role === Role.SELLER;
      if (!eligible || !role) {
        throw new Error(arbitrated
          ? "Only the resolved winner or assigned arbiter can build arbitration settlement."
          : "Only buyer or seller can build cooperative settlement.");
      }
      await ctx.client.sendSettlement(escrowId, { psbt, leaf: wireLeaf, role });
    }
    const pubkey = await ctx.client.getPubkey();
    const myRole = Object.values(Role).find(r => ctx.trade.participants[r] === pubkey);
    const signedByMe = (myRole === Role.BUYER || myRole === Role.SELLER || myRole === Role.ARBITER)
      && hasValidSettlementSignatureForRole(
        psbt,
        ctx.escrow,
        myRole,
        arbitrated ? "dispute" : "coop",
      );
    return { psbt, check: verifySettlementPsbt(psbt, ctx.expectation), signedByMe };
  }, [onchainSettlementContext]);

  const finalizeOnchainSettlement = useCallback(async (escrowId: string) => {
    // Recovery must run before UTXO discovery: after a successful broadcast the
    // address/utxo endpoint is empty, which is exactly the crash window S7c
    // needs to heal. Recompute the lock address, then probe its committed
    // funding outpoint directly.
    const recoveryClient = requireClient();
    const recoveryTrade = recoveryClient.getState(escrowId);
    const recoveryTerms = recoveryTrade?.lock.onchain;
    if (!recoveryTrade || !recoveryTerms) throw new Error("This trade has no on-chain lock terms.");
    const recoveryEscrow = buildOnchainEscrow({
      buyerXonly: hexToBytes(recoveryTerms.buyerXonly),
      sellerXonly: hexToBytes(recoveryTerms.sellerXonly),
      arbiterXonly: hexToBytes(recoveryTerms.arbiterXonly),
      funder: recoveryTerms.funder,
      refundLockUntil: recoveryTerms.refundLockUntil,
      disputeCsvBlocks: recoveryTerms.disputeCsvBlocks,
      network: ESCROW_NETWORK,
    });
    if (recoveryEscrow.address !== recoveryTerms.address) {
      throw new Error("On-chain lock address failed local recomputation.");
    }
    const recoveryFetch = esploraFetcher(defaultEsploraBase(ESCROW_NETWORK), { network: ESCROW_NETWORK });
    const recoveryWinner = getWinner(recoveryTrade);
    const recoveryWinnerRole = recoveryWinner?.role === Role.BUYER || recoveryWinner?.role === Role.SELLER
      ? recoveryWinner.role
      : null;
    const arbitrated = !!recoveryTrade.resolvedMajority?.includes(Role.ARBITER);
    const recoveryProof = recoveryWinnerRole
      ? [...(recoveryTrade.settlements ?? [])].reverse().map(message => ({
          message,
          proof: arbitrated
            ? finalArbiterSettlementProof(message, recoveryTerms, recoveryWinnerRole)
            : finalCoopSettlementProof(message, recoveryTerms, recoveryWinnerRole),
        })).find(candidate => candidate.proof !== null)
      : undefined;
    const committedOutspend = await esploraOutspend(
      recoveryFetch, recoveryTerms.fundingTxid, recoveryTerms.fundingVout,
    );
    if (committedOutspend.spent) {
      if (!committedOutspend.txid) throw new Error("Esplora reported a spent escrow output without its transaction id.");
      if (!recoveryProof?.proof || recoveryProof.proof.txid !== committedOutspend.txid) {
        throw new Error("The committed escrow output was spent by a transaction that does not match the final settlement journal.");
      }
      const expectedOutspends = await Promise.all(recoveryProof.proof.inputs.map(input =>
        esploraOutspend(recoveryFetch, input.txid, input.index),
      ));
      if (!adoptedExpectedSettlementTxid(recoveryProof.proof.txid, expectedOutspends)) {
        throw new Error("The final settlement did not coherently sweep every journaled escrow input.");
      }
      if (recoveryTrade.status === EscrowStatus.APPROVED) {
        await recoveryClient.completeOnchain(escrowId, recoveryProof.message.raw.id);
      }
      return { status: "adopted" as const, txid: committedOutspend.txid };
    }

    const ctx = await onchainSettlementContext(escrowId, arbitrated ? "dispute" : "coop");
    const readOutspends = () => Promise.all(
      ctx.utxos.map(utxo => esploraOutspend(ctx.fetchJson, utxo.txid, utxo.index)),
    );
    const adoptObservedSpend = async (expectedTxid?: string, proofEventId?: string) => {
      const outspends = await readOutspends();
      const txid = adoptedSettlementTxid(outspends);
      if (!txid && outspends.some(out => out.spent)) {
        throw new Error("Escrow outputs show a partial or conflicting spend; settlement completion is refused.");
      }
      if (!txid) return null;
      if (!expectedTxid || !proofEventId || !adoptedExpectedSettlementTxid(expectedTxid, outspends)) {
        throw new Error("Observed escrow spend does not match the final settlement transaction.");
      }
      if (ctx.trade.status === EscrowStatus.APPROVED) {
        await ctx.client.completeOnchain(escrowId, proofEventId);
      }
      return txid;
    };

    const currentProof = recoveryProof?.proof ?? null;
    const adopted = await adoptObservedSpend(currentProof?.txid, recoveryProof?.message.raw.id);
    if (adopted) return { status: "adopted" as const, txid: adopted };

    const finalizable = arbitrated
      ? finalizableArbiterSettlement(ctx.trade.settlements ?? [], ctx.expectation, ctx.escrow, recoveryWinnerRole!)
      : finalizableCoopSettlement(ctx.trade.settlements ?? [], ctx.expectation);
    if (!finalizable) return { status: "waiting" as const };
    const pubkey = await ctx.client.getPubkey();
    const role = Object.values(Role).find(r => ctx.trade.participants[r] === pubkey);
    const eligible = arbitrated
      ? role === Role.ARBITER || role === recoveryWinnerRole
      : role === Role.BUYER || role === Role.SELLER;
    if (!eligible || !role) {
      throw new Error(arbitrated
        ? "Only the resolved winner or assigned arbiter can finalize arbitration settlement."
        : "Only buyer or seller can finalize cooperative settlement.");
    }
    const finalId = settlementUnsignedId(finalizable.psbt);
    let proofEventId = recoveryProof?.proof?.txid === finalId
      ? recoveryProof.message.raw.id
      : null;
    if (!proofEventId) {
      const publishedProof = await ctx.client.sendSettlement(escrowId, {
        psbt: finalizable.psbt, leaf: arbitrated ? "arbiter" : "coop", role, final: true,
      });
      proofEventId = publishedProof.raw.id;
    }
    let txid: string;
    try {
      txid = await esploraBroadcast(ctx.base, finalizable.rawTx);
    } catch (error) {
      const recovered = await adoptObservedSpend(finalId, proofEventId);
      if (!recovered) throw error;
      return { status: "adopted" as const, txid: recovered };
    }
    await ctx.client.completeOnchain(escrowId, proofEventId);
    return { status: "broadcast" as const, txid };
  }, [onchainSettlementContext]);

  const signOnchainSettlement = useCallback(async (escrowId: string) => {
    const initial = requireClient().getState(escrowId);
    const arbitrated = !!initial?.resolvedMajority?.includes(Role.ARBITER);
    // Re-fetch the tip and re-run disputeWindow immediately before signing.
    // A checklist rendered earlier is never authority for a CSV spend.
    const ctx = await onchainSettlementContext(escrowId, arbitrated ? "dispute" : "coop");
    const prepared = await prepareOnchainSettlement(escrowId);
    if (!prepared.check.ok) {
      throw new Error(`Settlement verification failed: ${prepared.check.failures.join("; ")}`);
    }
    const pubkey = await ctx.client.getPubkey();
    const role = Object.values(Role).find(r => ctx.trade.participants[r] === pubkey);
    const winner = getWinner(ctx.trade);
    const eligible = arbitrated
      ? role === Role.ARBITER || role === winner?.role
      : role === Role.BUYER || role === Role.SELLER;
    if (!eligible || !role) {
      throw new Error(arbitrated
        ? "Only the resolved winner or assigned arbiter can sign arbitration settlement."
        : "Only buyer or seller can sign cooperative settlement.");
    }
    if (prepared.signedByMe) {
      throw new Error("You already signed this settlement. Waiting for the other signer.");
    }
    const key = await myEscrowKey(escrowId);
    if (!signingKeyMatchesRole(key.xonly, role, ctx.trade.lock.onchain!)) {
      throw new Error("This device's derived escrow key does not match the key committed for your role.");
    }
    const signedPsbt = coSignSettlement(prepared.psbt, key.priv);
    // Verify the exact revision again after signing; signatures must not be
    // allowed to smuggle a different transaction through the UI gate.
    const check = verifySettlementPsbt(signedPsbt, ctx.expectation);
    if (!check.ok) throw new Error(`Signed settlement failed verification: ${check.failures.join("; ")}`);
    await ctx.client.sendSettlement(escrowId, { psbt: signedPsbt, leaf: arbitrated ? "arbiter" : "coop", role });
    await finalizeOnchainSettlement(escrowId);
    return { psbt: signedPsbt, check };
  }, [finalizeOnchainSettlement, myEscrowKey, onchainSettlementContext, prepareOnchainSettlement]);

  const scanMyOnchainPayouts = useCallback(async () => {
    const current = stateRef.current;
    const pubkey = current?.pubkey;
    if (!pubkey) throw new Error("Reconnect to check your on-chain balance.");
    const candidates = payoutCandidatesFor([...(current?.escrows.values() ?? [])], pubkey);
    const payouts = await Promise.all(candidates.map(candidate => {
      const fetchJson = esploraFetcher(defaultEsploraBase(candidate.network), { network: candidate.network });
      return scanOnchainPayout(candidate, fetchJson);
    }));
    return { payouts, balanceSats: aggregateOnchainPayoutBalance(payouts) };
  }, []);

  const sweepOnchainPayout = useCallback(async (escrowId: string, destination: string) => {
    const current = stateRef.current;
    const pubkey = current?.pubkey;
    const trade = current?.escrows.get(escrowId);
    const client = requireClient();
    const signer = signerRef.current;
    if (!pubkey || !trade || !signer) throw new Error("Reconnect to recover this on-chain payout.");
    const words = await getOrCreateSeed(client, signer);
    const mnemonic = Array.isArray(words) ? words.join(" ") : String(words);
    const network = trade.lock.onchain?.network === "mainnet" ? (btcSigner.NETWORK as typeof ESCROW_NETWORK) : ESCROW_NETWORK;
    const base = defaultEsploraBase(network);
    const fetchJson = esploraFetcher(base, { network });
    const feeRate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: 2n });
    const built = await buildOnchainPayoutSweep({
      state: trade, viewerPubkey: pubkey, mnemonic, destination,
      fetchJson, feeRateSatsPerVb: feeRate,
    });
    const txid = await esploraBroadcast(base, built.rawTx);
    // Tranche progression requires local proof that the winner received this
    // slice. A successful sweep spends the confirmed, seed-controlled winner
    // output and is the on-chain analogue of observed ecash wallet growth.
    // Record it only after broadcast accepts the signed transaction.
    recordClaimCredit(escrowId, trade.amountMsats);
    return { txid, sentSats: built.sendSats, feeSats: built.feeSats };
  }, []);

  // ── Tranching: publish the next slice, but only if it is safe to ──────────
  // The gate (escrow-engine/tranche.ts) is re-evaluated HERE, not trusted from
  // the UI: a stale render, a mis-wired prop, or a user tapping twice must not
  // be able to start the next tranche while the previous one is live or
  // unproven. The UI's copy of the gate is for showing; this one is for doing.
  /** The plan's whole fiat price. Slice 0 carries its own share, so scale it
   *  back up by the plan's slice count rather than trusting any single slice. */
  const planTotalFiat = (tranches: readonly EscrowState[], prior: EscrowState): number | undefined => {
    const first = tranches.find((s) => s.tranche?.index === 0) ?? prior;
    if (typeof first.fiatAmount !== "number" || !first.tranche) return undefined;
    return Number((first.fiatAmount * first.tranche.total).toFixed(2));
  };

  const startNextTranche = useCallback(async (fromEscrowId: string) => {
    const client = requireClient();
    const prior = client.getState(fromEscrowId);
    if (!prior?.tranche) throw new Error("This trade isn't part of a tranche plan.");

    const all = [...client.getAllStates().values()];
    const gate = trancheGate({
      planId: prior.tranche.planId,
      total: prior.tranche.total,
      states: all,
      creditObserved: defaultCreditObserver(),
    });
    if (!gate.canProceed || gate.nextIndex === null) {
      throw new Error(
        gate.stopped
          ? "This plan stopped — the last slice didn't settle. Check it before sending anything else."
          : "The current slice is still in flight. Wait for it to settle before starting the next one.",
      );
    }

    const priorTranches = tranchesForPlan(prior.tranche.planId, all);
    const params = buildNextTrancheParams(
      prior, gate.nextIndex, priorTranches,
      (s) => buildRenewCreateParams(s) as unknown as Record<string, unknown>,
      // The PLAN's fiat, recovered from slice 0 — a later slice's own fiat
      // would be re-divided on every hop until it disappeared.
      planTotalFiat(priorTranches, prior),
    );
    if (!params) throw new Error("Couldn't build the next slice of this plan.");
    return createEscrow(params as Parameters<EscrowClient["createEscrow"]>[0]);
  }, [createEscrow]);

  // ── A3: edit a listing = replace it ───────────────────────────────────────
  // Publish the new terms, then retire + cancel the old. Create-then-cancel is
  // deliberate: a failed CANCEL leaves a duplicate the seller can delete (and
  // which lapses on its own within ~24h, since it is retired locally and will
  // never auto-renew), whereas a failed CREATE after a successful CANCEL would
  // leave them with no storefront at all.
  const editListing = useCallback(async (escrowId: string, edits: ListingEdits) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Listing not found — reload it first.");
    const userPubkey = stateRef.current?.pubkey ?? null;
    const nowSec = Math.floor(Date.now() / 1000);

    const check = canEditListing(state, userPubkey, nowSec);
    if (!check.ok) {
      throw new Error(
        check.reason === "buyer-holding"
          ? "A buyer is holding this offer right now. Wait a few minutes for their hold to lapse, then edit."
          : check.reason === "already-funded"
            ? "This trade is already funded — its terms are what the buyer locked to and can't change."
            : check.reason === "not-owner"
              ? "Only the seller can edit this listing."
              : "This can't be edited — only your own live, unfunded listings.",
      );
    }
    if (!editsAreMeaningful(state, edits)) {
      throw new Error("Nothing changed.");
    }

    const params = buildEditCreateParams(state, edits);
    const created = await createEscrow(params as Parameters<EscrowClient["createEscrow"]>[0]);

    // Retire locally FIRST so the old listing leaves this seller's own surfaces
    // (and can never be auto-renewed) even if the CANCEL publish fails.
    retireListing(escrowId);
    let oldCancelled = false;
    try {
      await client.cancel(escrowId, "seller_edited_listing");
      oldCancelled = true;
    } catch (e) {
      console.warn("[chama] edit: the replacement published but cancelling the old listing failed:", e);
    }
    return { ...created, oldCancelled };
  }, [createEscrow]);

  // ── Store permanence (#49) Tier 1: renew a lapsed-unfunded listing ─────────
  // Re-publish an IDENTICAL CREATE (fresh 24h window) for a listing that lapsed
  // WITHOUT ever being funded. Only the seller's own listing, only when it was
  // never LOCKED (canRenewListing gates all of this). Moves no sats — it's just
  // re-listing a browse offer (Option B: renewal re-publishes, never transfers).
  // Reuses `createEscrow` so fed tags, the expiry override, and the saved
  // pointer all apply exactly as a fresh publish — the renewed store keeps the
  // same short trade timeout (permanence via renewal, never via longer locks).
  const renewListing = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Listing not found — reload it first.");
    const userPubkey = stateRef.current?.pubkey ?? null;
    // A2: the MANUAL path, so it must not consult the bond — an unbonded
    // storefront has always been allowed to re-list by hand, and that is the
    // entire point of the unbonded tier.
    if (!canManuallyRenewListing(state, userPubkey, Math.floor(Date.now() / 1000))) {
      throw new Error("This listing can't be renewed — only your own lapsed, unfunded listings.");
    }
    const params = buildRenewCreateParams(state);
    return createEscrow(params as Parameters<EscrowClient["createEscrow"]>[0]);
  }, [createEscrow]);

  // Monthly CBP recurrence: re-publish an identical CREATE for the caller's OWN
  // bill-pay listing on the ~monthly cadence. Reuses buildRenewCreateParams (so
  // the re-post inherits the listing's community = the owner's HOME, never fans
  // out) but — unlike renewListing — does NOT require the prior instance to be
  // unfunded: a monthly bill that WAS paid last month must still re-post this
  // month. Bill-pay only; NO bond gate (CBP is self-limiting). Moves no sats.
  const repostRecurringCbp = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const state = client.getState(escrowId);
    if (!state) throw new Error("Listing not found — reload it first.");
    if (state.category !== "bill-pay") {
      throw new Error("Recurrence only applies to Community Bill Pay listings.");
    }
    const userPubkey = stateRef.current?.pubkey ?? null;
    if (!isSellerOwnedListing(state, userPubkey)) {
      throw new Error("Only your own bill can be re-posted.");
    }
    const params = buildRenewCreateParams(state);
    return createEscrow(params as Parameters<EscrowClient["createEscrow"]>[0]);
  }, [createEscrow]);

  /** Forget a trade locally: drop its saved pointer and hide it from the
   *  in-memory list. For unrecoverable "ghost" trades the user wants out of
   *  their view. Non-custodial-safe — money lives in 2-of-3 escrow regardless,
   *  and the trade can always be re-loaded by ID, which re-saves the pointer. */
  const forgetEscrow = useCallback((escrowId: string) => {
    const pk = stateRef.current?.pubkey ?? null;
    removeEscrowId(escrowId, pk);
    // Persistently deny-list it so the Browse feed can't re-add it on the next
    // restart; updateEscrow honors this (via the in-memory ref). Cleared when
    // the user loads it by ID.
    addForgottenEscrowId(escrowId, pk);
    forgottenIdsRef.current.add(escrowId);
    // Forgetting a ghost also drops it from the durable history index — the
    // user explicitly doesn't want it back (loading by ID re-indexes it).
    try { removeTradeFromIndex(escrowId); } catch {}
    // Stop watching it too, so a late relay event can't silently re-add a
    // ghost the user just dismissed. Re-loading by ID re-subscribes.
    clientRef.current?.unwatchEscrow(escrowId);
    setState(prev => {
      if (!prev.escrows.has(escrowId)) return prev;
      const next = new Map(prev.escrows);
      next.delete(escrowId);
      return { ...prev, escrows: next };
    });
  }, []);

  const fetchNostrProfiles = useCallback(async (pubkeys: string[]): Promise<NostrProfileNameMap> => {
    const client = clientRef.current;
    if (!client) return {};

    const authors = Array.from(new Set(
      pubkeys
        .map(pk => pk.trim().toLowerCase())
        .filter(pk => /^[0-9a-f]{64}$/.test(pk)),
    ));
    if (authors.length === 0) return {};

    const events = await client.queryOnce(
      { kinds: [0], authors, limit: Math.max(1, authors.length * 2) },
      3_000,
    );

    const profiles: NostrProfileNameMap = {};
    const newestFirst = [...events].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    for (const event of newestFirst) {
      const author = event.pubkey?.toLowerCase();
      if (!author || profiles[author]) continue;
      const name = extractNostrProfileName(event.content ?? "");
      if (name) profiles[author] = name;
    }

    return profiles;
  }, []);

  // ── Fedimint actions ────────────────────────────────────────────────────

  const refreshBalance = useCallback(async () => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) return;
    try {
      const balanceMsats = await fedimint.getBalance();
      updateFedimint({ balanceMsats });
    } catch (e) {
      console.debug("[chama] refreshBalance error:", e);
    }
  }, [updateFedimint]);

  const readBalance = useCallback(async (): Promise<number> => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) {
      return stateRef.current?.fedimint.balanceMsats ?? 0;
    }
    const balanceMsats = await fedimint.getBalance();
    updateFedimint({ balanceMsats });
    return balanceMsats;
  }, [updateFedimint]);

  // Keep the ref in sync so lock/claim actions can call it without
  // recreating their callbacks.
  refreshBalanceRef.current = refreshBalance;

  const markFedimintWalletNotReady = useCallback((message = FEDIMINT_WALLET_NOT_READY) => {
    const at = Date.now();
    healthRef.current = { ok: false, at };
    updateFedimint({
      initialized: false,
      joined: false,
      busy: false,
      error: message,
      lastHealthOk: false,
      lastHealthAt: at,
      bootProbeState: "failed",
    });
  }, [updateFedimint]);

  const initFedimint = useCallback(async (
    inviteCode?: string,
    options?: { force?: boolean; persistCustom?: boolean },
  ) => {
    if (!clientRef.current || !signerRef.current) {
      // Tag so the auto-init re-arm and the UI can distinguish a transient
      // handshake/session-restore window (retry) from a true signed-out state.
      const err: any = new Error("Connect to relays before initializing Fedimint");
      err.code = !clientRef.current
        ? (stateRef.current?.loading ? "RELAYS_CONNECTING" : "NOT_CONNECTED")
        : "SIGNER_NOT_READY";
      throw err;
    }

    const force = options?.force === true;
    const persistCustom = options?.persistCustom !== false;

    updateFedimint({ busy: true, error: null });

    try {
      // PR 2: resolve via the community-aware path. Precedence is
      // explicit arg > custom stored invite > community.federationInvite
      // > BLF default.
      const userCommunity = getUserCommunitySlug();
      const explicitInvite = inviteCode?.trim() || "";
      const communityInvite = getCommunityBySlug(userCommunity)?.federationInvite ?? null;
      const desiredInvite = explicitInvite
        || resolveFederationForCommunity(userCommunity);
      const previousActiveInvite = getActiveInvite();

      // Wait for at least one relay to actually accept publishes before
      // running the seed round-trip. `state.connected` flips true
      // synchronously when client.connect() is dispatched, but the
      // relay WebSocket handshakes happen async — racing this gate
      // sends getOrCreateSeed's publishRaw into "No connected relays —
      // cannot publish" on first-launch (no seed marker) users. Match
      // the saved-escrow-reload pattern (line ~671): bounded wait, ≥1
      // relay is enough since seed publish goes to all of them.
      if (!isTestnetMode() && !isSimModeOn()) {
        const client: any = clientRef.current;
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...client.relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 1) break;
          await new Promise(r => setTimeout(r, 250));
          waited += 250;
        }
      }

      // Fetch (or generate + publish) the Fedimint seed from Nostr
      // *before* initializing the wallet. The seed is encrypted to the
      // user's own pubkey and stored as a replaceable kind-30078 event,
      // so the wallet is recoverable on any device with access to the
      // user's signer. In testnet/sim mode the mock wallets ignore the
      // mnemonic, so we skip the Nostr round-trip.
      const skipMnemonic = isTestnetMode() || isSimModeOn();
      // Native/remote-bridge mode holds its OWN seed in the bridge's own database
      // and DISCARDS any mnemonic we pass (the wallet factory ignores it), so the
      // Nostr kind-30078 seed round-trip is dead weight there. Worse: on a degraded
      // mobile relay pool (the APK's on-device bridge competes for network) its
      // false-empty result trips the scary "couldn't reach your seed" fund-safety
      // refusal for a seed the bridge never uses. Skip the fetch in bridge mode too
      // (result unused) — but DO NOT fold this into skipMnemonic, which also drives
      // storageScope below; keep storage scoping exactly as it was.
      const skipSeedFetch = skipMnemonic || isNativeBridgeModeOn();
      // Browser only: overlap the large Fedimint core/transport imports with
      // Nostr seed recovery. Both are required before wallet construction,
      // but neither depends on the other; doing them serially made the first
      // trip to a federation needlessly longer on cold caches.
      const runtimeWarmup = !skipMnemonic && !isNativeBridgeModeOn()
        ? preloadRealWalletRuntime()
        : Promise.resolve(null);
      const mnemonic = skipSeedFetch
        ? undefined
        : await getOrCreateSeed(clientRef.current!, signerRef.current!);
      await runtimeWarmup;
      // Sim wallet keys its persisted state by npub so multiple
      // identities in the same browser don't share a sim balance.
      const activePubkey = await signerRef.current!.getPublicKey().catch(() => null);
      const simNpub = isSimModeOn()
        ? activePubkey
        : null;
      const bondedArbiter = listCommitmentBonds().some((bond) => bond.phase === "locked");
      const desiredFederationId = expectedFederationIdForInvite(desiredInvite);
      const rememberedArbiterRoute = bondedArbiter && activePubkey && desiredFederationId
        ? getArbiterFederationRoute(activePubkey, desiredFederationId)
        : null;
      // Browser arbiters reopen the OPFS file assigned to this federation.
      // Native shells select their isolated database through the bridge, so
      // storageScope remains informational there.
      const storageScope = !skipMnemonic
        ? (rememberedArbiterRoute?.storageScope ?? activePubkey)
        : null;

      const buildClient = () => new FedimintClient({
        onBalanceUpdate: (balance) => updateFedimint({ balanceMsats: balance }),
        onFederationJoined: (fedId) =>
          updateFedimint({ joined: true, federationId: fedId }),
        onError: (err, ctx) => {
          console.warn(`[chama] fedimint error (${ctx}):`, err);
          updateFedimint({ error: `${ctx}: ${err.message}` });
        },
      });

      // Reuse the in-memory client if init already ran this session;
      // otherwise create + init a fresh one against whatever the OPFS
      // currently holds.
      let fedimint = fedimintRef.current;
      if (fedimint && !fedimint.isInitialized()) {
        fedimintRef.current = null;
        bridgeRef.current = null;
        fedimint = null;
      }
      if (!fedimint) {
        fedimint = buildClient();
        await fedimint.init({ mnemonic, storageScope, simNpub });
        fedimintRef.current = fedimint;
        updateFedimint({ initialized: true });
      }

      // PR 5 (v0.1.82+): cold-start reconciliation with balance guard.
      // ───────────────────────────────────────────────────────────────
      // After init, the in-memory client mirrors whatever the OPFS
      // holds. If the user's preferred invite differs from the
      // last-joined invite (drift — typically from a previous-session
      // paste that the old "case (b) silent no-op" stored without
      // actually switching), we may need to wipe + rejoin.
      //
      // CRITICAL: ecash on the OPFS-bound fed is bearer cash. A silent
      // wipe destroys it. So before wiping, peek the balance:
      //   - no Lightning-withdrawable balance → safe to wipe + rejoin
      //                                        silently. Tiny dust cannot
      //                                        be recovered through the UI.
      //   - withdrawable balance && !force    → REFUSE; throw structured
      //                                        error that the UI catches and
      //                                        surfaces as a destroy-confirm
      //                                        modal.
      //   - withdrawable balance && force     → user-confirmed destruction;
      //                                        proceed.
      //
      // This is the load-bearing safety. Without it, a refresh + wrong
      // fed pick destroys notes purely and simply (reproduced twice
      // during v0.1.81 testing).
      const walletIsJoined = fedimint.isJoined();
      const walletFederationId = fedimint.getFederationId();
      // v3.4.x sim-mode fix: the sim wallet exposes a single synthetic
      // federation id (SIM_FEDERATION_ID) that never equals the real
      // community invite's expected fed id, so shouldReconcileFederation()
      // returns true on every re-init — driving a perpetual wipe→rejoin
      // churn that leaves fedimint.joined flapping false (ChamaBar stuck on
      // "Reconnect", Browse stuck on "reconnect to see what's trading").
      // Sim has no real bearer ecash to protect, so the reconcile/fund-loss
      // guard is meaningless here; bypass it like probeReachable() and the
      // wallet factory already do. Real mode is unaffected.
      let driftDetected = !isSimModeOn() && shouldReconcileFederation({
        previousActiveInvite,
        desiredInvite,
        walletIsJoined,
        walletFederationId,
      });

      // A native bonded arbiter may boot with the legacy (first) database
      // active even though their selected community belongs to another saved
      // federation. Select the desired database before the destructive drift
      // reconciliation path gets a chance to run.
      if (driftDetected && bondedArbiter && isNativeBridgeModeOn()) {
        await fedimint.switchFederationPreserving(desiredInvite);
        driftDetected = false;
      }
      if ((import.meta as any).env?.DEV) {
        console.info("[chama] initFedimint route", {
          userCommunity,
          explicitInvite: explicitInvite ? explicitInvite.slice(0, 24) + "…" : null,
          communityInvite: communityInvite ? communityInvite.slice(0, 24) + "…" : null,
          desiredInvite: desiredInvite.slice(0, 24) + "…",
          previousActiveInvite: previousActiveInvite ? previousActiveInvite.slice(0, 24) + "…" : null,
          walletIsJoined,
          walletFederationId,
          driftDetected,
        });
      }

      if (driftDetected) {
        if (bondedArbiter) {
          const err = new Error(
            "This arbiter federation has no preserved storage route. Chama refused to reset any arbiter ecash. Re-select the federation to repair the route.",
          );
          (err as Error & { code?: string }).code = "ARBITER_FEDERATION_ROUTE_MISSING";
          throw err;
        }
        const fundingSignal = fundingInProgressRef.current;
        const fundingInFlight = !!fundingSignal && !fundingSignal.aborted;
        if (fundingInFlight || claimPayoutInProgressRef.current) {
          const err = new Error(
            fundingInFlight
              ? "Refusing to switch federations while a funding operation is in progress."
              : "Refusing to switch federations while a claim payout is in progress.",
          );
          (err as Error & { code?: string }).code = "RECONCILE_REFUSED_MONEY_FLOW_IN_PROGRESS";
          throw err;
        }

        let opfsBalanceMsats = 0;
        try {
          opfsBalanceMsats = await fedimint.getBalance();
        } catch (e) {
          // If we can't read the balance, treat as unknown — refuse
          // without force rather than risk silent destruction.
          console.debug("[chama] reconcile: balance read failed:", e);
          opfsBalanceMsats = -1;
        }

        const balanceUnknown = opfsBalanceMsats < 0;
        // Material dust line: only a recoverable-worth balance blocks the switch
        // (same predicate the UI decision + modal use). Sub-material dust — e.g.
        // ~1 sat that costs more than itself to recover — switches silently.
        const balanceWithdrawable = balanceBlocksFederationSwitch(opfsBalanceMsats);
        if (!force && (balanceUnknown || balanceWithdrawable)) {
          const sats = opfsBalanceMsats > 0
            ? Math.floor(opfsBalanceMsats / 1000)
            : null;
          const refuseErr = new Error(
            sats !== null
              ? `Refusing to switch federations: ${sats} sats are held on ` +
                `your current federation and would be permanently destroyed ` +
                `when the local wallet is wiped. Move funds out (Lightning ` +
                `withdrawal) before switching, or confirm destruction explicitly.`
              : `Refusing to switch federations: couldn't verify the local ` +
                `wallet balance. Try again, or confirm destruction explicitly.`,
          );
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).code = "RECONCILE_REFUSED_NONZERO_BALANCE";
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).balanceMsats = opfsBalanceMsats > 0 ? opfsBalanceMsats : 0;
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).previousActiveInvite = previousActiveInvite ?? "";
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).desiredInvite = desiredInvite;
          throw refuseErr;
        }

        // Safe-to-wipe path: balance is 0, OR force === true.
        console.warn(
          "[chama] reconcile: wiping OPFS to switch federations",
          {
            previous: previousActiveInvite
              ? previousActiveInvite.slice(0, 24) + "…"
              : "(untracked OPFS)",
            desired: desiredInvite.slice(0, 24) + "…",
            balanceMsats: opfsBalanceMsats,
            forced: force,
          },
        );
        try { await fedimint.cleanup(); } catch {}
        fedimintRef.current = null;
        bridgeRef.current = null;
        healthRef.current = { ok: null, at: null };
        try {
          await resetLocalFedimintWallet({ storageScope });
        } catch (e) {
          console.warn("[chama] reconcile wipe threw (non-fatal):", e);
        }
        clearActiveInvite();

        // Re-create + init against the now-empty OPFS so joinFederation
        // below lands on the desired fed cleanly (no v0.1.69 case-c
        // throw, no case-b silent no-op).
        fedimint = buildClient();
        await fedimint.init({ mnemonic, storageScope, simNpub });
        fedimintRef.current = fedimint;
      }

      const effectiveInvite = desiredInvite;
      const usingCommunityPinnedInvite =
        !!communityInvite && effectiveInvite === communityInvite && !persistCustom;
      const staleCustomOverriddenByCommunity =
        !!communityInvite && effectiveInvite === communityInvite && !explicitInvite;
      const usingCustom =
        persistCustom
        && !staleCustomOverriddenByCommunity
        && (!!explicitInvite || hasCustomFederation());

      // Join federation (idempotent in the SDK when already on the
      // same fed; lands cleanly on the new fed when post-wipe).
      const federationId = await fedimint.joinFederation(effectiveInvite);

      // Adopt the pre-multi-federation database as the arbiter's first route.
      // This is the migration that preserves already-earned premiums (including
      // balances minted before this feature existed) in place.
      if (bondedArbiter && activePubkey && desiredFederationId) {
        const existingRoutes = listArbiterFederationRoutes(activePubkey);
        if (rememberedArbiterRoute || existingRoutes.length === 0) {
          rememberArbiterFederationRoute(activePubkey, {
            federationId,
            inviteCode: effectiveInvite,
            storageScope: rememberedArbiterRoute?.storageScope ?? activePubkey,
          });
        }
      }

      // PR 5: record the actually-joined invite so the next cold start
      // can reconcile if the user later switches preference.
      setActiveInvite(effectiveInvite);
      if (usingCustom && explicitInvite && persistCustom) {
        setCustomFederationInvite(effectiveInvite);
      } else if (usingCommunityPinnedInvite || staleCustomOverriddenByCommunity) {
        setCustomFederationInvite("");
      }

      // Construct the bridge now that we have a working wallet
      bridgeRef.current = new EscrowFedimintBridge(
        clientRef.current,
        fedimint,
        signerRef.current
      );

      // Read initial balance
      let balanceMsats = 0;
      try {
        balanceMsats = await fedimint.getBalance();
      } catch {
        // fresh wallet — balance fetch may fail briefly after join
      }

      // v0.1.68: Drain any pending-redemption stash in the background.
      // ─────────────────────────────────────────────────────────────────
      // If a previous session died between CLAIM publish and redeem
      // complete (the sm_moadjfkb_9ue9pd5p failure mode), oobNotes are
      // sitting in localStorage waiting to be redeemed. Fire the drain
      // fire-and-forget: onBalanceUpdate (wired above) will push the
      // new balance into state as redemptions land, so the user sees
      // balance tick up without a blocking spinner on init.
      //
      // Drain errors are already logged inside drainPendingRedemptions;
      // the outer .catch here is defense-in-depth against an unexpected
      // throw outside the per-entry try blocks.
      drainPendingRedemptions(fedimint).catch((e) =>
        console.warn("[chama] pending-redemption drain error:", e)
      );

      // Re-absorb any Fedi funding notes stranded mid-lock (the fund-loss
      // mirror of the redemption drain): a prior session that spent ecash out
      // of Fedi but died before the LOCK published left bearer notes in the
      // funding stash. No-ops outside a Fedi runtime. Fire-and-forget;
      // onBalanceUpdate reflects Fedi balance as notes land.
      drainPendingFundings().catch((e) =>
        console.warn("[chama] pending-funding drain error:", e)
      );

      // #37: settle any SDK-wallet lock attempt stranded mid-flight (the
      // native/browser mirror of the Fedi drain above). Fail-closed decision
      // table per entry: a LOCK committed with our notes clears the entry;
      // provably-uncommitted notes are re-absorbed into the wallet; unknown
      // trade state keeps the entry untouched. Never runs on sim/testnet
      // (their fake notes never enter this stash). Fire-and-forget; a
      // balance refresh makes a successful re-absorb visible immediately.
      if (!isSimModeOn() && !isTestnetMode() && bridgeRef.current) {
        drainPendingNativeLocks(bridgeRef.current.nativeLockRecoveryDeps())
          .then((summary) => {
            if (summary.reabsorbed > 0 || summary.clearedDead > 0) {
              refreshBalanceRef.current?.().catch(() => {});
            }
          })
          .catch((e) =>
            console.warn("[chama] pending-native-lock drain error:", e)
          );
      }

      // v0.1.69: Seed health check + staleness republish.
      // ─────────────────────────────────────────────────────────────────
      // Query relays for the current seed event and republish if it's
      // older than SEED_REPUBLISH_INTERVAL_MS (7 days). Also records
      // health info (relay count, timestamps) to localStorage for UI
      // consumption in a future release.
      //
      // Fresh-generation case: if getOrCreateSeed just generated a new
      // seed this session, its created_at ≈ now, so the staleness check
      // returns false and no republish happens — satisfying the "only
      // republish on recovery, not fresh generation" rule naturally.
      //
      // Fire-and-forget, matches the v0.1.68 drain pattern. Non-blocking
      // so UI transitions to the "joined" state without waiting.
      if (!isTestnetMode() && !isSimModeOn()) {
        checkAndMaybeRepublishSeed(
          clientRef.current!,
          signerRef.current!
        ).catch((e) =>
          console.warn("[chama] seed health check error:", e)
        );
      }

      // PR 5: a successful join is itself proof of reachability — seed
      // the health cache so the first invoice doesn't have to probe.
      // v0.3.1 Phase 3 caveat: this optimism is WRONG in the
      // broken-quorum case (Bitcoin Principles production smoke: join
      // succeeded against a federation with 3-of-4 guardians dead,
      // because join only requires reading public federation info
      // which any single guardian can serve; but mint operations need
      // the threshold and fail downstream). The boot probe below
      // overrides this seed when it actually exercises mint-touching
      // RPC — that's the only check that catches broken-quorum.
      const joinedAt = Date.now();
      healthRef.current = { ok: true, at: joinedAt };
      updateFedimint({
        initialized: true,
        joined: true,
        federationId,
        federationName: federationNameForInvite(effectiveInvite)
          ?? (usingCustom ? "External route" : BP_FEDERATION_NAME),
        isCustom: usingCustom,
        balanceMsats,
        busy: false,
        error: null,
        lastHealthOk: true,
        lastHealthAt: joinedAt,
        // Reset boot probe to pending; the probe below sets ok/failed.
        bootProbeState: "pending",
      });

      vibrate([40, 20, 40, 20, 80]);

      // v0.3.1 Phase 3: cold-boot federation probe. Start it after a
      // successful join, but deliberately do NOT await it. The picker can
      // land on Browse as soon as the wallet is joined; pending is already a
      // non-gating state and the just-in-time money-operation probes remain
      // the safety boundary. If a newer init replaces this client before the
      // probe settles, ignore the stale result.
      //
      // Probe1 vs probe2:
      //   probe1 — this block, fires once per initFedimint
      //   probe2 — the just-in-time check inside createFundingInvoice
      //            (line ~1614) and escrow-bridge probes at lock/claim.
      //   Probe2 sites are unchanged and remain authoritative before
      //   money moves; probe1 is the early warning shown from Browse.
      void fedimint.probeReachable().then(() => {
        if (fedimintRef.current !== fedimint) return;
        const probeOkAt = Date.now();
        healthRef.current = { ok: true, at: probeOkAt };
        updateFedimint({
          bootProbeState: "ok",
          lastHealthOk: true,
          lastHealthAt: probeOkAt,
        });
      }).catch((probeErr) => {
        if (fedimintRef.current !== fedimint) return;
        // Probe failed — joined the fed but it's structurally broken
        // (e.g., quorum dead). Override the optimistic ok seed above.
        // The ChamaBar "⚠ Chama unreachable · Reconnect →" pill picks
        // up bootProbeState=failed and the Fund + Claim buttons gate
        // themselves on the same flag.
        const probeFailedAt = Date.now();
        const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
        console.warn("[chama] boot probe failed:", probeMsg);
        healthRef.current = { ok: false, at: probeFailedAt };
        updateFedimint({
          bootProbeState: "failed",
          lastHealthOk: false,
          lastHealthAt: probeFailedAt,
        });
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint]);

  const setCustomInvite = useCallback((inviteCode: string) => {
    setCustomFederationInvite(inviteCode);
    const trimmed = inviteCode.trim();
    updateFedimint({
      isCustom: !!trimmed,
      federationName: federationNameForInvite(trimmed)
        ?? (trimmed ? "External route" : BP_FEDERATION_NAME),
    });
  }, [updateFedimint]);

  // v0.1.76 fund-loss protection: resetLocalWallet refuses to wipe
  // OPFS if there is a non-zero balance, unless caller passes
  // `force: true`. The UI layer is responsible for surfacing the
  // destruction explicitly to the user before passing force.
  const resetLocalWallet = useCallback(async (
    options: { force?: boolean } = {},
  ) => {
    const { force = false } = options;

    // Read the current balance from the live wallet, if any. If we
    // can't read it, treat as "unknown" and refuse without force —
    // we'd rather false-positive than destroy bearer notes.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] balance read during reset:", e);
    }

    if (!force && currentBalanceMsats !== null && currentBalanceMsats > 0) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing to reset local wallet: ${sats} sats would be ` +
        `permanently destroyed (Fedimint ecash is bearer cash and ` +
        `lives only in the local wallet file). Use force=true to ` +
        `override after explicit user confirmation.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "RESET_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    // Tear down the in-memory wallet first so the OPFS delete isn't
    // blocked by the WASM worker holding the database open.
    try {
      await fedimintRef.current?.cleanup();
    } catch (e) {
      console.debug("[chama] fedimint cleanup during reset:", e);
    }
    fedimintRef.current = null;
    bridgeRef.current = null;
    clearSeedCache();
    healthRef.current = { ok: null, at: null };
    clearActiveInvite();

    const activePubkey = await signerRef.current?.getPublicKey().catch(() => null) ?? null;
    await resetLocalFedimintWallet({ storageScope: activePubkey });

    updateFedimint({
      initialized: false,
      joined: false,
      federationId: null,
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
    });
  }, [updateFedimint]);

  // PR 5: switchFederation — production-grade fed switching.
  // ──────────────────────────────────────────────────────────────────────
  // Composed action: reset + reinit-with-new-invite, as one user-facing
  // operation. Promoted from devSwitchFederation in PR 5 — the prior
  // localStorage.chama_dev_fed_switch gate has been dropped.
  //
  // Safety: the v0.1.76 fund-loss guard refuses if the balance is
  // Lightning-withdrawable unless `{ force: true }` is passed. Fedimint
  // ecash is bearer cash and lives only in the local OPFS file — wiping
  // it without checking has destroyed real user sats in the past. Callers
  // (UI) must only pass force after explicit user confirmation.
  const switchFederation = useCallback(async (
    inviteCode: string,
    options: { force?: boolean; persistCustom?: boolean } = {},
  ) => {
    const { force = false } = options;
    const persistCustom = options.persistCustom !== false;

    const trimmed = inviteCode.trim();
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }

    const bondedArbiter = listCommitmentBonds().some((bond) => bond.phase === "locked");
    const activePubkey = await signerRef.current?.getPublicKey().catch(() => null) ?? null;
    const targetFederationId = expectedFederationIdForInvite(trimmed);
    const currentFederationId = fedimintRef.current?.getFederationId() ?? null;

    if (bondedArbiter && activePubkey && targetFederationId && currentFederationId) {
      const currentInvite = getActiveInvite();
      if (currentInvite) {
        const currentRoute = getArbiterFederationRoute(activePubkey, currentFederationId);
        rememberArbiterFederationRoute(activePubkey, {
          federationId: currentFederationId,
          inviteCode: currentInvite,
          storageScope: currentRoute?.storageScope ?? activePubkey,
        });
      }
      const targetRoute = getArbiterFederationRoute(activePubkey, targetFederationId);
      rememberArbiterFederationRoute(activePubkey, {
        federationId: targetFederationId,
        inviteCode: trimmed,
        storageScope: targetRoute?.storageScope
          ?? arbiterFederationStorageScope(activePubkey, targetFederationId),
      });

      console.info("[chama] selecting preserved arbiter federation", targetFederationId);
      updateFedimint({ busy: true, error: null });
      try {
        if (persistCustom) setCustomFederationInvite(trimmed);
        else setCustomFederationInvite("");

        if (isNativeBridgeModeOn()) {
          const fedimint = fedimintRef.current!;
          const federationId = await fedimint.switchFederationPreserving(trimmed);
          setActiveInvite(trimmed);
          bridgeRef.current = new EscrowFedimintBridge(
            clientRef.current!,
            fedimint,
            signerRef.current!,
          );
          const balanceMsats = await fedimint.getBalance();
          updateFedimint({
            initialized: true,
            joined: true,
            federationId,
            balanceMsats,
            busy: false,
            error: null,
            lastHealthOk: true,
            lastHealthAt: Date.now(),
          });
        } else {
          try { await fedimintRef.current?.cleanup(); } catch {}
          fedimintRef.current = null;
          bridgeRef.current = null;
          healthRef.current = { ok: null, at: null };
          clearActiveInvite();
          updateFedimint({
            initialized: false,
            joined: false,
            federationId: null,
            balanceMsats: 0,
            busy: true,
            error: null,
          });
          await initFedimint(trimmed, { persistCustom });
        }
        return;
      } catch (e) {
        // Browser switching releases the old OPFS handle before opening the
        // target. If the target federation is unreachable, immediately reopen
        // the preserved prior route so a failed community tap cannot leave the
        // arbiter disconnected (and can never fall into the destructive
        // single-wallet revert path).
        if (!isNativeBridgeModeOn() && currentInvite) {
          try {
            try { await fedimintRef.current?.cleanup(); } catch {}
            fedimintRef.current = null;
            bridgeRef.current = null;
            clearActiveInvite();
            await initFedimint(currentInvite, { persistCustom: false });
          } catch (restoreError) {
            console.error("[chama] couldn't reopen preserved arbiter federation", restoreError);
          }
        }
        const message = e instanceof Error ? e.message : String(e);
        updateFedimint({ busy: false, error: message });
        throw e;
      }
    }

    // v0.1.76 fund-loss protection: balance-aware refusal. v0.7.2
    // aligns this with the recovery UI: sub-fee dust cannot be sent out
    // through Lightning, so it should not strand users behind a
    // "Recover 0 sats" modal.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] switch-fed: balance read failed:", e);
    }
    if (
      !force
      && currentBalanceMsats !== null
      && balanceBlocksFederationSwitch(currentBalanceMsats)
    ) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing federation switch: ${sats} sats would be permanently ` +
        `destroyed when the OPFS file is wiped for the new federation. ` +
        `Move funds out (Lightning withdrawal) before switching, or ` +
        `confirm destruction explicitly in the UI.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "SWITCH_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    console.info("[chama] switching federation to", trimmed.slice(0, 24) + "...");
    updateFedimint({ busy: true, error: null });

    try {
      // Step 1 — tear down the current wallet (terminates worker, releases OPFS handle)
      try {
        await fedimintRef.current?.cleanup();
      } catch (e) {
        console.debug("[chama] switch-fed: cleanup threw (non-fatal):", e);
      }
      fedimintRef.current = null;
      bridgeRef.current = null;
      // NOTE: do NOT clearSeedCache() here. The Fedimint seed is per-pubkey
      // (encrypted to the user's own Nostr identity), not per-federation —
      // it survives a fed switch unchanged. Clearing it forces the next
      // initFedimint to re-query Nostr for the seed, which races against
      // post-teardown relay warmup and trips the v0.1.74 seed-safety
      // guard. v0.1.85 smoke testing showed this caused a 100% federation-
      // switch failure rate (every community-pill tap re-fetched the seed
      // from cold relays). The cache stays valid through the switch.
      healthRef.current = { ok: null, at: null };
      // Clear the active-invite record now; initFedimint(trimmed) below
      // will write the new one once the join succeeds.
      clearActiveInvite();

      // Step 2 — wipe OPFS file + rotate filename so init() opens a fresh DB
      await resetLocalFedimintWallet({ storageScope: activePubkey });

      // Step 3 — persist only Advanced/Sandbox/custom switches as custom
      // overrides. Community taps pass persistCustom:false; those should
      // clear stale custom state so the selected community's pinned invite
      // remains the source of truth on reload.
      if (persistCustom) setCustomFederationInvite(trimmed);
      else setCustomFederationInvite("");

      // Step 4 — clear React state so initFedimint can rebuild from scratch.
      // Reset health probe cache too — the new fed needs its own probe.
      updateFedimint({
        initialized: false,
        joined: false,
        federationId: null,
        balanceMsats: 0,
        lastHealthOk: null,
        lastHealthAt: null,
        busy: true,
        error: null,
      });

      // Step 5 — re-init with the new invite. Reuses the existing
      // initFedimint flow which probes the Nostr seed, joins the new
      // fed, and wires up the balance subscriber.
      await initFedimint(trimmed, { persistCustom });

      console.info("[chama] federation switch complete");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[chama] federation switch failed:", message);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint, initFedimint]);

  // PR 5: federation health gate.
  // ──────────────────────────────────────────────────────────────────────
  // Invoice generation is the moment users discover whether the federation
  // can actually transact. A successful join proves reachability at join
  // time, but mid-session the federation may go unreachable (the iroh-
  // canary failure mode) without producing any other surface signal. If
  // we let the user generate an invoice against an unreachable federation,
  // payments to it become orphaned.
  //
  // Cache discipline: 30s TTL. After a successful join/switch we seed
  // ok=true so the first invoice within 30s is fast. Failed probes are
  // also cached — repeat clicks within 30s see the same refusal without
  // hammering the federation.
  const HEALTH_TTL_MS = 30_000;

  const createFundingInvoice = useCallback(async (
    amountMsats: number,
    description: string = "Chama wallet top-up",
    onReceiveState?: (kind: LnReceiveStateKind) => void,
    meta?: ChamaOperationMeta,
    onGateway?: (gateway: InvoiceGatewayInfo) => void,
  ) => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
      markFedimintWalletNotReady();
      throw new Error(FEDIMINT_WALLET_NOT_READY);
    }

    // Health gate: refuse if the most recent probe failed and is still
    // fresh; probe now if the cache is stale or empty.
    const cached = healthRef.current;
    const now = Date.now();
    const fresh = cached.at !== null && (now - cached.at) < HEALTH_TTL_MS;

    let healthy: boolean;
    if (fresh && cached.ok !== null) {
      healthy = cached.ok;
    } else {
      try {
        await fedimint.probeReachable();
        healthy = true;
        healthRef.current = { ok: true, at: now };
        updateFedimint({ lastHealthOk: true, lastHealthAt: now });
      } catch (e) {
        healthy = false;
        healthRef.current = { ok: false, at: now };
        updateFedimint({ lastHealthOk: false, lastHealthAt: now });
        console.warn("[chama] federation probe failed:", e);
      }
    }

    if (!healthy) {
      const fedName = stateRef.current?.fedimint.federationName ?? "(unknown)";
      throw new Error(
        `Wallet temporarily can't receive — federation ${fedName} unreachable. ` +
        `Try again in a moment.`,
      );
    }

    try {
      const invoice = await fedimint.createInvoice(
        amountMsats, description, onReceiveState, meta, onGateway,
      );
      const receiveOkAt = Date.now();
      healthRef.current = { ok: true, at: receiveOkAt };
      updateFedimint({ lastHealthOk: true, lastHealthAt: receiveOkAt });
      return invoice;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const receiveFailedAt = Date.now();
      healthRef.current = { ok: false, at: receiveFailedAt };
      updateFedimint({
        lastHealthOk: false,
        lastHealthAt: receiveFailedAt,
        error: message,
      });
      throw e;
    }
  }, [markFedimintWalletNotReady, updateFedimint]);

  // v0.3.0 Phase 2: atomic fund-and-lock orchestrator. Composes the
  // existing createFundingInvoice + lockAndPublishAction into a single
  // flow with a phase callback for granular UI updates. The pure
  // orchestrator lives in src/payments/fund-and-lock.ts (testable
  // without React); this binding wires it to the live wallet.
  const fundAndLockAction = useCallback(async (
    escrowId: string,
    opts: {
      amountMsats: number;
      /** E1.1 arbiter insurance: extra msats folded into the funding
       *  invoice ON TOP of amountMsats so the wallet retains the funder's
       *  0.25% premium after the lock spend (which independently consumes
       *  state.amountMsats). Never enters the lock, the #37 intent stash,
       *  or the direct-lock balance gate. Ignored on the Fedi-internal
       *  path (exact-amount — a bump there would over-fund the escrow). */
      premiumMsats?: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc";
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: import("../payments/fund-and-lock.js").FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ): Promise<import("../payments/fund-and-lock.js").FundAndLockTerminal> => {
    // Fund moves sats, so honor "one tap = one intent": if the wallet isn't
    // ready yet (e.g. relays/init still settling), wait a bounded window on THIS
    // tap and proceed if it becomes ready — but never queue a deferred payment.
    // On timeout we fail safe below (fresh tap required). ensureFedimintReady is
    // instant when already ready, so the happy path pays no penalty.
    await ensureFedimintReady();
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
      markFedimintWalletNotReady();
      const err = FEDIMINT_WALLET_NOT_READY;
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    if (
      !isSimModeOn() &&
      !isTestnetMode() &&
      opts.amountMsats < MIN_REAL_ATOMIC_FUNDING_MSATS
    ) {
      const err = `${minimumAtomicFundingMessage()} Enter a positive amount for a real Lightning escrow.`;
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    // Snapshot the seated buyer BEFORE any external Lightning/on-chain payment
    // can begin. A slow payment may outlive the JOIN hold + hidden grace; the
    // bridge carries this identity through LOCK, but refuses if a different
    // buyer replaced them meanwhile. This is a money-path preflight: no buyer
    // means no invoice and therefore no sats can leave Alby first.
    let fundingBuyerPubkey: string;
    try {
      ({ buyerPubkey: fundingBuyerPubkey } = await requireBridge().preflightLock(escrowId));
    } catch (e) {
      const err = describeError(e, "This trade is not ready to fund");
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    // v0.6.5 funding-operation gate. The shared OPFS wallet's
    // spendNotes call cannot safely overlap with a second runFundAndLock.
    // The ref is the authoritative synchronous read at entry (setState
    // propagation is async — without this, two near-simultaneous Fund
    // taps could both pass the UI gate before React re-renders the
    // disabled button). The setState call drives the UI; the ref
    // stops the race.
    //
    // v0.6.5 follow-up: the ref now holds the AbortSignal of the
    // live run (or null when idle). A non-null + non-aborted ref
    // means a real concurrent call is in flight — reject. A non-null
    // + aborted ref means the previous run was cancelled (the most
    // common cause being React StrictMode's intentional double-mount
    // in dev: first effect mounts run#1, cleanup aborts it, second
    // effect synchronously starts run#2 BEFORE run#1's finally fires
    // and clears the ref). In that case the previous run is dead;
    // let the new run through.
    const inflight = fundingInProgressRef.current;
    if (inflight && !inflight.aborted) {
      const err = "Another funding operation is in progress. Complete it first.";
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    // Capture the signal we'll write to the ref so the finally can
    // compare by identity. If the caller didn't supply one, we mint
    // an internal AbortController so we still have a stable identity
    // to match against.
    const ownSignal = opts.signal ?? new AbortController().signal;
    fundingInProgressRef.current = ownSignal;
    setState(prev => prev.fundingInProgress
      ? prev
      : { ...prev, fundingInProgress: true });
    try {
      if (hasFediInternalGenerateEcash()) {
        // Fedi Mini-App funding is atomic via stash + re-absorb: ecash spent
        // out of Fedi is committed only once the LOCK publishes with our
        // notesHash; abort, lock-throw, racing tab, reload, or crash all
        // refund. See src/payments/fedi-fund-and-lock.ts. (The SDK-wallet
        // paths below get the same guarantee from the pending-native-locks
        // stash inside bridge.lockAndPublish — #37.)
        const { runFediFundAndLock } = await import("../payments/fedi-fund-and-lock.js");
        return await runFediFundAndLock({
          escrowId,
          amountMsats: opts.amountMsats,
          description: opts.description,
          savedHandleId: opts.savedHandleId,
          selectedItems: opts.selectedItems,
          onPhase: opts.onPhase,
          signal: opts.signal,
          preflight: async () => {}, // outer preflight pinned the buyer before funding
          generateEcash: (amountMsats, memo) => generateFediEcash(amountMsats, memo),
          // Re-absorb WITHOUT expectedMsats — re-absorbing the exact notes we
          // generated is exact, and passing it risks a receive-then-throw that
          // would double-attempt an already-consumed note on the boot drain.
          receiveEcash: (notes) => receiveFediEcash(notes),
          stashFunding: stashPendingFunding,
          clearFunding: clearPendingFunding,
          hashNotes,
          // lockAndPublishWithEcashAction keeps the stale-suppression swallow
          // (returns state, no throw, on "Cannot LOCK"/"TERMINAL"); we surface
          // the committed notesHash so the orchestrator confirms OUR lock.
          lockAndPublish: async (id, notes, lockOpts) => {
            const state = await lockAndPublishWithEcashAction(id, notes, {
              ...lockOpts,
              buyerPubkey: fundingBuyerPubkey,
            });
            return { lockedNotesHash: state?.lock?.notesHash ?? null };
          },
        });
      }

      // Fedi-shaped runtimes without the internal ecash primitive can't
      // fund at all — refuse BEFORE any #37 bookkeeping (an intent stashed
      // for a flow refused one line later tells a false story — F9).
      if (isFediMiniAppRuntime() || hasFediInternalEcash()) {
        opts.onPhase({ kind: "lock-failed", error: FEDI_ECASH_UNAVAILABLE });
        return { kind: "lock-failed", error: FEDI_ECASH_UNAVAILABLE };
      }

      // #37: a prior lock attempt's stash entry holds bearer notes for THIS
      // trade — settle it BEFORE creating any invoice, or the modal would
      // invite a SECOND payment for a trade whose sats already exist.
      if (!isSimModeOn() && !isTestnetMode()) {
        try {
          const settle = await requireBridge().settlePendingNativeLock(escrowId, {
            ignoreAttemptCap: true,
          });
          // The user may have cancelled while the settle ran — never
          // proceed (especially not into a direct lock) on an aborted
          // signal (review F6).
          if (opts.signal?.aborted) {
            opts.onPhase({ kind: "aborted" });
            return { kind: "aborted" };
          }
          if (settle === "kept") {
            // Couldn't positively resolve (relays degraded / fed mismatch).
            // Refuse to take a new payment — fail-safe, nothing moved.
            const err =
              "Chama is still recovering your previous funding attempt for this " +
              "trade. Your sats are safe — recovery retries automatically. Try " +
              "again in a moment.";
            opts.onPhase({ kind: "lock-failed", error: err });
            return { kind: "lock-failed", error: err };
          }
          if (settle === "cleared-committed") {
            // The crash-window publish actually landed — the trade is
            // already locked with the prior payment. Nothing owed.
            opts.onPhase({ kind: "locked" });
            return { kind: "locked" };
          }
          // Direct-lock shortcut: no new invoice when the wallet already
          // holds the trade amount. Covers (a) a just-re-absorbed prior
          // attempt and (b) the widest crash window — payment landed as
          // BALANCE but the lock never ran (intent-stage entry) — where a
          // re-tap of Fund must not solicit a second payment (review F10).
          const priorIntent = getPendingNativeLock(escrowId);
          const intentCoverable = priorIntent?.stage === "intent";
          if (settle === "reabsorbed" || settle === "cleared-dead-notes" || intentCoverable) {
            const balance = await fedimint.getBalance().catch(() => 0);
            if (opts.signal?.aborted) {
              opts.onPhase({ kind: "aborted" });
              return { kind: "aborted" };
            }
            if (balance >= opts.amountMsats) {
              // Only a CREATED trade is lockable — the settle's fresh
              // loadEscrow refreshed local state, so refuse honestly here
              // instead of letting the Cannot-LOCK swallow fake a success
              // on a cancelled/expired trade (review F8).
              const st = requireClient().getState(escrowId);
              if (st && st.status !== EscrowStatus.CREATED) {
                const err =
                  "This trade is no longer open to fund — your sats are back " +
                  "in your wallet, nothing was sent.";
                opts.onPhase({ kind: "lock-failed", error: err });
                return { kind: "lock-failed", error: err };
              }
              opts.onPhase({ kind: "locking" });
              const locked = await lockAndPublishAction(escrowId, {
                savedHandleId: opts.savedHandleId,
                selectedItems: opts.selectedItems,
                buyerPubkey: fundingBuyerPubkey,
              });
              // Positive confirmation, not the swallow's word (F8).
              if (locked?.lock?.notesHash) {
                opts.onPhase({ kind: "locked" });
                return { kind: "locked" };
              }
              const err =
                "This trade could no longer be locked — your sats stay in " +
                "your wallet.";
              opts.onPhase({ kind: "lock-failed", error: err });
              return { kind: "lock-failed", error: err };
            }
          }
        } catch (e) {
          // Fail-soft: bridge.lockAndPublish keeps its own settle gate as
          // defense-in-depth, and it fires before any spend.
          console.warn("[chama] pending-lock settle failed (continuing):", e);
        }
      }

      // #37: persist a funding INTENT for the SDK-wallet paths below, before
      // any payment can land. If the app dies mid-funding (payment landed,
      // lock never ran — the widest crash window), the balance stays
      // attributable to THIS trade: the recovery surfaces show "finish
      // locking your trade" instead of the drain banner mis-attributed to an
      // old claim. Best-effort here (nothing spent yet) — the fail-closed
      // probe lives at the spend inside bridge.lockAndPublish.
      if (!isSimModeOn() && !isTestnetMode()) {
        try {
          stashNativeLockIntent({
            escrowId,
            amountMsats: opts.amountMsats,
            federationId: fedimint.getFederationId(),
            lockOpts: {
              savedHandleId: opts.savedHandleId,
              selectedItems: opts.selectedItems,
              buyerPubkey: fundingBuyerPubkey,
            },
          });
        } catch (e) {
          console.warn("[chama] funding-intent stash failed (continuing):", e);
        }
      }

      // E1.1: sanitize the insurance bump once. Whole msats, never
      // negative, zero in sim/testnet (the premium sweep no-ops there).
      const premiumMsats = (!isSimModeOn() && !isTestnetMode())
        ? Math.max(0, Math.floor(opts.premiumMsats ?? 0))
        : 0;

      if (opts.fundingMethod === "onchain") {
        const meta = buildChamaOperationMeta({
          flow: "fund_receive",
          escrowId,
          amountMsats: opts.amountMsats,
        });
        opts.onPhase({ kind: "creating-onchain-address" });
        const amountSats = Math.floor(opts.amountMsats / 1000);
        const onchainInfo = await fedimint.getOnchainInfo();
        const pegInFeeSats = Math.max(0, Math.trunc(onchainInfo.pegInFeeSats));
        const minimumDepositSats = Math.max(
          1,
          Math.trunc(onchainInfo.minimumDepositSats || pegInFeeSats + 1),
        );
        if (amountSats < minimumDepositSats) {
          throw new Error(
            `Onchain funding requires at least ${minimumDepositSats.toLocaleString()} sats. ` +
            `Use Lightning for smaller trades.`
          );
        }
        // E1.1: the deposit ASK includes the insurance premium so the
        // residue exists after the lock; the shortfall check below stays
        // against the LOCK amount only — a deposit that covers the trade
        // but not the premium still proceeds (premium fails soft, the
        // sweep just finds no residue and retries another day).
        const depositAmountSats = amountSats + pegInFeeSats + Math.floor(premiumMsats / 1000);
        const baselineMsats = await fedimint.getBalance();
        const deposit = await fedimint.createOnchainDepositAddress(meta);
        if (opts.signal?.aborted) {
          opts.onPhase({ kind: "aborted" });
          return { kind: "aborted" };
        }
        opts.onPhase({
          kind: "onchain-address-created",
          address: deposit.address,
          operationId: deposit.operationId,
          finalityDelay: deposit.finalityDelay,
          pegInFeeSats,
          depositAmountSats,
          minimumDepositSats,
        });
        opts.onPhase({
          kind: "awaiting-onchain-confirmations",
          address: deposit.address,
          operationId: deposit.operationId,
          finalityDelay: deposit.finalityDelay,
          pegInFeeSats,
          depositAmountSats,
          minimumDepositSats,
        });

        let removeAbortListener: (() => void) | undefined;
        const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
          if (!opts.signal) return;
          const listener = () => resolve({ kind: "aborted" });
          opts.signal.addEventListener("abort", listener, { once: true });
          removeAbortListener = () => opts.signal?.removeEventListener("abort", listener);
        });
        const settledDepositPromise = fedimint.awaitOnchainDeposit(deposit.operationId);
        const settled = settledDepositPromise.then(
          (value) => ({ kind: "settled" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        );
        const result = await Promise.race([settled, aborted]);
        if (removeAbortListener) removeAbortListener();
        if (result.kind === "aborted" || opts.signal?.aborted) {
          opts.onPhase({ kind: "aborted" });
          return { kind: "aborted" };
        }
        if (result.kind === "error") {
          throw result.error;
        }
        const settledDeposit = result.value;
        if (
          typeof settledDeposit.amountSats === "number" &&
          settledDeposit.amountSats - pegInFeeSats < amountSats
        ) {
          const netSats = Math.max(0, settledDeposit.amountSats - pegInFeeSats);
          throw new Error(
            `Onchain deposit credited ${netSats.toLocaleString()} sats after federation fee, ` +
            `but this trade needs ${amountSats.toLocaleString()} sats. ` +
            `Send the full ${depositAmountSats.toLocaleString()} sats shown by Chama.`
          );
        }

        opts.onPhase({ kind: "onchain-deposit-confirmed" });

        const requiredBalanceMsats = baselineMsats + Math.floor(opts.amountMsats * 0.9);
        const start = Date.now();
        let balanceReady = false;
        while (Date.now() - start < 120_000) {
          if (opts.signal?.aborted) {
            opts.onPhase({ kind: "aborted" });
            return { kind: "aborted" };
          }
          const balance = await fedimint.getBalance();
          if (balance >= requiredBalanceMsats) {
            balanceReady = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        if (!balanceReady) {
          throw new Error("Onchain deposit was claimed, but Chama balance has not refreshed enough to lock yet. Try again shortly.");
        }

        opts.onPhase({ kind: "locking" });
        await lockAndPublishAction(escrowId, {
          savedHandleId: opts.savedHandleId,
          selectedItems: opts.selectedItems,
          buyerPubkey: fundingBuyerPubkey,
        });
        opts.onPhase({ kind: "locked" });
        return { kind: "locked" };
      }

      // (Fedi-runtime-without-ecash refusal hoisted above the #37 settle/
      // intent block — see F9.)

      const { runFundAndLock } = await import("../payments/fund-and-lock.js");
      // E1.1: the invoice (and the ≥90% payment-detection threshold) carry
      // amount + premium; the lock spend is decoupled (escrow-bridge
      // recomputes state.amountMsats), so the premium stays behind as the
      // wallet residue the settle-time sweep spends to the arbiter.
      const result = await runFundAndLock({
        escrowId,
        amountMsats: opts.amountMsats + premiumMsats,
        description: opts.description,
        savedHandleId: opts.savedHandleId,
        selectedItems: opts.selectedItems,
        getBalance: () => fedimint.getBalance(),
        createFundingInvoice: (amountMsats, description, onReceiveState, onGateway) =>
          createFundingInvoice(
            amountMsats,
            description,
            onReceiveState,
            buildChamaOperationMeta({
              flow: "fund_receive",
              escrowId,
              amountMsats,
            }),
            onGateway,
          ),
        autoPayInvoice: opts.fundingMethod === "nwc"
          ? async (bolt11) => {
              const connectionString = opts.nwcConnectionString?.trim();
              if (!connectionString) throw new Error("Paste an NWC connection");
              await payInvoiceWithNwc(connectionString, bolt11);
            }
          : undefined,
        lockAndPublish: (id, lockOpts) => lockAndPublishAction(id, {
          ...lockOpts,
          buyerPubkey: fundingBuyerPubkey,
        }),
        onPhase: opts.onPhase,
        signal: opts.signal,
      });
      // #37: a clean "expired" (payment never arrived) or a deliberate
      // user cancel retires the intent record so it can't linger as a
      // false "you were funding when the app closed" story (F3). Entries
      // that advanced to `spent` are untouchable by this path, and an
      // abort that raced a landed payment still surfaces honestly: the
      // balance-gated resume logic only tells the story when the wallet
      // actually holds the amount.
      if (result.kind === "expired" || result.kind === "aborted") {
        try { clearPendingNativeLockIfIntent(escrowId); } catch {}
      }
      return result;
    } catch (e: unknown) {
      const err = describeError(e, "Funding failed");
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    } finally {
      // Only clear the ref if THIS run still owns it. In the StrictMode
      // double-mount case, run#1's finally fires AFTER run#2 has
      // already replaced the ref with its own signal — clearing
      // unconditionally would strand run#2 in a state where the UI
      // thinks it's idle while a real fund flow is in progress.
      if (fundingInProgressRef.current === ownSignal) {
        fundingInProgressRef.current = null;
      }
      setState(prev => prev.fundingInProgress
        ? { ...prev, fundingInProgress: false }
        : prev);
    }
  }, [createFundingInvoice, lockAndPublishAction, lockAndPublishWithEcashAction, markFedimintWalletNotReady]);

  // R3-1b: re-attach to a submitted payout and, if it settled, transition the
  // trade to COMPLETED — on BOTH sides (publishing COMPLETE propagates to the
  // counterparty whose "settling…" resolves). Never re-pays (awaitPayoutOutcome
  // only watches the existing operationId). Used both as the immediate
  // background re-attach after a payout-confirming claim AND on re-opening a
  // trade that's stuck on CLAIMED with a submitted payout (e.g. the seller's
  // refund landed but the app was closed before the watch resolved).
  const reattachPayoutAction = useCallback(async (escrowId: string): Promise<void> => {
    let bridge: EscrowFedimintBridge;
    let client: EscrowClient;
    try {
      bridge = requireBridge();
      client = requireClient();
    } catch {
      return;
    }
    const completeIfClaimed = async () => {
      const st0 = client.getState(escrowId);
      if (st0 && st0.status === EscrowStatus.CLAIMED) {
        try { await client.complete(escrowId); } catch (e) {
          console.debug("[chama] reattach complete failed:", e);
        }
      }
      const st = client.getState(escrowId);
      if (st) updateEscrow(escrowId, st);
    };
    try {
      const rec = getPayoutRecord(escrowId);
      if (!rec) return;
      if (rec.status === "settled") {
        await completeIfClaimed();
        return;
      }
      // V7: intent records (crash before the submitted/settled upgrade) and
      // submitted records that lost their operationId reconcile BY ESCROW —
      // the payment carries chama_escrow_id in the fedimint op log. Never
      // re-pays; only observes. NOTE the fund-safety asymmetry: "none"
      // clears an INTENT (payment provably never dispatched ⇒ RETRY CLAIM
      // goes live) but NOT a submitted record (the gateway accepted a
      // payment — an empty scan is blindness, not proof of absence).
      if (rec.status === "intent" || (rec.status === "submitted" && !rec.operationId)) {
        const sinceMs = rec.createdAt !== undefined
          ? rec.createdAt - PAY_RECONCILE_SINCE_MARGIN_MS
          : undefined;
        const res = await bridge.payOutcomeByEscrow(escrowId, sinceMs);
        if (res.outcome === "settled") {
          markPayoutSettled(escrowId, res.operationId);
          await completeIfClaimed();
          refreshBalanceRef.current?.().catch(() => {});
        } else if (res.outcome === "inflight") {
          // Adopt the live payment's id so future reattaches go direct.
          recordPayoutSubmitted({ escrowId, operationId: res.operationId, amountMsats: rec.amountMsats });
        } else if (
          res.outcome === "refunded" ||
          (res.outcome === "none" && rec.status === "intent")
        ) {
          clearPayoutRecord(escrowId);
        }
        // unknown (or untrusted none): keep the record; retried next sweep.
        return;
      }
      if (rec.status !== "submitted" || !rec.operationId) return;
      const outcome = await bridge.awaitPayoutOutcome(rec.operationId);
      if (outcome === "settled") {
        markPayoutSettled(escrowId, rec.operationId);
        await completeIfClaimed();
        refreshBalanceRef.current?.().catch(() => {});
      } else if (outcome === "refunded") {
        clearPayoutRecord(escrowId);
      }
      // unknown: leave the submitted record for the next tap / re-open.
    } catch (e) {
      console.debug("[chama] reattachPayout failed:", e);
    }
  }, []);

  // v0.3.0 Phase 3: atomic claim-and-payout orchestrator. Composes the
  // existing claimAndRedeemAction with a balance watchdog and outbound
  // payInvoice into a single flow with phase callbacks. The pure
  // orchestrator lives in src/payments/claim-and-payout.ts (testable
  // without React); this binding wires it to the live wallet.
  const claimAndPayoutAction = useCallback(async (
    escrowId: string,
    args: {
      bolt11?: string;
      onchainAddress?: string;
      expectedDeltaMsats: number;
      saveAfter: boolean;
      addressUsed?: string;
      onPhase: (phase: import("../payments/claim-and-payout.js").ClaimAndPayoutPhase) => void;
    },
  ): Promise<import("../payments/claim-and-payout.js").ClaimAndPayoutTerminal> => {
    const fedimint = fedimintRef.current;
    if (!fedimint) {
      const err = "Wallet not initialized";
      args.onPhase({ kind: "claim-bridge-threw", error: err });
      return { kind: "claim-bridge-threw", error: err };
    }
    let bridge: EscrowFedimintBridge;
    let client: EscrowClient;
    try {
      bridge = requireBridge();
      client = requireClient();
    } catch (e: any) {
      const err = e?.message || "Fedimint wallet not ready";
      args.onPhase({ kind: "claim-bridge-threw", error: err });
      return { kind: "claim-bridge-threw", error: err };
    }
    // v0.6.5: mirror the funding-operation gate for the claim sweep.
    // Between claim-redeems and the outbound LN send, the OPFS balance
    // is transiently > 0 with no active trade explaining it. Without
    // this flag the recovery banner would race the very flow that's
    // about to drain the balance. Ref-mirror matches the funding side.
    claimPayoutInProgressRef.current = true;
    setState(prev => prev.claimPayoutInProgress
      ? prev
      : { ...prev, claimPayoutInProgress: true });
    try {
      if (hasFediInternalEcash()) {
        args.onPhase({ kind: "claiming" });
        try {
          await bridge.claimAndReceiveFedi(escrowId, { clearPendingOnRedeem: true });
          await client.complete(escrowId);
          refreshBalanceRef.current?.().catch(() => {});
          args.onPhase({ kind: "done" });
          return { kind: "done" };
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (isStaleClaim(msg)) {
            console.debug("[chama] Fedi claim suppressed (stale):", msg);
            args.onPhase({ kind: "done" });
            return { kind: "done" };
          }
          if (e?.code === "FED_PROBE_FAILED" || e?.code === "FED_MISMATCH") {
            args.onPhase({ kind: "claim-bridge-threw", error: msg });
            return { kind: "claim-bridge-threw", error: msg };
          }
          args.onPhase({ kind: "claim-failed", error: msg });
          return { kind: "claim-failed", error: msg };
        }
      }

      const { runClaimAndPayout } = await import("../payments/claim-and-payout.js");
      const onchainAddress = args.onchainAddress?.trim();
      const result = await runClaimAndPayout({
        escrowId,
        bolt11: args.bolt11 ?? "onchain-payout",
        expectedDeltaMsats: args.expectedDeltaMsats,
        saveAfter: args.saveAfter,
        addressUsed: args.addressUsed,
        payoutKind: onchainAddress ? "onchain" : "lightning",
        getBalance: () => fedimint.getBalance(),
        // Production claim+payout uses the raw bridge claim, not
        // claimAndRedeemAction, because claimAndRedeemAction emits the
        // legacy success progress that auto-publishes COMPLETE. COMPLETE
        // belongs after the balance-confirming watchdog below, not merely
        // after redeemEcash returns.
        claimAndRedeem: async (id: string) => {
          try {
            return await bridge.claimAndRedeem(id, { clearPendingOnRedeem: false });
          } catch (e: any) {
            const msg = e?.message || String(e);
            if (isStaleClaim(msg)) {
              console.debug("[chama] Claim suppressed (stale):", msg);
              return client.getState(id)!;
            }
            throw e;
          }
        },
        completeClaim: async (id: string) => {
          await client.complete(id);
        },
        clearPendingRedemption,
        payInvoice: async (bolt11: string) => {
          const operationId = await bridge.payInvoice(
            bolt11,
            buildChamaOperationMeta({
              flow: "claim_payout",
              escrowId,
              amountMsats: args.expectedDeltaMsats,
            }),
          );
          refreshBalanceRef.current?.().catch(() => {});
          return operationId;
        },
        // 3.5.1 payout double-pay guard. The journal is user-scoped
        // localStorage (payments/payout-journal.ts); awaitPayoutOutcome
        // re-attaches to a submitted payout's operationId via the bridge.
        getPayoutRecord,
        recordPayoutIntent,
        recordPayoutSubmitted,
        markPayoutSettled,
        clearPayoutRecord,
        assertPayoutJournalWritable,
        awaitPayoutOutcome: (operationId: string) =>
          bridge.awaitPayoutOutcome(operationId),
        // V7 reconcile-by-escrow. Sim's mocked pay auto-settles and stamps
        // no op log — "none" is the truthful sim answer (an intent there can
        // never mask a real payment), keeping sim retries unstranded.
        payOutcomeByEscrow: async (id: string, sinceMs?: number) =>
          isSimModeOn()
            ? { outcome: "none" as const }
            : bridge.payOutcomeByEscrow(id, sinceMs),
        payOnchain: async (grossAmountSats: number) => {
          if (!onchainAddress) throw new Error("Paste a bitcoin onchain address");
          let sendSats = grossAmountSats;
          let fees = await bridge.getOnchainWithdrawFees(onchainAddress, sendSats);
          sendSats = grossAmountSats - fees.feesSats;
          if (sendSats <= 0) {
            throw new Error("Onchain network fee exceeds this claim amount. Use Lightning for this payout.");
          }
          fees = await bridge.getOnchainWithdrawFees(onchainAddress, sendSats);
          sendSats = grossAmountSats - fees.feesSats;
          if (sendSats <= 0) {
            throw new Error("Onchain network fee exceeds this claim amount. Use Lightning for this payout.");
          }
          await bridge.withdrawOnchain(
            onchainAddress,
            sendSats,
            buildChamaOperationMeta({
              flow: "claim_payout",
              escrowId,
              amountMsats: args.expectedDeltaMsats,
            }),
          );
          refreshBalanceRef.current?.().catch(() => {});
        },
        addOrTouchLightningHandle: addOrTouchPayoutDestination,
        onPhase: args.onPhase,
      });
      if (result.kind === "payout-confirming") {
        // 3.5.1 (a) / R3-1b: the payout was submitted but its watch window
        // closed before settlement. Re-attach ONCE in the background (never
        // re-pays) so a slow HTLC that lands flips the trade to COMPLETED on
        // its own — on both sides — instead of stranding either party.
        void reattachPayoutAction(escrowId);
      }
      return result;
    } finally {
      claimPayoutInProgressRef.current = false;
      setState(prev => prev.claimPayoutInProgress
        ? { ...prev, claimPayoutInProgress: false }
        : prev);
    }
  }, []);

  const watchBondOnchainCredit = (operationId: string, bondId?: string) => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !operationId) return;
    void fedimint.awaitOnchainDeposit(operationId)
      .then(() => {
        // The peg-in confirmed and the ecash is now spendable — stamp the record
        // so the ceremony flips from "on their way" to "landed" (durable across
        // reloads; the balance refresh reflects the new sats).
        if (bondId) {
          const rec = getCommitmentBond(bondId);
          if (rec && !rec.creditConfirmedAt) {
            upsertCommitmentBond({ ...rec, creditConfirmedAt: Date.now() });
          }
        }
        return refreshBalanceRef.current?.();
      })
      .catch((error) => {
        console.warn("[chama] bond onchain credit watcher failed:", error);
      });
  };

  // ── Arbiter premium (task #53 E1) ─────────────────────────────────────
  // Payer side: spend a whole-sat OOB note (14-day try_cancel horizon —
  // an absent arbiter auto-refunds us) and publish it as kind 38113 on
  // the trade's channel, encrypted to the arbiter. Fund-safety mirrors
  // V7: the "sending" intent is written BEFORE the spend, so a crash in
  // the spend→publish gap blocks a re-spend (the stranded note refunds
  // itself); only a spend that never happened clears the intent.
  const payArbiterPremiumAction = async (escrowId: string): Promise<void> => {
    if (isSimModeOn() || isTestnetMode()) return;
    const fedimint = fedimintRef.current;
    if (!fedimint) return;
    let client: EscrowClient;
    try { client = requireClient(); } catch { return; }
    const state = client.getState(escrowId);
    if (!state || state.status !== EscrowStatus.COMPLETED) return;
    let pubkey: string;
    try { pubkey = await client.getPubkey(); } catch { return; }
    const decision = computeArbiterPremium(state, pubkey);
    if (!decision.payable) return;
    // Durable idempotence + the decline preference: any record blocks.
    if (hasPremiumOutboxRecord(escrowId)) return;
    // CROSS-DEVICE idempotence. The outbox above is this device's
    // localStorage; the premium is owed once per identity per trade. Another
    // device (APK / another origin / a re-install) with an empty outbox would
    // otherwise spend a second note on a trade already paid — field-confirmed
    // as 6 duplicate notes across 4 trades. The trade's own chain carries
    // every 38113, so a note authored by me is proof I already paid; backfill
    // the local record so this device stops asking and the toggle reads
    // "Insurance sent". (A genuine same-second race between two devices can
    // still double-pay; the realistic case — devices opened hours or days
    // apart — is fully covered.)
    if (hasOwnPremiumNote(state, pubkey)) {
      recordPremiumPaid(escrowId, decision.amountMsats);
      return;
    }
    recordPremiumSending(escrowId, decision.amountMsats);
    let spent: { oobNotes: string; operationId?: string };
    try {
      spent = await fedimint.spendNotesWithHorizon(
        decision.amountMsats,
        PREMIUM_SPEND_TRY_CANCEL_SECS,
        buildChamaOperationMeta({
          flow: "arbiter-premium",
          escrowId,
          amountMsats: decision.amountMsats,
        }),
      );
    } catch (e) {
      // No money moved — clear the intent so a later sweep can retry.
      clearPremiumSending(escrowId);
      console.warn("[chama] arbiter premium: spend failed:", e);
      return;
    }
    try {
      await client.sendPremium(escrowId, {
        amountSats: decision.amountSats,
        oobNotes: spent.oobNotes,
        federationId: fedimint.getFederationId() ?? undefined,
        noteKind: "ambient",
      });
    } catch (e) {
      // Spent but unpublished: KEEP the "sending" record (re-spend guard);
      // the note auto-refunds to us at the horizon. Never re-pay here.
      console.warn("[chama] arbiter premium: publish failed (note auto-refunds):", e);
      return;
    }
    recordPremiumPaid(escrowId, decision.amountMsats, spent.operationId);
    refreshBalanceRef.current?.().catch(() => {});
  };

  // Arbiter side: scan the trade's premium notes for ones addressed to me
  // that the ledger hasn't settled, decrypt, redeem, record. A redeem
  // failure bumps an attempt counter (capped — a note the payer's horizon
  // already refunded must not be retried forever).
  const redeemArbiterPremiumsAction = async (escrowId: string): Promise<void> => {
    if (isSimModeOn() || isTestnetMode()) return;
    const fedimint = fedimintRef.current;
    if (!fedimint) return;
    let client: EscrowClient;
    try { client = requireClient(); } catch { return; }
    const state = client.getState(escrowId);
    if (!state) return;
    let pubkey: string;
    try { pubkey = await client.getPubkey(); } catch { return; }
    const arbiter = state.participants[Role.ARBITER];
    if (!arbiter || arbiter.toLowerCase() !== pubkey.toLowerCase()) return;
    let redeemedAny = false;
    for (const ev of state.premiumNotes ?? []) {
      if (isEarningSettled(ev.raw.id)) continue;
      const body = await client.decryptPremiumBody(ev);
      const base = {
        eventId: ev.raw.id,
        escrowId,
        payer: ev.raw.pubkey,
        noteKind: ev.payload.noteKind,
      };
      if (!body || body.escrowId !== escrowId) {
        // Not for me / malformed — count toward give-up so it stops retrying.
        recordEarningAttemptFailed({ ...base, amountMsats: 0, lastError: "Premium envelope could not be decrypted or was malformed" });
        continue;
      }
      const amountMsats = Math.floor(body.amountSats) * 1000;
      const currentFed = fedimint.getFederationId();
      if (body.federationId && currentFed && body.federationId !== currentFed) {
        // Federation-bound bearer ecash cannot redeem in another mint. Do not
        // burn one of the finite retry attempts: the federation-keyed App
        // latch retries as soon as the arbiter switches to the right wallet.
        console.warn(`[chama] arbiter premium: waiting for federation ${body.federationId}; current wallet is ${currentFed}`);
        continue;
      }
      try {
        await fedimint.redeemWithRetry(body.oobNotes);
        recordEarningRedeemed({ ...base, amountMsats });
        redeemedAny = true;
      } catch (e) {
        const lastError = e instanceof Error ? e.message : String(e);
        recordEarningAttemptFailed({ ...base, amountMsats, lastError: lastError.slice(0, 500) });
        console.warn("[chama] arbiter premium: redeem failed:", e);
      }
    }
    if (redeemedAny) {
      setState(prev => ({ ...prev, earningsRevision: prev.earningsRevision + 1 }));
      refreshBalanceRef.current?.().catch(() => {});
      // Publish the newly redeemed receipt and opportunistically backfill any
      // pre-v5.4 local records. Never block redemption success on relay health.
      void syncArbiterEarnings(client)
        .then(() => setState(prev => ({ ...prev, earningsRevision: prev.earningsRevision + 1 })))
        .catch(() => {});
    }
  };

  // Task #62 arbiter redeem-probe. The App redeem sweep only walks LOADED
  // trades; a settled trade is unwatched (its live sub is gone) and
  // discovery skips it ("settled — nothing to heal"), so a 38113 published
  // AFTER settlement never reaches a passive arbiter's state. This probes
  // relays directly for premiums #p-tagged to me, loadEscrow's the trades
  // whose notes we don't hold (the #d re-fetch merges the 38113 into
  // premiumNotes), then redeems. Fail-soft everywhere — a probe must never
  // surface an error.
  const probeArbiterPremiumsAction = async (): Promise<void> => {
    if (isSimModeOn() || isTestnetMode()) return;
    const client = clientRef.current;
    if (!client) return;
    let pubkey: string;
    try { pubkey = await client.getPubkey(); } catch { return; }
    let events: { id: string; created_at: number; tags: string[][] }[];
    try {
      events = await client.queryOnce(
        { kinds: [EscrowEventKind.PREMIUM], "#p": [pubkey] } as any,
        8_000,
      );
    } catch { return; }
    if (events.length === 0) return;
    const targets = selectPremiumProbeLoads(events, {
      isSettled: isEarningSettled,
      isNoteLoaded: (escrowId, eventId) =>
        (client.getState(escrowId)?.premiumNotes ?? []).some((n) => n.raw.id === eventId),
    });
    for (const id of targets) {
      try {
        // loadEscrow merges + replays the full chain (partial-replay-safe)
        // and fires onStateUpdate, so the trade also lands in the App map.
        const loaded = await client.loadEscrow(id);
        if (!loaded) continue;
        await redeemArbiterPremiumsAction(id);
      } catch (e) {
        console.warn(`[chama] arbiter premium probe: ${id} load/redeem failed:`, e);
      }
    }
  };

  // ── Return ──────────────────────────────────────────────────────────────

  const actions: UseEscrowActions = {
    exportActiveRecoveryKey: async () => {
      const signer = signerRef.current;
      if (!signer?.exportRecoveryKey) return null;
      return signer.exportRecoveryKey();
    },
    connect,
    disconnect,
    recoverRelays,
    createEscrow,
    joinEscrow,
    renewListing,
    editListing,
    startNextTranche,
    startPrivateTranchePlan,
    syncPrivateTranchePlan,
    myEscrowKey,
    onchainFundingPlan,
    checkOnchainFunding,
    publishOnchainLock,
    prepareOnchainSettlement,
    signOnchainSettlement,
    finalizeOnchainSettlement,
    scanMyOnchainPayouts,
    sweepOnchainPayout,
    repostRecurringCbp,
    lockAndPublish: lockAndPublishAction,
    vote: voteAction,
    releasePeriod: async (escrowId: string, periodIndex: number) => {
      if (!clientRef.current) throw new Error("Not connected");
      const newState = await clientRef.current.releasePeriod(escrowId, periodIndex);
      updateEscrow(escrowId, newState);
      return newState;
    },
    claimAndRedeem: claimAndRedeemAction,
    claimAndPayout: claimAndPayoutAction,
    reattachPayout: reattachPayoutAction,
    payArbiterPremium: payArbiterPremiumAction,
    redeemArbiterPremiums: redeemArbiterPremiumsAction,
    probeArbiterPremiums: probeArbiterPremiumsAction,
    sendChat,
    cancel: cancelAction,
    loadEscrow,
    getLoadFailure,
    rebroadcastEscrow,
    refreshMyTrades,
    probeFetchById,
    forgetEscrow,
    purchaseFromListing,
    fetchNostrProfiles,
    vibrate,
    initFedimint,
    setCustomInvite,
    createFundingInvoice,
    fundAndLock: fundAndLockAction,
    payInvoice: async (bolt11: string, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      // R3-1: surface the operationId so the recovery payout can journal it
      // (same double-pay guard as the claim path).
      const operationId = await bridge.payInvoice(bolt11, meta);
      refreshBalanceRef.current?.().catch(() => {});
      return operationId;
    },
    awaitPayoutOutcome: async (operationId: string) => {
      const bridge = requireBridge();
      return bridge.awaitPayoutOutcome(operationId);
    },
    refreshCommunityRoster: async (community: string) => {
      const client = clientRef.current;
      if (!client || !community) return;
      const entry = getCommunityBySlug(community);
      const authority = resolveRosterAuthority({
        stewardPubkey: entry?.stewardPubkey ?? null,
        creatorPubkey: entry?.creatorPubkey ?? null,
      });
      if (authority.length === 0) return;
      await fetchAndCacheCommunityRoster({
        community,
        authority,
        query: (filter, timeoutMs) => client.queryOnce(filter as any, timeoutMs),
      });
    },
    publishCommunityRoster: async (community: string, arbiters: string[]) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const unsigned = buildArbiterRosterEvent({ community, arbiters });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
      writeCachedRosterEvent(community, signed);
    },
    applyAsArbiter: async (community: string, statement: string) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const unsigned = buildArbiterApplicationEvent({ community, statement });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
    },
    createCommitmentBond: async ({ amountSats, termBlocks }) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      if (typeof amountSats !== "bigint" || amountSats <= 0n) throw new Error("Bond amount must be a positive number of sats");
      if (!Number.isInteger(termBlocks) || termBlocks <= 0) throw new Error("Term must be a positive number of blocks");
      if (termBlocks < MIN_COMMITMENT_TERM_BLOCKS) {
        // A shorter term can END before funding confirms — a "locked" bond that is
        // already reclaimable is zero commitment signal (and very confusing).
        throw new Error(`Term too short — a bond must lock for at least ${MIN_COMMITMENT_TERM_BLOCKS} blocks.`);
      }
      // The bond key is BIP86-derived from the same Nostr-backed seed (a distinct path,
      // no key reuse), so the arbiter alone controls it — no cabinet, no custody.
      const words = await getOrCreateSeed(client, signer);
      // ⭐ A FRESH derivation index per bond → a unique key → a unique address, even at
      // the same term. No two bonds ever share an address (no commingled UTXOs, better
      // privacy). Index = highest existing + 1 (legacy single-key bonds count as 0).
      const keyIndex = listCommitmentBonds().reduce((m, b) => Math.max(m, b.keyIndex ?? 0), -1) + 1;
      const { xonly } = deriveBondSigningKey(words.join(" "), { network: BOND_NETWORK, index: keyIndex });
      const tip = await esploraTipHeight(esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK }));
      const lockUntil = tip + termBlocks;
      const bond = buildCommitmentBond(xonly, lockUntil, BOND_NETWORK);
      const bondId = newBondId();
      upsertCommitmentBond({ bondId, bond, amountSats, phase: "created", keyIndex, createdAt: Math.floor(Date.now() / 1000) });
      return { bondId, address: bond.address, lockUntil, amountSats, tipAtCreate: tip };
    },
    checkCommitmentFunding: async (bondId: string) => {
      const rec = getCommitmentBond(bondId);
      if (!rec) throw new Error("Unknown bond — post it first.");
      if (rec.phase === "reclaimed") return { locked: true, txid: rec.utxos?.[0]?.txid, lockedSats: rec.amountSats, deposits: rec.utxos?.length ?? 0 };
      // Re-scan on EVERY call — never early-return on a cached UTXO. A second deposit
      // that confirms after the first check must still be recorded, or the reclaim
      // sweep would strand it at the address. Accept ANY confirmed deposit(s) (the
      // arbiter's own sats, their own address — more is a bigger bond). Union
      // chain ∪ cache so one flaky read off a load-balanced Esplora node can't drop
      // an already-recorded deposit.
      const found = await findBondFundingUtxos({
        address: rec.bond.address,
        fetchJson: esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK }),
        minConfs: defaultMinConfs(BOND_NETWORK),
      });
      const merged = new Map<string, { txid: string; index: number; amountSats: bigint }>();
      for (const u of rec.utxos ?? []) merged.set(`${u.txid}:${u.index}`, u);
      for (const f of found) merged.set(`${f.utxo.txid}:${f.utxo.index}`, f.utxo);
      if (merged.size === 0) return { locked: false };
      const utxos = [...merged.values()];
      const total = utxos.reduce((s, u) => s + u.amountSats, 0n);
      const locked = upsertCommitmentBond({ ...rec, phase: "locked", utxos, amountSats: total });
      return { locked: true, txid: locked.utxos?.[0]?.txid, lockedSats: total, deposits: utxos.length };
    },
    getCommitmentReclaimQuote: async (bondId: string) => {
      const rec = getCommitmentBond(bondId);
      const fedimint = fedimintRef.current;
      if (!rec || !fedimint?.isInitialized() || !fedimint.isJoined()) return null;
      const info = await fedimint.getOnchainInfo();
      const utxos = rec.utxos ?? [];
      if (utxos.length === 0) return null;
      const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK });
      const rate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
      const minerFeeSats = estimateReclaimFeeSats(rec.bond, utxos.length, rate);
      const total = utxos.reduce((sum, u) => sum + u.amountSats, 0n);
      return {
        finalityDelay: Math.max(0, Math.trunc(info.finalityDelay)),
        minimumDepositSats: Math.max(0, Math.trunc(info.minimumDepositSats)),
        pegInFeeSats: Math.max(0, Math.trunc(info.pegInFeeSats)),
        minerFeeSats,
        estimatedNetSats: total - minerFeeSats - BigInt(Math.max(0, Math.trunc(info.pegInFeeSats))),
      };
    },
    renewCommitmentBond: async (bondId: string, termBlocks: number) => {
      const old = getCommitmentBond(bondId);
      if (!old) throw new Error("Unknown bond.");
      if (old.phase !== "locked") throw new Error("Only a funded bond can be renewed.");
      if (!Number.isInteger(termBlocks) || termBlocks < MIN_COMMITMENT_TERM_BLOCKS) {
        throw new Error(`A renewed bond must lock for at least ${MIN_COMMITMENT_TERM_BLOCKS} blocks.`);
      }
      // Idempotent resume: the raw transaction is journaled before its first
      // broadcast. A double tap or restart re-broadcasts the same transaction.
      if (old.renewalToBondId) {
        const next = getCommitmentBond(old.renewalToBondId);
        if (!next?.renewalRawTx) throw new Error("Renewal journal is incomplete; no sats were moved.");
        let txid = next.renewalTxid;
        if (!txid) {
          try { txid = await esploraBroadcast(defaultEsploraBase(BOND_NETWORK), next.renewalRawTx); }
          catch (error: any) {
            if (!/missingorspent|already.*(mempool|chain|known)|txn-already/i.test(error?.message ?? "")) throw error;
            const first = old.utxos?.[0];
            const out = first ? await esploraOutspend(esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK }), first.txid, first.index).catch(() => null) : null;
            if (!out?.spent || !out.txid) throw error;
            txid = out.txid;
          }
        }
        if (txid !== next.renewalTxid) {
          upsertCommitmentBond({ ...next, renewalTxid: txid, renewalBroadcastAt: Date.now() });
          upsertCommitmentBond({ ...old, renewalTxid: txid, renewalBroadcastAt: Date.now() });
        }
        return { bondId: next.bondId, txid, amountSats: next.amountSats, feeSats: next.renewalFeeSats ?? 0n, lockUntil: next.bond.lockUntil, pending: next.phase !== "locked" };
      }
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Reconnect to renew — your bond remains safe on-chain.");
      const base = defaultEsploraBase(BOND_NETWORK);
      const fetchJson = esploraFetcher(base);
      const tip = await esploraTipHeight(fetchJson);
      if (tip < old.bond.lockUntil) throw new Error(`This bond unlocks at block ${old.bond.lockUntil}; it cannot renew before then.`);
      const fresh = await findBondFundingUtxos({ address: old.bond.address, fetchJson, minConfs: defaultMinConfs(BOND_NETWORK) });
      const utxos = fresh.map((f) => f.utxo);
      if (utxos.length === 0) {
        const cached = old.utxos ?? [];
        const out = cached[0] ? await esploraOutspend(fetchJson, cached[0].txid, cached[0].index).catch(() => null) : null;
        if (out?.spent && out.txid) throw new Error(`This bond was already spent in ${out.txid}; it cannot be renewed.`);
        throw new Error("No unspent bond output was found. Nothing was broadcast.");
      }
      const words = await getOrCreateSeed(client, signer);
      const oldKey = deriveBondSigningKey(words.join(" "), { network: BOND_NETWORK, index: old.keyIndex ?? 0 });
      if (!oldKey.xonly.every((b, i) => b === old.bond.ownerXonly[i])) throw new Error("Bond key mismatch — renewal refused.");
      const keyIndex = listCommitmentBonds().reduce((m, b) => Math.max(m, b.keyIndex ?? 0), -1) + 1;
      const nextKey = deriveBondSigningKey(words.join(" "), { network: BOND_NETWORK, index: keyIndex });
      const lockUntil = tip + termBlocks;
      const nextBond = buildCommitmentBond(nextKey.xonly, lockUntil, BOND_NETWORK);
      const feeRate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
      const feeSats = estimateReclaimFeeSats(old.bond, utxos.length, feeRate);
      const total = utxos.reduce((sum, u) => sum + u.amountSats, 0n);
      const amountSats = total - feeSats;
      const rawTx = buildBondRolloverTx({ oldBond: old.bond, newBond: nextBond, utxos, oldOwnerPriv: oldKey.priv, feeSats, currentHeight: tip, network: BOND_NETWORK });
      const nextBondId = newBondId();
      const createdAt = Math.floor(Date.now() / 1000);
      upsertCommitmentBond({
        bondId: nextBondId, bond: nextBond, amountSats, phase: "created", keyIndex,
        renewedFromBondId: old.bondId, renewalRawTx: rawTx, renewalFeeSats: feeSats, createdAt,
      });
      upsertCommitmentBond({ ...old, renewalToBondId: nextBondId, renewalRawTx: rawTx, renewalFeeSats: feeSats });
      let txid: string;
      try {
        txid = await esploraBroadcast(base, rawTx);
      } catch (error: any) {
        const msg = error?.message ?? "";
        if (/missingorspent|already.*(mempool|chain|known)|txn-already/i.test(msg)) {
          const out = await esploraOutspend(fetchJson, utxos[0].txid, utxos[0].index).catch(() => null);
          if (!out?.spent || !out.txid) throw error;
          txid = out.txid;
        } else throw error;
      }
      const broadcastAt = Date.now();
      const next = getCommitmentBond(nextBondId)!;
      upsertCommitmentBond({ ...next, renewalTxid: txid, renewalBroadcastAt: broadcastAt });
      upsertCommitmentBond({ ...old, renewalToBondId: nextBondId, renewalTxid: txid, renewalBroadcastAt: broadcastAt });
      return { bondId: nextBondId, txid, amountSats, feeSats, lockUntil, pending: true };
    },
    reclaimCommitmentBond: async (bondId: string, destinationChoice: ReclaimDestinationChoice = { kind: "chama" }) => {
      const rec = getCommitmentBond(bondId);
      if (!rec) throw new Error("Unknown bond.");
      if (rec.phase === "reclaimed" && rec.reclaimTxid) {
        if (rec.creditOperationId) watchBondOnchainCredit(rec.creditOperationId, bondId);
        return {
          txid: rec.reclaimTxid,
          alreadyReclaimed: true,
          creditedToChama: !!rec.creditTxid,
          ...(rec.creditOperationId ? { creditOperationId: rec.creditOperationId } : {}),
          ...(rec.reclaimDestination ? { reclaimDestination: rec.reclaimDestination, destinationAddress: rec.reclaimDestination.address } : {}),
          ...(rec.reclaimDestination?.actual === "bond-key" ? { returnAddress: rec.reclaimDestination.address } : {}),
        };
      }
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Reconnect to reclaim — your bonded sats are safe on-chain either way.");
      const base = defaultEsploraBase(BOND_NETWORK);
      const fetchJson = esploraFetcher(base);
      // ⭐ Sweep what the CHAIN says is at the address, not the local cache — a deposit
      // that confirmed after the last funding check (or was recorded on another device)
      // must not be stranded. The cache is the fallback only when the scan itself fails.
      const cached = rec.utxos ?? [];
      let utxos = cached;
      try {
        const fresh = await findBondFundingUtxos({ address: rec.bond.address, fetchJson, minConfs: defaultMinConfs(BOND_NETWORK) });
        if (fresh.length > 0) {
          utxos = fresh.map((f) => f.utxo);
        } else if (cached.length > 0) {
          // Scan succeeded but the address is EMPTY while we remember deposits: the
          // bond leaf is owner-key-only, so a spend of those UTXOs can only ever be
          // the owner's reclaim (this device crashed post-broadcast, or another
          // device swept). Adopt the on-chain spend as the reclaim.
          const out = await esploraOutspend(fetchJson, cached[0].txid, cached[0].index).catch(() => null);
          if (out?.spent && out.txid) {
            upsertCommitmentBond({ ...rec, phase: "reclaimed", reclaimTxid: out.txid });
            return { txid: out.txid, alreadyReclaimed: true };
          }
          // Not spent, just not visible (lagging LB node) → sweep the cached set;
          // consensus is the authority either way.
        }
      } catch { /* Esplora unreachable — try the cached set */ }
      if (utxos.length === 0) throw new Error("This bond isn't funded yet.");
      // ⚠ Real sats: reclaim the arbiter's OWN bond to their own key. Re-derive the
      // private key from the seed (never stored). The reclaim tx carries nLockTime =
      // lockUntil, so CONSENSUS is the authority on whether the term has passed — we
      // attempt the broadcast and translate a genuine too-early rejection into a calm
      // message (instead of pre-guessing from a load-balanced, jittery tip height).
      const words = await getOrCreateSeed(client, signer);
      // Re-derive at THIS bond's persisted index (default 0 for legacy single-key bonds).
      const { priv, xonly } = deriveBondSigningKey(words.join(" "), { network: BOND_NETWORK, index: rec.keyIndex ?? 0 });
      // Sanity: the re-derived key MUST reproduce the bond's stored key (right seed +
      // index) — otherwise the sig wouldn't satisfy the leaf. Fail loud, never broadcast.
      if (xonly.length !== rec.bond.ownerXonly.length || !xonly.every((b, i) => b === rec.bond.ownerXonly[i])) {
        throw new Error("Bond key mismatch — cannot reclaim (unexpected seed or key index).");
      }
      const reclaimAddress = btcSigner.p2tr(xonly, undefined, BOND_NETWORK).address as string;
      // Dynamic reclaim fee: query the live mempool rate (non-urgent ~1h tier),
      // floored at the flat default so an unreachable Esplora still relays + confirms.
      const feeRate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
      const feeSats = estimateReclaimFeeSats(rec.bond, utxos.length, feeRate);
      const total = utxos.reduce((s, u) => s + u.amountSats, 0n);
      let reclaimDestination: CommitmentReclaimDestination;
      let creditOperationId: string | undefined;
      let pendingCreditOperationId: string | undefined;
      let chamaDepositAddress: string | null = null;
      let fallbackReason = "Chama is not available right now; reclaimed to the bond key instead.";

      if (destinationChoice.kind === "chama") {
        const fedimint = fedimintRef.current;
        if (fedimint && fedimint.isInitialized() && fedimint.isJoined()) {
          try {
            const onchainInfo = await fedimint.getOnchainInfo();
            const minimumDepositSats = BigInt(Math.max(
              1,
              Math.trunc(onchainInfo.minimumDepositSats || onchainInfo.pegInFeeSats + 1),
            ));
            const outputSats = total - feeSats;
            if (outputSats >= minimumDepositSats) {
              const deposit = await fedimint.createOnchainDepositAddress(
                buildChamaOperationMeta({ flow: "bond_reclaim", reason: bondId }),
              );
              chamaDepositAddress = deposit.address;
              pendingCreditOperationId = deposit.operationId;
            } else {
              fallbackReason = `Reclaim output is below the federation deposit minimum (${outputSats.toString()} sats < ${minimumDepositSats.toString()} sats); reclaimed to the bond key instead.`;
            }
          } catch (error) {
            console.warn("[chama] Falling back to self-custody bond reclaim address:", error);
            fallbackReason = "Chama deposit was unavailable; reclaimed to the bond key instead.";
          }
        }
        const resolved = resolveReclaimDestination({
          choice: destinationChoice,
          bondKeyAddress: reclaimAddress,
          network: BOND_NETWORK,
          chamaDepositAddress,
          fallbackReason,
        });
        if (!resolved.ok) throw new Error(resolved.message);
        reclaimDestination = resolved.destination;
        if (reclaimDestination.actual === "chama") creditOperationId = pendingCreditOperationId;
      } else {
        const resolved = resolveReclaimDestination({
          choice: destinationChoice,
          bondKeyAddress: reclaimAddress,
          network: BOND_NETWORK,
        });
        if (!resolved.ok) throw new Error(resolved.message);
        reclaimDestination = resolved.destination;
      }

      if (reclaimDestination.actual === "chama" && !creditOperationId) {
        reclaimDestination = {
          requested: "chama",
          actual: "bond-key",
          address: reclaimAddress,
          fallbackReason: "Chama deposit was unavailable; reclaimed to the bond key instead.",
        };
      }
      const creditedToChama = reclaimDestination.actual === "chama";
      const destination = reclaimDestination.address;
      const rawTx = buildReclaimTx({ bond: rec.bond, utxos, ownerPriv: priv, destination, feeSats });
      let txid: string;
      try {
        txid = await esploraBroadcast(base, rawTx);
      } catch (e: any) {
        const msg = e?.message ?? "";
        if (/non-final|locktime|checklocktime|not.*final/i.test(msg)) {
          throw new Error(`Almost — the chain hasn't quite reached your unlock block (${rec.bond.lockUntil}) yet. Give it a minute and try again; your bond is safe.`);
        }
        if (/missingorspent|already.*(mempool|chain|known)|txn-already/i.test(msg)) {
          // Inputs already swept — only the owner's key can do that. Recover the txid.
          const out = await esploraOutspend(fetchJson, utxos[0].txid, utxos[0].index).catch(() => null);
          if (out?.spent && out.txid) {
            upsertCommitmentBond({ ...rec, phase: "reclaimed", utxos, reclaimTxid: out.txid });
            return { txid: out.txid, alreadyReclaimed: true };
          }
        }
        throw e;
      }
      upsertCommitmentBond({
        ...rec,
        phase: "reclaimed",
        utxos,
        reclaimTxid: txid,
        reclaimDestination,
        ...(creditedToChama ? { creditTxid: txid } : {}),
        ...(creditOperationId ? { creditOperationId } : {}),
      });
      if (creditOperationId) watchBondOnchainCredit(creditOperationId, bondId);
      return {
        txid,
        creditedToChama,
        ...(creditOperationId ? { creditOperationId } : {}),
        destinationAddress: destination,
        reclaimDestination,
        ...(reclaimDestination.actual === "bond-key" ? { returnAddress: reclaimAddress } : {}),
      };
    },
    creditReclaimedCommitmentBond: async (bondId: string) => {
      const rec = getCommitmentBond(bondId);
      if (!rec) throw new Error("Unknown bond.");
      if (!rec.reclaimTxid) throw new Error("Reclaim the bond first, then credit it to Chama.");
      if (rec.creditTxid) {
        if (rec.creditOperationId) watchBondOnchainCredit(rec.creditOperationId, bondId);
        return {
          txid: rec.creditTxid,
          ...(rec.creditOperationId ? { operationId: rec.creditOperationId } : {}),
          alreadyCredited: true,
        };
      }
      if (rec.reclaimDestination && rec.reclaimDestination.actual !== "bond-key") {
        throw new Error("This bond was not reclaimed to the Chama-controlled bond key, so Chama cannot sweep it.");
      }
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Reconnect to credit your reclaimed bond.");
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
        markFedimintWalletNotReady();
        throw new Error(FEDIMINT_WALLET_NOT_READY);
      }
      const base = defaultEsploraBase(BOND_NETWORK);
      const fetchJson = esploraFetcher(base);
      const words = await getOrCreateSeed(client, signer);
      const { priv, xonly } = deriveBondSigningKey(words.join(" "), { network: BOND_NETWORK, index: rec.keyIndex ?? 0 });
      if (xonly.length !== rec.bond.ownerXonly.length || !xonly.every((b, i) => b === rec.bond.ownerXonly[i])) {
        throw new Error("Bond key mismatch — cannot credit reclaimed sats (unexpected seed or key index).");
      }
      const returnAddress = btcSigner.p2tr(xonly, undefined, BOND_NETWORK).address as string;
      const found = await findBondFundingUtxos({
        address: returnAddress,
        fetchJson,
        minConfs: defaultMinConfs(BOND_NETWORK),
      });
      const utxos = found.map((f) => f.utxo);
      if (utxos.length === 0) {
        const out = await esploraOutspend(fetchJson, rec.reclaimTxid, 0).catch(() => null);
        if (out?.spent && out.txid) {
          upsertCommitmentBond({ ...rec, phase: "reclaimed", creditTxid: out.txid });
          return { txid: out.txid, alreadyCredited: true };
        }
        throw new Error("No reclaimed sats are confirmed at the return address yet. Wait for the reclaim to confirm, then try again.");
      }
      const feeRate = await esploraRecommendedFeeRate(fetchJson, { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
      const feeSats = estimateKeyPathSweepFeeSats(utxos.length, feeRate);
      const total = utxos.reduce((s, u) => s + u.amountSats, 0n);
      const sendSats = total - feeSats;
      const onchainInfo = await fedimint.getOnchainInfo();
      const minimumDepositSats = BigInt(Math.max(
        1,
        Math.trunc(onchainInfo.minimumDepositSats || onchainInfo.pegInFeeSats + 1),
      ));
      if (sendSats < minimumDepositSats) {
        throw new Error(`Reclaimed amount is too small to credit to Chama after fees (${sendSats.toString()} sats < ${minimumDepositSats.toString()} sats minimum).`);
      }
      const deposit = await fedimint.createOnchainDepositAddress(
        buildChamaOperationMeta({ flow: "bond_credit", reason: bondId }),
      );
      const rawTx = buildKeyPathSweepTx({
        ownerXonly: xonly,
        utxos,
        ownerPriv: priv,
        destination: deposit.address,
        feeSats,
        network: BOND_NETWORK,
      });
      let txid: string;
      try {
        txid = await esploraBroadcast(base, rawTx);
      } catch (e: any) {
        const msg = e?.message ?? "";
        if (/missingorspent|already.*(mempool|chain|known)|txn-already/i.test(msg)) {
          const out = await esploraOutspend(fetchJson, utxos[0].txid, utxos[0].index).catch(() => null);
          if (out?.spent && out.txid) {
            upsertCommitmentBond({ ...rec, phase: "reclaimed", creditTxid: out.txid, creditOperationId: deposit.operationId });
            watchBondOnchainCredit(deposit.operationId, bondId);
            return { txid: out.txid, operationId: deposit.operationId, amountSats: sendSats, alreadyCredited: true };
          }
        }
        throw e;
      }
      upsertCommitmentBond({
        ...rec,
        phase: "reclaimed",
        creditTxid: txid,
        creditOperationId: deposit.operationId,
      });
      watchBondOnchainCredit(deposit.operationId, bondId);
      return { txid, operationId: deposit.operationId, amountSats: sendSats };
    },
    getBondChainTip: async () => esploraTipHeight(esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK })),
    publishBondAnnouncement: async (bondId: string, community: string, roles?: readonly BondRole[]) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const rec = getCommitmentBond(bondId);
      if (!rec) throw new Error("Unknown bond — post it first.");
      if (rec.phase !== "locked") throw new Error("Announce a bond only once it's funded and locked.");
      const npub = await signer.getPublicKey();
      // A0: when this bond was created by renewing a previous one, carry the
      // hop so the tenure walk (A1) has a chain to follow. Derived entirely
      // from what the commitment store already persists — a renewal genuinely
      // spends the previous bond's output, so the claim is chain-checkable.
      // Fails SOFT: an unresolvable predecessor announces without lineage
      // rather than blocking a real bond from being announced at all.
      // The WHOLE chain, not one hop: announcing a renewal REPLACES the
      // predecessor's 38135, so a one-hop pointer would dead-end at the first
      // superseded ancestor. This device's commitment store is the only place
      // the full history survives, so it publishes all of it and lets any
      // reader prove each hop independently.
      let lineage: BondLineage | undefined;
      try {
        const hops: BondLineageHop[] = [];
        const walked = new Set<string>([rec.bondId]);
        let cursor = rec.renewedFromBondId ? getCommitmentBond(rec.renewedFromBondId) : null;
        while (cursor && hops.length < MAX_LINEAGE_HOPS) {
          if (walked.has(cursor.bondId)) break; // corrupt store: a renewal loop
          walked.add(cursor.bondId);
          const fromTxid = cursor.utxos?.[0]?.txid;
          if (!fromTxid) break; // no funding outpoint ⇒ nothing a verifier could check
          hops.push({
            fromXonly: [...cursor.bond.ownerXonly].map((b) => b.toString(16).padStart(2, "0")).join(""),
            fromLockUntil: cursor.bond.lockUntil,
            fromTxid,
          });
          cursor = cursor.renewedFromBondId ? getCommitmentBond(cursor.renewedFromBondId) : null;
        }
        if (hops.length > 0) lineage = { hops, rootTxid: hops[hops.length - 1].fromTxid };
      } catch (e) {
        // Fails SOFT: a bond announcing without its history under-reports its
        // own tenure, which is always better than not announcing at all.
        console.warn("[chama] bond lineage unavailable; announcing without it:", e);
      }
      const unsigned = buildBondAnnouncementEvent({
        pubkey: npub, community,
        ownerXonly: rec.bond.ownerXonly, lockUntil: rec.bond.lockUntil,
        amountSats: rec.amountSats, network: BOND_NETWORK, address: rec.bond.address,
        ...(roles ? { roles } : {}),
        ...(lineage ? { lineage } : {}),
      });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
      return { community, address: rec.bond.address };
    },
    recoverMyBonds: async () => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const myPubkey = await signer.getPublicKey();
      const words = await getOrCreateSeed(client, signer);
      const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK });
      const events = await client.queryOnce(
        { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], authors: [myPubkey] } as any, 6_000,
      );
      const minConfs = defaultMinConfs(BOND_NETWORK);
      const parsed = selectLatestAnnouncements(events as any).filter((a: any) => a.npub === myPubkey);
      const have = new Set(listCommitmentBonds().map((b) => b.bond.address));
      let recovered = 0;
      for (const a of parsed) {
        if (have.has(a.address)) continue;
        // Live-bond funds sit at the CLTV address; reclaimed-not-yet-swept funds sit at
        // the bond-KEY address (the reclaim destination). Check both so a reclaimed bond
        // also recovers → its "credit to Chama" sweep button surfaces on this device.
        let bondKeyAddress: string;
        try { bondKeyAddress = btcSigner.p2tr(hexToBytes(a.ownerXonly), undefined, BOND_NETWORK).address as string; }
        catch { continue; }
        const [bondUtxos, bondKeyUtxos] = await Promise.all([
          findBondFundingUtxos({ address: a.address, fetchJson, minConfs }).then((f) => f.map((x) => x.utxo)).catch(() => []),
          findBondFundingUtxos({ address: bondKeyAddress, fetchJson, minConfs }).then((f) => f.map((x) => x.utxo)).catch(() => []),
        ]);
        const rec = reconstructBondRecord({
          ownerXonlyHex: a.ownerXonly, lockUntil: a.lockUntil, claimedSats: a.claimedSats,
          announcedAddress: a.address, seedWords: words.join(" "), network: BOND_NETWORK,
          bondUtxos, bondKeyUtxos, createdAt: a.createdAt,
        });
        if (!rec) continue;
        upsertCommitmentBond(rec);
        have.add(a.address);
        recovered++;
      }
      return { recovered };
    },
    fetchMyBonds: async (): Promise<VerifiedBond[]> => {
      // #77: the user's OWN announced bonds, chain-verified — so the Dashboard
      // shows a live bond on a fresh device (no local commitment record yet).
      // Fail-soft everywhere: any relay/esplora hiccup yields [] (never throws
      // into render), and each announcement is recompute-don't-trust verified.
      try {
        const client = clientRef.current;
        const signer = signerRef.current;
        if (!client || !signer) return [];
        const myPubkey = (await signer.getPublicKey()).trim().toLowerCase();
        const events = await client.queryOnce(
          { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], authors: [myPubkey] } as any, 6_000,
        );
        const latest = selectLatestAnnouncements(events as any).filter(
          (a: any) => a.npub.toLowerCase() === myPubkey,
        );
        if (latest.length === 0) return [];
        const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK });
        const tip = await esploraTipHeight(fetchJson).catch(() => undefined);
        const verified: VerifiedBond[] = [];
        for (const a of latest) {
          const v = await verifyBondAnnouncement(
            a, { network: BOND_NETWORK, fetchJson, tipHeight: tip },
          ).catch(() => null);
          if (v) verified.push(v);
        }
        await resolveLineageTenure(verified, fetchJson);
        return verified;
      } catch (e) {
        console.warn("[chama] fetchMyBonds failed — showing local bonds only:", e);
        return [];
      }
    },
    /**
     * Fault-attested arbiters (kind 38136) among the given candidates.
     *
     * Queried by `#p` so this only ever asks about arbiters we're actually
     * considering. Verification needs each attested trade's chain — an
     * attestation is only real if BOTH principals of a SETTLED disputed trade
     * signed it — so referenced trades are loaded, bounded, preferring what is
     * already in memory.
     *
     * FAIL-OPEN by design: any error, timeout, or unloadable trade yields an
     * empty set. A relay hiccup must never invent an exclusion, and the caller
     * treats the result as a preference that can never empty the pool.
     */
    fetchFaultExcludedArbiters: async (candidates: readonly string[]): Promise<string[]> => {
      const client = clientRef.current;
      if (!client || candidates.length === 0) return [];
      try {
        const events = await client.queryOnce(
          { kinds: [ARBITER_FAULT_KIND], "#p": [...candidates] } as any, 6_000,
        );
        if (events.length === 0) return [];

        // Load the referenced trades so each attestation can be verified
        // against its own chain. Bounded — a flood of fabricated ids must not
        // turn one CREATE into a hundred chain fetches.
        const referenced: string[] = [];
        for (const event of events as any[]) {
          const record = parseArbiterFaultEvent(event);
          if (record && !referenced.includes(record.payload.escrowId)) {
            referenced.push(record.payload.escrowId);
          }
          if (referenced.length >= FAULT_VERIFY_TRADE_CAP) break;
        }
        const states = new Map<string, EscrowState | null>();
        for (const id of referenced) {
          const known = client.getState(id);
          if (known) { states.set(id, known); continue; }
          states.set(id, await client.loadEscrow(id).catch(() => null));
        }

        const pairs = selectArbiterFaultPairs(events as any, (id) => states.get(id) ?? null);
        return excludedArbitersNow(pairs, Math.floor(Date.now() / 1000));
      } catch (e) {
        console.debug("[chama] fault-attestation fetch failed (fail-open):", (e as Error)?.message || e);
        return [];
      }
    },

    fetchCommunityBonds: async (community: string) => {
      const client = clientRef.current;
      if (!client) throw new Error("Not connected");
      // Stamp-hardening (the flaky-bondedArbiters fix): this fetch feeds the
      // CREATE-time bonded stamp, where a silent empty result = silent
      // arbiter-revenue loss on the whole trade. So: (1) retry an EMPTY relay
      // read once (empty is ambiguous — no announcements vs a flap), and
      // (2) on any failure OR an empty verify, fall back to the last
      // chain-verified cached set (12h TTL) instead of returning nothing.
      try {
        let events = await client.queryOnce(
          { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], "#d": [community] } as any, 6_000,
        );
        if (events.length === 0) {
          await new Promise((r) => setTimeout(r, 800));
          events = await client.queryOnce(
            { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], "#d": [community] } as any, 6_000,
          );
        }
        const latest = selectLatestAnnouncements(events as any);
        const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK });
        const tip = await esploraTipHeight(fetchJson).catch(() => undefined);
        // ⭐ Each announcement is chain-verified (recompute address + read on-chain);
        // an unfunded or unreproducible claim is dropped, never counted.
        const verified: VerifiedBond[] = [];
        for (const a of latest) {
          const v = await verifyBondAnnouncement(a, { network: BOND_NETWORK, fetchJson, tipHeight: tip });
          if (v) verified.push(v);
        }
        await resolveLineageTenure(verified, fetchJson);
        if (verified.length > 0) {
          writeCachedCommunityBonds(community, verified);
          return verified;
        }
        // Empty after the retry: either genuinely bond-less or a flap that
        // outlived the retry. Prefer recent verified truth while it's fresh.
        return readCachedCommunityBonds(community) ?? verified;
      } catch (e) {
        const cached = readCachedCommunityBonds(community);
        if (cached) {
          console.warn(
            `[chama] fetchCommunityBonds(${community}): live fetch failed — using cached chain-verified set:`, e,
          );
          return cached;
        }
        throw e;
      }
    },
    fetchBondedArbiterCounts: async (): Promise<Record<string, number>> => {
      const client = clientRef.current;
      if (!client) throw new Error("Not connected");
      // ONE batched read across every community (no #d filter). Announcements
      // are parameterized-replaceable and rare (one per arbiter × community),
      // so a 500-limit comfortably covers the world for now.
      const events = await client.queryOnce(
        { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], limit: 500 } as any, 6_000,
      );
      const byCommunity = groupLatestAnnouncementsByCommunity(events as any);
      if (byCommunity.size === 0) return {};
      const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK });
      const tip = (await esploraTipHeight(fetchJson).catch(() => 0)) ?? 0;
      const counts: Record<string, number> = {};
      for (const [community, anns] of byCommunity) {
        // ⭐ Same recompute-don't-trust as the detail read — every counted bond
        // is chain-verified. Per-community chain reads bounded: the list count
        // saturates visually long before 12, and a flood of fake announcements
        // must not turn the picker into an esplora hammer.
        const bonds: VerifiedBond[] = [];
        for (const a of anns.slice(0, 12)) {
          const v = await verifyBondAnnouncement(
            a, { network: BOND_NETWORK, fetchJson, tipHeight: tip },
          ).catch(() => null);
          if (v) bonds.push(v);
        }
        // Empty ratings map: the list needs the FUNDED+ACTIVE distinct-arbiter
        // count only (computeChamaLiveness owns that predicate + dedup).
        const n = computeChamaLiveness(community, bonds, new Map(), tip).arbiterCount;
        if (n > 0) counts[community] = n;
      }
      return counts;
    },
    getChamaLiveness: async (community: string, signal?: AbortSignal): Promise<ChamaLiveness> => {
      const client = clientRef.current;
      if (!client) throw new Error("Not connected");
      const throwIfAborted = () => {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      };
      throwIfAborted();
      // 1. Chain-verified bonds for the community + the chain tip they were verified against.
      const fetchJson = esploraFetcher(defaultEsploraBase(BOND_NETWORK), { signal, timeoutMs: 8_000, network: BOND_NETWORK });
      // A missing chain tip is UNKNOWN, never a verified zero-bond result.
      // Let the coordinator retain the last verified cache (or render unknown)
      // instead of overwriting it with a synthetic tip-height zero snapshot.
      const tip = await esploraTipHeight(fetchJson);
      throwIfAborted();
      const annEvents = await client.queryOnce(
        { kinds: [ARBITER_BOND_ANNOUNCEMENT_KIND], "#d": [community] } as any, 6_000,
      );
      throwIfAborted();
      const bonds: VerifiedBond[] = [];
      const candidates = selectLatestAnnouncements(annEvents as any).slice(0, 12);
      const verified = await mapPool(candidates, 3, async (announcement) => {
        throwIfAborted();
        return verifyBondAnnouncement(
          announcement,
          { network: BOND_NETWORK, fetchJson, tipHeight: tip },
        ).catch(() => null);
      });
      for (const bond of verified) if (bond) bonds.push(bond);
      throwIfAborted();
      // 2. Trade-verified ratings for exactly the bonded arbiters (one query, then
      //    the SAME verification fetchRatingSummary uses — a rating on a trade we
      //    can't see, or one that never settled, never counts).
      const npubs = [...new Set(bonds.map((b) => b.npub.toLowerCase()))];
      const ratingsByNpub = new Map<string, LivenessRatingSummary>();
      if (npubs.length > 0) {
        const events = await client.queryOnce(
          { kinds: [RATING_KIND], "#p": npubs, limit: 500 } as any, 6_000,
        );
        throwIfAborted();
        const missingTradeIds = [...new Set(
          (events as any[])
            .map((e) => parseRatingEvent(e as any)?.tradeId ?? null)
            .filter((id): id is string => !!id && !client.getState(id)),
        )].slice(0, 12);
        await mapPool(missingTradeIds, 3, async (id) => {
          throwIfAborted();
          try { await client.loadEscrow(id); } catch { /* unverifiable → won't count */ }
        });
        throwIfAborted();
        for (const npub of npubs) {
          const agg = aggregateVerifiedRatings(events as any, npub, (id) => client.getState(id));
          if (agg.count > 0) ratingsByNpub.set(npub, agg);
        }
      }
      // 3. Pure composite.
      return computeChamaLiveness(community, bonds, ratingsByNpub, tip);
    },
    publishCommunityReport: async (input: CommunityRequestInput) => {
      const signer = signerRef.current;
      if (!signer) throw new Error("Not connected");
      // Reuse the active signer (NsecSigner et al.) — detectSigner() can't see
      // an nsec login, so the sender must be handed the signer explicitly.
      return sendCommunityRequestToGlobalArbiters(input, { signer });
    },
    authorizeImageUpload: async (url: string, method: "POST") => {
      const signer = signerRef.current;
      if (!signer) throw new Error("Reconnect your signer before uploading photos.");
      const signed = await signer.signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        // A nonce makes rapid multi-image uploads distinct even when several
        // signatures share the same one-second Nostr timestamp. Some hosts
        // reject an identical NIP-98 event as a replay.
        tags: [["u", url], ["method", method], ["nonce", crypto.randomUUID()]],
      });
      return `Nostr ${btoa(JSON.stringify(signed))}`;
    },
    fetchArbiterApplications: async (community: string, excludePubkeys?: string[]) => {
      const client = clientRef.current;
      if (!client || !community) return [];
      const events = await client.queryOnce(
        { kinds: [ARBITER_APPLICATION_KIND], "#d": [community], limit: 50 } as any,
        5_000,
      );
      return collectArbiterApplications(events, { excludePubkeys }).map(app => ({
        applicant: app.applicant,
        statement: app.statement,
        createdAt: app.createdAt,
      }));
    },
    rateCounterparty: async (tradeId: string, ratee: string, thumb: RatingThumb) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const unsigned = buildRatingEvent({ tradeId, ratee, thumb });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
    },
    fetchRatingSummary: async (ratee: string): Promise<AggregateRatings> => {
      const client = clientRef.current;
      if (!client || !ratee) return { count: 0, positive: 0, negative: 0 };
      const events = await client.queryOnce(
        { kinds: [RATING_KIND], "#p": [ratee.toLowerCase()], limit: 500 } as any,
        5_000,
      );
      const missingTradeIds = [...new Set(
        (events as any[])
          .map((event) => parseRatingEvent(event as any)?.tradeId ?? null)
          .filter((id): id is string => !!id && !client.getState(id)),
      )].slice(0, 25);
      await Promise.all(missingTradeIds.map(async (id) => {
        try {
          await client.loadEscrow(id);
        } catch (e) {
          console.debug(`[chama] rating summary: couldn't load verifying trade ${id}`, e);
        }
      }));
      // Each rating is verified against the trade THIS client knows: a rating on
      // a trade we can't see, or one that never settled, never counts.
      return aggregateVerifiedRatings(events as any, ratee, (id) => client.getState(id));
    },
    fetchMyGivenRatings: async (): Promise<Array<{ tradeId: string; ratee: string; thumb: RatingThumb; ratedAt?: number }>> => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) return [];
      const me = (await signer.getPublicKey()).toLowerCase();
      const events = await client.queryOnce(
        { kinds: [RATING_KIND], authors: [me], limit: 500 } as any,
        5_000,
      );
      // Newest thumb per (trade, ratee): what the one-tap surfaces read to show
      // "rated" instead of an active button.
      const latest = new Map<string, { tradeId: string; ratee: string; thumb: RatingThumb; at: number }>();
      for (const e of events as any[]) {
        const r = parseRatingEvent(e);
        if (!r || r.rater !== me) continue;
        const key = `${r.tradeId}:${r.ratee}`;
        const ex = latest.get(key);
        if (!ex || r.createdAt > ex.at) {
          latest.set(key, { tradeId: r.tradeId, ratee: r.ratee, thumb: r.thumb, at: r.createdAt });
        }
      }
      return [...latest.values()].map(({ tradeId, ratee, thumb, at }) => ({ tradeId, ratee, thumb, ratedAt: at }));
    },
    spendNotes: async (amountMsats: number, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      const notes = await bridge.spendNotes(amountMsats, meta);
      refreshBalanceRef.current?.().catch(() => {});
      return notes;
    },
    redeemEcash: async (oobNotes: string, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      await bridge.redeemEcash(oobNotes, meta);
      refreshBalanceRef.current?.().catch(() => {});
    },
    getOnchainInfo: async () => {
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
        markFedimintWalletNotReady();
        throw new Error(FEDIMINT_WALLET_NOT_READY);
      }
      return fedimint.getOnchainInfo();
    },
    probeFederation: async () => {
      // v0.3.1 Phase 1: explicit probe seam for the Try-again path on
      // claim-bridge-threw. Doesn't pass through the HEALTH_TTL_MS cache
      // (createFundingInvoice does) — a retry intentionally wants a
      // fresh read. Returns a structured result; never throws.
      //
      // v0.3.1 Phase 3: also updates bootProbeState so a successful
      // retry-probe naturally unblocks the boot gate. If the user
      // reaches claim-bridge-threw → taps Try Again → probe succeeds,
      // the ChamaBar "⚠ unreachable" pill clears AND the Fund/Claim
      // buttons un-disable across the rest of the UI — single source
      // of truth.
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
        markFedimintWalletNotReady();
        return { ok: false as const, error: FEDIMINT_WALLET_NOT_READY };
      }
      try {
        await fedimint.probeReachable();
        const at = Date.now();
        healthRef.current = { ok: true, at };
        updateFedimint({
          lastHealthOk: true,
          lastHealthAt: at,
          bootProbeState: "ok",
        });
        return { ok: true as const };
      } catch (e: any) {
        const message = e?.message || "Federation unreachable";
        if (/FedimintClient not initialized/i.test(message)) {
          markFedimintWalletNotReady();
          return { ok: false as const, error: FEDIMINT_WALLET_NOT_READY };
        }
        const at = Date.now();
        healthRef.current = { ok: false, at };
        updateFedimint({
          lastHealthOk: false,
          lastHealthAt: at,
          bootProbeState: "failed",
        });
        return { ok: false as const, error: message };
      }
    },
    prewarmFunding: async () => {
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) return;
      try {
        await fedimint.probeReachable();
        const at = Date.now();
        healthRef.current = { ok: true, at };
        updateFedimint({
          lastHealthOk: true,
          lastHealthAt: at,
          bootProbeState: "ok",
        });
      } catch (e) {
        console.debug("[chama] prewarmFunding skipped:", e);
      }
    },
    refreshBalance,
    getBalance: readBalance,
    resetLocalWallet,
    switchFederation,
    watchPublicListings: (since?: number) => {
      clientRef.current?.watchPublicListings(since);
    },
    watchEscrow: (escrowId: string) => {
      clientRef.current?.watchEscrow(escrowId);
    },
    getCommunity: getUserCommunitySlug,
    setCommunity: setUserCommunitySlug,
  };

  return [state, actions];
}
