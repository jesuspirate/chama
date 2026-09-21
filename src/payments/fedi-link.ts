// ══════════════════════════════════════════════════════════════════════════
// Chama — handing ecash to Fedi instead of asking someone to paste it
// ══════════════════════════════════════════════════════════════════════════
//
// Direction matters here, and only one direction is ours to automate.
//
// LOCKING with ecash: the note must be minted inside Fedi. Chama cannot
// initiate that, and the paste step is the mechanism, not friction — the
// user goes to their wallet, exports an exact amount, and brings it back.
// Nothing in this file applies to that path.
//
// CLAIMING: Chama already holds the note and is handing it OUT. Today that
// means a long QR and a copy button, and the user carries a bearer string
// across apps by hand. A deep link ends that: one tap and Fedi opens with
// the note already in it.
//
// The token is bearer value, so it rides in the URL FRAGMENT, which browsers
// and OS handlers do not send to any server, never in a query string.

/** Fedi's universal link host. Chama's own constant — never taken from a
 *  relay, a listing, or anything a counterparty can influence. */
export const FEDI_LINK_BASE = "https://app.fedi.xyz/link";

/**
 * Practical ceiling for a URL handed to an OS handler. Long OOB notes exist
 * (many denominations = a long string), and a link past this is more likely
 * to be truncated by an intent/handler than to open — so we return null and
 * the caller keeps the QR and copy button, which always work.
 */
export const FEDI_LINK_MAX_TOKEN_CHARS = 2000;

/** Fedimint OOB notes are base64-ish bearer strings. Anything outside that
 *  alphabet is not a note we should be handing to another app. */
const TOKEN_SHAPE = /^[A-Za-z0-9+/=_-]+$/;

/**
 * A link that opens Fedi with this ecash note loaded, or null when we should
 * not offer one. Null is a normal answer: the caller shows the QR and copy.
 */
export function fediEcashLink(token: string | null | undefined): string | null {
  const clean = (token ?? "").trim();
  if (!clean) return null;
  if (clean.length > FEDI_LINK_MAX_TOKEN_CHARS) return null;
  if (!TOKEN_SHAPE.test(clean)) return null;
  return `${FEDI_LINK_BASE}#screen=ecash&id=${encodeURIComponent(clean)}`;
}
