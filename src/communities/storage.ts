// ══════════════════════════════════════════════════════════════════════════
// Chama — User Community Selection (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// The user's chosen community persists across sessions in localStorage
// under the key `chama_community`. v2 will migrate this to a NIP-78
// application-data event so the choice follows the npub across devices.
//
// The slug stored here flows into:
//   - createEscrow: tags listings with the user's community
//   - initFedimint: resolves which federation backs this community's wallet
//   - Browse filter: defaults to listings that match this community

import { DEFAULT_COMMUNITY_SLUG, getCommunityBySlug } from "./registry.js";

export const COMMUNITY_STORAGE_KEY = "chama_community";

/** Read the user's selected community slug. Falls back to the default
 *  (global-usd) when nothing is stored or storage is unreachable. An
 *  unknown slug (stale entry from an older registry version) also
 *  falls back to default rather than silently flowing into new listings. */
export function getUserCommunitySlug(): string {
  try {
    const raw = typeof localStorage !== "undefined"
      ? localStorage.getItem(COMMUNITY_STORAGE_KEY)
      : null;
    if (!raw) return DEFAULT_COMMUNITY_SLUG;
    return getCommunityBySlug(raw) ? raw : DEFAULT_COMMUNITY_SLUG;
  } catch {
    return DEFAULT_COMMUNITY_SLUG;
  }
}

/** Persist the user's community choice. Pass empty string to clear and
 *  revert to the default on next read. */
export function setUserCommunitySlug(slug: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!slug) localStorage.removeItem(COMMUNITY_STORAGE_KEY);
    else localStorage.setItem(COMMUNITY_STORAGE_KEY, slug);
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}
