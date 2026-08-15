// ══════════════════════════════════════════════════════════════════════════
// Chama — Community Registry
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: Communities are the user-facing layer; federations
// are the technical layer. A community is currency-primary, country-and-
// language-multivalent. Users pick a community at sign-in; Chama silently
// provisions a wallet on the appropriate backing federation.
//
// v0.1.85 schema additions: flagEmoji, country, browserReliable, notes,
// disambiguator, hiddenFromPicker. The brief's pre-seed list is curated
// to federations Jetty has operational relationships with or proven
// testing history — every other federation is left to its community
// leader to claim permissionlessly via addCustomCommunity(). The curated
// picker can hide old slugs while keeping them resolvable on the wire.
//
// federationInvite is non-null for every pre-seeded entry in v0.1.85.
// The legacy `null` semantics (fall through to a default) survive only
// for back-compat with on-the-wire listings that carry an unknown slug —
// in that case `resolveFederationForCommunity` returns BP per
// federation-config.ts.

// Pull invite constants from the dedicated module rather than
// federation-config.js — the latter imports back into registry for
// resolveFederationForCommunity, and we'd hit a TDZ on COMMUNITY_REGISTRY
// initialization if we let that cycle stand.
import {
  AFRIBIT_KIBERA_FEDERATION_INVITE,
  BITSACCO_FEDERATION_INVITE,
  BLF_FEDERATION_INVITE,
  BLF_FEDERATION_NAME,
  GBF_FEDERATION_INVITE,
  OCA_FEDERATION_INVITE,
  OCA_FEDERATION_NAME,
  LATNET_FEDERATION_INVITE,
  LATNET_FEDERATION_NAME,
  PUBLIC_FEDI_APPROVED_FEDERATIONS,
  type PublicFediFederation,
} from "../fedimint/federation-invites.js";

export interface Community {
  /** Stable wire identifier — must never change once published. Lower-case
   *  region-or-scope hyphen currency. Examples: sn-cfa, ke-kes, sv-usd,
   *  global-usd, us-blf. */
  slug: string;
  /** Human-readable display name in the UI. Localizable in v2. */
  displayName: string;
  /** Three-letter currency code (ISO 4217) — the load-bearing axis. */
  currency: string;
  /** ISO 3166-1 alpha-2 country codes the community spans. May be empty
   *  for genuinely scope-less communities (Global · USD). */
  countries: string[];
  /** ISO 639-1 language codes spoken by the community. Listings and chat
   *  happen in any of these — Chama does not enforce one. */
  languages: string[];
  /** Federation invite code that backs this community's wallet. `null`
   *  falls through to BP per resolveFederationForCommunity — used only
   *  for legacy/wire-stale slugs; every pre-seeded entry pins explicitly. */
  federationInvite: string | null;
  /** V3 roster anchor (hybrid authority, see arbiters/roster.ts): the hex
   *  pubkey allowed to sign this community's kind:38120 arbiter roster.
   *  Curated communities pin one here; permissionless shells fall back to
   *  creatorPubkey. Absent ⇒ rosters for this community stay unverifiable. */
  stewardPubkey?: string | null;
  /** V3 roster anchor fallback: the npub/hex of whoever created a custom
   *  community shell (recorded by addCustomCommunity going forward). */
  creatorPubkey?: string | null;
  /** Single flag emoji for the community pill. 🌎 / 🌍 are valid for
   *  scope-less or regional communities. */
  flagEmoji: string;
  /** Optional Browse-tile chip accent (hex). Lets two different federations
   *  read as distinct at a glance instead of all sharing the neutral grey
   *  chip. Hand-picked from a SAFE palette that never collides with the
   *  sacred role colors (buyer/seller/arbiter) or the status pills — a fed is
   *  an identity, not a role. Absent ⇒ neutral grey (the default). The amber
   *  "off-route" tile state still overrides this. */
  chipAccent?: string | null;
  /** ISO country code for the primary flag-display country. `null` for
   *  global / regional aggregators. */
  country: string | null;
  /** Optional first-run/onboarding label when the picker should name the
   *  backing wallet service instead of the stable community identity. */
  pickerLabel?: string;
  /** True when the backing federation works reliably from browsers.
   *  v0.5.0: now true across the board after the Fedimint canary SDK
   *  bumped iroh-relay to 0.90 and resolved the 400 Bad Request that
   *  previously gated browser transport. The flag stays in the schema
   *  so individual entries can flip back to false if a specific
   *  federation regresses. APK users are unaffected either way. */
  browserReliable: boolean;
  /** Optional internal note, NOT shown to users. Tracks why a federation
   *  has the reliability flag it does, etc. */
  notes: string | null;
  /** Optional disambiguator suffix when multiple federations serve one
   *  country (e.g. Kenya · Afribit vs Kenya · Bitsacco). Null until
   *  needed; gets set when a second federation for the same country is
   *  added. */
  disambiguator: string | null;
  /** When true, the entry resolves on-the-wire (existing listings still
   *  render correctly) but is hidden from the community picker. Used
   *  for slugs we're sunsetting from the curated list while preserving
   *  back-compat. */
  hiddenFromPicker: boolean;
}

/** Shared notes string. 2026-06-25: the G-Bot federations (GBF, BLF, OCA,
 *  LatNet) are the same Fedi-hosted class and were verified NATIVE end-to-end
 *  by Jetty — Afghanistan(BLF), Benin/Tanzania(OCA), Mexico(LatNet), US(GBF) —
 *  lock/claim flawless on the native Rust sidecar (post #17 pkarr discovery +
 *  #9 gateway-picker). Browser/WASM is de-emphasized for now (not promoted);
 *  revive it when the WASM fedimint-core SDK firms up. The `browserReliable`
 *  flag stays in the schema, unchanged, for that future. */
const NATIVE_VERIFIED_NOTE =
  "Native Fedimint sidecar verified end-to-end.";

export const EAST_AFRICA_COUNTRY_CODES = [
  "BI", "KM", "DJ", "ER", "ET", "KE", "MG", "MW", "MU",
  "MZ", "RW", "SC", "SO", "SS", "TZ", "UG", "ZM", "ZW",
] as const;

export const WEST_AFRICA_COUNTRY_CODES = [
  "BJ", "BF", "CV", "CI", "GM", "GH", "GN", "GW",
  "LR", "ML", "MR", "NE", "NG", "SN", "SL", "TG",
] as const;

export const CENTRAL_AFRICA_COUNTRY_CODES = [
  "AO", "CM", "CF", "TD", "CG", "CD", "GQ", "GA", "ST",
] as const;

export interface CountryChamaSeed {
  country: string;
  name: string;
  currency: string;
  languages: string[];
  slug?: string;
  displayName?: string;
}

export function flagEmojiForCountry(country: string): string {
  // v3.1 B3 guard: `country` can arrive on an untrusted wire CREATE (it bypasses
  // validateCreatePayload), so anything that isn't a 2-letter ISO code would
  // render regional-indicator garbage ("foo" → 🇫🇴🇴, "12" → 🇖🇗). Reject those
  // and fall back to a neutral globe.
  if (!/^[A-Za-z]{2}$/.test(country)) return "🌐";
  const codePoints = country.toUpperCase().split("")
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// v2.6 regional default routing. A country WITHOUT a real local Chama
// (no elected/bonded arbiters yet) shouldn't all funnel onto BLF — it routes
// to a sensible regional federation so each region "feels the love":
//   Africa → Orange Club Africa · Latin America → LatNet · everywhere else → BLF.
// Deterministic and sticky on purpose — NOT a boot-time rotation: a user's
// backing fed must never change underneath them (Pillar 2.1 stickiness, and
// a changed fed under a held ecash balance would strand it). US and Canada
// now resolve to BLF; this resolver feeds their country shells/defaults.
const AFRICA_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG",
  "CD", "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN",
  "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ",
  "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD",
  "TZ", "TG", "TN", "UG", "ZM", "ZW",
]);

// Latin America + the wider non-US/Canada Americas → LatNet.
const LATAM_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AG", "AR", "BS", "BB", "BZ", "BO", "BR", "CL", "CO", "CR", "CU", "DM",
  "DO", "EC", "SV", "GD", "GT", "GY", "HT", "HN", "JM", "MX", "NI", "PA",
  "PY", "PE", "KN", "LC", "VC", "SR", "TT", "UY", "VE",
]);

/** The default backing federation for a country with no real local Chama.
 *  Regional: Africa→OCA, Latin America→LatNet, else→BLF. */
export function defaultFederationForCountry(
  country: string | null,
): { invite: string; name: string } {
  const cc = (country ?? "").toUpperCase();
  if (AFRICA_COUNTRY_CODES.has(cc)) return { invite: OCA_FEDERATION_INVITE, name: OCA_FEDERATION_NAME };
  if (LATAM_COUNTRY_CODES.has(cc)) return { invite: LATNET_FEDERATION_INVITE, name: LATNET_FEDERATION_NAME };
  return { invite: BLF_FEDERATION_INVITE, name: BLF_FEDERATION_NAME };
}

/** Build a country community on its REGIONAL default federation (see
 *  defaultFederationForCountry). Used for the pre-seed country shells and for
 *  the picker's generated full-ISO shells, so both route identically. */
export function defaultCountryChama(seed: CountryChamaSeed): Community {
  const currency = seed.currency.toUpperCase();
  const fed = defaultFederationForCountry(seed.country);
  return {
    slug: seed.slug ?? `${seed.country.toLowerCase()}-${currency.toLowerCase()}`,
    displayName: seed.displayName ?? `${seed.name} · ${currency}`,
    currency,
    countries: [seed.country],
    languages: seed.languages,
    federationInvite: fed.invite,
    flagEmoji: flagEmojiForCountry(seed.country),
    country: seed.country,
    browserReliable: true,
    notes: `${NATIVE_VERIFIED_NOTE} Default route: ${fed.name}.`,
    disambiguator: null,
    hiddenFromPicker: false,
  };
}

const KENYA_AFRIBIT_CHAMA: Community = {
  slug: "ke-kes",
  displayName: "Kenya · KES",
  currency: "KES",
  countries: ["KE"],
  languages: ["sw", "en"],
  federationInvite: AFRIBIT_KIBERA_FEDERATION_INVITE,
  flagEmoji: "🇰🇪",
  country: "KE",
  browserReliable: true,
  notes: "Native Fedimint sidecar route wired for Afribit Kibera.",
  disambiguator: "Afribit Kibera",
  hiddenFromPicker: false,
};

const KENYA_BITSACCO_CHAMA: Community = {
  slug: "ke-kes-bitsacco",
  displayName: "Kenya · KES",
  currency: "KES",
  countries: ["KE"],
  languages: ["sw", "en"],
  federationInvite: BITSACCO_FEDERATION_INVITE,
  flagEmoji: "🇰🇪",
  country: "KE",
  browserReliable: true,
  notes: `${NATIVE_VERIFIED_NOTE} Kenya route backed by Bitsacco.`,
  disambiguator: "Bitsacco",
  hiddenFromPicker: false,
};

function publicFediWalletServiceChama(route: PublicFediFederation): Community {
  return {
    slug: route.slug,
    displayName: route.name,
    currency: "BTC",
    countries: route.country ? [route.country] : [],
    languages: ["en"],
    federationInvite: route.invite,
    flagEmoji: route.flagEmoji,
    country: route.country,
    browserReliable: true,
    notes: `${NATIVE_VERIFIED_NOTE} Public Fedi-approved wallet service.`,
    disambiguator: null,
    hiddenFromPicker: false,
  };
}

const PUBLIC_FEDI_WALLET_SERVICE_CHAMAS: Community[] =
  PUBLIC_FEDI_APPROVED_FEDERATIONS.map(publicFediWalletServiceChama);

const SOUTH_AFRICA_GLOBAL_CHAMA: Community = defaultCountryChama({
  country: "ZA",
  name: "South Africa",
  currency: "ZAR",
  languages: ["en", "af", "zu", "xh"],
});

const EAST_AFRICA_COUNTRY_CHAMAS: Community[] = [
  defaultCountryChama({ country: "BI", name: "Burundi", currency: "BIF", languages: ["rn", "fr", "en"] }),
  defaultCountryChama({ country: "KM", name: "Comoros", currency: "KMF", languages: ["ar", "fr"] }),
  defaultCountryChama({ country: "DJ", name: "Djibouti", currency: "DJF", languages: ["fr", "ar"] }),
  defaultCountryChama({ country: "ER", name: "Eritrea", currency: "ERN", languages: ["ti", "ar", "en"] }),
  defaultCountryChama({ country: "ET", name: "Ethiopia", currency: "ETB", languages: ["am", "en"] }),
  KENYA_AFRIBIT_CHAMA,
  KENYA_BITSACCO_CHAMA,
  defaultCountryChama({ country: "MG", name: "Madagascar", currency: "MGA", languages: ["mg", "fr"] }),
  defaultCountryChama({ country: "MW", name: "Malawi", currency: "MWK", languages: ["en", "ny"] }),
  defaultCountryChama({ country: "MU", name: "Mauritius", currency: "MUR", languages: ["en", "fr"] }),
  defaultCountryChama({ country: "MZ", name: "Mozambique", currency: "MZN", languages: ["pt"] }),
  defaultCountryChama({ country: "RW", name: "Rwanda", currency: "RWF", languages: ["rw", "en", "fr"] }),
  defaultCountryChama({ country: "SC", name: "Seychelles", currency: "SCR", languages: ["en", "fr"] }),
  defaultCountryChama({ country: "SO", name: "Somalia", currency: "SOS", languages: ["so", "ar"] }),
  defaultCountryChama({ country: "SS", name: "South Sudan", currency: "SSP", languages: ["en"] }),
  defaultCountryChama({ country: "UG", name: "Uganda", currency: "UGX", languages: ["en", "sw"] }),
  defaultCountryChama({ country: "ZM", name: "Zambia", currency: "ZMW", languages: ["en"] }),
  defaultCountryChama({ country: "ZW", name: "Zimbabwe", currency: "ZWG", languages: ["en", "sn", "nd"] }),
];

const WEST_AFRICA_COUNTRY_CHAMAS: Community[] = [
  defaultCountryChama({ country: "BJ", name: "Benin", currency: "XOF", languages: ["fr"] }),
  defaultCountryChama({ country: "BF", name: "Burkina Faso", currency: "XOF", languages: ["fr"] }),
  defaultCountryChama({ country: "CV", name: "Cabo Verde", currency: "CVE", languages: ["pt"] }),
  defaultCountryChama({ country: "CI", name: "Côte d'Ivoire", currency: "XOF", languages: ["fr"] }),
  defaultCountryChama({ country: "GM", name: "Gambia", currency: "GMD", languages: ["en"] }),
  defaultCountryChama({ country: "GH", name: "Ghana", currency: "GHS", languages: ["en"] }),
  defaultCountryChama({ country: "GN", name: "Guinea", currency: "GNF", languages: ["fr"] }),
  defaultCountryChama({ country: "GW", name: "Guinea-Bissau", currency: "XOF", languages: ["pt"] }),
  defaultCountryChama({ country: "LR", name: "Liberia", currency: "LRD", languages: ["en"] }),
  defaultCountryChama({ country: "ML", name: "Mali", currency: "XOF", languages: ["fr"] }),
  defaultCountryChama({ country: "MR", name: "Mauritania", currency: "MRU", languages: ["ar", "fr"] }),
  defaultCountryChama({ country: "NE", name: "Niger", currency: "XOF", languages: ["fr"] }),
  defaultCountryChama({ country: "NG", name: "Nigeria", currency: "NGN", languages: ["en"] }),
  defaultCountryChama({ country: "SL", name: "Sierra Leone", currency: "SLE", languages: ["en"] }),
  defaultCountryChama({ country: "TG", name: "Togo", currency: "XOF", languages: ["fr"] }),
];

const CENTRAL_AFRICA_COUNTRY_CHAMAS: Community[] = [
  defaultCountryChama({ country: "AO", name: "Angola", currency: "AOA", languages: ["pt"] }),
  defaultCountryChama({ country: "CM", name: "Cameroon", currency: "XAF", languages: ["fr", "en"] }),
  defaultCountryChama({ country: "CF", name: "Central African Republic", currency: "XAF", languages: ["fr", "sg"] }),
  defaultCountryChama({ country: "TD", name: "Chad", currency: "XAF", languages: ["fr", "ar"] }),
  defaultCountryChama({ country: "CG", name: "Republic of the Congo", currency: "XAF", languages: ["fr"] }),
  defaultCountryChama({ country: "CD", name: "DR Congo", currency: "CDF", languages: ["fr", "ln", "sw"] }),
  defaultCountryChama({ country: "GQ", name: "Equatorial Guinea", currency: "XAF", languages: ["es", "fr", "pt"] }),
  defaultCountryChama({ country: "GA", name: "Gabon", currency: "XAF", languages: ["fr"] }),
  defaultCountryChama({ country: "ST", name: "Sao Tome and Principe", currency: "STN", languages: ["pt"] }),
];

/** v0.1.85 pre-seed list, expanded in v0.7.0 to make country-first
 *  onboarding feel welcoming across East, West, and Central Africa.
 *  Most country
 *  shells are backed by BLF until a country-specific federation is
 *  claimed; permissionless additions still go via `addCustomCommunity()`
 *  to localStorage.
 *
 *  PRE-SEED ORDER MATTERS for default-first storage and legacy lookup;
 *  the onboarding picker sorts countries alphabetically inside filters. */
export const COMMUNITY_REGISTRY: Community[] = [
  {
    slug: "us-blf",
    displayName: "USA · USD",
    currency: "USD",
    countries: ["US"],
    languages: ["en", "es", "fr"],
    federationInvite: BLF_FEDERATION_INVITE,
    flagEmoji: "🇺🇸",
    country: "US",
    pickerLabel: "Bitcoin Life Federation",
    chipAccent: "#6366f1", // indigo — distinct from arbiter cyan + buyer magenta
    browserReliable: true,
    notes: NATIVE_VERIFIED_NOTE,
    disambiguator: "BLF",
    // v6.0: BLF replaces GBF as the visible US anchor as well as the
    // universal/default route. Canada already resolves to BLF through its
    // country shell. One route, one federation, no GBF default drift.
    hiddenFromPicker: false,
    // V3 roster authority (maintainer's steward key, pinned 2026-06-08):
    // npub1ytm3v8mkup6mnc9z2zjy0zz2czdsfd3kal7hcup6jgu5a5lm885qhup3z6
    stewardPubkey: "22f7161f76e075b9e0a250a447884ac09b04b636effd7c703a92394ed3fb39e8",
  },
  {
    slug: "us-gbf",
    displayName: "USA · USD",
    currency: "USD",
    countries: ["US"],
    languages: ["en"],
    federationInvite: GBF_FEDERATION_INVITE,
    flagEmoji: "🇺🇸",
    country: "US",
    pickerLabel: "Global Bitcoin Federation",
    chipAccent: "#0d9488", // deep teal — distinct from BLF indigo, not a role hue
    browserReliable: true,
    notes: "Native Fedimint sidecar route verified end-to-end against GBF.",
    disambiguator: "GBF",
    // Historical resolver only. Old signed GBF trades must keep their real
    // federation route, but no new home/listing should anchor here.
    hiddenFromPicker: true,
  },
  ...PUBLIC_FEDI_WALLET_SERVICE_CHAMAS,
  SOUTH_AFRICA_GLOBAL_CHAMA,
  {
    slug: "sn-cfa",
    displayName: "Senegal · CFA",
    currency: "XOF",
    countries: ["SN"],
    languages: ["fr", "wo"],
    federationInvite: OCA_FEDERATION_INVITE,
    flagEmoji: "🇸🇳",
    country: "SN",
    browserReliable: true,
    notes: NATIVE_VERIFIED_NOTE,
    disambiguator: null,
    hiddenFromPicker: false,
  },
  ...WEST_AFRICA_COUNTRY_CHAMAS,
  ...CENTRAL_AFRICA_COUNTRY_CHAMAS,
  {
    slug: "global-usd",
    displayName: "Global · Bitcoin",
    currency: "USD",
    countries: [],
    languages: ["en", "es"],
    // 2026-06-16: repointed BP → BLF. BLF is the universal backup federation
    // across the board; this legacy slug stays hidden but wire-resolvable so
    // old listings carrying community:"global-usd" render on the same backup
    // route as the live us-blf default instead of orphaning onto BP.
    federationInvite: BLF_FEDERATION_INVITE,
    flagEmoji: "🌎",
    country: null,
    browserReliable: true,
    notes: NATIVE_VERIFIED_NOTE,
    disambiguator: null,
    hiddenFromPicker: true,
  },
  ...EAST_AFRICA_COUNTRY_CHAMAS,
  {
    slug: "tz-tzs",
    displayName: "Tanzania · TZS",
    currency: "TZS",
    countries: ["TZ"],
    languages: ["sw", "en"],
    // Tanzania is user-facing identity first; until a Tanzania-specific
    // federation is claimed, route to the African regional default (OCA).
    federationInvite: OCA_FEDERATION_INVITE,
    flagEmoji: "🇹🇿",
    country: "TZ",
    browserReliable: true,
    notes: NATIVE_VERIFIED_NOTE,
    disambiguator: null,
    hiddenFromPicker: false,
  },
  // Sunset entry — kept alive so old listings carrying community: "sv-usd"
  // still resolve, but hidden from the curated picker until a community
  // leader claims El Salvador. (Invite stays null → BP fallback on the wire,
  // a deliberately-tested invariant; the optional v4.1 LatNet-repoint hygiene
  // was dropped — sv-usd is hidden so the picker is unaffected, and a fresh SV
  // tap already resolves to LatNet via the regional shell.)
  {
    slug: "sv-usd",
    displayName: "El Salvador · USD",
    currency: "USD",
    countries: ["SV"],
    languages: ["es"],
    federationInvite: null,
    flagEmoji: "🇸🇻",
    country: "SV",
    browserReliable: true,
    notes: NATIVE_VERIFIED_NOTE,
    disambiguator: null,
    hiddenFromPicker: true,
  },
];

const BY_SLUG: Map<string, Community> = new Map(
  COMMUNITY_REGISTRY.map(c => [c.slug, c])
);

/** Look up a community by slug. Walks pre-seeds first, then user-added
 *  custom communities in localStorage. Returns null if the slug is
 *  unknown — callers must handle null (typically by treating the
 *  listing as cross-community and rendering a neutral pill). */
export function getCommunityBySlug(slug: string | null | undefined): Community | null {
  if (!slug) return null;
  const preSeed = BY_SLUG.get(slug);
  if (preSeed) return preSeed;
  // Permissionless additions live in localStorage; resolve on demand.
  return getCustomCommunityBySlug(slug);
}

/** The best community whose backing federation matches a given invite.
 *  Used at create time (#103) to keep a listing's community LABEL honest with
 *  the fed it's actually minted on: `browseCommunity` (the header pill) can
 *  drift from the wallet's loaded fed during a foreign-listing visit, which
 *  used to stamp a listing with one chama's label but another's fed — so the
 *  Browse chip read "GBF" while the off-route amber tint (which tracks the real
 *  fed) never fired. Prefers a curated, picker-visible entry; deterministic. */
export function communityForInvite(invite: string | null | undefined): Community | null {
  if (!invite) return null;
  const visible = COMMUNITY_REGISTRY.find(
    c => c.federationInvite === invite && !c.hiddenFromPicker,
  );
  if (visible) return visible;
  const anyPreSeed = COMMUNITY_REGISTRY.find(c => c.federationInvite === invite);
  if (anyPreSeed) return anyPreSeed;
  return getCustomCommunities().find(c => c.federationInvite === invite) ?? null;
}

/** Default community when the user hasn't picked one yet. In v6, us-blf is
 *  both the BLF-backed US anchor and the universal fallback; Canada resolves
 *  to BLF through its country shell. Historical us-gbf remains wire-resolvable
 *  but is not a selectable or default route. */
export const DEFAULT_COMMUNITY_SLUG = "us-blf";

/** Registry communities (excluding hiddenFromPicker) whose primary (`country`)
 *  or spanned (`countries`) ISO 3166-1 alpha-2 code matches `code`. Returns 0,
 *  1, or many — e.g. Kenya → [Afribit, Bitsacco], US → [BLF]. The
 *  full-world country picker uses this to resolve a tapped country to its
 *  Chama(s); 0 results means "no Chama here yet" (soft-landing / request),
 *  >1 means a disambiguation step keyed on `disambiguator`. */
export function getCommunitiesByCountry(code: string): Community[] {
  const cc = code.toUpperCase();
  return COMMUNITY_REGISTRY.filter(
    c => !c.hiddenFromPicker && (c.country === cc || c.countries.includes(cc)),
  );
}

/** Federations that back a confirmed, vouched LOCAL community with real
 *  arbiters/leaders today — currently Afribit + Bitsacco in Kenya. A
 *  community backed by one
 *  of these is a REAL local Chama: the picker lands the user straight in.
 *
 *  Everything else — BLF/BP defaults and the unconfirmed public-Fedi wallet
 *  services — is NOT a local Chama yet: a flag exists, but the "arbiters" are
 *  a couple of distant npubs, so the picker gives those countries the honest
 *  soft-landing ("no local Chama here yet") instead of implying a ready local
 *  arbiter network. Add invites here as community-led federations onboard
 *  real, bonded arbiters (the graduated-trust / bond work is V3). */
// Today only Kenya's on-the-ground communities (Afribit Kibera, Bitsacco)
// qualify. The US BLF route is intentionally NOT here: its arbiters haven't
// gone through the (coming) elected + bonded + rated process — and that bar
// applies to everyone, including Chama's own operator. The US therefore gets
// the same honest soft-landing as everywhere else.
// Add an invite here only once its community completes the arbiter process.
export const REAL_CHAMA_FEDERATION_INVITES: ReadonlySet<string> = new Set([
  AFRIBIT_KIBERA_FEDERATION_INVITE,
  BITSACCO_FEDERATION_INVITE,
]);

/** True when `community` is backed by a federation with real local arbiters
 *  (see REAL_CHAMA_FEDERATION_INVITES). Drives the picker's "land directly"
 *  vs "honest soft-landing" split. */
export function isRealLocalChama(community: Community): boolean {
  return community.federationInvite !== null
    && REAL_CHAMA_FEDERATION_INVITES.has(community.federationInvite);
}

/** The G-Bot-class federations Jetty verified NATIVE end-to-end (see
 *  NATIVE_VERIFIED_NOTE): lock/claim flawless on the Rust sidecar. A country
 *  backed by one of these can really trade TODAY — the cabinet's global
 *  arbiters back every escrow — even though it hasn't seated its own elected
 *  LOCAL arbiters yet. This is the picker's NEW second green tier
 *  ("✓ Available now"), distinct from the elected-local "⚡ Live now" tier
 *  (isRealLocalChama, unchanged). The honest split is preserved: "available"
 *  never claims a local Chama, it states the federation route works. */
export const NATIVE_VERIFIED_FEDERATION_INVITES: ReadonlySet<string> = new Set([
  GBF_FEDERATION_INVITE,
  BLF_FEDERATION_INVITE,
  OCA_FEDERATION_INVITE,
  LATNET_FEDERATION_INVITE,
]);

/** True when `community` is backed by a native-verified G-Bot fed and is NOT
 *  already a real local Chama — i.e. it earns the green "✓ Available now"
 *  tier. The regional resolver routes effectively every country onto one of
 *  these feds, so almost everywhere is "available"; only genuinely uncovered
 *  shells (federationInvite === null, e.g. El Salvador) fall to "coming soon". */
export function isNativeVerifiedChama(community: Community): boolean {
  return community.federationInvite !== null
    && !isRealLocalChama(community)
    && NATIVE_VERIFIED_FEDERATION_INVITES.has(community.federationInvite);
}

// ══════════════════════════════════════════════════════════════════════════
// PERMISSIONLESS COMMUNITY ADDITION (v0.1.85)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3 and the v0.2.0 brief: any user can add a custom
// community to their local picker. v0.1.85 ships the localStorage-backed
// primitive; v0.2.0 wires a Sandbox-mode UI for testing; v1.5 adds the
// Nostr-published kind:38112 community-claim layer for cross-client
// discovery.
//
// Storage: a JSON array of Community records under a single key. Custom
// entries always have hiddenFromPicker:false (the user added them on
// purpose) and a `notes` field set to "user-added" so they're visually
// distinguishable from pre-seeds in debug surfaces.

const CUSTOM_COMMUNITIES_STORAGE_KEY = "chama_custom_communities";

export interface AddCustomCommunityInput {
  slug: string;
  displayName: string;
  currency: string;
  country: string | null;
  flagEmoji: string;
  federationInvite: string;
  /** Defaults to true — user-added communities are assumed browser-friendly
   *  unless the user knows otherwise. */
  browserReliable?: boolean;
  /** Optional language list; defaults to []. */
  languages?: string[];
  /** Optional disambiguator suffix. */
  disambiguator?: string | null;
  /** V3 roster anchor fallback — the creating user's hex pubkey. */
  creatorPubkey?: string | null;
}

/** Read all user-added communities from localStorage. Silently returns []
 *  on any parse error or if storage is unavailable. */
export function getCustomCommunities(): Community[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(CUSTOM_COMMUNITIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCommunityShape);
  } catch {
    return [];
  }
}

/** Look up a custom (user-added) community by slug. */
export function getCustomCommunityBySlug(slug: string): Community | null {
  return getCustomCommunities().find(c => c.slug === slug) ?? null;
}

/** Persist a new custom community. Throws on shape errors (invalid slug,
 *  invite that doesn't start with `fed1`, slug colliding with a pre-seed).
 *  Slug collision with another custom community OVERWRITES the previous
 *  entry — the user is intentionally updating it. */
export function addCustomCommunity(input: AddCustomCommunityInput): Community {
  const slug = (input.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("slug must be lowercase letters, digits, and hyphens only");
  }
  if (BY_SLUG.has(slug)) {
    throw new Error(`slug "${slug}" collides with a pre-seeded community`);
  }
  const invite = (input.federationInvite || "").trim();
  if (!invite.startsWith("fed1")) {
    throw new Error("federationInvite must start with fed1");
  }
  const entry: Community = {
    slug,
    displayName: input.displayName.trim(),
    currency: input.currency.trim().toUpperCase(),
    countries: input.country ? [input.country] : [],
    languages: input.languages ?? [],
    federationInvite: invite,
    flagEmoji: input.flagEmoji,
    country: input.country,
    browserReliable: input.browserReliable ?? true,
    notes: "user-added",
    disambiguator: input.disambiguator ?? null,
    hiddenFromPicker: false,
    // V3 roster anchor fallback: record who created this shell so a
    // permissionless community can still have a verifiable arbiter roster
    // (hybrid authority — registry pin wins where one exists).
    creatorPubkey: input.creatorPubkey ?? null,
  };
  const all = getCustomCommunities().filter(c => c.slug !== slug);
  all.push(entry);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CUSTOM_COMMUNITIES_STORAGE_KEY, JSON.stringify(all));
    }
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  return entry;
}

/** After first sign-in, stamp the now-known creator pubkey onto custom
 *  community shells generated PRE-login. The globe picker runs before any
 *  signer exists, so its generated shells (addCustomCommunity in
 *  GlobeCountryPicker.selectDefault) land with creatorPubkey null — and
 *  resolveRosterAuthority falls back to creatorPubkey, so a null leaves those
 *  permissionless communities with no verifiable kind:38120 arbiter roster
 *  authority, ever. Re-persisting each through addCustomCommunity's same-slug
 *  overwrite path anchors it to the first connecting identity (the person who
 *  walked this device through onboarding), making the shell roster-eligible.
 *
 *  Idempotent: a shell that already carries a creatorPubkey is left untouched,
 *  so this is safe to call on every connect. Returns the slugs it stamped. */
export function claimGeneratedShellCreator(pubkey: string): string[] {
  const hex = (pubkey || "").trim();
  if (!hex) return [];
  const stamped: string[] = [];
  for (const c of getCustomCommunities()) {
    if (c.creatorPubkey) continue;       // already anchored — leave it
    if (!c.federationInvite) continue;   // addCustomCommunity requires fed1…
    try {
      addCustomCommunity({
        slug: c.slug,
        displayName: c.displayName,
        currency: c.currency,
        country: c.country,
        flagEmoji: c.flagEmoji,
        federationInvite: c.federationInvite,
        browserReliable: c.browserReliable,
        languages: c.languages,
        disambiguator: c.disambiguator,
        creatorPubkey: hex,
      });
      stamped.push(c.slug);
    } catch {
      // A single malformed shell must not block stamping the rest.
    }
  }
  return stamped;
}

/** Remove a user-added community by slug. No-op if the slug isn't user-added. */
export function removeCustomCommunity(slug: string): void {
  const all = getCustomCommunities().filter(c => c.slug !== slug);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CUSTOM_COMMUNITIES_STORAGE_KEY, JSON.stringify(all));
    }
  } catch { /* no-op */ }
}

function isCommunityShape(c: any): c is Community {
  return (
    typeof c === "object" && c !== null &&
    typeof c.slug === "string" &&
    typeof c.displayName === "string" &&
    typeof c.currency === "string" &&
    Array.isArray(c.countries) &&
    Array.isArray(c.languages) &&
    (c.federationInvite === null || typeof c.federationInvite === "string") &&
    typeof c.flagEmoji === "string" &&
    (c.country === null || typeof c.country === "string") &&
    typeof c.browserReliable === "boolean" &&
    (c.notes === null || typeof c.notes === "string") &&
    (c.disambiguator === null || typeof c.disambiguator === "string") &&
    typeof c.hiddenFromPicker === "boolean"
  );
}
