import { TIMEZONE_COUNTRY } from "./geography-data.js";
import { getCommunityBySlug } from "./registry.js";

const SEEN_PREFIX = "chama_timezone_nudge_v1:";
const seenInSession = new Set<string>();
export function deviceTimezoneCountry(timeZone?: string): string | null {
  try {
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_COUNTRY[zone] ?? null;
  } catch { return null; }
}
export function timezoneMismatchCountry(slug: string, timeZone?: string): string | null {
  const community = getCommunityBySlug(slug);
  const country = deviceTimezoneCountry(timeZone);
  if (!community?.country || !country || community.country === country || community.countries.includes(country)) return null;
  return country;
}
export function timezoneNudgeSeen(slug: string): boolean {
  if (seenInSession.has(slug)) return true;
  try { return localStorage.getItem(SEEN_PREFIX + slug) === "1"; } catch { return false; }
}
export function markTimezoneNudgeSeen(slug: string): void {
  seenInSession.add(slug);
  try { localStorage.setItem(SEEN_PREFIX + slug, "1"); } catch { /* session still remembers */ }
}
