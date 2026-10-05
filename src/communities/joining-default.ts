import { DEFAULT_COMMUNITY_SLUG } from "./registry.js";
import { getLastHomeHint, getUserCommunitySlugRaw } from "./storage.js";
import { getAllPickerCountries } from "./countries.js";
import { resolveCountryCommunitySlug } from "./country-resolve.js";

/** The community shown before joining is the default committed after the tap.
 * No identity or wallet mutation here; generated country entries only register
 * their public routing metadata, as they do in the country picker. */
export function resolveJoiningCommunitySlug(languages?: readonly string[]): string {
  const stored = getUserCommunitySlugRaw() ?? getLastHomeHint();
  if (stored) return stored;
  const tags = languages ?? (typeof navigator === "undefined" ? []
    : navigator.languages?.length ? navigator.languages : [navigator.language]);
  const countries = getAllPickerCountries();
  for (const tag of tags) {
    // Use an explicit locale region; language alone never guesses a country.
    const region = tag.match(/^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})(?:-|$)/i)?.[1];
    const country = region && countries.find(c => c.code === region.toUpperCase());
    if (country) return resolveCountryCommunitySlug(country);
  }
  return DEFAULT_COMMUNITY_SLUG;
}
