// ══════════════════════════════════════════════════════════════════════════
// Protocol core — deterministic arbiter selection
// ══════════════════════════════════════════════════════════════════════════
//
// Pure functions of the signed payload: every client replaying the same
// CREATE picks the same seat. Which arbiters THIS device trusts is an app
// concern and stays in src/arbiters/pool.ts.

/**
 * v0.6.5: deterministic round-robin selection from a community arbiter
 * pool. Same escrow id always picks the same arbiter — important so
 * repeated relay replays of LOCK pick a consistent slot rather than
 * drifting. No server-side state required.
 *
 * Algorithm is intentionally simple (charcode sum mod pool length):
 * the input is a UUID-ish escrow id and the pool is tiny (≤ a few
 * dozen). A cryptographic hash would be overkill — distribution is
 * close enough to uniform for fair load-spreading across the pool.
 */
export function pickArbiterFromPool(
  pool: string[],
  escrowId: string,
  excludePubkeys: Array<string | null | undefined> = [],
): string | undefined {
  const excluded = new Set(
    excludePubkeys
      .map((pk) => pk?.toLowerCase())
      .filter((pk): pk is string => !!pk)
  );
  const candidates = pool.filter((pk) => !excluded.has(pk.toLowerCase()));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  let hash = 0;
  for (let i = 0; i < escrowId.length; i++) {
    hash = (hash + escrowId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % candidates.length;
  return candidates[idx];
}

/**
 * 2B prefer-bonded assignment. Picks deterministically from the FUNDED bonded
 * subset (∩ pool, minus exclusions) when non-empty, else falls back to the
 * legacy `pickArbiterFromPool`. Pure + replay-identical given the STAMPED
 * `bondedArbiters` set (never a live fetch), so every client replaying the same
 * CREATE computes the same seat. The reducer JOIN gate accepts BOTH this pick
 * AND the legacy pick, so a mixed-version client never rejects a valid arbiter
 * (see state-machine handleJoin). Empty/undefined bonded ⇒ identical to legacy.
 */
export function pickPreferredArbiter(
  pool: string[],
  bondedArbiters: readonly string[] | null | undefined,
  escrowId: string,
  excludePubkeys: Array<string | null | undefined> = [],
): string | undefined {
  const poolSet = new Set(pool.map((pk) => pk.toLowerCase()));
  const bondedInPool = (bondedArbiters ?? []).filter((pk) => poolSet.has(pk.toLowerCase()));
  if (bondedInPool.length > 0) {
    const preferred = pickArbiterFromPool(bondedInPool, escrowId, excludePubkeys);
    if (preferred) return preferred;
  }
  return pickArbiterFromPool(pool, escrowId, excludePubkeys);
}
