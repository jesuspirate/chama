// ══════════════════════════════════════════════════════════════════════════
// Chama — Federation Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.5, browser users can only reach federations whose
// guardians expose WebSocket endpoints. As of the v0.5.0 canary iroh-relay
// 0.90 bump, BLF's transport is browser-reliable (registry `browserReliable:
// true`), so BLF is the universal backup/default across the board
// (DECISION 2026-06-16). BP remains a curated/visible option but is no
// longer the silent fallback. As of v6, BLF also backs the visible US anchor;
// GBF is retained only to resolve historical signed trades.
//
// The federation invite/name CONSTANTS live in ./federation-invites.ts
// so the community registry can import them without forming a circular
// dep (this module needs registry's getCommunityBySlug at function-call
// time; registry needs the invite strings at top-level array
// construction time — putting them in a third file breaks the cycle).
// We re-export them here for back-compat with downstream consumers.
//
// If you don't already have a Fedimint wallet, the easiest way to manage
// your ecash balance on mobile is the Fedi app: https://www.fedi.xyz/

import {
  BP_FEDERATION_NAME,
  BP_FEDERATION_INVITE,
  BP_FEDERATION_ID,
  AFRIBIT_KIBERA_FEDERATION_NAME,
  AFRIBIT_KIBERA_FEDERATION_INVITE,
  AFRIBIT_KIBERA_FEDERATION_ID,
  BITSACCO_FEDERATION_NAME,
  BITSACCO_FEDERATION_INVITE,
  BITSACCO_FEDERATION_ID,
  BLF_FEDERATION_NAME,
  BLF_FEDERATION_INVITE,
  BLF_FEDERATION_ID,
  GBF_FEDERATION_NAME,
  GBF_FEDERATION_INVITE,
  GBF_FEDERATION_ID,
  PUBLIC_FEDI_APPROVED_FEDERATIONS,
} from "./federation-invites.js";
import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export {
  BP_FEDERATION_NAME,
  BP_FEDERATION_INVITE,
  BP_FEDERATION_ID,
  AFRIBIT_KIBERA_FEDERATION_NAME,
  AFRIBIT_KIBERA_FEDERATION_INVITE,
  AFRIBIT_KIBERA_FEDERATION_ID,
  BITSACCO_FEDERATION_NAME,
  BITSACCO_FEDERATION_INVITE,
  BITSACCO_FEDERATION_ID,
  BLF_FEDERATION_NAME,
  BLF_FEDERATION_INVITE,
  BLF_FEDERATION_ID,
  GBF_FEDERATION_NAME,
  GBF_FEDERATION_INVITE,
  GBF_FEDERATION_ID,
  PUBLIC_FEDI_APPROVED_FEDERATIONS,
};

/**
 * localStorage key for a user-supplied custom invite code.
 * If present, takes precedence over the universal BLF fallback.
 */
export const CUSTOM_INVITE_STORAGE_KEY = "chama_federation_invite";

/**
 * Resolve the federation invite code to use at runtime, community-blind.
 * Custom user invite wins; otherwise fall back to BLF — the universal
 * backup federation (browser-reliable since the v0.5.0 canary iroh bump).
 * Community-aware callers should prefer `resolveFederationForCommunity(slug)`
 * so a community-pinned invite (e.g. ke-kes → Afribit) is honored.
 */
export function getFederationInvite(): string {
  try {
    const custom = getScopedStorageItem(CUSTOM_INVITE_STORAGE_KEY);
    if (custom && custom.trim().startsWith("fed1")) {
      return custom.trim();
    }
  } catch {
    // localStorage unavailable (SSR, etc.) — fall through to default
  }
  return BLF_FEDERATION_INVITE;
}

/**
 * Save a custom federation invite code. Pass empty string to clear
 * and revert to the default.
 */
export function setCustomFederationInvite(inviteCode: string): void {
  try {
    const trimmed = inviteCode.trim();
    if (!trimmed) {
      removeScopedStorageItem(CUSTOM_INVITE_STORAGE_KEY);
      return;
    }
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }
    setScopedStorageItem(CUSTOM_INVITE_STORAGE_KEY, trimmed);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Whether the user is currently overriding the default federation */
export function hasCustomFederation(): boolean {
  try {
    return !!getScopedStorageItem(CUSTOM_INVITE_STORAGE_KEY);
  } catch {
    return false;
  }
}

// ── Active joined invite (PR 5) ──────────────────────────────────────────
//
// Records the invite that the OPFS-resident wallet was actually joined
// with, separately from the user's preference (CUSTOM_INVITE_STORAGE_KEY).
// On next page load, initFedimint compares the two: if they diverge, the
// OPFS holds a stale federation and must be wiped before joining the
// preferred one. Without this reconciliation, a user who pastes a new
// custom invite and hits the old "case (b) silent no-op" gets stuck on
// whatever federation their OPFS was created with — a refresh wouldn't
// rescue them, since the OPFS persists across reloads.
//
// Written on every successful join/switch; cleared on full reset.
export const ACTIVE_INVITE_STORAGE_KEY = "chama_active_invite";

export function getActiveInvite(): string | null {
  try {
    const v = getScopedStorageItem(ACTIVE_INVITE_STORAGE_KEY);
    const trimmed = v?.trim();
    return trimmed && trimmed.startsWith("fed1") ? trimmed : null;
  } catch {
    return null;
  }
}

export function setActiveInvite(invite: string): void {
  try {
    const trimmed = invite.trim();
    if (!trimmed) {
      removeScopedStorageItem(ACTIVE_INVITE_STORAGE_KEY);
      return;
    }
    setScopedStorageItem(ACTIVE_INVITE_STORAGE_KEY, trimmed);
  } catch {
    // localStorage unavailable — silently no-op
  }
}

export function clearActiveInvite(): void {
  try {
    removeScopedStorageItem(ACTIVE_INVITE_STORAGE_KEY);
  } catch { /* no-op */ }
}

function normalizeFederationId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function expectedFederationIdForInvite(invite: string | null | undefined): string | null {
  const trimmed = invite?.trim();
  if (trimmed === BP_FEDERATION_INVITE) return BP_FEDERATION_ID;
  if (trimmed === AFRIBIT_KIBERA_FEDERATION_INVITE) return AFRIBIT_KIBERA_FEDERATION_ID;
  if (trimmed === BITSACCO_FEDERATION_INVITE) return BITSACCO_FEDERATION_ID;
  if (trimmed === BLF_FEDERATION_INVITE) return BLF_FEDERATION_ID;
  if (trimmed === GBF_FEDERATION_INVITE) return GBF_FEDERATION_ID;
  const publicFedi = PUBLIC_FEDI_APPROVED_FEDERATIONS.find((route) => route.invite === trimmed);
  if (publicFedi) return publicFedi.federationId;
  return null;
}

/**
 * Resolve the effective federation ID for a CREATE payload, including a narrow
 * compatibility path for listings published during the route-drift era.
 *
 * Modern listings carry a `fed` tag and it normally wins: it is the fast,
 * canonical route fact. Some pre-fix CREATEs, however, were stamped with a
 * stale `fed` while `mintUrl` and `community` both pointed at the intended
 * route. Open listings have no minted sats yet, so when those two independent
 * route fields agree on a known federation, treat the mismatched `fed` tag as
 * stale and use the corroborated route instead.
 *
 * Older listings may have no `fed` tag at all. In that shape, a resolvable
 * community is allowed to rescue a stale `mintUrl` because it is the only
 * user-visible route stamp carried by the card.
 */
export function effectiveCreateFederationId(inputs: {
  fed?: string | null;
  mintUrl?: string | null;
  community?: string | null;
} | null | undefined): string | undefined {
  const stampedFed = normalizeFederationId(inputs?.fed);
  const mintFed = normalizeFederationId(expectedFederationIdForInvite(inputs?.mintUrl));
  const communityInvite = getCommunityBySlug(inputs?.community)?.federationInvite ?? null;
  const communityFed = normalizeFederationId(expectedFederationIdForInvite(communityInvite));

  if (stampedFed) {
    if (mintFed && communityFed && mintFed === communityFed && stampedFed !== mintFed) {
      return mintFed;
    }
    return stampedFed;
  }

  if (communityFed) return communityFed;
  return mintFed ?? undefined;
}

// ── Cold-start drift detection (pure) ───────────────────────────────────
//
// Pure helper for initFedimint's reconcile gate. Returns true when the
// OPFS-resident wallet may be bound to a route that doesn't match the invite
// we want to use, in which case the caller must wipe + rejoin subject to the
// fund-loss balance guard.
//
// Two flavors of drift:
//   1. Tracked drift: previousActiveInvite is recorded and disagrees with
//      desiredInvite.
//   2. Untracked OPFS: previousActiveInvite is null, but the wallet is already
//      joined from a previous session. Sign-out/reload does not wipe OPFS.
//      Without this branch, joinFederation can record the requested invite
//      while the wallet stays bound to whatever route the OPFS already held,
//      producing CREATE events whose `mintUrl` and `fed` facts disagree.
//
// We can't peek an invite's fed-id without joining, so the untracked case is
// conservative for unknown routes. For curated routes, compare the desired
// invite's known federation ID to the wallet's actual federation ID before
// trusting localStorage. The caller's balance guard prevents silent bearer-cash
// loss.
export function shouldReconcileFederation(inputs: {
  previousActiveInvite: string | null;
  desiredInvite: string;
  walletIsJoined: boolean;
  walletFederationId?: string | null;
}): boolean {
  if (!inputs.walletIsJoined) return false;
  const previousInvite = inputs.previousActiveInvite?.trim() || null;
  const desiredInvite = inputs.desiredInvite.trim();
  const expectedFedId = expectedFederationIdForInvite(desiredInvite);
  const walletFedId = normalizeFederationId(inputs.walletFederationId);
  if (expectedFedId && walletFedId) {
    return expectedFedId !== walletFedId;
  }
  if (previousInvite === null) return true;
  return previousInvite !== desiredInvite;
}

// ══════════════════════════════════════════════════════════════════════════
// COMMUNITY-AWARE RESOLUTION
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: communities are the user-facing layer; federations
// are the technical layer that backs them. A community whose registry entry
// has federationInvite === null falls back to BLF — the universal backup
// federation, browser-reliable since the v0.5.0 canary iroh bump
// (DECISION 2026-06-16). The live default and visible US community
// (us-blf, "USA · USD") is BLF-backed. Historical us-gbf still resolves its
// original invite so already-signed trades remain recoverable.
//
// Precedence (highest first):
//   1. The community's federationInvite (when the registry has one)
//   2. User's pasted custom invite (manual override only without a pinned community)
//   3. BLF fallback
//
import { getCommunityBySlug } from "../communities/registry.js";

/**
 * Resolve the federation invite code for a given community slug.
 *
 * - Look up the community in the registry first. If the entry has a
 *   non-null federationInvite, use it. A selected community is an identity
 *   choice and must not be silently overridden by stale custom-route state.
 * - Otherwise, if the user has set a custom invite, use it as the manual
 *   override escape hatch.
 * - Otherwise (community null/unknown, or its federationInvite is null),
 *   fall back to BLF (the universal backup, DECISION 2026-06-16).
 */
export function resolveFederationForCommunity(slug: string | null | undefined): string {
  // 1. Community-mapped invite, if any. v0.8.0: this intentionally beats
  //    custom storage so a stale BLF/BP custom override cannot leave the UI
  //    showing Kenya while the wallet joins a different federation.
  const community = getCommunityBySlug(slug);
  if (community?.federationInvite) {
    return community.federationInvite;
  }

  // 2. Manual override only applies when there is no pinned community
  //    route. The Advanced/Sandbox picker still calls init/switch with an
  //    explicit invite and persists this key there.
  try {
    const custom = getScopedStorageItem(CUSTOM_INVITE_STORAGE_KEY);
    if (custom && custom.trim().startsWith("fed1")) {
      return custom.trim();
    }
  } catch {
    // localStorage unavailable — fall through
  }

  // 3. BLF fallback. The universal backup federation across the board
  //    (DECISION 2026-06-16). BLF is browser-reliable since the v0.5.0
  //    canary iroh bump, so it is the one default everywhere — community
  //    null/unknown, or its federationInvite is null.
  return BLF_FEDERATION_INVITE;
}

// ══════════════════════════════════════════════════════════════════════════
// FEDERATION PRESETS — Curated list for the dropdown picker
// ══════════════════════════════════════════════════════════════════════════

/**
 * Metadata describing a single Fedimint federation option in the picker.
 * Chama exposes routes we intentionally curate here, plus the user's own
 * custom invite in the advanced field.
 */
export interface FederationPreset {
  /** Display name shown in the picker */
  name: string;
  /** Federation ID (hex) if known; used for deduplication */
  federationId?: string;
  /** Full fed1 invite code */
  inviteCode: string;
  /** Short description or tagline for the picker row */
  description?: string;
  /** Origin: baked into this file. */
  source: "curated";
  /** Community arbiter pool — npubs designated by community leader */
  arbiters?: {
    /** Primary arbiter — auto-selected for new trades */
    primary: string;
    /** Secondary/backup arbiters — share is encrypted to all of them */
    pool: string[];
    /** Minimum arbiters required (enforced at UI level) */
    minArbiters?: number;
  };
  /** Optional URL for a community leader / community page */
  communityUrl?: string;
  /** Optional country / locality tag */
  region?: string;
}

/**
 * Curated federation list. It includes Chama-operated/private routes plus
 * the Fedi-approved public wallet services from the Discover screen. New
 * community-led federations should still enter through the permissionless
 * community-add primitive (see addCustomCommunity in
 * src/communities/registry.ts; v1.5 will publish kind:38112 community
 * claims to Nostr for cross-client discovery).
 */
export const CURATED_PRESETS: FederationPreset[] = [
  {
    name: BP_FEDERATION_NAME,
    federationId: BP_FEDERATION_ID,
    inviteCode: BP_FEDERATION_INVITE,
    description: "Browser-friendly default. Safe starting point.",
    source: "curated",
  },
  {
    name: BLF_FEDERATION_NAME,
    federationId: BLF_FEDERATION_ID,
    inviteCode: BLF_FEDERATION_INVITE,
    description: "Best on the mobile app — limited browser support today.",
    source: "curated",
  },
  {
    name: AFRIBIT_KIBERA_FEDERATION_NAME,
    federationId: AFRIBIT_KIBERA_FEDERATION_ID,
    inviteCode: AFRIBIT_KIBERA_FEDERATION_INVITE,
    description: "Kenya KES route for the Afribit Chama.",
    source: "curated",
    region: "KE",
  },
  {
    name: BITSACCO_FEDERATION_NAME,
    inviteCode: BITSACCO_FEDERATION_INVITE,
    description: "Kenya KES route for the Bitsacco Chama.",
    source: "curated",
    region: "KE",
  },
  {
    name: GBF_FEDERATION_NAME,
    federationId: GBF_FEDERATION_ID,
    inviteCode: GBF_FEDERATION_INVITE,
    description: "Native Rust sidecar test route. Public gateways reachable.",
    source: "curated",
  },
  ...PUBLIC_FEDI_APPROVED_FEDERATIONS
    .filter((route) => route.invite !== BP_FEDERATION_INVITE)
    .map((route): FederationPreset => ({
      name: route.name,
      federationId: route.federationId,
      inviteCode: route.invite,
      description: "Public Fedi-approved wallet service.",
      source: "curated",
      region: route.country ?? undefined,
    })),
];

export function federationNameForInvite(invite: string | null | undefined): string | null {
  const trimmed = invite?.trim();
  if (!trimmed) return null;
  return CURATED_PRESETS.find((preset) => preset.inviteCode === trimmed)?.name ?? null;
}

/**
 * Friendly name for the community-leader messaging shown under the picker.
 * Exported so the UI can keep the copy in one place.
 */
export const COMMUNITY_LEADER_MESSAGE =
  "Not sure which federation to join? Talk to your Community Leader. " +
  "All participants in a trade must use the same federation for the ecash " +
  "to be spendable across the Shamir shares — joining a federation your " +
  "community already uses keeps your circular economy intact.";
