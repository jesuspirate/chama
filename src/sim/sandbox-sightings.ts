// ══════════════════════════════════════════════════════════════════════════
// Chama — sandbox trades seen by the real app
// ══════════════════════════════════════════════════════════════════════════
//
// The real app drops every sandbox (`chama-sim`) event on arrival, which is
// right: a test trade must never enter real state. But dropping it silently
// left a person who opened a sandbox trade in the real app with "Couldn't
// open that trade", and their own sandbox offer simply missing from Browse
// (Jet, rc.12: posted on the iPhone sandbox, looked for it on the Pixel APK).
//
// This module only REMEMBERS which trade ids were dropped as sandbox, and who
// created them, so the app can say so out loud. Nothing here reads the
// event's content or feeds any trade state; it is a list of ids in memory.

import { eventIsSim, isSimModeOn } from "./simMode.js";

export const SANDBOX_ORIGIN = "https://poc.getchama.app";

const MAX_SIGHTINGS = 500;

/** escrow id -> creator pubkey (lower-case hex), oldest first. */
const sightings = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * Called for every event the real app drops under the sim policy. Records
 * only the sandbox-in-real-app direction, and only signed trade events (the
 * relay layer verifies signatures before the drop predicate runs).
 */
export function noteDroppedSandboxEvent(event: { pubkey?: string; tags: string[][] }): void {
  if (isSimModeOn() || !eventIsSim(event)) return;
  const id = event.tags.find(t => t[0] === "d")?.[1];
  if (!id || !/^sm_[a-z0-9_]+$/i.test(id)) return;
  if (sightings.has(id)) return;
  const by = (event.pubkey ?? "").toLowerCase();
  sightings.set(id, by);
  if (sightings.size > MAX_SIGHTINGS) {
    const oldest = sightings.keys().next().value;
    if (oldest !== undefined) sightings.delete(oldest);
  }
  for (const listener of listeners) listener();
}

/** Whether the real app has seen (and dropped) this trade as a sandbox trade. */
export function wasSeenAsSandboxTrade(id: string): boolean {
  return sightings.has(id);
}

/** Sandbox trades this person created that the real app has seen. */
export function sandboxTradeCountBy(pubkey: string | null | undefined): number {
  if (!pubkey) return 0;
  const me = pubkey.toLowerCase();
  let n = 0;
  for (const by of sightings.values()) if (by === me) n++;
  return n;
}

export function onSandboxSighting(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only. */
export function resetSandboxSightingsForTests(): void {
  sightings.clear();
}
