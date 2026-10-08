// ══════════════════════════════════════════════════════════════════════════
// Chama — Browse look: "steps" (Figma pass) or the classic "canvas"
// ══════════════════════════════════════════════════════════════════════════
//
// Jet, 2026-10-08: try the Figma "one question at a time" look on Browse,
// with a one-tap way back to the canvas. Both looks run the same canvas
// conversation and the same matching; only the presentation differs. The
// choice is a per-device convenience, so localStorage is fine.

import { useSyncExternalStore } from "react";

export type BrowseSkin = "steps" | "canvas";
const KEY = "chama_browse_skin";
const listeners = new Set<() => void>();

export function readBrowseSkin(): BrowseSkin {
  try { return localStorage.getItem(KEY) === "canvas" ? "canvas" : "steps"; } catch { return "steps"; }
}

export function writeBrowseSkin(skin: BrowseSkin): void {
  try { localStorage.setItem(KEY, skin); } catch { /* private mode: this session only */ }
  memory = skin;
  listeners.forEach(fn => fn());
}

let memory: BrowseSkin | null = null;
const snapshot = () => memory ?? (memory = readBrowseSkin());

export function useBrowseSkin(): [BrowseSkin, (skin: BrowseSkin) => void] {
  const skin = useSyncExternalStore(
    fn => { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot,
    () => "steps" as BrowseSkin,
  );
  return [skin, writeBrowseSkin];
}
