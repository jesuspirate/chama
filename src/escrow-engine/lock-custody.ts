// ══════════════════════════════════════════════════════════════════════════
// Chama — what LOCKED actually means (the honest-custody disclosure)
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠ READ THIS BEFORE CHANGING ANY LOCK COPY.
//
// A Chama lock spends Fedimint ecash out-of-band and Shamir-splits the resulting
// bearer-note string 2-of-3. Against the ARBITER and against the COUNTERPARTY
// that is real: neither can move the sats alone.
//
// It is NOT real against the party who funded it. Secret-sharing distributes
// knowledge; it does not remove it from the dealer. The funder minted those
// notes, knows the note string, and can reissue it to their own wallet at any
// time — `reabsorb()` in fedimint/pending-native-locks.ts ships exactly that
// call as supported crash recovery. Nothing in the app checks that locked notes
// are still spendable (`verifyClaim` exists and has no callers), so a drained
// escrow looks identical to a healthy one until the winner tries to claim.
//
// So until the escrow itself is held somewhere no single party can reach, the
// product must not tell users otherwise. It previously said, verbatim:
//
//     "The sats are locked in 2-of-3 escrow — no one can move them alone."
//
// That sentence is true of two parties out of three, and the third is the one
// holding the money. This module decides WHO needs to be told, so the warning
// lands on the person actually carrying the risk rather than as boilerplate
// everyone learns to scroll past.
//
// PURE: no relays, no money, no reducer touch. Display logic only.

import { Role, type EscrowState } from "./types.js";

/** The role that funds (locks) each category, mirroring `expectedLocker` in
 *  state-machine.ts. Kept in sync deliberately: if the reducer's rule changes,
 *  this must change with it, or the disclosure names the wrong party.
 *  `null` = raw escrow, where anyone may lock. */
export function expectedLockerRole(category: string): Role | null {
  if (category === "marketplace") return Role.BUYER;
  if (category === "lending") return Role.SELLER;
  if (category === "p2p-trade" || category === "bill-pay") return Role.SELLER;
  return null;
}

/** Who locked this escrow. The reducer ENFORCES `expectedLocker` per category
 *  (state-machine.ts `WRONG_LOCKER`), so the category is authoritative — a LOCK
 *  by anyone else was rejected and never reached state. */
export function lockerRoleOf(state: EscrowState): Role | null {
  return expectedLockerRole(state.category);
}

/** ⭐ Is the viewer the party who is exposed?
 *
 *  The exposed party is the NON-locker: the one who performs the irreversible
 *  off-platform leg — sending fiat, shipping goods, paying the bill — against a
 *  lock the funder can still undo. The funder is not at risk from this; they are
 *  the one who holds the capability.
 *
 *  Returns false for the arbiter, who moves nothing either way, and false
 *  pre-lock, when there is nothing to disclose yet. */
export function viewerIsExposedByLock(
  state: EscrowState,
  viewerRole: Role | null,
): boolean {
  if (!viewerRole || viewerRole === Role.ARBITER) return false;
  if (state.lock.lockedAt === null) return false;
  const locker = lockerRoleOf(state);
  if (locker === null) return true; // raw escrow: if we can't tell, warn.
  return viewerRole !== locker;
}
