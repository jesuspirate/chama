// ══════════════════════════════════════════════════════════════════════════
// Work — categories (A4), per-country registry
// ══════════════════════════════════════════════════════════════════════════
//
// A work category makes a Work listing MATCHABLE. That is the whole reason it
// exists: Assisted Chama pairs a worker's offer with a client's request, and
// matching on free text is either a substring hack or a language model. Neither
// is acceptable on a money path — one is wrong quietly, the other is expensive,
// unauditable, and cannot run offline.
//
// ⭐ DELIBERATELY SMALL AND FLAT. Twelve tiles, no drilling. A deep taxonomy is
// the complexity AC exists to remove, and it fails the people it is for: someone
// posting from a shared handset does not want a six-level tree, and a tree
// always has a leaf nobody's real job fits under. The escape hatch below is what
// makes a small set honest.
//
// ⚠ THE FREE-TEXT ESCAPE IS MANDATORY, in every list, forever. "Other" plus the
// listing's own description means the closed set can never block a person from
// publishing their actual work. Matching degrades to the other signals (rails,
// community, amount) for those listings rather than refusing them.
//
// INFORMATIONAL METADATA ONLY — never touches escrow logic, exactly like
// `bill-types.ts`, whose shape this follows on purpose.

import { translate, getCurrentLang } from "../i18n/index.js";

export interface WorkCategory {
  /** Stable slug persisted on the listing (e.g. "repair-trades"). Never change:
   *  it is the join key both sides of a match are compared on. */
  id: string;
  /** English source-of-truth label, kept raw for search + as the fallback. */
  label: string;
  /** i18n key so the DISPLAY label follows the viewer's language. App chrome
   *  translates to the viewer; the listing's own words stay as written. */
  labelKey?: string;
  icon: string;
}

function workLabel(c: WorkCategory): string {
  return c.labelKey ? translate(getCurrentLang(), c.labelKey) : c.label;
}

/** The default set. Chosen to cover how work is actually sold in the markets
 *  Chama serves — trades, transport, care, land, and small commerce — rather
 *  than mirroring a Western freelance-platform taxonomy. */
const GENERIC: WorkCategory[] = [
  { id: "repair-trades",   label: "Repair & trades",      labelKey: "work.catRepair",    icon: "🔧" },
  { id: "construction",    label: "Building & construction", labelKey: "work.catConstruction", icon: "🧱" },
  { id: "transport",       label: "Delivery & driving",   labelKey: "work.catTransport", icon: "🛵" },
  { id: "home-care",       label: "Cleaning & home",      labelKey: "work.catHomeCare",  icon: "🧹" },
  { id: "food",            label: "Cooking & catering",   labelKey: "work.catFood",      icon: "🍲" },
  { id: "farm",            label: "Farm & land",          labelKey: "work.catFarm",      icon: "🌾" },
  { id: "beauty",          label: "Hair & beauty",        labelKey: "work.catBeauty",    icon: "💇" },
  { id: "tailoring",       label: "Tailoring & crafts",   labelKey: "work.catTailoring", icon: "🧵" },
  { id: "teaching",        label: "Teaching & tutoring",  labelKey: "work.catTeaching",  icon: "📚" },
  { id: "care",            label: "Childcare & care work", labelKey: "work.catCare",     icon: "🤲" },
  { id: "digital",         label: "Design & digital",     labelKey: "work.catDigital",   icon: "💻" },
  { id: "other",           label: "Something else",       labelKey: "work.catOther",     icon: "✳️" },
];

/** ISO 3166-1 alpha-2 → localised list. Empty today by design: the generic set
 *  is deliberately broad, and a country list should be added when someone who
 *  lives there says it is wrong, not when we guess. */
const BY_COUNTRY: Record<string, WorkCategory[]> = {};

/** The work categories for a community's country (alpha-2), generic fallback. */
export function workCategoriesForCountry(country: string | null | undefined): WorkCategory[] {
  const list = !country ? GENERIC : (BY_COUNTRY[country.toUpperCase()] ?? GENERIC);
  return list.map((c) => ({ ...c, label: workLabel(c) }));
}

/** Resolve a stored id to {label, icon}, searching EVERY list — a card must
 *  render correctly when the viewer's country differs from the poster's. An
 *  unknown id (a future or foreign list) renders raw rather than vanishing. */
export function workCategoryDisplay(
  id: string | null | undefined,
): { label: string; icon: string } | null {
  if (!id) return null;
  for (const list of [GENERIC, ...Object.values(BY_COUNTRY)]) {
    const hit = list.find((c) => c.id === id);
    if (hit) return { label: workLabel(hit), icon: hit.icon };
  }
  return { label: id, icon: "✳️" };
}

/** Every known category id, for validation and for the matcher's own checks. */
export function isKnownWorkCategory(id: string | null | undefined): boolean {
  if (!id) return false;
  return [GENERIC, ...Object.values(BY_COUNTRY)].some((list) => list.some((c) => c.id === id));
}
