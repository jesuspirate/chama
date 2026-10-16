// ══════════════════════════════════════════════════════════════════════════
// Chama — Sim mode
// ══════════════════════════════════════════════════════════════════════════
//
// Sim mode replaces the live Fedimint client with an in-memory MockWallet
// so anyone can demo the full trade flow without needing a working
// federation, real ecash, or LN funding. Trades still go through real
// Nostr relays; only the money layer is fake.
//
// Activation
// ──────────
//   ?sim=1  → turn sim mode on for this app session
//   ?sim=1&onchain=slow       → delayed on-chain deposit (default)
//   ?sim=1&onchain=instant    → immediate, zero-fee legacy demo
//   ?sim=1&onchain=stuck      → deposit remains pending until cleanup
//   ?sim=1&onchain=underpaid  → deposit below the federation minimum
//   ?sim=0  → turn sim mode off
//
// Sandbox builds (`VITE_CHAMA_SANDBOX=1`, served at poc.getchama.app) force
// sim mode on: the URL flag, `setSimMode(false)` and localStorage are all
// ignored there. See sandbox-build.ts.
//
// There is no UI toggle. The URL flag is the public entry point. A normal
// `getchama.app` visit always clears a prior sim session: users must never
// land in a fake-money experience simply because they explored the sandbox
// earlier.
//
// Sim mode is independent of `powerUserMode` (the former `sandboxMode`).
// Power-user mode gates dangerous surfaces in production; sim mode swaps
// the wallet layer for a mock. Both can be on at once.
//
// Co-existence with `?testnet=1`
// ──────────────────────────────
// `isTestnetMode()` in mock-wallet.ts predates sim mode and gives a
// fresh-1k-sats wallet for unit-test scaffolding. Sim mode is the
// product-facing equivalent (0 starting sats, npub-keyed persistence,
// realistic timing). If both flags are set, sim mode wins.

import { CHAMA_SANDBOX } from "./sandbox-build.js";
import { SIM_TAG_NAME, SIM_TAG_VERSION, eventIsSim } from "../protocol/core/sim-tag.js";

const SIM_STORAGE_KEY = "chama_sim_mode";

let _cachedReadAtStartup: boolean | null = null;

/**
 * Read the `?sim=` URL parameter once at module load and apply it to
 * localStorage. `?sim=1` opts in; `?sim=0` *and a normal URL with no sim
 * parameter* opt out. After this, `isSimModeOn()` is a pure localStorage
 * read for the current app session.
 *
 * Called automatically on first `isSimModeOn()` invocation.
 */
function applyUrlFlagOnce(): void {
  if (_cachedReadAtStartup !== null) return;
  _cachedReadAtStartup = true;

  if (typeof window === "undefined") return;
  let param: string | null = null;
  try {
    param = new URLSearchParams(window.location.search).get("sim");
  } catch {
    return;
  }
  try {
    if (param === "1") {
      localStorage.setItem(SIM_STORAGE_KEY, "1");
    } else {
      // A bare production URL is an explicit return to real mode. This also
      // fixes older sticky `chama_sim_mode` values left by sandbox visits.
      localStorage.removeItem(SIM_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (SSR, privacy mode) — ignore
  }
}

/**
 * Whether sim mode is currently active. The URL is applied once at startup;
 * a bare production URL cannot inherit a prior sandbox session.
 */
export function isSimModeOn(): boolean {
  if (CHAMA_SANDBOX) return true;
  applyUrlFlagOnce();
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SIM_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Programmatic toggle. Used by the entry-modal "Exit sim mode" affordance.
 * URL is still the canonical entry; this exists so the modal's exit
 * button doesn't require a copy-paste of `?sim=0`.
 */
export function setSimMode(on: boolean): void {
  if (CHAMA_SANDBOX) return; // the sandbox never leaves sim mode
  try {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(SIM_STORAGE_KEY, "1");
    else localStorage.removeItem(SIM_STORAGE_KEY);
  } catch { /* no-op */ }
}

// The tag itself is wire format and lives in the protocol core.
export { SIM_TAG_NAME, SIM_TAG_VERSION, eventIsSim } from "../protocol/core/sim-tag.js";

/**
 * Returns the sim-tag array suitable for splatting into an event's
 * `tags`, or `null` if sim mode is off. Call this at every event-
 * construction site that should respect sim mode.
 */
export function simTagOrNull(): [string, string] | null {
  return isSimModeOn() ? [SIM_TAG_NAME, SIM_TAG_VERSION] : null;
}


/**
 * Drop policy for incoming events given the local sim-mode state:
 *   sim on, event not sim  → drop (we don't want prod chatter)
 *   sim on, event is sim   → keep
 *   sim off, event is sim  → drop (don't pollute prod UI with sim trades)
 *   sim off, event not sim → keep
 *   kind 0 (profiles)      → always keep
 */
export function shouldDropForSimPolicy(event: { kind?: number; tags: string[][] }): boolean {
  // A Nostr profile (kind 0) is who someone is, not trade data: both worlds
  // read the same one, so the sandbox shows real names (Jet, rc.12). The
  // sandbox never publishes one (useEscrow publishProfileName/Avatar).
  if (event.kind === 0) return false;
  const evtSim = eventIsSim(event);
  const localSim = isSimModeOn();
  return evtSim !== localSim;
}

export type SimOnchainMode = "slow" | "instant" | "stuck" | "underpaid";
export function simOnchainMode(search = typeof window === "undefined" ? "" : window.location.search): SimOnchainMode {
  const mode = new URLSearchParams(search).get("onchain");
  return mode === "instant" || mode === "stuck" || mode === "underpaid" ? mode : "slow";
}
