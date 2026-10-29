// ══════════════════════════════════════════════════════════════════════════
// Chama — Sandbox build flag
// ══════════════════════════════════════════════════════════════════════════
//
// The sandbox is production code with the money layer replaced: the same
// bundle main would ship, built with `VITE_CHAMA_SANDBOX=1`, served from its
// own origin (poc.getchama.app) so browser storage never overlaps the live
// app. In a sandbox build sim mode is on and cannot be turned off — not by
// `?sim=0`, not by the entry modal, not by anything in localStorage — so the
// origin can never touch a real federation or real sats.
//
// `__CHAMA_SANDBOX__` is a Vite `define`. It is undefined in dev, Android,
// Tauri and live web builds, and in direct Node/tsx protocol tests, where the
// flag reads false and sim mode keeps its URL-driven behaviour.

export const CHAMA_SANDBOX: boolean =
  typeof __CHAMA_SANDBOX__ !== "undefined" && __CHAMA_SANDBOX__ === true;

/** Where the sandbox build is served. Documentation only; nothing routes on it. */
export const SANDBOX_HOST = "poc.getchama.app";

/**
 * String baked into the sandbox bundle only (as a DOM attribute on the sim
 * pill) so the deploy script can prove a dist is a sandbox build before it
 * uploads, and the live lane can refuse one. It comes from a Vite define that
 * is "" outside sandbox builds, so no other bundle carries the literal
 * (vite 8 kept a plain constant in every build's shared chunk).
 */
export const SANDBOX_BUILD_MARKER: string =
  typeof __CHAMA_SANDBOX_MARKER__ !== "undefined" ? __CHAMA_SANDBOX_MARKER__ : "";
