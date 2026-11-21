import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COUNTRY_CURRENCY } from "./country-currency.js";
import { currencyFlag, currencyName, currencySymbol, describeCurrency, rankCurrencies } from "./currency-names.js";

// Jet, 2026-11-21: the converter's currency picker showed bare codes.
const world = [...new Set(Object.values(COUNTRY_CURRENCY))].sort();

// Every currency the picker can list has a real name in every app language.
for (const lang of ["en", "es", "fr", "sw"]) {
  const unnamed = world.filter(code => currencyName(code, lang) === code);
  assert.deepEqual(unnamed, [], `${lang}: every picker currency has a name`);
}
assert.equal(currencyName("KES", "en"), "Kenyan Shilling");
assert.equal(currencyName("KES", "sw"), "Shilingi ya Kenya");
assert.match(currencyName("USD", "fr"), /^D/, "French names start with a capital in a list row");
assert.equal(currencyName("ZZZ", "en"), "ZZZ", "an unknown code falls back to itself");

// Symbols: a real symbol when there is one, never the code repeated.
assert.equal(currencySymbol("USD", "en"), "$");
assert.equal(currencySymbol("EUR", "en"), "€");
for (const code of world) assert.notEqual(currencySymbol(code, "en"), code);

// Flags: the issuing country, the EU for the euro, none for shared regional ones.
assert.equal(currencyFlag("USD"), "🇺🇸");
assert.equal(currencyFlag("KES"), "🇰🇪");
assert.equal(currencyFlag("EUR"), "🇪🇺");
assert.equal(currencyFlag("XOF"), null, "the West African CFA franc is no single country's");
assert.equal(currencyFlag("XAF"), null);

const about = describeCurrency("xof", "en");
assert.equal(about.code, "XOF");
assert.ok(about.countries.includes("Senegal"), "shared currencies list who uses them");

// Search: by code, by name, by country, in the reader's language and English.
const first = (q: string, lang = "en") => rankCurrencies(world, q, lang)[0];
assert.equal(first("kes"), "KES");
assert.equal(first("KES"), "KES");
assert.equal(first("kenya"), "KES", "a country finds its currency");
assert.equal(first("uk"), "GBP", "country aliases work too");
assert.equal(first("usa"), "USD");
assert.equal(first("senegal"), "XOF");
assert.equal(first("euro"), "EUR");
assert.equal(first("france"), "EUR");
assert.ok(rankCurrencies(world, "dollar").includes("USD"));
assert.ok(rankCurrencies(world, "dollar", "sw").includes("USD"), "English names are searched in every language");
assert.ok(rankCurrencies(world, "dolar", "es").includes("USD"));
assert.ok(rankCurrencies(world, "etats", "fr").includes("USD"), "accents are optional");
assert.equal(first("shilingi", "sw") !== undefined, true);
assert.deepEqual(rankCurrencies(world, "zzzzqq"), [], "no match is no match");
assert.deepEqual(rankCurrencies(world, "  "), world, "an empty query shows everything in order");

// Display only: the converter still hands back the ISO code as the value.
const converter = readFileSync(new URL("../ui/components/BitcoinConverter.tsx", import.meta.url), "utf8");
assert.match(converter, /value: code,\s*\n\s*label: code,/, "the picker's value and trigger stay the bare code");
assert.match(converter, /search=\{currencySearch\}/, "the converter's picker is searchable");

console.log("Currency names: every currency named in en/es/fr/sw, flags, symbols and search passed");
