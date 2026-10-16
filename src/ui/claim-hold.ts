import { getSignInEnvironment, isFediWebViewSignInEnvironment } from "./sign-in-environment.js";

/**
 * v7 redesign — where the claim's hold-to-confirm lives.
 *
 * Jet chose option (b), 2026-10-05: true.
 * false: the hold is on the trade room's Collect button; inside the
 *   claim sheet each destination's final "send" is a single tap.
 * true (option b): the hold moves onto that final
 *   "send" in the sheet (ClaimSendButton), and Collect becomes a plain tap
 *   everywhere except inside Fedi, where Collect pays out immediately and
 *   must stay a hold.
 */
export const CLAIM_HOLD_IN_SHEET = true;

/** Whether the trade room's Collect button is a hold. It always is today;
 *  with the hold moved into the sheet it stays one only inside Fedi, where
 *  the sheet auto-claims into the host wallet the moment Collect is tapped. */
export function collectIsHold(): boolean {
  if (!CLAIM_HOLD_IN_SHEET) return true;
  return isFediWebViewSignInEnvironment(getSignInEnvironment());
}
