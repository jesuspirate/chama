/** Federation-scoped emergency receive killswitch.
 *
 * BLF was removed after repeated receive/mint passes and the final staged
 * 21-sat claim completed end to end. Keep the mechanism empty and available
 * for a future verified federation-specific incident; do not use per-origin
 * localStorage as a production safety boundary. */
const BLOCKED_BROWSER_LIGHTNING_RECEIVE_FEDERATIONS = new Set<string>();

/**
 * Compatibility support for a localhost-only field probe when a federation
 * is present in the emergency killswitch above. It is inert while the set is
 * empty and is not part of the enabled production route.
 *
 * The token is deliberately armed outside application UI and consumed before
 * gateway lookup or invoice creation. It cannot enable a production origin,
 * cannot authorize more than one invoice, and cannot authorize more than 50
 * sats. A failed receive therefore returns immediately to the shipped circuit
 * breaker instead of silently turning diagnostics into product behavior.
 */
export const BROWSER_LIGHTNING_RECEIVE_PROBE_KEY =
  "chama_browser_lightning_receive_probe_v1";
export const BROWSER_LIGHTNING_RECEIVE_PROBE_MAX_MSATS = 50_000;
/** Legacy local-only claim probe retained for diagnostic compatibility. The
 * production browser route no longer consults it: exact-note staged claim is
 * the only enabled implementation. */
export const BROWSER_LIGHTNING_CLAIM_PROBE_KEY =
  "chama_browser_lightning_claim_probe_v1";
export const BROWSER_LIGHTNING_CLAIM_PROBE_MAX_MSATS = 50_000;

function isLocalDevelopmentOrigin(): boolean {
  try {
    const hostname = globalThis.location?.hostname?.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function browserLightningReceiveProbeIsArmed(
  federationId: string | null | undefined,
  amountMsats: number,
): boolean {
  const normalizedFederationId = (federationId ?? "").trim().toLowerCase();
  if (
    !isLocalDevelopmentOrigin() ||
    !Number.isFinite(amountMsats) ||
    amountMsats <= 0 ||
    amountMsats > BROWSER_LIGHTNING_RECEIVE_PROBE_MAX_MSATS ||
    !BLOCKED_BROWSER_LIGHTNING_RECEIVE_FEDERATIONS.has(normalizedFederationId)
  ) return false;

  try {
    return globalThis.localStorage?.getItem(BROWSER_LIGHTNING_RECEIVE_PROBE_KEY) === "1";
  } catch {
    return false;
  }
}

export function consumeBrowserLightningReceiveProbe(
  federationId: string | null | undefined,
  amountMsats: number,
): boolean {
  if (!browserLightningReceiveProbeIsArmed(federationId, amountMsats)) return false;
  const normalizedFederationId = (federationId ?? "").trim().toLowerCase();
  try {
    // Burn authorization before any gateway call. A thrown createInvoice can
    // never leave a reusable permission behind.
    globalThis.localStorage.removeItem(BROWSER_LIGHTNING_RECEIVE_PROBE_KEY);
    console.warn(
      `[chama] Consumed localhost-only Lightning receive probe amountMsats=${amountMsats} federation=${normalizedFederationId}`,
    );
    return true;
  } catch {
    return false;
  }
}

export function browserLightningReceiveIsBlocked(
  federationId: string | null | undefined,
): boolean {
  return BLOCKED_BROWSER_LIGHTNING_RECEIVE_FEDERATIONS.has(
    (federationId ?? "").trim().toLowerCase(),
  );
}

/** Non-consuming UI check. This only decides whether the localhost claim
 * chooser may expose Lightning; the authorization is still burned by
 * consumeBrowserLightningClaimProbe immediately before CLAIM begins. */
export function browserLightningClaimProbeIsArmed(amountMsats: number): boolean {
  if (
    !isLocalDevelopmentOrigin() ||
    !Number.isFinite(amountMsats) ||
    amountMsats <= 0 ||
    amountMsats > BROWSER_LIGHTNING_CLAIM_PROBE_MAX_MSATS
  ) return false;
  try {
    return globalThis.localStorage?.getItem(BROWSER_LIGHTNING_CLAIM_PROBE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Legacy field-test query. Production claim routing does not consult it. */
export function browserLightningClaimFieldTestIsEnabled(amountMsats: number): boolean {
  return isLocalDevelopmentOrigin()
    && Number.isFinite(amountMsats)
    && amountMsats > 0
    && amountMsats <= BROWSER_LIGHTNING_CLAIM_PROBE_MAX_MSATS;
}

export function consumeBrowserLightningClaimProbe(amountMsats: number): boolean {
  if (!browserLightningClaimProbeIsArmed(amountMsats)) return false;
  try {
    // Burn before any escrow CLAIM or mint reissue. One authorization can
    // never turn into two attempts after a throw or refresh.
    globalThis.localStorage.removeItem(BROWSER_LIGHTNING_CLAIM_PROBE_KEY);
    console.warn(
      `[chama] Consumed localhost-only Lightning claim probe amountMsats=${amountMsats}`,
    );
    return true;
  } catch {
    return false;
  }
}
