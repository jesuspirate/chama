// ══════════════════════════════════════════════════════════════════════════
// Chama — User Community Selection (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// The user's chosen community persists across sessions in localStorage
// under `chama_community:<pubkey>` once a signer is connected. First-run
// onboarding may write the legacy `chama_community` key before the pubkey is
// known; the scoped storage helper claims that value after connect. v2 will
// migrate this to a NIP-78 application-data event so the choice follows the
// npub across devices.
//
// The slug stored here flows into:
//   - createEscrow: tags listings with the user's community
//   - initFedimint: resolves which federation backs this community's wallet
//   - Browse filter: defaults to listings that match this community

import { DEFAULT_COMMUNITY_SLUG, getCommunityBySlug } from "./registry.js";
import {
  claimLegacyStorageItem,
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const COMMUNITY_STORAGE_KEY = "chama_community";

// v3.5.1 #6 — UNSCOPED "last home" display hint. The per-npub home lives at
// the scoped `chama_community:<pubkey>` key, which is UNREADABLE before a
// signer connects (no scope yet). On web there is no auto-login, so every
// reload lands on the disconnected ConnectScreen — and with the scoped home
// unreadable, a returning user was dropped onto the first-run globe.
//
// This hint is written whenever the home is set/known and read ONLY by the
// ConnectScreen, purely to keep a returning user past the globe pre-signin.
// It is deliberately NOT consulted by getUserCommunitySlug /
// claimLegacyStorageItem, so it can never flow into a *different* npub's
// committed community — the v3.5.1 onboarding-leak fix stays intact. Worst
// case on a shared browser is cosmetic: a fresh npub briefly sees the prior
// user's home name on the pre-signin welcome screen; their actual home is
// still resolved from their own (empty) scope after sign-in.
const LAST_HOME_KEY = "chama_last_home";

/** Persist the unscoped "last home" display hint (see LAST_HOME_KEY). */
export function setLastHomeHint(slug: string): void {
  try {
    if (typeof localStorage === "undefined" || !slug) return;
    localStorage.setItem(LAST_HOME_KEY, slug);
  } catch {
    // localStorage unavailable — silently no-op.
  }
}

/** Read the unscoped "last home" hint, or null. Unknown slugs (stale
 *  registry) resolve to null rather than flowing onward. */
export function getLastHomeHint(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LAST_HOME_KEY);
    if (!raw) return null;
    return getCommunityBySlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read the user's selected community slug. Falls back to the default
 *  (us-blf, the silent Global · Bitcoin / BLF backup) when nothing is stored or storage is unreachable. An
 *  unknown slug (stale entry from an older registry version) also
 *  falls back to default rather than silently flowing into new listings. */
export function getUserCommunitySlug(): string {
  try {
    const raw = claimLegacyStorageItem(COMMUNITY_STORAGE_KEY);
    if (!raw) return DEFAULT_COMMUNITY_SLUG;
    return getCommunityBySlug(raw) ? raw : DEFAULT_COMMUNITY_SLUG;
  } catch {
    return DEFAULT_COMMUNITY_SLUG;
  }
}

/** Read the raw stored community slug, returning `null` when the user
 *  hasn't picked one yet. Use this for UI affordances that should
 *  distinguish "explicit choice" from "default fallback" — e.g. the
 *  community pill highlight, where a first-time user should see no
 *  pill highlighted rather than a misleading default. For resolution
 *  paths (createEscrow, initFedimint) keep using `getUserCommunitySlug`,
 *  which guarantees a non-null slug. */
export function getUserCommunitySlugRaw(): string | null {
  try {
    const raw = claimLegacyStorageItem(COMMUNITY_STORAGE_KEY);
    if (!raw) return null;
    return getCommunityBySlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the user's community choice. Pass empty string to clear and
 *  revert to the default on next read. */
export function setUserCommunitySlug(slug: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!slug) removeScopedStorageItem(COMMUNITY_STORAGE_KEY);
    else {
      setScopedStorageItem(COMMUNITY_STORAGE_KEY, slug);
      // Keep the unscoped pre-signin display hint in sync (v3.5.1 #6).
      setLastHomeHint(slug);
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}

// ── RETIRED (v4.3): pre-signer onboarding selection stash ─────────────────
//
// v3.5.1 introduced a `chama_pending_community` localStorage stash because
// the globe picker ran BEFORE a signer was known and couldn't write the
// per-npub scoped community key. The v4.3 auth-first reorder moved the
// picker POST-connect (App's needsHomePick gate → handleSelectCommunity
// writes the npub scope directly), so the stash and its four helpers
// (set/get/clear/applyPendingCommunitySelection) were deleted. useEscrow's
// connect path removes any stale stash key left by pre-4.3 builds. Do NOT
// reuse the "chama_pending_community" key — old devices may still carry
// values under it.
