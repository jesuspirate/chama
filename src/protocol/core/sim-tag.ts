// ══════════════════════════════════════════════════════════════════════════
// Protocol core — the sim-mode event tag
// ══════════════════════════════════════════════════════════════════════════
//
// Wire format only. Whether THIS device is in sim mode is an app concern and
// lives in src/sim/simMode.ts; the core only needs to recognise the tag on a
// received event.

/**
 * Nostr tag that flags an event as sim-mode-published. Consumers
 * filter on the tag's first element (`chama-sim`) and treat any
 * non-empty value as match — the version slot exists so future sim
 * schemas can be distinguished without breaking older events.
 */
export const SIM_TAG_NAME = "chama-sim";
export const SIM_TAG_VERSION = "v1";

/**
 * Whether a received Nostr event was published from sim mode. Read
 * from the event's tags; we do not trust the relay-side filter alone.
 */
export function eventIsSim(event: { tags: string[][] }): boolean {
  for (const t of event.tags) {
    if (t[0] === SIM_TAG_NAME) return true;
  }
  return false;
}
