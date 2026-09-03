// ══════════════════════════════════════════════════════════════════════════
// Chama — Saved Payment Handles (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: handles are private by default; rails are public.
// A listing publicly advertises which rails a seller accepts but masks
// the actual handle in Browse and previews. The handle is revealed only
// to the three trade participants at lock time, via NIP-44 encryption in
// the LOCK event payload.
//
// This module owns:
//   - Persistence of counterparty payment handles in localStorage
//     (`chama_saved_handles:<pubkey>` once connected)
//   - CRUD over saved handles
//   - The visibility-setter guard that refuses "public" for rails whose
//     allowPublicHandle === false. The Settings UI is the first line
//     (it doesn't render a toggle for those rails); this module is the
//     second line — defense in depth, in case anything slips past UI.
//   - The masking utility used by render paths in Browse / profile / list
//
// Storage format (localStorage["chama_saved_handles[:pubkey]"] is a JSON array):
//   [{ id, rail, handle, visibility, createdAt }, ...]
//
// IDs are local to this device — they're how the LOCK payload's
// `handleId` field references the seller's audit trail. Other devices
// don't share the ID space; that's fine, the cleartext `handle` flowing
// alongside is what receivers use.

import { getRailByKey, railAllowsPublicHandle } from "./rail-registry.js";
import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";
import { randomId } from "../storage/random-id.js";

export const SAVED_HANDLES_STORAGE_KEY = "chama_saved_handles";
export const SAVED_HANDLES_BACKUP_STORAGE_KEY = "chama_saved_handles_backup";

/** Legacy rail key for pre-v0.6.3 Lightning Address rows. New payout
 *  destinations live in payments/payout-destinations.ts under
 *  `chama_payout_destinations`; this constant remains only so migration
 *  code can identify and remove old rows from saved handles. */
export const LIGHTNING_RAIL = "lightning";

export type HandleVisibility = "private" | "public";

export interface SavedHandle {
  /** Local UUID — used as the `handleId` audit reference in LOCK events. */
  id: string;
  /** Rail key — must match an entry in rail-registry.ts. */
  rail: string;
  /** Cleartext handle (phone number, username, account, etc.). Stored
   *  locally only; flows into LOCK payloads via the bridge's resolver. */
  handle: string;
  /** "private" → masked everywhere except active-trade reveal.
   *  "public"  → may be shown in profile / listing-public surfaces.
   *  Defense-in-depth: setVisibility() refuses "public" when the rail
   *  doesn't allow it, so this can never be "public" for a sensitive rail. */
  visibility: HandleVisibility;
  /** Unix seconds — for stable list ordering and audit. */
  createdAt: number;
  /** Legacy optional field from the era where Lightning destinations
   *  were stored here. Kept so old rows validate long enough to migrate. */
  lastUsedAt?: number;
  /** v0.6.5: rail keys the user accepts on THIS handle. Only meaningful
   *  for phone-number entries — one number often works on multiple
   *  mobile-money networks (Safaricom SIM → M-Pesa; Senegalese number →
   *  Wave AND Orange Money; etc.). Counterparties need to know which
   *  network to send to during a trade. Each entry is a rail key from
   *  rail-registry.ts (e.g. "m-pesa", "wave", "orange-money"). Empty/
   *  undefined for non-phone rails. Flows through the LOCK envelope so
   *  it's visible to all three participants at active-trade time. */
  networks?: string[];
}

// ── Storage I/O ───────────────────────────────────────────────────────────

function dedupeHandles(handles: SavedHandle[]): SavedHandle[] {
  const seen = new Set<string>();
  const out: SavedHandle[] = [];
  for (const handle of handles) {
    const key = handle.id || `${handle.rail}:${handle.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

function readStoredFromKey(key: string): SavedHandle[] {
  try {
    const raw = getScopedStorageItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Light validation — drop entries that don't look right rather than
    // crashing the whole page on a corrupt key.
    return dedupeHandles(parsed.filter(isSavedHandle));
  } catch {
    return [];
  }
}

function readStoredAll(): SavedHandle[] {
  const primary = readStoredFromKey(SAVED_HANDLES_STORAGE_KEY);
  if (primary.length > 0) return primary;

  const backup = readStoredFromKey(SAVED_HANDLES_BACKUP_STORAGE_KEY);
  if (backup.length > 0) {
    writeAll(backup, { allowEmptyOverwrite: true });
    return backup;
  }

  return [];
}

function readAll(): SavedHandle[] {
  return readStoredAll().filter(h => h.rail !== LIGHTNING_RAIL);
}

function writeAll(
  handles: SavedHandle[],
  opts: { allowEmptyOverwrite?: boolean } = {},
): void {
  try {
    // Preserve legacy Lightning rows until payout-destinations.ts has a
    // chance to migrate them into `chama_payout_destinations`.
    const existingPrimary = readStoredFromKey(SAVED_HANDLES_STORAGE_KEY);
    const existingBackup = readStoredFromKey(SAVED_HANDLES_BACKUP_STORAGE_KEY);
    const legacySource = existingPrimary.length > 0 ? existingPrimary : existingBackup;
    const legacyLightning = legacySource.filter(h => h.rail === LIGHTNING_RAIL);
    const next = dedupeHandles([
      ...handles.filter(h => h.rail !== LIGHTNING_RAIL),
      ...legacyLightning,
    ]);
    if (next.length === 0 && !opts.allowEmptyOverwrite) {
      const existing = readStoredFromKey(SAVED_HANDLES_STORAGE_KEY);
      const backup = readStoredFromKey(SAVED_HANDLES_BACKUP_STORAGE_KEY);
      if (existing.length > 0 || backup.length > 0) {
        console.warn("[chama] Refusing to overwrite saved payment handles with an empty list");
        return;
      }
    }
    const serialized = JSON.stringify(next);
    setScopedStorageItem(
      SAVED_HANDLES_STORAGE_KEY,
      serialized,
    );
    setScopedStorageItem(SAVED_HANDLES_BACKUP_STORAGE_KEY, serialized);
  } catch {
    // localStorage unavailable / quota exceeded — no-op. The Settings
    // UI surfaces persistence failures via the next read returning the
    // pre-write list (i.e. the change "didn't take").
  }
}

function isSavedHandle(x: any): x is SavedHandle {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.rail === "string" &&
    typeof x.handle === "string" &&
    (x.visibility === "private" || x.visibility === "public") &&
    typeof x.createdAt === "number" &&
    // networks is optional; if present must be an array of strings.
    (x.networks === undefined
      || (Array.isArray(x.networks) && x.networks.every((n: unknown) => typeof n === "string")))
  );
}

function generateId(): string {
  // SECURITY: saved-handle IDs are opaque storage keys. They're not
  // surfaced today, but if a future code path exposes them (via
  // export, a sync URL, etc.) predictability becomes a deanonymization
  // hook. Use crypto randomness so we don't have to revisit later.
  return `h_${Date.now().toString(36)}_${randomId(8)}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export function listSavedHandles(): SavedHandle[] {
  return readAll();
}

export function getSavedHandle(id: string): SavedHandle | null {
  return readAll().find(h => h.id === id) ?? null;
}

/** Saved handles for a given rail key, newest first. Used by the Create
 *  form to auto-prefill when the seller picks a payment method. */
export function getSavedHandlesByRail(rail: string): SavedHandle[] {
  return readAll()
    .filter(h => h.rail === rail)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function addSavedHandle(
  rail: string,
  handle: string,
  opts?: { networks?: string[] },
): SavedHandle {
  const trimmed = handle.trim();
  if (!trimmed) {
    throw new Error("Handle cannot be empty");
  }
  // v0.7.0: phone numbers get canonicalized to "+CC XXX-XXX-XXXX" on
  // save. Other rails store the user's input verbatim — formatting a
  // Revtag or email wouldn't help and could break a literal handle.
  const normalized = normalizeHandleForRail(rail, trimmed);
  const existing = readAll();
  const networks = opts?.networks?.filter(n => typeof n === "string" && n.length > 0);
  const entry: SavedHandle = {
    id: generateId(),
    rail,
    handle: normalized,
    visibility: "private",
    createdAt: Math.floor(Date.now() / 1000),
    ...(networks && networks.length > 0 ? { networks } : {}),
  };
  writeAll([entry, ...existing]);
  return entry;
}

export function deleteSavedHandle(id: string): void {
  writeAll(readAll().filter(h => h.id !== id), { allowEmptyOverwrite: true });
}

/** Update mutable fields of a saved handle. Visibility changes go
 *  through setHandleVisibility() instead — it's the one with the rail
 *  guard. */
export function updateSavedHandle(
  id: string,
  patch: { rail?: string; handle?: string; networks?: string[] },
): SavedHandle | null {
  const handles = readAll();
  const idx = handles.findIndex(h => h.id === id);
  if (idx === -1) return null;
  const nextRail = patch.rail ?? handles[idx].rail;
  const nextHandle = patch.handle !== undefined
    ? normalizeHandleForRail(nextRail, patch.handle)
    : handles[idx].handle;
  // Drop the networks field entirely when the patch sets it to an
  // empty array — keeps the stored object minimal for non-phone rails.
  const nextNetworks = patch.networks
    ?.filter(n => typeof n === "string" && n.length > 0);
  const next: SavedHandle = {
    ...handles[idx],
    ...(patch.rail !== undefined ? { rail: nextRail } : {}),
    ...(patch.handle !== undefined ? { handle: nextHandle } : {}),
    ...(patch.networks !== undefined
      ? (nextNetworks && nextNetworks.length > 0
          ? { networks: nextNetworks }
          : { networks: undefined })
      : {}),
  };
  // Strip undefined networks so the stored JSON stays clean.
  if (next.networks === undefined) delete next.networks;
  handles[idx] = next;
  writeAll(handles);
  return next;
}

// ── Visibility (the load-bearing privacy gate) ────────────────────────────

export type SetVisibilityResult =
  | { ok: true; handle: SavedHandle }
  | { ok: false; error: string };

/** Change a saved handle's visibility. Refuses "public" when the rail
 *  doesn't allow it. The Settings UI also hides the toggle for those
 *  rails — this is the second line of defense in case the toggle ever
 *  gets there by accident (programmatic call, future UI bug, etc.).
 *
 *  Refused requests return an error rather than throwing because the
 *  caller is typically a UI handler that needs to surface the message. */
export function setHandleVisibility(
  id: string,
  visibility: HandleVisibility,
): SetVisibilityResult {
  const handles = readAll();
  const idx = handles.findIndex(h => h.id === id);
  if (idx === -1) {
    return { ok: false, error: `No saved handle with id ${id}` };
  }
  const handle = handles[idx];

  // Refuse "public" for sensitive rails. The unknown-rail path is also
  // refused (railAllowsPublicHandle returns false for unknown keys) so
  // a stale handle from a removed rail can't be promoted to public.
  if (visibility === "public" && !railAllowsPublicHandle(handle.rail)) {
    return {
      ok: false,
      error:
        `Rail "${handle.rail}" doesn't allow public handles. ` +
        `Phone numbers, bank accounts, and email-based rails are kept private.`,
    };
  }

  const next: SavedHandle = { ...handle, visibility };
  handles[idx] = next;
  writeAll(handles);
  return { ok: true, handle: next };
}

// ── Privacy decision + masking ────────────────────────────────────────────

// ── Phone-number formatting ───────────────────────────────────────────────
//
// v0.7.0: normalize phone numbers to a consistent "+CC XXX-XXX-XXXX" shape
// so saved entries are unambiguous and visually scannable for the
// counterparty receiving them at LOCK time. The user can type the
// number any way they like — "+254712345678", "+254 712-345-678",
// "0712345678", "254-712-345-678" — and the formatter reduces it to a
// single canonical form before persistence. Display helpers can then
// replace the visible "+CC" with a country flag while preserving the
// dial code in storage.
//
// Country-code length is the only fuzzy part: most countries use a
// 2- or 3-digit CC, but a handful (NANP=1, Russia/KZ=7) use 1 digit.
// The function uses a small heuristic based on the first digit:
//   "1" or "7" → 1-digit CC (NANP / Russia)
//   "2…"      → 3-digit CC (most African countries)
//   anything else → 2-digit CC
// Domestic numbers (no leading "+") are left as dashed digit groups with
// no CC prefix — the user opted out of international formatting.
//
// The function is intentionally lenient: it never throws and always
// returns SOMETHING the user can read. Garbage in (empty string, all
// non-digits) yields a trimmed empty string.

const PHONE_CC_TO_ISO: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "39": "IT",
  "44": "GB",
  "49": "DE",
  "54": "AR",
  "55": "BR",
  "57": "CO",
  "61": "AU",
  "63": "PH",
  "81": "JP",
  "82": "KR",
  "86": "CN",
  "91": "IN",
  "92": "PK",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "221": "SN",
  "223": "ML",
  "225": "CI",
  "226": "BF",
  "229": "BJ",
  "233": "GH",
  "234": "NG",
  "237": "CM",
  "243": "CD",
  "250": "RW",
  "251": "ET",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "260": "ZM",
  "263": "ZW",
  "265": "MW",
  "503": "SV",
  "880": "BD",
};

const PHONE_CC_TO_COUNTRY: Record<string, string> = {
  "1": "US/Canada",
  "7": "Russia/Kazakhstan",
  "20": "Egypt",
  "27": "South Africa",
  "30": "Greece",
  "31": "Netherlands",
  "32": "Belgium",
  "33": "France",
  "34": "Spain",
  "39": "Italy",
  "44": "United Kingdom",
  "49": "Germany",
  "54": "Argentina",
  "55": "Brazil",
  "57": "Colombia",
  "61": "Australia",
  "63": "Philippines",
  "81": "Japan",
  "82": "South Korea",
  "86": "China",
  "91": "India",
  "92": "Pakistan",
  "212": "Morocco",
  "213": "Algeria",
  "216": "Tunisia",
  "218": "Libya",
  "221": "Senegal",
  "223": "Mali",
  "225": "Côte d'Ivoire",
  "226": "Burkina Faso",
  "229": "Benin",
  "233": "Ghana",
  "234": "Nigeria",
  "237": "Cameroon",
  "243": "DR Congo",
  "250": "Rwanda",
  "251": "Ethiopia",
  "254": "Kenya",
  "255": "Tanzania",
  "256": "Uganda",
  "260": "Zambia",
  "263": "Zimbabwe",
  "265": "Malawi",
  "503": "El Salvador",
  "880": "Bangladesh",
};

const PHONE_NATIONAL_GROUPS: Record<string, number[]> = {
  "1": [3, 3, 4],
  "7": [3, 3, 4],
  "33": [1, 2, 2, 2, 2],
  "54": [1, 2, 4, 4],
  "55": [2, 5, 4],
  "57": [3, 3, 4],
  "63": [3, 3, 4],
  "92": [3, 7],
  "221": [2, 3, 4],
  "233": [2, 3, 4],
  "251": [2, 3, 4],
  "254": [3, 3, 3],
  "255": [2, 3, 4],
  "880": [4, 6],
};

interface PhoneLengthRule {
  lengths?: number[];
  min?: number;
  max?: number;
  example: string;
}

const PHONE_LENGTH_RULES: Record<string, PhoneLengthRule> = {
  "1": { lengths: [10], example: "+1 555 123 4567" },
  "7": { lengths: [10], example: "+7 916 123 4567" },
  "20": { lengths: [10], example: "+20 100 123 4567" },
  "27": { lengths: [9], example: "+27 71 123 4567" },
  "30": { lengths: [10], example: "+30 691 234 5678" },
  "31": { lengths: [9], example: "+31 6 1234 5678" },
  "32": { lengths: [9], example: "+32 470 12 34 56" },
  "33": { lengths: [9], example: "+33 6 12 34 56 78" },
  "34": { lengths: [9], example: "+34 612 34 56 78" },
  "39": { min: 9, max: 10, example: "+39 312 345 6789" },
  "44": { lengths: [10], example: "+44 7700 900123" },
  "49": { min: 10, max: 11, example: "+49 1512 3456789" },
  "54": { lengths: [11], example: "+54 9 11 1234 5678" },
  "55": { lengths: [11], example: "+55 11 91234 5678" },
  "57": { lengths: [10], example: "+57 300 123 4567" },
  "61": { lengths: [9], example: "+61 412 345 678" },
  "63": { lengths: [10], example: "+63 917 123 4567" },
  "81": { min: 10, max: 11, example: "+81 90 1234 5678" },
  "82": { min: 9, max: 10, example: "+82 10 1234 5678" },
  "86": { lengths: [11], example: "+86 131 2345 6789" },
  "91": { lengths: [10], example: "+91 98765 43210" },
  "92": { lengths: [10], example: "+92 300 1234567" },
  "212": { lengths: [9], example: "+212 612 345678" },
  "213": { lengths: [9], example: "+213 551 234 567" },
  "216": { lengths: [8], example: "+216 20 123 456" },
  "218": { lengths: [9], example: "+218 91 234 5678" },
  "221": { lengths: [9], example: "+221 77 123 4567" },
  "223": { lengths: [8], example: "+223 76 12 34 56" },
  "225": { lengths: [10], example: "+225 07 12 34 5678" },
  "226": { lengths: [8], example: "+226 70 12 34 56" },
  "229": { lengths: [8], example: "+229 91 234 567" },
  "233": { lengths: [9], example: "+233 24 123 4567" },
  "234": { lengths: [10], example: "+234 801 234 5678" },
  "237": { lengths: [9], example: "+237 6 71 23 45 67" },
  "243": { lengths: [9], example: "+243 81 234 5678" },
  "250": { lengths: [9], example: "+250 78 123 4567" },
  "251": { lengths: [9], example: "+251 91 234 5678" },
  "254": { lengths: [9], example: "+254 712 345 678" },
  "255": { lengths: [9], example: "+255 71 234 5678" },
  "256": { lengths: [9], example: "+256 70 123 4567" },
  "260": { lengths: [9], example: "+260 97 123 4567" },
  "263": { lengths: [9], example: "+263 77 123 4567" },
  "265": { lengths: [9], example: "+265 99 123 4567" },
  "503": { lengths: [8], example: "+503 7123 4567" },
  "880": { lengths: [10], example: "+880 1700 123456" },
};

function normalizeHandleForRail(rail: string, handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) throw new Error("Handle cannot be empty");
  if (paymentHandleNeedsCountryCode(rail, trimmed)) {
    throw new Error("Include the country code so the other person can use this number, for example +1 555 555 5555.");
  }
  return shouldSanitizeHandleAsPhone(rail, trimmed)
    ? sanitizePhoneNumberForSave(trimmed)
    : trimmed;
}

/** True when a phone-capable payment rail received a phone-shaped value without
 *  an international prefix. Email/user-name alternatives remain untouched.
 *  Shared by every entry surface and enforced again at persistence. */
export function paymentHandleNeedsCountryCode(rail: string, handle: string): boolean {
  const trimmed = handle.trim();
  if (!trimmed || trimmed.startsWith("+") || trimmed.includes("@")) return false;
  const meta = getRailByKey(rail);
  const acceptsPhone = rail === "phone-number" || meta?.placeholder?.includes("+") === true;
  if (!acceptsPhone) return false;
  return /^\(?\d[\d\s().-]+$/.test(trimmed);
}

function railLooksPhoneBased(rail: string): boolean {
  if (rail === "phone-number") return true;
  const meta = getRailByKey(rail);
  return meta?.allowPublicHandle === false && meta.placeholder?.trim().startsWith("+") === true;
}

function shouldSanitizeHandleAsPhone(rail: string, handle: string): boolean {
  return railLooksPhoneBased(rail) || handle.trim().startsWith("+");
}

function isoToFlagEmoji(iso: string): string {
  const codePoints = iso.toUpperCase().split("")
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function phoneFlagForCountryCode(countryCode: string | null): string | null {
  if (!countryCode) return null;
  const iso = PHONE_CC_TO_ISO[countryCode];
  return iso ? isoToFlagEmoji(iso) : null;
}

function detectCountryCodeLength(digits: string): number {
  if (digits.length === 0) return 0;
  const known = [3, 2, 1].find(len =>
    digits.length >= len && PHONE_CC_TO_ISO[digits.slice(0, len)]
  );
  if (known) return known;
  // NANP (+1) and Russia/Kazakhstan (+7) are the well-known 1-digit CCs.
  if (digits[0] === "1" || digits[0] === "7") return 1;
  // Most African dial codes are 3 digits and start with "2":
  // 211 (South Sudan), 212 (Morocco), 213 (Algeria), 216 (Tunisia),
  // 218 (Libya), 220-229 (Gambia, Senegal, Mauritania, Mali, Guinea…),
  // 230-239 (Mauritius, Liberia, Sierra Leone, Ghana…), 240-249
  // (Equatorial Guinea, Gabon, Congo, DRC, Angola, Guinea-Bissau…),
  // 250-259 (Rwanda, Ethiopia, Somalia, Djibouti, Kenya, Tanzania,
  // Uganda…), 260-269 (Zambia, Madagascar, Zimbabwe, Namibia, Malawi,
  // Lesotho, Botswana, Swaziland, Comoros…), 290-299 (Saint Helena,
  // Eritrea, Aruba, Faroe, Greenland, Sudan, South Sudan).
  if (digits[0] === "2") return digits.length >= 3 ? 3 : 0;
  // Default: 2-digit CC covers most of Europe, Asia, Oceania.
  return digits.length >= 2 ? 2 : 0;
}

function expectedLengthText(rule: PhoneLengthRule): string {
  if (rule.lengths && rule.lengths.length > 0) {
    return rule.lengths.length === 1
      ? `${rule.lengths[0]} digits`
      : `${rule.lengths.join(" or ")} digits`;
  }
  return `${rule.min ?? 4}-${rule.max ?? 12} digits`;
}

function phoneLengthBounds(rule: PhoneLengthRule): { min: number; max: number } {
  if (rule.lengths && rule.lengths.length > 0) {
    return {
      min: Math.min(...rule.lengths),
      max: Math.max(...rule.lengths),
    };
  }
  return {
    min: rule.min ?? 4,
    max: rule.max ?? 12,
  };
}

function phoneLengthMatches(rule: PhoneLengthRule, length: number): boolean {
  if (rule.lengths && rule.lengths.length > 0) return rule.lengths.includes(length);
  return length >= (rule.min ?? 0) && length <= (rule.max ?? Number.POSITIVE_INFINITY);
}

export function getPhoneNumberSaveError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a phone number";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "Enter a phone number with digits";

  if (!hasPlus) {
    if (!digits.startsWith("0")) {
      return "Add the country code so nobody has to guess the missing prefix, for example +254 712 345 678.";
    }
    if (digits.length !== 10) {
      return digits.length < 10
        ? "This local phone number looks short. Include all 10 local digits, for example 0712 345 678."
        : "This local phone number looks too long. Use 10 local digits, for example 0712 345 678.";
    }
    return null;
  }

  const ccLen = detectCountryCodeLength(digits);
  if (ccLen === 0 || digits.length <= ccLen) {
    return "Enter the full phone number after the country code, for example +254 712 345 678.";
  }

  const countryCode = digits.slice(0, ccLen);
  const nationalLength = digits.length - ccLen;
  const rule = PHONE_LENGTH_RULES[countryCode];
  if (!rule) {
    if (digits.length < 8) {
      return "This phone number looks short. Include the full country code and national number.";
    }
    if (digits.length > 15) {
      return "This phone number looks too long. International phone numbers can be at most 15 digits.";
    }
    return null;
  }

  if (phoneLengthMatches(rule, nationalLength)) return null;

  const { min, max } = phoneLengthBounds(rule);
  const country = PHONE_CC_TO_COUNTRY[countryCode] ?? `+${countryCode}`;
  const direction = nationalLength < min ? "missing digits" : nationalLength > max ? "too many digits" : "the wrong length";
  return `This +${countryCode} ${country} number has ${direction}. It should have ${expectedLengthText(rule)} after +${countryCode}, for example ${rule.example}.`;
}

/** Strict save-time phone sanitizer. Keep formatPhoneNumber() lenient for
 *  typing, but refuse persistence when a known-country number is missing
 *  digits. This is the guardrail that keeps a seller from saving
 *  "+25471234567" when they meant "+254712345678". */
export function sanitizePhoneNumberForSave(value: string): string {
  const error = getPhoneNumberSaveError(value);
  if (error) throw new Error(error);
  return formatPhoneNumber(value);
}

/** Group a string of digits into "XXX-XXX-XXXX" chunks. Final chunk
 *  absorbs any 4-digit trailer (so NANP "5551234567" → "555-123-4567",
 *  not the ugly "555-123-456-7"). 1-digit trailers also merge into
 *  the previous chunk; 2-digit trailers stay separate.
 *
 *  Examples:
 *    "612345678"    (9)  → "612-345-678"
 *    "5551234567"   (10) → "555-123-4567"
 *    "12345678"     (8)  → "123-456-78"
 *    "123"          (3)  → "123"
 *    ""             (0)  → ""                                       */
function groupPhoneDigits(rest: string, countryCode?: string): string {
  if (rest.length === 0) return "";
  const pattern = countryCode ? PHONE_NATIONAL_GROUPS[countryCode] : undefined;
  if (pattern && pattern.reduce((sum, n) => sum + n, 0) === rest.length) {
    let offset = 0;
    return pattern.map(size => {
      const chunk = rest.slice(offset, offset + size);
      offset += size;
      return chunk;
    }).join("-");
  }

  const chunks: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const remaining = rest.length - i;
    // 4-digit trailer absorbed into one chunk; covers NANP / Russia
    // 10-digit forms cleanly.
    if (remaining === 4) {
      chunks.push(rest.slice(i, i + 4));
      i += 4;
    } else {
      const take = Math.min(3, remaining);
      chunks.push(rest.slice(i, i + take));
      i += take;
    }
  }
  return chunks.join("-");
}

/** Normalize a user-typed phone number to "+CC XXX-XXX-XXXX" form.
 *  Lenient: never throws, returns the best-effort canonical form.
 *  Examples:
 *    "+254712345678"         → "+254 712-345-678"
 *    "+254 712-345-678"      → "+254 712-345-678"  (idempotent)
 *    "  +254-712.345 678 "   → "+254 712-345-678"
 *    "+15551234567"          → "+1 555-123-4567"   (NANP)
 *    "0712345678"            → "071-234-5678"      (domestic, no CC)
 *    ""                      → ""
 *    "+"                     → "+"                 (typing in progress) */
export function formatPhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return hasPlus ? "+" : "";

  if (hasPlus) {
    const ccLen = detectCountryCodeLength(digits);
    if (ccLen === 0) return `+${digits}`;
    const cc = digits.slice(0, ccLen);
    const rest = digits.slice(ccLen);
    const grouped = groupPhoneDigits(rest, cc);
    return grouped ? `+${cc} ${grouped}` : `+${cc}`;
  }
  // Domestic — same grouping rule, no CC prefix.
  return groupPhoneDigits(digits);
}

export interface PhoneNumberDisplayParts {
  normalized: string;
  countryCode: string | null;
  flagEmoji: string | null;
  nationalDigits: string;
  nationalFormatted: string;
  /** Flag-led display for saved/revealed phone handles. */
  display: string;
  /** Value to show inside the tel input when the flag prefix is visible. */
  inputValue: string;
}

export function getPhoneNumberDisplayParts(value: string): PhoneNumberDisplayParts {
  const normalized = formatPhoneNumber(value);
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  const ccLen = hasPlus ? detectCountryCodeLength(digits) : 0;

  if (!hasPlus || ccLen === 0) {
    return {
      normalized,
      countryCode: null,
      flagEmoji: null,
      nationalDigits: digits,
      nationalFormatted: normalized,
      display: normalized,
      inputValue: normalized,
    };
  }

  const countryCode = digits.slice(0, ccLen);
  const nationalDigits = digits.slice(ccLen);
  const nationalFormatted = groupPhoneDigits(nationalDigits, countryCode);
  const flagEmoji = phoneFlagForCountryCode(countryCode);
  const flagDisplay = flagEmoji
    ? (nationalFormatted ? `${flagEmoji} ${nationalFormatted}` : flagEmoji)
    : normalized;

  return {
    normalized,
    countryCode,
    flagEmoji,
    nationalDigits,
    nationalFormatted,
    display: flagDisplay,
    inputValue: flagEmoji ? nationalFormatted : normalized,
  };
}

export interface PhoneCountryHint {
  countryCode: string;
  countryName: string | null;
  flagEmoji: string | null;
  expectedLength: string;
  nationalPlaceholder: string;
}

export function getPhoneCountryHint(value: string): PhoneCountryHint | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("+")) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  const ccLen = detectCountryCodeLength(digits);
  if (ccLen === 0) return null;

  const countryCode = digits.slice(0, ccLen);
  const rule = PHONE_LENGTH_RULES[countryCode];
  const exampleParts = rule ? getPhoneNumberDisplayParts(rule.example) : null;
  return {
    countryCode,
    countryName: PHONE_CC_TO_COUNTRY[countryCode] ?? null,
    flagEmoji: phoneFlagForCountryCode(countryCode),
    expectedLength: rule ? expectedLengthText(rule) : "4-12 digits",
    nationalPlaceholder: exampleParts?.nationalFormatted || "phone number",
  };
}

export function formatPhoneNumberForDisplay(value: string): string {
  return getPhoneNumberDisplayParts(value).display;
}

const ISO_TO_PHONE_CC: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [cc, iso] of Object.entries(PHONE_CC_TO_ISO)) {
    if (!(iso in m)) m[iso] = cc; // first dial code wins per ISO (e.g. "1" → US)
  }
  return m;
})();

/** A national-format phone placeholder for a community's country (ISO alpha-2),
 *  e.g. "KE" → "+254 712 345 678", "CM" → "+237 6 71 23 45 67". Null when we
 *  have no dial-code rule for that country, so callers can fall back. */
export function phonePlaceholderForCountryIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const cc = ISO_TO_PHONE_CC[iso.toUpperCase()];
  if (!cc) return null;
  return PHONE_LENGTH_RULES[cc]?.example ?? null;
}

/** Fully revealed phone number — for the settings reveal toggle and the
 *  active-trade reveal shown to the three participants. Unlike
 *  formatPhoneNumberForDisplay (flag-led, which drops the explicit +CC
 *  digits), this always shows the ENTIRE international number with the
 *  country code visible, and dash-groups the national part for
 *  readability in EVERY country — including ones whose dial code we
 *  don't recognise, where we still group the run rather than printing an
 *  unreadable string of digits. Flag-led when the country is known, so a
 *  participant about to send fiat sees e.g. "🇰🇪 +254 712-345-678".
 *    "+254712345678" → "🇰🇪 +254 712-345-678"
 *    "+15551234567"  → "🇺🇸 +1 555-123-4567"
 *    "+9991234567"   → "+999-123-4567"   (unknown CC: still grouped)
 *    "0712345678"    → "071-234-5678"    (domestic, no CC)            */
export function formatPhoneNumberRevealed(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return hasPlus ? "+" : "";

  // Domestic (no +): group the national digits, no country code to show.
  if (!hasPlus) return groupPhoneDigits(digits);

  const ccLen = detectCountryCodeLength(digits);
  // Unknown dial code: keep it readable anyway — group the whole run so
  // the user never sees a bare "+999123456789" wall of digits.
  if (ccLen === 0) return `+${groupPhoneDigits(digits)}`;

  const cc = digits.slice(0, ccLen);
  const national = groupPhoneDigits(digits.slice(ccLen), cc);
  const withCc = national ? `+${cc} ${national}` : `+${cc}`;
  const flag = phoneFlagForCountryCode(cc);
  return flag ? `${flag} ${withCc}` : withCc;
}

/** Mask a handle for public display. Heuristics:
 *   - Very short handles (<= 4 chars): full mask "•••"
 *   - Phone-shaped (starts with + or digit): keep the country flag
 *     when known, otherwise "+CC", plus last 4 digits. The previous heuristic
 *     ("split on space, keep first two chunks") leaked the whole number
 *     when the user entered without spaces — split(" ") returned a
 *     one-element array and "first two" was the entire input. v0.6.5
 *     fix: strip non-digits first so formatting doesn't matter, then
 *     reconstruct from a canonical anchor (country code + last 4).
 *   - Email-shaped (contains @): mask local + first chars of domain
 *   - Otherwise: keep first 2 + last 2, mask middle */
export function maskHandle(handle: string): string {
  if (!handle) return "";
  if (handle.length <= 4) return "•••";
  if (handle.startsWith("+") || /^\+?\d/.test(handle)) {
    const digits = handle.replace(/\D/g, "");
    if (digits.length <= 4) return `•••${digits}`;
    const parts = getPhoneNumberDisplayParts(handle);
    const last4 = digits.slice(-4);
    if (parts.flagEmoji) return `${parts.flagEmoji} ••• ${last4}`;
    return parts.countryCode ? `+${parts.countryCode} ••• ${last4}` : `••• ${last4}`;
  }
  if (handle.includes("@")) {
    const [local, domain = ""] = handle.split("@");
    const maskedLocal = local.length > 1 ? `${local[0]}•••` : "•••";
    const maskedDomain = domain.length > 1 ? `${domain[0]}•••${domain.includes(".") ? "." + domain.split(".").pop() : ""}` : domain;
    return `${maskedLocal}@${maskedDomain}`;
  }
  return `${handle.slice(0, 2)}•••${handle.slice(-2)}`;
}

/** Decide what to display for a saved handle in a public/profile context.
 *  Returns the cleartext handle when the rail allows public handles AND
 *  the user has opted in (visibility === "public"). Otherwise returns
 *  the masked form.
 *
 *  This is for Browse / listing preview / profile views where the viewer
 *  is NOT one of the trade's three participants. Active-trade reveal
 *  flows separately through the LOCK payload. */
export function publicHandleDisplay(handle: SavedHandle): string {
  if (handle.visibility === "public" && railAllowsPublicHandle(handle.rail)) {
    return handle.handle;
  }
  return maskHandle(handle.handle);
}

/** Display rule for a handle string given the viewer's relationship to
 *  the trade. The handle here is the cleartext that flowed in the LOCK
 *  payload (active trade) or that the viewer pulled from a public
 *  profile (settings-published handle).
 *
 *  - When the viewer IS one of the three participants of an active
 *    locked trade, return the cleartext (full reveal — they need to
 *    actually use it to send the fiat).
 *  - When the viewer is NOT a participant, return the masked form
 *    regardless of the visibility flag the seller set. The flag only
 *    controls whether the cleartext is allowed to flow into the public
 *    surface at all; viewer context still determines the final display. */
export function handleDisplayForViewer(
  handle: string,
  viewerIsParticipant: boolean,
): string {
  if (viewerIsParticipant) {
    return handle.startsWith("+")
      ? formatPhoneNumberRevealed(handle)
      : handle;
  }
  return maskHandle(handle);
}
