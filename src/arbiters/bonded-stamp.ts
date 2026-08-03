// ══════════════════════════════════════════════════════════════════════════
// Chama — verifying the CREATE `bondedArbiters` stamp
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠ THE STAMP IS CREATOR-CONTROLLED AND UNVERIFIED ON THE WIRE.
//
// `bondedArbiters` rides in on CREATE, written by the creator's own client and
// stored verbatim by the reducer (state-machine.ts `handleCreate`). The reducer
// is pure — it cannot read the chain — so it has no way to check the claim, and
// that is correct: verification belongs in the consent layer, which is where
// this module lives.
//
// What the unverified stamp buys an attacker: `pickPreferredArbiter` intersects
// it with the pool, and a stamp naming exactly ONE key yields a set of size one,
// which short-circuits the deterministic pick entirely. Stamp your confederate
// and the honest counterparty's own client seats them — the attacker need not
// even be the locker. Meanwhile `TradeDetail` was fetching the chain-verified
// bonded set and then passing the creator's stamp to the classifier without ever
// comparing the two.
//
// ⭐ FAIL-SOFT IN BOTH DIRECTIONS, and the asymmetry is deliberate:
//   • no verified set yet (fetch pending, offline, relay flap) ⇒ the stamp is
//     used as-is, exactly as before, and `checked` is false. Refusing to seat a
//     legitimately bonded arbiter because the network is slow would punish
//     honest users for an attacker's existence.
//   • a verified set IS available ⇒ the stamp is INTERSECTED with it, and any
//     stamped key the chain does not back is reported so the UI can say so.
// Never invent a bonded arbiter; never strand a trade over a failed lookup.

/** Case-insensitive hex compare, matching the rest of the arbiters modules. */
function norm(pk: string | null | undefined): string | null {
  const t = pk?.trim().toLowerCase();
  return t ? t : null;
}

export interface StampVerdict {
  /** The stamp to actually act on: intersected when we could check, the raw
   *  claim when we could not. */
  effective: string[];
  /** Stamped keys the chain does NOT back. Non-empty ⇒ the creator claimed a
   *  bond that does not exist, which is worth surfacing even though the
   *  intersection has already neutralised it. */
  unbacked: string[];
  /** False when no verified set was available, so the caller knows the green
   *  reading is "not contradicted" rather than "confirmed". */
  checked: boolean;
}

/**
 * Reconcile a CREATE's `bondedArbiters` claim against the chain-verified set.
 *
 * `verified` of `null`/`undefined` means "we could not check" and is distinct
 * from `[]`, which means "we checked and this community has no bonded
 * arbiters". The empty array correctly empties the stamp; the null does not.
 */
export function verifyBondedStamp(
  stamped: readonly string[] | null | undefined,
  verified: readonly string[] | null | undefined,
): StampVerdict {
  const claim = [...new Set((stamped ?? []).map(norm).filter((pk): pk is string => !!pk))];
  if (claim.length === 0) return { effective: [], unbacked: [], checked: !!verified };
  if (!verified) return { effective: claim, unbacked: [], checked: false };

  const backed = new Set(verified.map(norm).filter((pk): pk is string => !!pk));
  const effective = claim.filter((pk) => backed.has(pk));
  const unbacked = claim.filter((pk) => !backed.has(pk));
  return { effective, unbacked, checked: true };
}

/** True when the creator claimed a bond the chain does not back. Display-only —
 *  a forged stamp is already neutralised by the intersection, but a counterparty
 *  deciding whether to send fiat deserves to know the creator wrote something
 *  untrue into the trade. */
export function stampIsForged(verdict: StampVerdict): boolean {
  return verdict.checked && verdict.unbacked.length > 0;
}
