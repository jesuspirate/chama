import assert from "node:assert/strict";
import { rankCountries, normalizeCountryQuery } from "./country-search.js";
import { getAllPickerCountries } from "./countries.js";

const world = getAllPickerCountries().map(c => ({ code: c.code, name: c.name }));
const first = (q: string) => rankCountries(world, q)[0]?.code;
const codes = (q: string) => rankCountries(world, q).map(c => c.code);

assert.equal(normalizeCountryQuery("  U.K. "), "uk");

// The two that started this: neither worked before.
assert.equal(first("us"), "US", "us → United States, ahead of Belarus/Cyprus/Russia");
assert.equal(first("uk"), "GB", "uk → United Kingdom, which is not its ISO code");
assert.equal(first("usa"), "US");
assert.equal(first("britain"), "GB");
assert.equal(first("uae"), "AE");

// Ranking, not culling: the substring matches survive, just lower down.
const usResults = codes("us");
assert.equal(usResults[0], "US");
assert.ok(usResults.length > 1, "other countries containing 'us' are still reachable");

// Ordinary typing is unchanged.
assert.equal(first("keny"), "KE");
assert.equal(first("tanz"), "TZ");
assert.equal(first("united states"), "US");
assert.ok(codes("zzzz").length === 0, "no match still means no match");
assert.ok(codes("").length === 0, "an empty query shows nothing, as before");

console.log("Country search: aliases, ranking and plain typing passed");
