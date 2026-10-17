// H4: helpers for keeping one wallet per federation.
//
// Moving to another federation parks the open wallet under its federation
// (see arbiter-federation-store.ts) instead of deleting it. These pure helpers
// answer the two questions that needs: which invite reopens a parked wallet,
// and which federation an invite belongs to.

import { bech32m } from "@scure/base";
import { CURATED_PRESETS, expectedFederationIdForInvite, shouldReconcileFederation } from "./federation-config.js";
import {
  arbiterFederationStorageScope,
  getArbiterFederationRoute,
  listArbiterFederationRoutes,
  rememberArbiterFederationRoute,
} from "./arbiter-federation-store.js";
import type { FederationInspection } from "./federation-inspection.js";

/** The federation id written into an invite. Every fed1 invite carries it,
 *  so it is read locally, without asking the federation. Null when the
 *  invite can't be decoded (a malformed or unusually encoded invite): the
 *  caller then reads it from the federation, or refuses. */
export function federationIdFromInvite(invite: string | null | undefined): string | null {
  const trimmed = invite?.trim().toLowerCase();
  if (!trimmed?.startsWith("fed1")) return null;
  let bytes: Uint8Array;
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, 10_000);
    if (decoded.prefix !== "fed1") return null;
    bytes = bech32m.fromWords(decoded.words);
  } catch {
    return null;
  }
  // Consensus encoding: a count of parts, then per part a variant and a
  // length-prefixed payload. Variant 1 is the 32-byte federation id. Only
  // one-byte lengths are read; anything longer is left to the network read.
  let at = 0;
  const small = (): number => {
    const value = bytes[at++];
    if (value === undefined || value >= 0x80) throw new Error("unsupported");
    return value;
  };
  try {
    const parts = small();
    let id: string | null = null;
    for (let i = 0; i < parts; i++) {
      const variant = small();
      const length = small();
      if (at + length > bytes.length) return null;
      if (variant === 1) {
        if (length !== 32) return null;
        const hex = Array.from(bytes.subarray(at, at + 32), (b) => b.toString(16).padStart(2, "0")).join("");
        if (id && id !== hex) return null;
        id = hex;
      }
      at += length;
    }
    return at === bytes.length ? id : null;
  } catch {
    return null;
  }
}

/** The federation id an invite is known to name without a network read:
 *  a listed one, else the id written into the invite. */
export function knownFederationIdForInvite(invite: string | null | undefined): string | null {
  return expectedFederationIdForInvite(invite)?.toLowerCase() ?? federationIdFromInvite(invite);
}

/** The invite a parked wallet is reopened with: the invite it last joined
 *  when that is known to name this federation, else the one its route
 *  remembers, else a curated invite for it. An invite whose federation
 *  can't be checked is never pinned onto the open wallet: that is how one
 *  federation's wallet came to be reopened for another. Null when none is
 *  known, in which case the wallet cannot be parked. */
export function parkedInviteFor(pubkey: string | null, federationId: string, activeInvite: string | null): string | null {
  const fed = federationId.trim().toLowerCase();
  const active = activeInvite?.trim();
  const remembered = pubkey ? getArbiterFederationRoute(pubkey, fed)?.inviteCode : undefined;
  if (active?.startsWith("fed1") && knownFederationIdForInvite(active) === fed
    && inviteToRemember(remembered, active) === active) return active;
  if (remembered) return remembered;
  return CURATED_PRESETS.find((preset) => preset.federationId?.toLowerCase() === fed)?.inviteCode ?? null;
}

/** The invite a federation's route keeps when another is offered for it.
 *  An unlisted invite only claims its federation id (anyone can write one
 *  that points at other guardians), so it never replaces the invite a route
 *  already reopens its wallet with; a listed invite, or a route with none
 *  yet, takes the offered one. The caller has already matched the ids. */
export function inviteToRemember(existing: string | null | undefined, offered: string): string {
  const current = existing?.trim();
  const next = offered.trim();
  if (!current || current === next || expectedFederationIdForInvite(next)) return next;
  return current;
}

/** A remembered route found by the invite it joined with, so an unlisted
 *  federation reopens its own wallet without a network read. */
export function federationIdForRememberedInvite(pubkey: string, invite: string): string | null {
  const trimmed = invite.trim();
  return listArbiterFederationRoutes(pubkey).find((route) => route.inviteCode === trimmed)?.federationId ?? null;
}

/** Which federation an invite belongs to. Known locally for a listed or
 *  decodable invite; any other is read from the federation itself (public
 *  config only: no wallet is opened or joined). Null when it can't be read. */
export async function federationIdForInvite(
  invite: string,
  client: { inspectFederation(invite: string): Promise<FederationInspection> } | null,
  preview?: (invite: string) => Promise<FederationInspection>,
): Promise<string | null> {
  const known = knownFederationIdForInvite(invite);
  if (known) return known;
  try {
    const inspected = client
      ? await client.inspectFederation(invite)
      : await (preview ?? (await import("./sdk-adapter.js")).previewPublicFederation)(invite);
    const id = inspected.federationId?.trim().toLowerCase();
    return id && /^[0-9a-f]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function cleanId(value: string | null | undefined): string | null {
  const id = value?.trim().toLowerCase();
  return id && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/** The browser storage scope a wallet for `federationId` lives in: its
 *  remembered route, else the identity's first (legacy) file while no other
 *  federation claims it, else a scope of its own. */
export function scopeForFederation(pubkey: string, federationId: string | null): string {
  const fed = cleanId(federationId);
  if (fed) {
    const route = getArbiterFederationRoute(pubkey, fed);
    if (route) return route.storageScope;
    const legacyClaimed = listArbiterFederationRoutes(pubkey)
      .some((route) => route.storageScope === pubkey && route.federationId !== fed);
    if (legacyClaimed) return arbiterFederationStorageScope(pubkey, fed);
  }
  return pubkey;
}

/** Browser: the file to open for a wanted federation. A federation whose id
 *  is unknown is refused rather than given the identity's first file, which
 *  may already be another federation's wallet; nothing could then tell that
 *  wallet apart from the one wanted (a top-up would land in the wrong one). */
export function planBrowserWalletScope(pubkey: string, federationId: string | null):
  | { kind: "open"; scope: string }
  | { kind: "refuse"; reason: "target-unverified" } {
  if (!cleanId(federationId)) return { kind: "refuse", reason: "target-unverified" };
  return { kind: "open", scope: scopeForFederation(pubkey, federationId) };
}

/** The route to record after a successful join, or null when the join does
 *  not prove which federation the invite names. The joined client's id is
 *  authoritative for the file; the invite is only recorded with it when it
 *  was checked to name that federation, a fresh file joined with it, or the
 *  route already records it. A file another federation's route claims is
 *  never given a second owner. */
export function routeAfterJoin(inputs: {
  pubkey: string;
  joinedFederationId: string | null | undefined;
  joinedInvite: string;
  desiredFederationId: string | null | undefined;
  /** The file already held a joined wallet before this join. */
  reopenedWallet: boolean;
  /** The browser file opened; informational (null is fine) in native mode. */
  openScope: string | null;
  native: boolean;
}): { federationId: string; inviteCode: string; storageScope: string } | null {
  const fed = cleanId(inputs.joinedFederationId);
  const invite = inputs.joinedInvite.trim();
  if (!fed || !invite.startsWith("fed1")) return null;
  const desired = cleanId(inputs.desiredFederationId);
  if (desired && desired !== fed) return null;
  const existing = getArbiterFederationRoute(inputs.pubkey, fed);
  if (desired !== fed && inputs.reopenedWallet && existing?.inviteCode !== invite) return null;
  const storageScope = inputs.native
    ? existing?.storageScope ?? inputs.openScope ?? inputs.pubkey
    : inputs.openScope;
  if (!storageScope) return null;
  if (!inputs.native && scopeHoldsParkedWallet(inputs.pubkey, storageScope, fed)) return null;
  // A reopened wallet's join never reached the guardians with this invite,
  // so it proves nothing about it: the route keeps the invite it has.
  const inviteCode = inputs.reopenedWallet ? inviteToRemember(existing?.inviteCode, invite) : invite;
  return { federationId: fed, inviteCode, storageScope };
}

/** Whether the open wallet is on a different federation from the one wanted.
 *  Compares federation ids when both are known (an unlisted invite has no
 *  locally known id, so comparing invite strings alone misreads it). */
export function walletDrifted(inputs: {
  walletIsJoined: boolean;
  walletFederationId: string | null | undefined;
  desiredFederationId: string | null | undefined;
  previousActiveInvite: string | null;
  desiredInvite: string;
}): boolean {
  if (!inputs.walletIsJoined) return false;
  const wallet = cleanId(inputs.walletFederationId);
  const desired = cleanId(inputs.desiredFederationId);
  if (wallet && desired) return wallet !== desired;
  return shouldReconcileFederation({
    previousActiveInvite: inputs.previousActiveInvite,
    desiredInvite: inputs.desiredInvite,
    walletIsJoined: inputs.walletIsJoined,
    walletFederationId: inputs.walletFederationId,
  });
}

export type DriftPlan =
  /** Park the open wallet under its federation and open `targetScope`. */
  | { kind: "park"; park: { federationId: string; inviteCode: string; storageScope: string }; targetScope: string }
  /** Moving is not safe; nothing changes. */
  | { kind: "refuse"; reason: "target-unreadable" | "scope-collision" }
  /** The open wallet can't be reopened later (no invite is known for it):
   *  only an empty wallet, or a confirmed one, may be replaced. */
  | { kind: "replace-if-empty" };

/** What to do when a browser wallet opened on the wrong federation. */
export function planBrowserDrift(inputs: {
  pubkey: string;
  walletFederationId: string;
  openScope: string;
  desiredFederationId: string | null;
  previousActiveInvite: string | null;
}): DriftPlan {
  const desired = cleanId(inputs.desiredFederationId);
  if (!desired) return { kind: "refuse", reason: "target-unreadable" };
  const wallet = inputs.walletFederationId.trim().toLowerCase();
  const invite = parkedInviteFor(inputs.pubkey, wallet, inputs.previousActiveInvite);
  if (!invite) return { kind: "replace-if-empty" };
  const targetScope = getArbiterFederationRoute(inputs.pubkey, desired)?.storageScope
    ?? arbiterFederationStorageScope(inputs.pubkey, desired);
  if (targetScope === inputs.openScope) return { kind: "refuse", reason: "scope-collision" };
  return { kind: "park", park: { federationId: wallet, inviteCode: invite, storageScope: inputs.openScope }, targetScope };
}

/** Remember a route and prove it was saved. A wallet is only moved away
 *  from once its way back is on disk. */
export function rememberRouteOrThrow(
  pubkey: string,
  route: { federationId: string; inviteCode: string; storageScope: string; lastBalanceMsats?: number },
): void {
  const previous = getArbiterFederationRoute(pubkey, route.federationId);
  rememberArbiterFederationRoute(pubkey, {
    ...route,
    // A failed balance read keeps the last sighting rather than forgetting it.
    lastBalanceMsats: route.lastBalanceMsats ?? previous?.lastBalanceMsats,
  });
  const saved = getArbiterFederationRoute(pubkey, route.federationId);
  if (!saved || saved.storageScope !== route.storageScope || saved.inviteCode !== route.inviteCode.trim()) {
    const err = new Error(
      "Chama couldn't save where this wallet is kept, so it didn't switch. Nothing was changed.",
    ) as Error & { code?: string };
    err.code = "FEDERATION_ROUTE_NOT_SAVED";
    throw err;
  }
}

/** A storage scope some remembered route still points at. Such a file is a
 *  parked wallet and is never wiped to make room. */
export function scopeHoldsParkedWallet(pubkey: string, scope: string, exceptFederationId?: string | null): boolean {
  const except = cleanId(exceptFederationId);
  return listArbiterFederationRoutes(pubkey)
    .some((route) => route.storageScope === scope && route.federationId !== except);
}
