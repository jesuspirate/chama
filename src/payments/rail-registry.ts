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
  /** Human-readable label shown in pickers and listing pills. */
  displayName: string;
  /** Whether the user is permitted to opt this rail's handles into the
   *  public-display path. Sensitive rails (phone number, bank account)
   *  are locked private; public-by-design rails (Revtag, $cashtag)
   *  default to masked but allow opt-in publishing. */
  allowPublicHandle: boolean;
  /** Optional list of community slugs this rail is geo-relevant to.
   *  Empty/missing means available to every community (Revtag, $cashtag,
   *  Wise — they cross borders). */
  region?: string[];
  /** Placeholder hint for the input field — "+221 77 123 4567",
   *  "@username", "your.bank@email.com", etc. */
  placeholder?: string;
}

/** v1 seed list. Bias toward small + honest: enumerate the rails we
 *  actually expect users in our four seed communities to want. Sensitive
 *  rails (phone-number-based mobile money, bank transfers) are private-
 *  only; public-by-design tags get the opt-in path. */
export const RAIL_REGISTRY: Rail[] = [
  // ── sn-cfa (Senegal · CFA) ─────────────────────────────────────────
  // Mobile money in Francophone West Africa is phone-number-based —
  // sensitive by definition.
  {
    key: "wave",
    displayName: "Wave",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "orange-money",
    displayName: "Orange Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "wizall",
    displayName: "Wizall",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "free-money",
    displayName: "Free Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },

  // ── ke-kes (Kenya · KES) ───────────────────────────────────────────
  {
    key: "m-pesa",
    displayName: "M-Pesa",
    allowPublicHandle: false,
    region: ["ke-kes"],
    placeholder: "+254 712 345 678",
  },
  {
    key: "airtel-money",
    displayName: "Airtel Money",
    allowPublicHandle: false,
    region: ["ke-kes"],
    placeholder: "+254 733 123 456",
  },

  // ── sv-usd (El Salvador · USD) ─────────────────────────────────────
  // Strike usernames are public-by-design (paystrike.me/<user>).
  {
    key: "strike",
    displayName: "Strike",
    allowPublicHandle: true,
    region: ["sv-usd"],
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
    placeholder: "@username",
  },
  {
    key: "cashtag",
    displayName: "$cashtag (Cash App)",
    allowPublicHandle: true,
    placeholder: "$username",
  },
  {
    key: "zbd",
    displayName: "ZBD username",
    allowPublicHandle: true,
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
    placeholder: "you@example.com",
  },
  {
    key: "venmo",
    displayName: "Venmo",
    // Venmo usernames CAN be public, but the typical handle (often phone-
    // tied or PII-adjacent) defaults to private. Conservative.
    allowPublicHandle: false,
    placeholder: "@username",
  },
  {
    key: "zelle",
    displayName: "Zelle",
    allowPublicHandle: false,
    placeholder: "you@example.com or +1 555 555 5555",
  },
  {
    key: "bank-transfer",
    displayName: "Bank transfer",
    allowPublicHandle: false,
    placeholder: "Account number / IBAN",
  },
];

const BY_KEY: Map<string, Rail> = new Map(
  RAIL_REGISTRY.map(r => [r.key, r])
);

/** Look up a rail by its wire key. Returns null for unknown keys
 *  (e.g. a listing using a rail from a future registry version) so
 *  callers can render a generic pill without crashing. */
export function getRailByKey(key: string | null | undefined): Rail | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/** Rails available to a given community. Includes:
 *   - region-scoped rails whose `region` array contains the slug
 *   - cross-community rails (no region field)
 *  Returns the original registry order (curated). */
export function railsForCommunity(slug: string | null | undefined): Rail[] {
  return RAIL_REGISTRY.filter(r => {
    if (!r.region || r.region.length === 0) return true;
    return slug ? r.region.includes(slug) : false;
  });
}

/** Convenience: whether a rail's handles can EVER be made public.
 *  False for unknown keys (conservative — refuse public path on
 *  unfamiliar rails rather than leak by default). */
export function railAllowsPublicHandle(key: string | null | undefined): boolean {
  return getRailByKey(key)?.allowPublicHandle === true;
}
