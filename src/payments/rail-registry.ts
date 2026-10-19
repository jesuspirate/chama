// ══════════════════════════════════════════════════════════════════════════
// Chama — Payment Rail Registry
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: payment methods are first-class extensible data.
// Each community surfaces a different set of rails (Wave/Orange Money in
// Senegal, M-Pesa in Kenya, Revtag/$cashtag in global, etc.). The registry
// here is the static v1 truth; v2 may publish rails as community-attached
// Nostr events for organic growth.
//
// allowPublicHandle is the load-bearing privacy bit. Per the philosophy:
//
//   "Customizable public-by-design usernames (Revtag, $cashtag, ZBD
//    username, etc.) get an opt-in 'show publicly' toggle per saved
//    handle in Settings; default is masked. Sensitive handles (phone
//    numbers, bank accounts) have no public-toggle path — privacy
//    default is locked."
//
// allowPublicHandle === false means the Settings UI MUST NOT render a
// visibility toggle for that handle, AND saved-handles.ts enforces the
// same rule on writes (defense in depth).

export interface Rail {
  /** Stable wire identifier — never change once shipped. Lowercase
   *  hyphenated. Examples: wave, orange-money, m-pesa, revtag, cashtag. */
  key: string;
  /** Human-readable name. Listings STORE this text in paymentMethods and
   *  every client matches on it (toRailKey), so it is a wire value too:
   *  never rename a shipped one. To change what people see, set `label`. */
  displayName: string;
  /** Shorter name shown in the app when it differs from displayName (Jet,
   *  6.4.25: "Cash App", not "$cashtag (Cash App)"). Display only. */
  label?: string;
  /** Whether the user is permitted to opt this rail's handles into the
   *  public-display path. Sensitive rails (phone number, bank account)
   *  are locked private; public-by-design rails (Revtag, $cashtag)
   *  default to masked but allow opt-in publishing. */
  allowPublicHandle: boolean;
  /** Optional list of community slugs this rail is geo-relevant to.
   *  Kept for Chama-specific overrides, especially where one country has
   *  multiple Chamas or legacy slugs. */
  region?: string[];
  /** ISO country codes where this rail should appear in the default local
   *  picker. Search still exposes the wider catalog. */
  countries?: string[];
  /** Placeholder hint for the input field — "+221 77 123 4567",
   *  "@username", "your.bank@email.com", etc. */
  placeholder?: string;
  /** i18n key for a PROSE placeholder (not a phone-number example). When set,
   *  the render sites show t(placeholderKey); `placeholder` stays for search
   *  indexing + phone-rail detection. */
  placeholderKey?: string;
  /** Phone examples for countries where this network's own prefix differs
   *  from the country's usual example (M-Pesa in Tanzania is Vodacom 074,
   *  not Tigo 071). Render through railPlaceholderForCountry. */
  placeholdersByCountry?: Partial<Record<string, string>>;
}

/** v1 seed list. Bias toward mobile-first + honest: enumerate the rails
 *  users already reach for across Chama's early communities, then keep a
 *  compact global tail of mobile money, instant mobile-bank rails, and app
 *  wallets close enough that cross-border sellers do not need a new release
 *  to tag a local rail. Sensitive rails (phone-number-based mobile money,
 *  bank transfers) are private-only; public-by-design tags get the opt-in
 *  path. */
export const RAIL_REGISTRY: Rail[] = [
  // ── universal default ──────────────────────────────────────────────
  // Mobile money, bank-transfer coordination, and cash-in/cash-out
  // workflows default to phone numbers across much of the global south.
  // Phone numbers are sensitive identifiers, so they are locked private.
  {
    key: "phone-number",
    displayName: "Phone number",
    allowPublicHandle: false,
    placeholder: "+254 712 345 678",
  },

  // ── sn-cfa (Senegal · CFA) ─────────────────────────────────────────
  // Mobile money in Francophone West Africa is phone-number-based —
  // sensitive by definition.
  {
    key: "wave",
    displayName: "Wave",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    countries: ["SN", "CI"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "orange-money",
    displayName: "Orange Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    countries: ["SN", "CI", "CM", "GN", "ML", "BF", "BJ", "MG"],
    placeholder: "+221 77 123 4567",
    placeholdersByCountry: { CM: "+237 6 91 23 45 67" },
  },
  {
    key: "wizall",
    displayName: "Wizall",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    countries: ["SN"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "free-money",
    displayName: "Free Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    countries: ["SN"],
    placeholder: "+221 76 123 4567",
  },
  {
    key: "moov-money",
    displayName: "Moov Money",
    allowPublicHandle: false,
    countries: ["BJ", "CI", "BF", "TG", "NE"],
    placeholder: "+229 01 95 12 34 56",
    placeholdersByCountry: { CI: "+225 01 12 34 5678", BF: "+226 60 12 34 56", TG: "+228 96 12 34 56", NE: "+227 94 12 34 56" },
  },
  {
    key: "vodafone-cash",
    displayName: "Vodafone Cash",
    allowPublicHandle: false,
    countries: ["GH"],
    placeholder: "+233 20 123 4567",
  },
  {
    key: "airtel-tigo-money",
    displayName: "AirtelTigo Money",
    allowPublicHandle: false,
    countries: ["GH"],
    placeholder: "+233 27 123 4567",
  },

  // ── East Africa & broader M-Pesa / Airtel footprint ───────────────
  // v0.6.5: broadened region tags. M-Pesa is Safaricom in Kenya but
  // also Vodacom in Tanzania, DRC, Mozambique, Lesotho, and others —
  // the brand and the UX are interchangeable from the user's
  // perspective, so we treat them as one rail. Airtel Money operates
  // across Kenya, Uganda, Tanzania, Rwanda, Zambia, Malawi, Niger,
  // Chad, DRC, Madagascar, Gabon, Republic of Congo, and more.
  // Region arrays list known community slugs (only ke-kes today, but
  // future TZ/UG/RW/etc. communities will pick these up automatically).
  {
    key: "m-pesa",
    displayName: "M-Pesa",
    allowPublicHandle: false,
    region: ["ke-kes", "tz-tzs"],
    countries: ["KE", "TZ", "MZ", "CD", "LS", "GH", "EG", "ZA", "ET"],
    placeholder: "+254 712 345 678",
    placeholdersByCountry: { TZ: "+255 74 123 4567", GH: "+233 20 123 4567", ZA: "+27 82 123 4567", ET: "+251 70 123 4567" },
  },
  {
    key: "airtel-money",
    displayName: "Airtel Money",
    allowPublicHandle: false,
    region: ["ke-kes", "tz-tzs"],
    countries: ["KE", "TZ", "UG", "RW", "ZM", "MW", "NE", "TD", "CD", "MG", "GA", "CG", "SC"],
    placeholder: "+254 733 123 456",
    placeholdersByCountry: { TZ: "+255 68 123 4567", RW: "+250 73 123 4567", CD: "+243 99 123 4567", MG: "+261 33 12 345 67", CG: "+242 05 123 4567" },
  },
  // MTN Mobile Money (MoMo) — the dominant network across West and
  // Central Africa: Ghana, Côte d'Ivoire, Cameroon, Uganda, Rwanda,
  // Zambia, Bénin, Liberia, Republic of Congo, Guinea, South Sudan.
  // No region tag yet because none of those communities exist in the
  // registry, but listed universally so users in countries it
  // operates in can still tag their phones.
  {
    key: "mtn-momo",
    displayName: "MTN Mobile Money",
    allowPublicHandle: false,
    countries: ["GH", "CI", "CM", "UG", "RW", "ZM", "BJ", "LR", "CG", "GN", "SS", "ZA"],
    placeholder: "+233 24 123 4567",
    placeholdersByCountry: { CI: "+225 05 12 34 5678", UG: "+256 77 123 4567", ZM: "+260 96 123 4567", BJ: "+229 01 97 12 34 56", LR: "+231 88 012 3456", GN: "+224 664 12 34 56", SS: "+211 921 234 567", ZA: "+27 83 123 4567" },
  },
  // Tigo Pesa — Tanzania (rebranded to "Mixx by Yas" 2023 but Tigo
  // Pesa is still widely recognized), historically Senegal & Chad.
  {
    key: "tigo-pesa",
    displayName: "Tigo Pesa",
    allowPublicHandle: false,
    region: ["tz-tzs"],
    countries: ["TZ"],
    placeholder: "+255 71 234 5678",
  },
  {
    key: "halopesa",
    displayName: "HaloPesa",
    allowPublicHandle: false,
    region: ["tz-tzs"],
    countries: ["TZ"],
    placeholder: "+255 62 123 4567",
  },
  {
    key: "azampesa",
    displayName: "AzamPesa",
    allowPublicHandle: false,
    region: ["tz-tzs"],
    countries: ["TZ"],
    placeholder: "+255 68 123 4567",
  },
  // Telebirr — Ethio Telecom's wallet, Ethiopia's dominant mobile
  // money since 2021.
  {
    key: "telebirr",
    displayName: "Telebirr",
    allowPublicHandle: false,
    countries: ["ET"],
    placeholder: "+251 91 234 5678",
  },
  {
    key: "ecocash",
    displayName: "EcoCash",
    allowPublicHandle: false,
    countries: ["ZW"],
    placeholder: "+263 77 123 4567",
  },
  {
    key: "opay",
    displayName: "OPay",
    allowPublicHandle: false,
    countries: ["NG"],
    placeholder: "+234 801 234 5678",
  },
  {
    key: "paga",
    displayName: "Paga",
    allowPublicHandle: false,
    countries: ["NG"],
    placeholder: "+234 801 234 5678",
  },
  {
    key: "palmpay",
    displayName: "PalmPay",
    allowPublicHandle: false,
    countries: ["NG", "GH"],
    placeholder: "+234 801 234 5678",
  },
  {
    key: "chipper-cash",
    displayName: "Chipper Cash",
    allowPublicHandle: false,
    countries: ["GH", "NG", "UG", "RW", "TZ", "ZA", "KE"],
    placeholder: "+233 24 123 4567",
  },
  {
    key: "mukuru",
    displayName: "Mukuru",
    allowPublicHandle: false,
    countries: ["ZA", "ZW", "ZM", "MW", "BW", "LS", "SZ", "MZ"],
    placeholder: "+27 71 123 4567",
  },
  {
    key: "fawry",
    displayName: "Fawry",
    allowPublicHandle: false,
    countries: ["EG"],
    placeholder: "+20 100 123 4567",
  },

  // ── South & Southeast Asia mobile money ───────────────────────────
  // UPI — India's mobile-first instant payment layer. VPAs are shareable but
  // often phone/PII-adjacent, so Chama keeps them private by default.
  {
    key: "upi",
    displayName: "UPI (India)",
    allowPublicHandle: false,
    countries: ["IN"],
    placeholder: "name@bank or +91 98765 43210",
  },
  // bKash — Bangladesh's dominant mobile financial service.
  {
    key: "bkash",
    displayName: "bKash",
    allowPublicHandle: false,
    countries: ["BD"],
    placeholder: "+880 1700 123456",
  },
  {
    key: "nagad",
    displayName: "Nagad",
    allowPublicHandle: false,
    countries: ["BD"],
    placeholder: "+880 1700 123456",
  },
  {
    key: "rocket",
    displayName: "Rocket",
    allowPublicHandle: false,
    countries: ["BD"],
    placeholder: "+880 1700 123456",
  },
  // GCash — Philippines, ~70M users. Globe Telecom's wallet.
  {
    key: "gcash",
    displayName: "GCash",
    allowPublicHandle: false,
    countries: ["PH"],
    placeholder: "+63 917 123 4567",
  },
  // Maya (formerly PayMaya) — Philippines, GCash's main competitor.
  {
    key: "maya",
    displayName: "Maya (PayMaya)",
    allowPublicHandle: false,
    countries: ["PH"],
    placeholder: "+63 917 123 4567",
  },
  // Easypaisa — Pakistan, Telenor Bank wallet.
  {
    key: "easypaisa",
    displayName: "Easypaisa",
    allowPublicHandle: false,
    countries: ["PK"],
    placeholder: "+92 300 1234567",
  },
  // JazzCash — Pakistan, Jazz Mobile Bank wallet.
  {
    key: "jazzcash",
    displayName: "JazzCash",
    allowPublicHandle: false,
    countries: ["PK"],
    placeholder: "+92 300 1234567",
  },
  {
    key: "truemoney",
    displayName: "TrueMoney",
    allowPublicHandle: false,
    countries: ["TH", "KH", "MM", "ID", "PH", "VN"],
    placeholder: "+66 81 234 5678",
  },
  {
    key: "dana",
    displayName: "DANA",
    allowPublicHandle: false,
    countries: ["ID"],
    placeholder: "+62 812 3456 7890",
  },
  {
    key: "gopay",
    displayName: "GoPay",
    allowPublicHandle: false,
    countries: ["ID"],
    placeholder: "+62 812 3456 7890",
  },
  {
    key: "ovo",
    displayName: "OVO",
    allowPublicHandle: false,
    countries: ["ID"],
    placeholder: "+62 812 3456 7890",
  },
  {
    key: "momo-vietnam",
    displayName: "MoMo (Vietnam)",
    allowPublicHandle: false,
    countries: ["VN"],
    placeholder: "+84 91 234 5678",
  },
  {
    key: "touch-n-go",
    displayName: "Touch 'n Go eWallet",
    allowPublicHandle: false,
    countries: ["MY"],
    placeholder: "+60 12 345 6789",
  },
  {
    key: "grabpay",
    displayName: "GrabPay",
    allowPublicHandle: false,
    countries: ["SG", "MY", "PH", "TH", "ID", "VN"],
    placeholder: "+65 8123 4567",
  },

  // ── Latin America popular rails ──────────────────────────────────
  // PIX — Brazil's instant-payment system. Keys are CPF, email,
  // phone, or a random UUID; phone-keyed PIX is common. Public-by-
  // design (the PIX key is meant to be shared).
  {
    key: "pix",
    displayName: "PIX (Brazil)",
    allowPublicHandle: true,
    countries: ["BR"],
    placeholder: "+55 11 91234 5678 or CPF / email",
  },
  // Mercado Pago — Argentina, Brazil, Mexico, Chile, Colombia, Peru,
  // Uruguay. Phone-based wallet plus full bank app.
  {
    key: "mercado-pago",
    displayName: "Mercado Pago",
    allowPublicHandle: false,
    countries: ["AR", "BR", "MX", "CL", "CO", "PE", "UY"],
    placeholder: "+54 9 11 1234 5678",
  },
  // Nequi — Colombia, Bancolombia's digital wallet. Phone-keyed.
  {
    key: "nequi",
    displayName: "Nequi",
    allowPublicHandle: false,
    countries: ["CO"],
    placeholder: "+57 300 123 4567",
  },
  {
    key: "yape",
    displayName: "Yape",
    allowPublicHandle: false,
    countries: ["PE"],
    placeholder: "+51 987 654 321",
  },
  {
    key: "plin",
    displayName: "Plin",
    allowPublicHandle: false,
    countries: ["PE"],
    placeholder: "+51 987 654 321",
  },
  {
    key: "codi",
    displayName: "CoDi (Mexico)",
    allowPublicHandle: false,
    countries: ["MX"],
    placeholder: "+52 55 1234 5678",
  },
  {
    key: "spei",
    displayName: "SPEI (Mexico)",
    allowPublicHandle: false,
    countries: ["MX"],
    placeholder: "CLABE / phone / bank alias",
    placeholderKey: "claim.railPlaceholderSpei",
  },
  {
    key: "sinpe-movil",
    displayName: "SINPE Movil",
    allowPublicHandle: false,
    countries: ["CR"],
    placeholder: "+506 8888 8888",
  },

  // ── sv-usd (El Salvador · USD) ─────────────────────────────────────
  // Strike usernames are public-by-design (paystrike.me/<user>).
  {
    key: "strike",
    displayName: "Strike",
    allowPublicHandle: true,
    region: ["sv-usd", "us-gbf", "us-blf", "global-usd"],
    countries: ["US", "SV", "AR"],
    placeholder: "username",
  },

  // ── global-usd & cross-community ───────────────────────────────────
  // Public-by-design tags that cross borders. allowPublicHandle: true
  // because the handle was designed to be shared (the username IS the
  // address).
  {
    key: "revtag",
    displayName: "Revtag (Revolut)",
    allowPublicHandle: true,
    countries: ["GB", "IE", "FR", "ES", "PT", "DE", "NL", "BE", "IT", "PL", "RO", "LT", "LV", "EE", "CZ", "HU", "SE", "DK", "NO", "IS", "AU", "NZ"],
    placeholder: "@username",
  },
  {
    key: "cashtag",
    displayName: "$cashtag (Cash App)",
    label: "Cash App",
    allowPublicHandle: true,
    countries: ["US", "GB"],
    placeholder: "$username",
  },
  {
    key: "zbd",
    displayName: "ZBD username",
    allowPublicHandle: true,
    countries: ["US"],
    placeholder: "username@zbd.gg",
  },
  {
    key: "wise-tag",
    displayName: "Wise tag",
    allowPublicHandle: true,
    placeholder: "@username",
  },
  // Sensitive: email-based payment apps, Zelle (typically email/phone),
  // raw bank wires.
  {
    key: "paypal",
    displayName: "PayPal",
    allowPublicHandle: false,
    countries: ["US", "GB", "CA", "AU", "NZ", "FR", "DE", "ES", "IT", "NL", "BE", "IE", "PT", "MX", "BR", "PH", "SG"],
    placeholder: "you@example.com",
  },
  {
    key: "venmo",
    displayName: "Venmo",
    // Venmo usernames CAN be public, but the typical handle (often phone-
    // tied or PII-adjacent) defaults to private. Conservative.
    allowPublicHandle: false,
    countries: ["US"],
    placeholder: "@username",
  },
  {
    key: "zelle",
    displayName: "Zelle",
    allowPublicHandle: false,
    countries: ["US"],
    placeholder: "you@example.com or +1 555 555 5555",
  },
  {
    key: "bank-transfer",
    displayName: "Bank transfer",
    allowPublicHandle: false,
    placeholder: "Account number / IBAN",
    placeholderKey: "claim.railPlaceholderBank",
  },
];

const BY_KEY: Map<string, Rail> = new Map(
  RAIL_REGISTRY.map(r => [r.key, r])
);

const AFRICA_FIRST_RAIL_KEYS = [
  "wave",
  "orange-money",
  "m-pesa",
  "airtel-money",
  "mtn-momo",
  "moov-money",
  "tigo-pesa",
  "halopesa",
  "azampesa",
  "vodafone-cash",
  "airtel-tigo-money",
  "telebirr",
  "ecocash",
  "opay",
  "paga",
  "palmpay",
  "chipper-cash",
  "mukuru",
  "fawry",
  "wizall",
  "free-money",
];

const GLOBAL_SOUTH_TAIL_RAIL_KEYS = [
  "upi",
  "bkash",
  "nagad",
  "rocket",
  "gcash",
  "maya",
  "easypaisa",
  "jazzcash",
  "truemoney",
  "dana",
  "gopay",
  "ovo",
  "momo-vietnam",
  "touch-n-go",
  "grabpay",
  "pix",
  "mercado-pago",
  "nequi",
  "yape",
  "plin",
  "codi",
  "spei",
  "sinpe-movil",
  "strike",
  "revtag",
  "cashtag",
  "zbd",
  "wise-tag",
];

/** Whether a listing category settles fiat over a payment rail, so rails /
 *  handles are relevant. Marketplace ("Market") is sats-only — the buyer locks
 *  sats into escrow and any fiat conversion happens off-app after claim — so it
 *  carries NO payment rails. The fiat verticals (p2p-trade, bill-pay, lending)
 *  do. Used to gate the Create payment picker and the trade-detail rail UI. */
export function categoryUsesPaymentRails(category: string | null | undefined): boolean {
  return category !== "marketplace";
}

/** Look up a rail by its wire key. Returns null for unknown keys
 *  (e.g. a listing using a rail from a future registry version) so
 *  callers can render a generic pill without crashing. */
/** What people see for a rail (a Rail, a key or a stored display name). */
export function railLabel(rail: Rail | string | null | undefined): string {
  if (!rail) return "";
  if (typeof rail !== "string") return rail.label ?? rail.displayName;
  const found = BY_KEY.get(rail) ?? BY_KEY.get(toRailKey(rail));
  return found ? found.label ?? found.displayName : rail;
}

/** The full name, for where people enter their payment details: it says
 *  what to share ("$cashtag (Cash App)"). Chips and listings use railLabel. */
export function railEntryName(rail: string | null | undefined): string {
  if (!rail) return "";
  const found = BY_KEY.get(rail) ?? BY_KEY.get(toRailKey(rail));
  return found ? found.displayName : rail;
}

export function getRailByKey(key: string | null | undefined): Rail | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/** Rails shown by default for a given community. Defaults are country-first:
 *  a Kenyan Chama should feel Kenyan, a Senegal Chama should feel Senegalese,
 *  and broad cross-border rails should appear only when they are local to that
 *  country. Search surfaces the wider catalog via searchableRailsForCommunity.
 */
export function railsForCommunity(slug: string | null | undefined): Rail[] {
  return searchableRailsForCommunity(slug).filter(rail => railIsDefaultForCommunity(rail, slug));
}

/** Full catalog, ranked for the community. Used when a user explicitly
 *  searches beyond their local defaults, and for matching legacy/listing rails
 *  that may have been selected in another country. */
export function searchableRailsForCommunity(slug: string | null | undefined): Rail[] {
  return [...RAIL_REGISTRY].sort((a, b) => railCommunityRank(a, slug) - railCommunityRank(b, slug));
}

/** Convenience: whether a rail's handles can EVER be made public.
 *  False for unknown keys (conservative — refuse public path on
 *  unfamiliar rails rather than leak by default). */
export function railAllowsPublicHandle(key: string | null | undefined): boolean {
  return getRailByKey(key)?.allowPublicHandle === true;
}

/** v0.6.5: the set of phone-number-based mobile-money networks the
 *  user can tag on their saved phone entry for a given community.
 *  Surfaces the same regional rails Create lets sellers pick, minus
 *  the synthetic "phone-number" rail itself. A user in Senegal sees
 *  Wave / Orange Money / Wizall / Free Money; a user in Kenya sees
 *  M-Pesa / Airtel Money; a global user sees a curated fallback. The
 *  selection rides through the LOCK envelope so counterparties know
 *  which network(s) to send fiat to.
 *
 *  Heuristic for "phone-based": region-scoped rails with the
 *  +cc-formatted placeholder. We don't ship a strict type bit on the
 *  Rail interface to keep registry rows minimal; placeholder is a
 *  reliable proxy for now and easy to upgrade later. */
export function phoneNetworksForCommunity(
  slug: string | null | undefined,
  options: { includeSearchable?: boolean } = {},
): Rail[] {
  // "Phone-shaped" proxy = placeholder starts with "+". Easy to keep in sync
  // as the registry grows. Defaults are country-local; search can opt into the
  // full catalog so travelers/cross-border sellers can still find their rail.
  const isPhoneShaped = (r: Rail) =>
    r.key !== "phone-number"
    && (r.placeholder ? r.placeholder.startsWith("+") : false);

  const source = options.includeSearchable
    ? searchableRailsForCommunity(slug)
    : railsForCommunity(slug);
  return source.filter(isPhoneShaped);
}

// #1: US-leaning Chamas (GBF, and Global USD / us-blf) almost certainly mean a
// US user, so Create's payment picker should lead with US rails rather than the
// global/Africa tail. These are ranked ahead of everything (including the
// phone-number meta rail) for just these community slugs; every other community
// is completely unaffected.
const US_LEANING_COMMUNITY_SLUGS = new Set(["us-gbf", "us-blf", "global-usd"]);
const US_FIRST_RAIL_KEYS = ["strike", "cashtag", "zelle", "bank-transfer"];

const UNIVERSAL_DEFAULT_RAIL_KEYS = new Set(["phone-number", "bank-transfer"]);

function communityCountryCodes(slug: string | null | undefined): Set<string> {
  const countries = new Set<string>();
  if (slug && US_LEANING_COMMUNITY_SLUGS.has(slug)) countries.add("US");
  // Keep payment rails independent from the community registry. This file is
  // imported during boot/HMR, and the community registry already has federation
  // dependencies; deriving the country from stable country-currency slugs keeps
  // this path cycle-free.
  const slugPrefix = slug?.split("-")[0]?.toUpperCase();
  if (slugPrefix && /^[A-Z]{2}$/.test(slugPrefix)) countries.add(slugPrefix);
  return countries;
}

function railIsDefaultForCommunity(rail: Rail, slug: string | null | undefined): boolean {
  if (UNIVERSAL_DEFAULT_RAIL_KEYS.has(rail.key)) return true;
  if (slug && rail.region?.includes(slug)) return true;
  const countries = communityCountryCodes(slug);
  if (countries.size === 0) return false;
  return (rail.countries ?? []).some(country => countries.has(country.toUpperCase()));
}

function railCommunityRank(rail: Rail, slug: string | null | undefined): number {
  const registryIndex = RAIL_REGISTRY.findIndex(r => r.key === rail.key);
  if (slug && US_LEANING_COMMUNITY_SLUGS.has(slug)) {
    const usIndex = US_FIRST_RAIL_KEYS.indexOf(rail.key);
    if (usIndex >= 0) return -100 + usIndex;
  }
  if (rail.key === "phone-number") return registryIndex / 1000;
  const local = slug && rail.region?.includes(slug);
  if (local) return 100 + registryIndex / 1000;
  const countries = communityCountryCodes(slug);
  if ((rail.countries ?? []).some(country => countries.has(country.toUpperCase()))) {
    return 110 + registryIndex / 1000;
  }
  const africaIndex = AFRICA_FIRST_RAIL_KEYS.indexOf(rail.key);
  if (africaIndex >= 0) return 200 + africaIndex;
  const globalSouthIndex = GLOBAL_SOUTH_TAIL_RAIL_KEYS.indexOf(rail.key);
  if (globalSouthIndex >= 0) return 400 + globalSouthIndex;
  return 600 + registryIndex;
}

// ── #4: suggest + match rails before lock ─────────────────────────────────
// A listing advertises which rails the seller accepts; the buyer needs to pay
// on a rail they can both use. The catch the matcher MUST absorb: a listing's
// `paymentMethods` is stored as rail DISPLAY NAMES (CreateForm toggles by
// `rail.displayName`), while a buyer's saved handles carry rail KEYS. Matching
// the two requires normalizing both to the canonical key — otherwise "M-Pesa"
// (name) never equals "m-pesa" (key) and every match silently fails.

const BY_DISPLAY_NAME: Map<string, string> = new Map(
  RAIL_REGISTRY.map(r => [r.displayName.toLowerCase(), r.key]),
);

/** Normalize a rail token (a key OR a display name, any case) to its canonical
 *  registry key. Unknown tokens fall through lowercased so a rail from a future
 *  registry version still compares consistently rather than throwing. */
export function toRailKey(token: string): string {
  const t = token.trim().toLowerCase();
  if (BY_KEY.has(t)) return t;
  return BY_DISPLAY_NAME.get(t) ?? t;
}

export interface RailMatch {
  /** Rails the seller accepts AND the buyer already uses (has a saved handle on)
   *  — community-ranked, best first. The strongest "you both use this" match. */
  shared: string[];
  /** Rails the seller accepts that the buyer has no saved handle for — they can
   *  still pay if they use it. Community-ranked. */
  sellerOnly: string[];
  /** The one rail to settle on before lock: top shared, else top seller rail. */
  suggested: string | null;
}

/** Intersect a seller's accepted rails with the rails a buyer uses, ranked for
 *  the community, to suggest a shared rail BEFORE lock. Both sides are
 *  normalized to keys first (names vs keys). Pure — no storage, no money. */
export function matchRails(
  sellerAccepts: readonly string[] | null | undefined,
  buyerRails: readonly string[] | null | undefined,
  community: string | null | undefined,
): RailMatch {
  const rankOf = new Map<string, number>();
  searchableRailsForCommunity(community).forEach((r, i) => rankOf.set(r.key, i));
  const byRank = (a: string, b: string) =>
    (rankOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b) ?? Number.MAX_SAFE_INTEGER);

  const sellerKeys: string[] = [];
  const seen = new Set<string>();
  for (const token of sellerAccepts ?? []) {
    const key = toRailKey(token);
    if (key && !seen.has(key)) { seen.add(key); sellerKeys.push(key); }
  }
  const buyerSet = new Set((buyerRails ?? []).map(toRailKey));

  const shared = sellerKeys.filter(k => buyerSet.has(k)).sort(byRank);
  const sellerOnly = sellerKeys.filter(k => !buyerSet.has(k)).sort(byRank);
  return { shared, sellerOnly, suggested: shared[0] ?? sellerOnly[0] ?? null };
}
