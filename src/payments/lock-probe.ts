// Lock invoice, Step 2a (Jet, 6.4.25-rc.7 timing): run the federation check
// while the Lock button is being held. rc.7 measured it at ~650 ms after the
// hold; the hold itself is 1.2 s, so starting it on press-down hides it.
//
// Read-only: the check only asks whether the federation answers. No invoice,
// nothing payable, no sats move, no join or switch. A check started on
// press-down is used only for the same trade on the same federation, and
// only while fresh; an early lift simply leaves it unused. A failed early
// check is never trusted as a refusal: the Lock path asks again.

export const LOCK_PROBE_FRESH_MS = 5_000;

export type ProbeResult = { ok: true } | { ok: false; error: string };
type Probe = () => Promise<ProbeResult>;

let primed: { key: string; at: number; answer: Promise<ProbeResult> } | null = null;
let clock = () => Date.now();

export function lockProbeKey(federationId: string | null | undefined, escrowId: string): string | null {
  return federationId ? `${federationId}:${escrowId}` : null;
}

/** Press-down: start the check for this trade unless a fresh one is running. */
export function primeLockProbe(key: string | null, probe: Probe): void {
  if (!key) return;
  if (primed?.key === key && clock() - primed.at < LOCK_PROBE_FRESH_MS) return;
  primed = {
    key, at: clock(),
    answer: probe().catch((error: unknown) => ({ ok: false as const, error: String(error) })),
  };
}

/** Lock confirmed: a fresh passing check for this trade, else a new check. */
export async function takeLockProbe(key: string | null, probe: Probe): Promise<{ result: ProbeResult; early: boolean }> {
  const early = primed;
  primed = null;
  if (key && early && early.key === key && clock() - early.at < LOCK_PROBE_FRESH_MS) {
    const result = await early.answer;
    if (result.ok) return { result, early: true };
  }
  return { result: await probe(), early: false };
}

/** Tests only. */
export function resetLockProbe(now?: () => number): void {
  primed = null;
  clock = now ?? (() => Date.now());
}
