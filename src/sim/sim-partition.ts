// ══════════════════════════════════════════════════════════════════════════
// Chama — sim/prod partition for TRADE-HISTORY storage keys
// ══════════════════════════════════════════════════════════════════════════
//
// Sim mode is hard-partitioned on the wire: every sim event carries the
// `chama-sim` tag and `shouldDropForSimPolicy` drops the other world's
// events on arrival. But the LOCAL history stores were scoped by npub only,
// and sim shares the browser and the npub with prod. So a circle run in the
// sandbox was written into the same durable trade index as real trades, and
// prod would later offer it as "your latest trade" — then fail to open it,
// because every event backing it is sim-tagged and correctly dropped
// ("Couldn't open that trade — the relays didn't return it", Jet 2026-09-19).
//
// The fix is one suffix, applied to the stores that remember WHICH TRADES
// EXIST. Prod keys are unchanged (no migration, nothing to lose); sim gets
// its own list, which is what a sandbox should have had all along.
//
// Deliberately NOT applied to settings-shaped stores (home community, saved
// handles, payout profiles): re-doing setup to try a demo would be friction
// with no honesty gained. What must never cross is trade IDENTITY.

import { isSimModeOn } from "./simMode.js";

export const SIM_KEY_SUFFIX = "#sim";

/** Suffix a storage key with the active world. Prod returns `base` exactly. */
export function worldScopedKey(base: string): string {
  return isSimModeOn() ? base + SIM_KEY_SUFFIX : base;
}
