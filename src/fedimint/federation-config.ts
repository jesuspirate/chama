// ══════════════════════════════════════════════════════════════════════════
// Chama — Federation Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Default Fedimint federation for new users. Advanced users can override
// this at runtime by pasting a custom invite code in the federation
// onboarding screen.
//
// If you don't already have a Fedimint wallet, the easiest way to manage
// your ecash balance on mobile is the Fedi app: https://www.fedi.xyz/

/**
 * Bitcoin Life Federation — the default community federation for Chama.
 * Beginner users join this federation automatically on first launch.
 */
export const DEFAULT_FEDERATION_NAME = "Bitcoin Life Federation";

export const DEFAULT_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram";

/**
 * localStorage key for a user-supplied custom invite code.
 * If present, takes precedence over DEFAULT_FEDERATION_INVITE.
 */
export const CUSTOM_INVITE_STORAGE_KEY = "chama_federation_invite";

/**
 * Resolve the federation invite code to use at runtime.
 * Custom user invite wins, otherwise fall back to the BLF default.
 */
export function getFederationInvite(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const custom = localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
      if (custom && custom.trim().startsWith("fed1")) {
        return custom.trim();
      }
    }
  } catch {
    // localStorage unavailable (SSR, etc.) — fall through to default
  }
  return DEFAULT_FEDERATION_INVITE;
}

/**
 * Save a custom federation invite code. Pass empty string to clear
 * and revert to the default.
 */
export function setCustomFederationInvite(inviteCode: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = inviteCode.trim();
    if (!trimmed) {
      localStorage.removeItem(CUSTOM_INVITE_STORAGE_KEY);
      return;
    }
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }
    localStorage.setItem(CUSTOM_INVITE_STORAGE_KEY, trimmed);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Whether the user is currently overriding the default federation */
export function hasCustomFederation(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return !!localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FEDERATION PRESETS — Curated + dynamic list for the dropdown picker
// ══════════════════════════════════════════════════════════════════════════

/**
 * Metadata describing a single Fedimint federation option in the picker.
 * Chama combines three sources at runtime:
 *   1. CURATED_PRESETS (this file) — BLF + any private invites baked in
 *   2. fetchObserverFederations() — live list from observer.fedimint.org
 *   3. User's own custom invite (advanced field)
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
  /** Origin: "curated" = baked into this file, "observer" = live fetch */
  source: "curated" | "observer";
  /** Optional URL for a community leader / community page */
  communityUrl?: string;
  /** Optional country / locality tag */
  region?: string;
}

/**
 * Curated federation list. Intentionally minimal: only the Bitcoin Life
 * Federation default lives here. Private federations are NOT baked into
 * this file — instead, Community Leaders surface their federations
 * organically via the arbiter / community-leader form (see roadmap for
 * kind-38109 community federation announcements published to Nostr).
 *
 * The wider public federation list is fetched live from
 * observer.fedimint.org at runtime — see `fetchObserverFederations()`.
 */
export const CURATED_PRESETS: FederationPreset[] = [
  {
    name: DEFAULT_FEDERATION_NAME,
    inviteCode: DEFAULT_FEDERATION_INVITE,
    description: "Default for new users. Safe starting point.",
    source: "curated",
  },
];

/**
 * Fetch the live public federation list from Fedimint Observer.
 *
 * The observer API returns an array of federations with fields like
 * `federation_id`, `federation_name`, `invite_code`, `nickname`, etc.
 * We normalize into FederationPreset[].
 *
 * Returns [] on any network/CORS/JSON error — the UI falls back to the
 * curated list, so failure is silent and non-blocking.
 */
export async function fetchObserverFederations(
  signal?: AbortSignal
): Promise<FederationPreset[]> {
  const OBSERVER_URL = "https://observer.fedimint.org/api/federations";
  try {
    const resp = await fetch(OBSERVER_URL, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      console.warn(`[chama] observer fetch failed: HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      console.warn("[chama] observer returned non-array payload");
      return [];
    }

    const presets: FederationPreset[] = [];
    for (const entry of data) {
      // The observer schema has shifted over versions. Defensively pull
      // whatever fields look relevant and skip entries without an invite.
      const inviteCode =
        entry?.invite ||
        entry?.invite_code ||
        entry?.inviteCode ||
        entry?.config?.invite_code ||
        null;
      if (typeof inviteCode !== "string" || !inviteCode.startsWith("fed1")) {
        continue;
      }
      const name =
        entry?.meta?.federation_name ||
        entry?.federation_name ||
        entry?.nickname ||
        entry?.name ||
        "Unnamed federation";
      const federationId =
        entry?.federation_id || entry?.federationId || undefined;
      const description =
        entry?.meta?.welcome_message ||
        entry?.description ||
        undefined;

      // Extract health + activity for display
      const health = entry?.health || "unknown";
      const deposits = entry?.deposits ? Math.floor(entry.deposits / 1000) : 0;
      const depositsSats = deposits > 0
        ? deposits > 1_000_000 ? `${(deposits / 1_000_000).toFixed(1)}M sats`
        : deposits > 1_000 ? `${(deposits / 1_000).toFixed(0)}k sats`
        : `${deposits} sats`
        : "";
      const descParts = [];
      if (health === "online") descParts.push("Online");
      else if (health === "offline") descParts.push("Offline");
      if (depositsSats) descParts.push(depositsSats + " deposits");
      if (description) descParts.push(description);

      presets.push({
        name: String(name).slice(0, 60),
        federationId: federationId ? String(federationId) : undefined,
        inviteCode,
        description: descParts.join(" · ").slice(0, 160) || undefined,
        source: "observer",
      });
    }
    return presets;
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.warn("[chama] observer fetch error:", e);
    }
    return [];
  }
}

/**
 * Merge curated + observer presets, deduplicating by federation ID or
 * invite code. Curated always wins over observer for the same federation.
 */
export function mergePresets(
  curated: FederationPreset[],
  observer: FederationPreset[]
): FederationPreset[] {
  const byKey = new Map<string, FederationPreset>();
  const keyFor = (p: FederationPreset) =>
    p.federationId || p.inviteCode.slice(0, 64);
  for (const p of curated) byKey.set(keyFor(p), p);
  for (const p of observer) {
    const k = keyFor(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  return [...byKey.values()];
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
