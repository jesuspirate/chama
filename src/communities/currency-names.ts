// ══════════════════════════════════════════════════════════════════════════
// Chama — what a currency code means, in the reader's language
// ══════════════════════════════════════════════════════════════════════════
//
// Jet, 2026-11-21: the converter's currency picker listed bare ISO codes
// (USD, AED, AFN, ALL…). Most people do not know AFN is the Afghan afghani or
// that ALL is the Albanian lek, so the list could only be read by people who
// already knew the answer. Every row now says the currency's name in the
// app's language, its symbol and a flag, and the list can be searched by
// name, code or the country that uses it.
//
// Display only. The value a picker hands back is always the ISO code it was
// given; nothing here changes what is stored or sent.

import { COUNTRY_CURRENCY } from "./country-currency.js";
import { countryName } from "./countries.js";
import { flagEmojiForCountry } from "./registry.js";
import { COUNTRY_ALIASES } from "./country-search.js";

const nameFormatters = new Map<string, Intl.DisplayNames | null>();

function displayNames(language: string): Intl.DisplayNames | null {
  if (!nameFormatters.has(language)) {
    try {
      nameFormatters.set(language, new Intl.DisplayNames([language], { type: "currency" }));
    } catch {
      nameFormatters.set(language, null);
    }
  }
  return nameFormatters.get(language) ?? null;
}

/** The currency's name in `language` ("Kenyan Shilling", "Shilingi ya Kenya").
 *  Falls back to the code itself on a webview without Intl.DisplayNames, so
 *  the picker degrades to today's list and never breaks. */
export function currencyName(code: string, language = "en"): string {
  const upper = code.toUpperCase();
  let name: string | undefined;
  try {
    name = displayNames(language)?.of(upper);
  } catch {
    name = undefined;
  }
  if (!name || name.toUpperCase() === upper) return upper;
  // French and Spanish write currency names in lower case ("dollar des
  // États-Unis"); as the first word of a list row it reads as a typo.
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
}

/** The short symbol people write ("$", "€", "KSh"), or null when the only
 *  symbol is the code itself. */
export function currencySymbol(code: string, language = "en"): string | null {
  const upper = code.toUpperCase();
  try {
    const part = new Intl.NumberFormat(language, { style: "currency", currency: upper, currencyDisplay: "narrowSymbol" })
      .formatToParts(1)
      .find(p => p.type === "currency")?.value?.trim();
    if (!part || part.toUpperCase() === upper) return null;
    return part;
  } catch {
    return null;
  }
}

/** Every country (ISO alpha-2) whose currency this is, in table order. */
export function countriesUsingCurrency(code: string): string[] {
  const upper = code.toUpperCase();
  return Object.keys(COUNTRY_CURRENCY).filter(country => COUNTRY_CURRENCY[country] === upper);
}

/** One flag that honestly stands for the currency, or null. ISO 4217 codes
 *  begin with the issuing country (USD → US, KES → KE), and EUR with the EU.
 *  Shared regional currencies with no issuing country (the CFA francs, the
 *  East Caribbean dollar) get no flag rather than one member's. */
export function currencyFlag(code: string): string | null {
  const upper = code.toUpperCase();
  if (upper === "EUR") return flagEmojiForCountry("EU");
  const issuer = upper.slice(0, 2);
  if (COUNTRY_CURRENCY[issuer] === upper) return flagEmojiForCountry(issuer);
  const users = countriesUsingCurrency(upper);
  return users.length === 1 ? flagEmojiForCountry(users[0]) : null;
}

export interface DescribedCurrency {
  code: string;
  name: string;
  symbol: string | null;
  flag: string | null;
  /** Names of the countries that use it, in the reader's language. */
  countries: string[];
}

export function describeCurrency(code: string, language = "en"): DescribedCurrency {
  const upper = code.toUpperCase();
  return {
    code: upper,
    name: currencyName(upper, language),
    symbol: currencySymbol(upper, language),
    flag: currencyFlag(upper),
    countries: countriesUsingCurrency(upper).map(country => countryName(country, language)),
  };
}

/** Lower case, accents dropped ("États" → "etats"), so "etats", "dolar" and
 *  "dólar" all find what was meant. */
export function foldSearchText(raw: string): string {
  return raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Rank, do not cull — the same rule as the country search. Lower sorts first:
 *   0  the query is the code, or names a country that uses it ("uk" → GBP)
 *   1  the code or the name starts with the query
 *   2  a word of the name starts with the query ("shil" → Kenyan Shilling)
 *   3  a country that uses it starts with the query ("kenya" → KES)
 *   4  the name or a country contains the query
 * The English name is searched too, so "dollar" works in every language.
 * Ties keep the caller's order. An empty query returns everything as given.
 */
export function rankCurrencies(codes: readonly string[], raw: string, language = "en"): string[] {
  const q = foldSearchText(raw);
  if (!q) return [...codes];
  const flatQ = q.replace(/[^a-z0-9]/g, "");
  const aliasCountry = COUNTRY_ALIASES[flatQ];
  const aliasCurrency = aliasCountry ? COUNTRY_CURRENCY[aliasCountry] : undefined;
  const scored: { code: string; score: number; index: number }[] = [];

  codes.forEach((code, index) => {
    const upper = code.toUpperCase();
    const lowerCode = upper.toLowerCase();
    const names = [...new Set([currencyName(upper, language), currencyName(upper, "en")])].map(foldSearchText);
    const countries = countriesUsingCurrency(upper)
      .flatMap(country => [countryName(country, language), countryName(country, "en")])
      .map(foldSearchText);
    const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

    let score: number | null = null;
    if (lowerCode === flatQ || aliasCurrency === upper) score = 0;
    else if (lowerCode.startsWith(flatQ) || names.some(n => n.startsWith(q))) score = 1;
    else if (names.some(n => words(n).some(w => w.startsWith(q)))) score = 2;
    else if (countries.some(c => c.startsWith(q) || words(c).some(w => w.startsWith(q)))) score = 3;
    else if (names.some(n => n.includes(q)) || countries.some(c => c.includes(q))) score = 4;

    if (score !== null) scored.push({ code, score, index });
  });

  return scored
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .map(entry => entry.code);
}
