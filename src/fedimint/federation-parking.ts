// H4: helpers for keeping one wallet per federation.
//
// Moving to another federation parks the open wallet under its federation
// (see arbiter-federation-store.ts) instead of deleting it. These pure helpers
// answer the two questions that needs: which invite reopens a parked wallet,
// and which federation an invite belongs to.

import { CURATED_PRESETS, expectedFederationIdForInvite } from "./federation-config.js";
import { getArbiterFederationRoute, listArbiterFederationRoutes } from "./arbiter-federation-store.js";
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
