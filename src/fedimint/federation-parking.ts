// H4: helpers for keeping one wallet per federation.
//
// Moving to another federation parks the open wallet under its federation
// (see arbiter-federation-store.ts) instead of deleting it. These pure helpers
// answer the two questions that needs: which invite reopens a parked wallet,
// and which federation an invite belongs to.

import { CURATED_PRESETS, expectedFederationIdForInvite, shouldReconcileFederation } from "./federation-config.js";
import {
  arbiterFederationStorageScope,
  getArbiterFederationRoute,
  listArbiterFederationRoutes,
  rememberArbiterFederationRoute,
} from "./arbiter-federation-store.js";
import type { FederationInspection } from "./federation-inspection.js";

/** The invite a parked wallet is reopened with: the invite it last joined
 *  when that names this federation (or can't be checked locally), else the
 *  one its route remembers, else a curated invite for it. Null when none is
 *  known, in which case the wallet cannot be parked. */
export function parkedInviteFor(pubkey: string | null, federationId: string, activeInvite: string | null): string | null {
  const fed = federationId.trim().toLowerCase();
  const active = activeInvite?.trim();
  if (active?.startsWith("fed1")) {
    const known = expectedFederationIdForInvite(active);
    if (known === null || known.toLowerCase() === fed) return active;
  }
  const remembered = pubkey ? getArbiterFederationRoute(pubkey, fed)?.inviteCode : undefined;
  if (remembered) return remembered;
  return CURATED_PRESETS.find((preset) => preset.federationId?.toLowerCase() === fed)?.inviteCode ?? null;
}

/** A remembered route found by the invite it joined with, so an unlisted
 *  federation reopens its own wallet without a network read. */
export function federationIdForRememberedInvite(pubkey: string, invite: string): string | null {
  const trimmed = invite.trim();
  return listArbiterFederationRoutes(pubkey).find((route) => route.inviteCode === trimmed)?.federationId ?? null;
}

/** Which federation an invite belongs to. Curated invites are known locally;
 *  any other is read from the federation itself (public config only: no
 *  wallet is opened or joined). Null when it can't be read. */
export async function federationIdForInvite(
  invite: string,
  client: { inspectFederation(invite: string): Promise<FederationInspection> } | null,
  preview?: (invite: string) => Promise<FederationInspection>,
): Promise<string | null> {
  const known = expectedFederationIdForInvite(invite);
  if (known) return known.toLowerCase();
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
