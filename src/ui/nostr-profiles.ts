import { getLocalStorageUserScope, getScopedStorageItem, setScopedStorageItem } from "../storage/user-scope.js";

export const KIND0_TOGGLE_KEY_PREFIX = "chama_fetch_kind0_enabled_";

export type NostrProfileNameMap = Record<string, string>;

export function readKind0Toggle(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KIND0_TOGGLE_KEY_PREFIX + pubkey) === "1";
  } catch {
    return false;
  }
}

export function writeKind0Toggle(pubkey: string | null | undefined, on: boolean): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(KIND0_TOGGLE_KEY_PREFIX + pubkey, "1");
    else localStorage.removeItem(KIND0_TOGGLE_KEY_PREFIX + pubkey);
  } catch {
    // best-effort preference
  }
}

export function extractNostrProfileName(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    const raw =
      typeof parsed.display_name === "string" && parsed.display_name.trim()
        ? parsed.display_name
        : typeof parsed.displayName === "string" && parsed.displayName.trim()
          ? parsed.displayName
          : typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name
            : typeof parsed.username === "string" && parsed.username.trim()
              ? parsed.username
              : null;
    if (!raw) return null;
    const name = raw.trim().replace(/\s+/g, " ");
    return name.length > 40 ? name.slice(0, 39).trimEnd() + "..." : name;
  } catch {
    return null;
  }
}


// ── Generated trade names (v6.3.1) ─────────────────────────────────────────
// Every pubkey deterministically maps to a friendly "Adjective Animal" name —
// English adjective, Swahili animal — computed locally from the key alone.
// Every client derives the SAME name for the same pubkey with zero protocol,
// zero network, and zero setup, so trades read like people instead of hex.
// The name is a nickname, never an identity claim: the key stays canonical
// and visible where verification matters.

const NAME_ADJECTIVES = [
  "Amber", "Bold", "Brave", "Bright", "Calm", "Clever", "Cosmic", "Daring",
  "Deft", "Fleet", "Gentle", "Golden", "Grand", "Happy", "Keen", "Kind",
  "Lively", "Loyal", "Lucky", "Mellow", "Noble", "Patient", "Proud", "Quick",
  "Quiet", "Solid", "Steady", "Sunny", "Swift", "True", "Warm", "Wise",
] as const;

const NAME_ANIMALS = [
  "Simba", "Twiga", "Tembo", "Chui", "Duma", "Nyati", "Kobe", "Kiboko",
  "Kifaru", "Swala", "Mbuni", "Sungura", "Kanga", "Korongo", "Njiwa", "Tai",
  "Kipepeo", "Nyuki", "Samaki", "Pomboo", "Kasa", "Kongoni", "Digidigi", "Kima",
  "Ndovu", "Jogoo", "Mbega", "Chiriku", "Kunguru", "Mamba", "Paka", "Punda",
] as const;

/** Deterministic friendly name for any pubkey (FNV-1a over the lowercase
 *  key; two independent byte picks). Same input → same name on every device. */
export function generatedNameFor(pubkey: string): string {
  const key = pubkey.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const adjective = NAME_ADJECTIVES[hash & 31];
  const animal = NAME_ANIMALS[(hash >>> 5) & 31];
  return `${adjective} ${animal}`;
}

// ── Local self-chosen trade name ───────────────────────────────────────────
// A quick in-app username, stored per active npub on THIS device only — no
// Nostr profile (kind-0) setup required. Because it never leaves the device,
// only the owner sees it; everyone else sees the deterministic generated
// name (or the kind-0 name when that opt-in is on). Publishing it via kind-0
// from inside Chama is a later, separate feature.

export const LOCAL_TRADE_NAME_KEY = "chama_trade_name_v1";
const TRADE_NAME_MAX = 24;

export function sanitizeTradeName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, TRADE_NAME_MAX);
}

export function readLocalTradeName(): string | null {
  const value = getScopedStorageItem(LOCAL_TRADE_NAME_KEY);
  const clean = value ? sanitizeTradeName(value) : "";
  return clean || null;
}

export function writeLocalTradeName(raw: string): void {
  setScopedStorageItem(LOCAL_TRADE_NAME_KEY, sanitizeTradeName(raw));
}

function isActiveUser(pubkey: string): boolean {
  const scope = getLocalStorageUserScope();
  return !!scope && pubkey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_") === scope;
}

/** The display name for a pubkey, layered (v6.3.1 — trades read like
 *  people, never hex, with zero required setup):
 *    1. the viewer's own locally chosen trade name (their explicit in-app
 *       choice, self only, this device),
 *    2. the counterparty's kind-0 profile name (only when that network
 *       opt-in is enabled — `enabled` gates the FETCHED map, not the local
 *       math below),
 *    3. the deterministic generated name every client derives identically.
 *  Returns null only without a pubkey, so `?? shortPubkey(...)` fallbacks at
 *  call sites remain as belt-and-braces. */
export function profileNameFor(
  profiles: NostrProfileNameMap | undefined,
  pubkey: string | null | undefined,
  enabled: boolean,
): string | null {
  if (!pubkey) return null;
  if (isActiveUser(pubkey)) {
    const own = readLocalTradeName();
    if (own) return own;
  }
  if (enabled) {
    const kind0 = profiles?.[pubkey.toLowerCase()];
    if (kind0) return kind0;
  }
  return generatedNameFor(pubkey);
}

