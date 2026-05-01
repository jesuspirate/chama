// ══════════════════════════════════════════════════════════════════════════
// Chama — Community Registry
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: Communities are the user-facing layer; federations
// are the technical layer. A community is currency-primary, country-and-
// language-multivalent. Users pick a community at sign-in; Chama silently
// provisions a wallet on the appropriate backing federation.
//
// v1: static slug + registry. Small honest seed list. The slug is what
// flows on the wire (CreatePayload.community, listing's "community" tag);
// the registry lives in the app and renders flags/languages/federation-
// mapping for that slug.
//
// federationInvite: null means "use BLF as fallback." Per the philosophy,
// no user is locked out by federation availability — community-run
// federations are progressively layered on top of BLF as they appear.
//
// Future: a v2 path will publish community definitions as Nostr events
// so communities can self-organize without a registry release. Slug + e
// reference is upgrade-safe.

export interface Community {
  /** Stable wire identifier — must never change once published. Lower-case
   *  region-or-scope hyphen currency. Examples: sn-cfa, ke-kes, sv-usd,
   *  global-usd. */
  slug: string;
  /** Human-readable display name in the UI. Localizable in v2. */
  displayName: string;
  /** Three-letter currency code (ISO 4217) — the load-bearing axis. */
  currency: string;
  /** ISO 3166-1 alpha-2 country codes the community spans. May be empty
   *  for genuinely scope-less communities (global-usd). */
  countries: string[];
  /** ISO 639-1 language codes spoken by the community. Listings and chat
   *  happen in any of these — Chama does not enforce one. */
  languages: string[];
  /** Federation invite code that backs this community's wallet. `null`
   *  means BLF (the universal fallback) — see resolveFederationForCommunity
   *  in fedimint/federation-config.ts. */
  federationInvite: string | null;
}

/** v1 seed list. Expand as real users surface real communities; see the
 *  PHILOSOPHY.md scope-creep test before adding speculative entries. */
export const COMMUNITY_REGISTRY: Community[] = [
  {
    slug: "sn-cfa",
    displayName: "Senegal · CFA",
    currency: "XOF",
    countries: ["SN"],
    languages: ["fr", "wo"],
    federationInvite: null,
  },
  {
    slug: "ke-kes",
    displayName: "Kenya · KES",
    currency: "KES",
    countries: ["KE"],
    languages: ["sw", "en"],
    federationInvite: null,
  },
  {
    slug: "sv-usd",
    displayName: "El Salvador · USD",
    currency: "USD",
    countries: ["SV"],
    languages: ["es"],
    federationInvite: null,
  },
  {
    slug: "global-usd",
    displayName: "Global · USD",
    currency: "USD",
    countries: [],
    languages: ["en", "es"],
    federationInvite: null,
  },
];

const BY_SLUG: Map<string, Community> = new Map(
  COMMUNITY_REGISTRY.map(c => [c.slug, c])
);

/** Look up a community by slug. Returns null if the slug is unknown
 *  (e.g. a listing from a future registry version). Callers must
 *  handle null — typically by treating the listing as cross-community
 *  and rendering a neutral pill. */
export function getCommunityBySlug(slug: string | null | undefined): Community | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}

/** Default community when the user hasn't picked one yet. global-usd
 *  exists precisely so first-launch users always have a sensible
 *  fallback that won't geofence them out of any listing. */
export const DEFAULT_COMMUNITY_SLUG = "global-usd";
