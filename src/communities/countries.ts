// ══════════════════════════════════════════════════════════════════════════
// Chama — Full-world country list for the globe / country picker
// ══════════════════════════════════════════════════════════════════════════
//
// PHILOSOPHY.md §6's "Hey Chama, where's home?" globe lets users tap their
// country off a full-world map. This is the data layer: every country in
// COUNTRY_CURRENCY is tappable and resolves to its OWN flag + currency + a
// backing federation — never a generic "Global · USD".
//
// The honest split (the user's "a flag is not a Chama" point):
//   • realChamas        — communities backed by a verified local federation
//                         with real arbiters (Kenya/Afribit+Bitsacco).
//                         These land the user straight in.
//   • defaultCommunity  — the country's own flag + currency on its regional
//                         default federation (Africa→OCA, LatAm→LatNet, else→
//                         BLF). The picker gives these the honest "no local
//                         Chama here yet" landing.

import {
  type Community,
  defaultCountryChama,
  flagEmojiForCountry,
  getCommunitiesByCountry,
  isNativeVerifiedChama,
  isRealLocalChama,
} from "./registry.js";
import { COUNTRY_CURRENCY, currencyForCountry } from "./country-currency.js";

// The picker's full country set is exactly the currency table's keys, so the
// two never drift. Sorted by localized name at render time.
export const PICKER_COUNTRY_CODES: readonly string[] = Object.keys(COUNTRY_CURRENCY);

let regionNames: Intl.DisplayNames | null = null;

/** Localized country name from an ISO alpha-2 code, via Intl.DisplayNames.
 *  Falls back to the raw code on older webviews without DisplayNames support
 *  — the flag + code still render, so the picker degrades, never breaks. */
export function countryName(code: string): string {
  try {
    if (!regionNames) {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    }
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export type PickerCountry = {
  code: string;
  name: string;
  flag: string;
  currency: string;
  /** Verified local Chamas (real arbiters) for this country: 0, 1, or many
   *  (Kenya → Afribit + Bitsacco). >0 ⇒ land directly / disambiguate. */
  realChamas: Community[];
  /** ALL named registry chamas for this country — real-local AND
   *  native-verified (US → BLF; Kenya → Afribit + Bitsacco) — excluding the
   *  synthesized country shell. Drives the N-chama drill-down: ≥2 ⇒ show the
   *  disambiguation picker (tier-tagged), regardless of which tier each is.
   *  Empty ⇒ the country lands on its generated shell. */
  chamas: Community[];
  /** What a press resolves to when there's no real Chama yet: the country's
   *  own flag + currency on its regional default federation. Prefers an
   *  existing registry slug (stable, e.g. tz-tzs); otherwise a generated
   *  shell. `isGeneratedShell` ⇒ must be persisted (addCustomCommunity) on
   *  select, since its slug isn't in the pre-seed registry. */
  defaultCommunity: Community;
  isGeneratedShell: boolean;
  /** The picker's green-tier split:
   *   • "live"       — elected LOCAL arbiters (isRealLocalChama). ⚡ Live now.
   *   • "available"  — backed by a native-verified G-Bot fed, no local
   *                    arbiters yet. ✓ Available now (still green, honest).
   *   • "comingSoon" — genuinely uncovered (no verified fed). Quiet, rare. */
  availability: "live" | "available" | "comingSoon";
};

export function getAllPickerCountries(): PickerCountry[] {
  return PICKER_COUNTRY_CODES.map((code): PickerCountry => {
    const all = getCommunitiesByCountry(code);
    const realChamas = all.filter(isRealLocalChama);
    const currency = currencyForCountry(code);
    const name = countryName(code);
    // A non-real registry community (e.g. tz-tzs on BLF) is the stable
    // default landing; only synthesize a shell when nothing exists yet.
    const registryDefault = all.find((c) => !isRealLocalChama(c)) ?? null;
    const defaultCommunity =
      registryDefault ??
      defaultCountryChama({ country: code, name, currency, languages: [] });
    const availability: PickerCountry["availability"] =
      realChamas.length > 0
        ? "live"
        : isNativeVerifiedChama(defaultCommunity)
          ? "available"
          : "comingSoon";
    return {
      code,
      name,
      flag: flagEmojiForCountry(code),
      currency,
      realChamas,
      chamas: all,
      defaultCommunity,
      isGeneratedShell: registryDefault === null,
      availability,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Globe hub markers (lat, lng) — the "live activity dots" nod from PHILOSOPHY.md §6.
// EMPTIED 2026-07-03: now that every country is enabled, a curated orange subset
// implied "only these places" and contradicted the two-green-tier "you're covered
// wherever you are" message. An empty set = a clean, uniform spinning world (the
// globe still turns; the country list below does the actual selecting). To restore
// a populated look, either repopulate this array or scatter dots across ALL enabled
// countries. Former hubs, kept for easy revival:
//   [-1.29,36.82] Nairobi · [6.52,3.38] Lagos · [5.60,-0.19] Accra · [14.69,-17.44]
//   Dakar · [-26.20,28.04] Joburg · [-6.79,39.21] Dar · [0.35,32.58] Kampala ·
//   [9.07,7.49] Abuja · [40.71,-74.01] NYC · [-23.55,-46.63] São Paulo · [13.69,-89.19] San Salvador
export const GLOBE_MARKERS: readonly [number, number][] = [];
