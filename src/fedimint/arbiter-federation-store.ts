// Per-federation wallet storage routing.
//
// Ecash cannot cross federation boundaries, so every federation keeps its own
// client database. Bonded arbiters used this first; since H4 every wallet
// does, so moving to another federation parks the old wallet instead of
// deleting it. This registry only remembers which browser OPFS scope belongs
// to each federation (and the balance last seen there); it never stores
// ecash, keys, or a seed. The names keep their arbiter prefix so existing
// routes and storage scopes stay where they are.

const STORE_PREFIX = "chama_arbiter_federations_v1";

export interface ArbiterFederationRoute {
  federationId: string;
  inviteCode: string;
  storageScope: string;
  updatedAt: number;
  /** Balance read just before this wallet was parked. A last sighting, not
   *  a live balance: it is shown so a parked wallet is never forgotten. */
  lastBalanceMsats?: number;
}

interface StoredRoutes {
  version: 1;
  routes: Record<string, ArbiterFederationRoute>;
}

function storeKey(pubkey: string): string {
  return `${STORE_PREFIX}:${pubkey.trim().toLowerCase()}`;
}

function cleanFederationId(federationId: string): string {
  return federationId.trim().toLowerCase();
}

function read(pubkey: string): StoredRoutes {
  try {
    if (typeof localStorage === "undefined") return { version: 1, routes: {} };
    const raw = localStorage.getItem(storeKey(pubkey));
    if (!raw) return { version: 1, routes: {} };
    const parsed = JSON.parse(raw) as Partial<StoredRoutes>;
    if (parsed.version !== 1 || !parsed.routes || typeof parsed.routes !== "object") {
      return { version: 1, routes: {} };
    }
    const routes: Record<string, ArbiterFederationRoute> = {};
    for (const [key, value] of Object.entries(parsed.routes)) {
      if (!value || typeof value !== "object") continue;
      const route = value as Partial<ArbiterFederationRoute>;
      if (
        typeof route.federationId !== "string"
        || typeof route.inviteCode !== "string"
        || typeof route.storageScope !== "string"
        || typeof route.updatedAt !== "number"
      ) continue;
      const id = cleanFederationId(route.federationId || key);
      if (!id || !route.inviteCode.startsWith("fed1") || !route.storageScope) continue;
      const lastBalanceMsats = typeof route.lastBalanceMsats === "number"
        && Number.isFinite(route.lastBalanceMsats) && route.lastBalanceMsats >= 0
        ? route.lastBalanceMsats : undefined;
      routes[id] = {
        federationId: id,
        inviteCode: route.inviteCode,
        storageScope: route.storageScope,
        updatedAt: route.updatedAt,
        ...(lastBalanceMsats !== undefined ? { lastBalanceMsats } : {}),
      };
    }
    return { version: 1, routes };
  } catch {
    return { version: 1, routes: {} };
  }
}

function write(pubkey: string, value: StoredRoutes): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storeKey(pubkey), JSON.stringify(value));
  } catch {
    // A missing registry must fail closed into the existing balance guard; it
    // must never make a destructive switch appear safe.
  }
}

/** Stable scope for a newly joined arbiter federation. */
export function arbiterFederationStorageScope(pubkey: string, federationId: string): string {
  return `${pubkey.trim().toLowerCase()}:arbiter-fed:${cleanFederationId(federationId)}`;
}

export function getArbiterFederationRoute(
  pubkey: string,
  federationId: string,
): ArbiterFederationRoute | null {
  return read(pubkey).routes[cleanFederationId(federationId)] ?? null;
}

export function listArbiterFederationRoutes(pubkey: string): ArbiterFederationRoute[] {
  return Object.values(read(pubkey).routes).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function rememberArbiterFederationRoute(
  pubkey: string,
  route: Omit<ArbiterFederationRoute, "updatedAt"> & { updatedAt?: number },
): ArbiterFederationRoute {
  const state = read(pubkey);
  const federationId = cleanFederationId(route.federationId);
  // A route saved without a fresh balance keeps the last one seen, so a
  // failed read never makes a parked wallet disappear from view.
  const lastBalanceMsats = typeof route.lastBalanceMsats === "number"
    && Number.isFinite(route.lastBalanceMsats) && route.lastBalanceMsats >= 0
    ? route.lastBalanceMsats
    : state.routes[federationId]?.lastBalanceMsats;
  const saved: ArbiterFederationRoute = {
    federationId,
    inviteCode: route.inviteCode.trim(),
    storageScope: route.storageScope,
    updatedAt: route.updatedAt ?? Date.now(),
    ...(lastBalanceMsats !== undefined ? { lastBalanceMsats } : {}),
  };
  state.routes[federationId] = saved;
  write(pubkey, state);
  return saved;
}

/** #64 follow-up: forget a route written for a switch that never opened its
 *  wallet. A route that has seen a balance is kept: it may point at sats. */
export function forgetUnjoinedFederationRoute(pubkey: string, federationId: string): void {
  const state = read(pubkey);
  const id = cleanFederationId(federationId);
  const route = state.routes[id];
  if (!route || route.lastBalanceMsats !== undefined) return;
  delete state.routes[id];
  write(pubkey, state);
}
