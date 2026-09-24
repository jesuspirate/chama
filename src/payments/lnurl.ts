import { errorText } from "./error-text.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — LNURL-pay resolver for Lightning Address claim destinations
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.7: claim time is when the user provides a destination
// to receive sats. v0.3.0's DestinationPicker accepts a Lightning Address
// (`user@domain.tld`); this module resolves it to a BOLT11 invoice for the
// exact claim amount via LNURL-pay.
//
// Two-stage resolution:
//   1. Parse the address synchronously. Malformed input fails here, before
//      any network call. UX win: "that's not a valid Lightning Address" in
//      <1ms beats a 5-second DNS timeout that surfaces as a generic network
//      error.
//   2. Fetch metadata at https://{domain}/.well-known/lnurlp/{user}, then
//      hit the callback URL with the amount to receive a BOLT11.
//
// Errors are typed via LnurlError.code so DestinationPicker can render a
// targeted message (DNS down vs server 500 vs amount out of range vs
// malformed metadata). Per Q2 the picker does NOT auto-fall-back to BOLT11
// paste mode on resolution failure — it surfaces the typed error and lets
// the user retry or switch tier deliberately.
//
// LNURL-pay protocol reference: LUD-06, LUD-16 (Lightning Address).

/** Code-tagged error carrying the failure category. Callers branch on
 *  `.code` to render the right message. */
export class LnurlError extends Error {
  constructor(public code: LnurlErrorCode, message: string) {
    super(message);
    this.name = "LnurlError";
  }
}

export type LnurlErrorCode =
  /** Input failed parse-time validation. No network call was made. */
  | "LnurlParseError"
  /** DNS resolution or transport-level failure (CORS, fetch threw). */
  | "LnurlDnsError"
  /** Server reachable but returned non-2xx, or LNURL `status: "ERROR"`. */
  | "LnurlServerError"
  /** Server returned 2xx but body was non-JSON or didn't match the
   *  LNURL-pay schema. Includes "tag != payRequest" and missing fields. */
  | "LnurlMalformedError"
  /** Requested amount fell outside the recipient's minSendable/maxSendable. */
  | "LnurlAmountOutOfRangeError";

/** Parsed Lightning Address. */
export interface LightningAddressParts {
  user: string;
  domain: string;
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function stripLightningUri(raw: string): string {
  const trimmed = raw.trim();
  return /^lightning:/i.test(trimmed) ? trimmed.slice("lightning:".length).trim() : trimmed;
}

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= BECH32_GENERATORS[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const expanded: number[] = [];
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) >> 5);
  expanded.push(0);
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) & 31);
  return expanded;
}

function bech32VerifyChecksum(hrp: string, data: number[]): boolean {
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || (value >> fromBits) !== 0) {
      throw new LnurlError("LnurlParseError", "LNURL contains invalid bech32 data");
    }
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new LnurlError("LnurlParseError", "LNURL has invalid bech32 padding");
  }
  return ret;
}

/** True iff `raw` looks like a raw bech32 LNURL or lightning:LNURL URI. */
export function isRawLnurl(raw: string): boolean {
  if (typeof raw !== "string") return false;
  return /^lnurl1[02-9ac-hj-np-z]+$/i.test(stripLightningUri(raw));
}

/** Decode a raw bech32 LNURL into its metadata URL. */
export function parseRawLnurl(raw: string): string {
  if (typeof raw !== "string") {
    throw new LnurlError("LnurlParseError", "LNURL must be text");
  }
  const input = stripLightningUri(raw);
  if (!input) {
    throw new LnurlError("LnurlParseError", "LNURL cannot be empty");
  }
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) {
    throw new LnurlError("LnurlParseError", "LNURL cannot mix upper and lower case");
  }
  const normalized = input.toLowerCase();
  const sep = normalized.lastIndexOf("1");
  if (sep < 1 || sep + 7 > normalized.length) {
    throw new LnurlError("LnurlParseError", "Malformed LNURL bech32 payload");
  }
  const hrp = normalized.slice(0, sep);
  if (hrp !== "lnurl") {
    throw new LnurlError("LnurlParseError", "LNURL must start with lnurl1");
  }
  const dataChars = normalized.slice(sep + 1);
  const data = [...dataChars].map((char) => BECH32_CHARSET.indexOf(char));
  if (data.some((value) => value < 0)) {
    throw new LnurlError("LnurlParseError", "LNURL contains invalid bech32 characters");
  }
  if (!bech32VerifyChecksum(hrp, data)) {
    throw new LnurlError("LnurlParseError", "LNURL checksum is invalid");
  }
  const payload = data.slice(0, -6);
  const bytes = convertBits(payload, 5, 8, false);
  const url = new TextDecoder().decode(new Uint8Array(bytes)).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LnurlError("LnurlParseError", "LNURL did not decode to a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LnurlError("LnurlParseError", "LNURL decoded to an unsupported URL scheme");
  }
  return parsed.toString();
}

/** Parse a Lightning Address (LUD-16) — `user@domain.tld`. Synchronous;
 *  throws LnurlError("LnurlParseError") for malformed input.
 *
 *  Validation rules (intentionally strict — Lightning Addresses are
 *  email-shaped but not full email; restricting to the LUD-16 subset
 *  catches typos before a network round-trip):
 *    - exactly one '@'
 *    - user: lowercase a-z, 0-9, dot, dash, underscore (1+ chars)
 *    - domain: at least one dot, ASCII letters/digits/dashes, TLD ≥ 2 chars
 *    - whitespace trimmed before validation
 *    - case-insensitive (normalized to lowercase) */
export function parseLightningAddress(raw: string): LightningAddressParts {
  if (typeof raw !== "string") {
    throw new LnurlError(
      "LnurlParseError",
      "Lightning Address must be a string",
    );
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new LnurlError(
      "LnurlParseError",
      "Lightning Address cannot be empty",
    );
  }
  // Exactly one '@'.
  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) {
    throw new LnurlError(
      "LnurlParseError",
      `Not a valid Lightning Address: expected one '@', got ${atCount}`,
    );
  }
  const match = trimmed.match(
    /^([a-z0-9._-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/,
  );
  if (!match) {
    throw new LnurlError(
      "LnurlParseError",
      `Not a valid Lightning Address: ${raw}`,
    );
  }
  return { user: match[1], domain: match[2] };
}

/** True iff `raw` parses as a Lightning Address. Convenience for
 *  DestinationPicker's input classifier — never throws. */
export function isLightningAddress(raw: string): boolean {
  try {
    parseLightningAddress(raw);
    return true;
  } catch {
    return false;
  }
}

/** LNURL-pay metadata returned from `.well-known/lnurlp/{user}`. */
export interface LnurlPayMetadata {
  /** Callback URL to GET with `?amount=<msats>` to receive a BOLT11. */
  callback: string;
  /** Minimum receivable amount in millisatoshis. */
  minSendable: number;
  /** Maximum receivable amount in millisatoshis. */
  maxSendable: number;
  /** Description metadata (used by some wallets for invoice annotation). */
  metadata: string;
  /** Always "payRequest" for LNURL-pay. */
  tag: "payRequest";
}

/** Non-2xx LNURL responses commonly carry the only useful diagnosis in a
 * JSON `reason` or `message` field. Preserve it instead of reducing every
 * recipient-wallet refusal to an opaque HTTP status. */
async function lnurlHttpErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json() as Record<string, unknown>;
    for (const value of [body.reason, body.message, body.error]) {
      if (typeof value === "string" && value.trim()) {
        return `${value.trim()} (HTTP ${res.status})`;
      }
    }
  } catch {
    // A non-JSON error page still gets the status-based fallback.
  }
  return fallback;
}

/** Fetch LNURL-pay metadata for a Lightning Address. Caller passes a
 *  fetch implementation explicitly so tests can mock it without touching
 *  globalThis.fetch. */
export async function fetchLnurlPayMetadata(
  address: string,
  fetchImpl: typeof fetch = (typeof fetch !== "undefined" ? fetch : (() => {
    throw new Error("fetch is not available in this environment");
  }) as any),
): Promise<LnurlPayMetadata> {
  const { user, domain } = parseLightningAddress(address);
  const url = `https://${domain}/.well-known/lnurlp/${user}`;
  return fetchLnurlPayMetadataUrl(url, domain, fetchImpl);
}

/** Fetch LNURL-pay metadata from a decoded raw LNURL URL. */
export async function fetchLnurlPayMetadataUrl(
  url: string,
  label = (() => {
    try { return new URL(url).host; }
    catch { return "LNURL server"; }
  })(),
  fetchImpl: typeof fetch = (typeof fetch !== "undefined" ? fetch : (() => {
    throw new Error("fetch is not available in this environment");
  }) as any),
): Promise<LnurlPayMetadata> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e: any) {
    throw new LnurlError(
      "LnurlDnsError",
      `Couldn't reach ${label}: ${errorText(e, "network error")}`,
    );
  }
  if (!res.ok) {
    throw new LnurlError(
      "LnurlServerError",
      await lnurlHttpErrorMessage(res, `${label} returned HTTP ${res.status}`),
    );
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new LnurlError(
      "LnurlMalformedError",
      `${label} returned non-JSON metadata`,
    );
  }
  // LNURL convention: `status: "ERROR"` with a `reason` field.
  if (body && body.status === "ERROR") {
    throw new LnurlError(
      "LnurlServerError",
      typeof body.reason === "string" && body.reason
        ? body.reason
        : `${label} returned an LNURL error`,
    );
  }
  if (
    !body ||
    body.tag !== "payRequest" ||
    typeof body.callback !== "string" ||
    typeof body.minSendable !== "number" ||
    typeof body.maxSendable !== "number"
  ) {
    throw new LnurlError(
      "LnurlMalformedError",
      `${label} returned malformed LNURL-pay metadata`,
    );
  }
  return {
    callback: body.callback,
    minSendable: body.minSendable,
    maxSendable: body.maxSendable,
    metadata: typeof body.metadata === "string" ? body.metadata : "",
    tag: "payRequest",
  };
}

/** Hit the LNURL-pay callback for `amountSats` and return the BOLT11
 *  invoice. Validates the amount against minSendable/maxSendable
 *  upfront — out-of-range amounts fail synchronously without a network
 *  call (same UX principle as parseLightningAddress). */
export async function requestLnurlInvoice(
  meta: LnurlPayMetadata,
  amountSats: number,
  fetchImpl: typeof fetch = (typeof fetch !== "undefined" ? fetch : (() => {
    throw new Error("fetch is not available in this environment");
  }) as any),
): Promise<string> {
  const amountMsats = amountSats * 1000;
  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    const minSats = Math.ceil(meta.minSendable / 1000);
    const maxSats = Math.floor(meta.maxSendable / 1000);
    throw new LnurlError(
      "LnurlAmountOutOfRangeError",
      `Amount ${amountSats} sats outside receiver's range (${minSats}–${maxSats} sats)`,
    );
  }
  const sep = meta.callback.includes("?") ? "&" : "?";
  const url = `${meta.callback}${sep}amount=${amountMsats}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e: any) {
    throw new LnurlError(
      "LnurlDnsError",
      `LNURL callback unreachable: ${errorText(e, "network error")}`,
    );
  }
  if (!res.ok) {
    throw new LnurlError(
      "LnurlServerError",
      await lnurlHttpErrorMessage(res, `LNURL callback returned HTTP ${res.status}`),
    );
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new LnurlError(
      "LnurlMalformedError",
      "LNURL callback returned non-JSON response",
    );
  }
  if (body && body.status === "ERROR") {
    throw new LnurlError(
      "LnurlServerError",
      typeof body.reason === "string" && body.reason
        ? body.reason
        : "LNURL callback returned an error",
    );
  }
  if (typeof body?.pr !== "string" || !/^lnbc/i.test(body.pr)) {
    throw new LnurlError(
      "LnurlMalformedError",
      "LNURL callback didn't return a BOLT11 invoice",
    );
  }
  return body.pr;
}

/** One-shot helper: address + amount → BOLT11. Composes
 *  parseLightningAddress → fetchLnurlPayMetadata → requestLnurlInvoice.
 *  This is what DestinationPicker calls for Tier 1 / Tier 2. */
export async function resolveLightningAddressToInvoice(
  address: string,
  amountSats: number,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const meta = await fetchLnurlPayMetadata(address, fetchImpl);
  return requestLnurlInvoice(meta, amountSats, fetchImpl);
}

/** One-shot helper: raw bech32 LNURL + amount → BOLT11. */
export async function resolveRawLnurlToInvoice(
  rawLnurl: string,
  amountSats: number,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const url = parseRawLnurl(rawLnurl);
  const meta = await fetchLnurlPayMetadataUrl(url, undefined, fetchImpl);
  return requestLnurlInvoice(meta, amountSats, fetchImpl);
}
