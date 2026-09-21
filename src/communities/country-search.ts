// ══════════════════════════════════════════════════════════════════════════
// Chama — country search: what people actually type
// ══════════════════════════════════════════════════════════════════════════
//
// The picker matched a country only by name substring or an exact ISO code.
// That fails the two most common things anyone types. "uk" is not a code
// (the United Kingdom is GB) so it matched nothing at all, and "us" matched
// Belarus, Cyprus, Mauritius and Russia before the United States, which is
// worse than nothing because the answer is on screen and buried.
//
// Pure, so it can be tested without a picker: give it the list and a query,
// get the list back ranked. Never filters a real match out — it reorders.

export interface SearchableCountry {
  code: string;
  name: string;
}

/** What people type instead of the ISO code. Lower case, no punctuation —
 *  `normalize` strips both before lookup, so "U.K." and "U K" arrive as "uk". */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  us: "US", usa: "US", america: "US", unitedstates: "US", states: "US",
  uk: "GB", gb: "GB", britain: "GB", greatbritain: "GB", england: "GB",
  scotland: "GB", wales: "GB", unitedkingdom: "GB",
  uae: "AE", emirates: "AE",
  drc: "CD", congokinshasa: "CD",
  car: "CF",
  ivorycoast: "CI", cotedivoire: "CI",
  southkorea: "KR", korea: "KR",
  northkorea: "KP",
  czechia: "CZ", czechrepublic: "CZ",
  holland: "NL", netherlands: "NL",
  swaziland: "SZ",
  burma: "MM",
  eire: "IE", ireland: "IE",
  turkiye: "TR", turkey: "TR",
  cabo: "CV", capeverde: "CV",
  ksa: "SA", saudi: "SA",
  png: "PG",
  nz: "NZ", newzealand: "NZ",
  za: "ZA", southafrica: "ZA",
  tz: "TZ", tanzania: "TZ",
  ke: "KE", kenya: "KE",
  ng: "NG", nigeria: "NG",
  gh: "GH", ghana: "GH",
  sv: "SV", elsalvador: "SV",
};

export function normalizeCountryQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Rank, do not cull. Lower score sorts first:
 *   0  the query IS this country's code, or an alias for it ("us", "uk")
 *   1  the name starts with the query ("uni" → United …)
 *   2  a word inside the name starts with the query ("states" → United States)
 *   3  the name merely contains the query ("us" → Belarus)
 * Anything unmatched is dropped. Ties keep the caller's original order, so a
 * featured or live country stays ahead of a quiet one.
 */
export function rankCountries<T extends SearchableCountry>(countries: readonly T[], raw: string): T[] {
  const q = normalizeCountryQuery(raw);
  if (!q) return [];
  const aliased = COUNTRY_ALIASES[q];
  const scored: { item: T; score: number; index: number }[] = [];

  countries.forEach((item, index) => {
    const code = item.code.toLowerCase();
    const name = item.name.toLowerCase();
    const flat = name.replace(/[^a-z]/g, "");
    let score: number | null = null;

    if (code === q || (aliased && item.code.toUpperCase() === aliased)) score = 0;
    else if (flat.startsWith(q) || name.startsWith(q)) score = 1;
    else if (name.split(/[^a-z]+/i).some(word => word.toLowerCase().startsWith(q))) score = 2;
    else if (name.includes(raw.trim().toLowerCase()) || flat.includes(q)) score = 3;

    if (score !== null) scored.push({ item, score, index });
  });

  return scored
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .map(entry => entry.item);
}
