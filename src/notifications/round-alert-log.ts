import { CHAMA_NEXT } from "../sim/next-build.js";
import { recordNativeFundingDiagnostic } from "./native-push.js";
import type { Outcome } from "../escrow-engine/types.js";

export interface RoundAlert { shareId: string; roundId: string; outcome: Outcome; at: number }
const KEY = "chama_next_round_alerts_v1";
export function roundAlertLog(): RoundAlert[] {
  try { const entries = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(entries) ? entries.slice(-50) : []; }
  catch { return []; }
}
/** Called only after the vote publisher succeeds. No private key or payload. */
export function recordRoundVote(shareId: string, roundId: string, outcome: Outcome, at: number): void {
  if (!CHAMA_NEXT) return;
  const entry = { shareId, roundId, outcome, at };
  try { localStorage.setItem(KEY, JSON.stringify([...roundAlertLog(), entry].slice(-50))); } catch { /* privacy mode */ }
  void recordNativeFundingDiagnostic({ area: "round-watcher", ...entry });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:round-alert"));
}
