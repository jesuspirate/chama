// ══════════════════════════════════════════════════════════════════════════
// Community Bill Pay — bill types (#12), per-country registry
// ══════════════════════════════════════════════════════════════════════════
//
// A bill type makes a CBP listing legible ("what am I paying?"), helps a
// volunteer payer decide, and enables Browse filtering later. INFORMATIONAL
// METADATA ONLY — it never touches escrow logic. Optional on every listing;
// "Other" catches the long tail. Keyed by the home community's ISO country so
// Senegal / Benin / etc. localise their own later; an unlisted country falls
// back to a generic set. Kenya ships first (Nairobi launch).

import { translate, getCurrentLang } from "../i18n/index.js";

export interface BillType {
  /** Stable slug persisted on the listing (e.g. "electricity-kplc"). Never change. */
  id: string;
  /** Human label shown in the picker + on the card/detail. English source of truth. */
  label: string;
  /** Optional i18n key — when present, the DISPLAY label resolves to the viewer's
   *  language (app chrome translates to the viewer; the raw `label` stays for search
   *  and as the English fallback). Country-specific proper nouns (KPLC, DSTV, SHA)
   *  keep no key and render raw in every language. */
  labelKey?: string;
  /** Leading emoji. */
  icon: string;
}

/** Resolve a bill type's display label to the viewer's language when it carries a
 *  labelKey; otherwise the raw English/proper-noun label. */
function billLabel(bt: BillType): string {
  return bt.labelKey ? translate(getCurrentLang(), bt.labelKey) : bt.label;
}

// 🇰🇪 Kenya — Nairobi-first (Jetty to confirm the exact set on-device).
const KENYA: BillType[] = [
  { id: "electricity-kplc", label: "Electricity — KPLC", labelKey:"create.billElectricityKplc", icon: "⚡" },
  { id: "water",            label: "Water",              labelKey: "create.billWater",      icon: "💧" },
  { id: "school-fees",      label: "School fees",        labelKey: "create.billSchoolFees", icon: "🎓" },
  { id: "rent",             label: "Rent",               labelKey: "create.billRent",       icon: "🏠" },
  { id: "tv",               label: "TV (DSTV/GOtv/Zuku)", labelKey:"create.billTv", icon: "📺" },
  { id: "internet",         label: "Internet / fibre",   labelKey: "create.billInternet",   icon: "🌐" },
  { id: "airtime-data",     label: "Airtime & data",     labelKey: "create.billAirtime",    icon: "📱" },
  { id: "health-sha",       label: "Health — SHA/SHIF", labelKey:"create.billHealthSha", icon: "🛡️" },
  { id: "cooking-gas",      label: "Cooking gas (LPG)",  labelKey: "create.billCookingGas", icon: "🔥" },
  { id: "other",            label: "Other",              labelKey: "create.billOther",      icon: "🧾" },
];

// Generic fallback for communities without a localised list yet.
const GENERIC: BillType[] = [
  { id: "utilities",   label: "Utilities",      labelKey: "create.billUtilities",  icon: "💡" },
  { id: "rent",        label: "Rent",           labelKey: "create.billRent",       icon: "🏠" },
  { id: "school-fees", label: "School fees",    labelKey: "create.billSchoolFees", icon: "🎓" },
  { id: "airtime",     label: "Airtime & data", labelKey: "create.billAirtime",    icon: "📱" },
  { id: "other",       label: "Other",          labelKey: "create.billOther",      icon: "🧾" },
];

// ISO 3166-1 alpha-2 country code → localised list.
const BY_COUNTRY: Record<string, BillType[]> = {
  KE: KENYA,
};

/** The bill-type options for a community's country (alpha-2); generic fallback
 *  when that country has no localised list yet. */
export function billTypesForCountry(country: string | null | undefined): BillType[] {
  const list = !country ? GENERIC : (BY_COUNTRY[country.toUpperCase()] ?? GENERIC);
  return list.map((bt) => ({ ...bt, label: billLabel(bt) }));
}

/** Resolve a stored bill-type id to its {label, icon}, searching ALL lists — so a
 *  card renders correctly even when the viewer's country differs from the poster's.
 *  An unknown id (a future / foreign list) renders raw with a neutral icon. Empty
 *  / missing id ⇒ null. */
export function billTypeDisplay(id: string | null | undefined): { label: string; icon: string } | null {
  if (!id) return null;
  for (const list of [KENYA, GENERIC]) {
    const hit = list.find(b => b.id === id);
    if (hit) return { label: billLabel(hit), icon: hit.icon };
  }
  return { label: id, icon: "🧾" };
}
