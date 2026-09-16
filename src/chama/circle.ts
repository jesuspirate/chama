import {
  EARLY_LOCK_BONUS_MAX,
  MAX_ROUND_SEC,
  type CircleProgress,
  type CircleRound,
  type CircleShareLock,
  type CircleStatus,
  type LockPunctuality,
  type SeatRefusal,
} from "./types.js";
import { CHAMA_RING_WRITER_ENABLED } from "../escrow-engine/experimental-escrow-features.js";

// ── Validation ─────────────────────────────────────────────────────────────

/** Every rule a circle must satisfy BEFORE the first lock. Returns the empty
 *  array for a lawful circle; each entry is one violated law in plain words.
 *  The CREATE gate (money-path wiring, next phase) refuses on any entry —
 *  a malformed circle must be unrepresentable on the chain, not repaired
 *  after money moved. */
export function validateCircleRound(circle: CircleRound): string[] {
  const errors: string[] = [];
  if (![circle.createdAt, circle.fillDeadlineSec, circle.roundEndSec].every(Number.isSafeInteger)) errors.push("Circle timestamps must be safe integer seconds");
  if (circle.prevCircleId !== null && (typeof circle.prevCircleId !== "string" || !circle.prevCircleId)) errors.push("Previous circle id must be null or a nonempty string");
  if (!Number.isSafeInteger(circle.shareMsats) || circle.shareMsats <= 0) {
    errors.push("shareMsats must be a positive integer");
  }
  if (!Number.isSafeInteger(circle.seatThreshold) || circle.seatThreshold < 2) {
    // A circle of one is not a circle: "nobody is ever the only one who
    // showed up" requires at least one other person who can show up.
    errors.push("seatThreshold must be an integer of at least 2");
  }
  if (circle.seatCap !== null) {
    if (!Number.isSafeInteger(circle.seatCap) || circle.seatCap < circle.seatThreshold) {
      errors.push("seatCap must be null or an integer >= seatThreshold");
    }
  }
  if (!(circle.fillDeadlineSec > circle.createdAt)) {
    errors.push("fillDeadlineSec must be after createdAt");
  }
  if (!(circle.roundEndSec > circle.fillDeadlineSec)) {
    errors.push("roundEndSec must be after fillDeadlineSec");
  }
  if (circle.roundEndSec - circle.createdAt > MAX_ROUND_SEC) {
    // The federation safe-hold bound. A feature, said out loud: "locked
    // together, guaranteed back by <date>" only stays true while the date
    // is one the federation can honor without redeem.
    errors.push("round exceeds the two-week federation hold bound");
  }
  if (!Number.isSafeInteger(circle.roundIndex) || circle.roundIndex < 1) {
    errors.push("roundIndex must be a positive integer");
  }
  if (circle.roundIndex === 1 && circle.prevCircleId !== null) {
    errors.push("a first round cannot claim a previous circle");
  }
  if (circle.roundIndex > 1 && !circle.prevCircleId) {
    errors.push("a re-formed round must name its previous circle");
  }
  return errors;
}

// ── Derived state (Chip In's idiom: the status IS the arithmetic) ─────────

function circleLocks(
  circle: CircleRound,
  locks: readonly CircleShareLock[],
): CircleShareLock[] {
  return locks.filter(lock => lock.circleId === circle.circleId);
}

/** Seats that DID lock inside the fill window — a historical chain fact
 *  (every valid share carries a LOCK stamped before the deadline; the engine
 *  gate enforces it), deliberately NOT the current status.
 *
 *  ⚠ THE LATCH. Deriving the fill from current status let one member's early
 *  exit flip a healthy running circle to refund-due, cascading refunds
 *  through everyone else (proven by probe, 2026-09-07). Fill is a moment,
 *  not a mood: whether the circle gathered is settled at the deadline and
 *  can never un-happen. */
function seatsLockedInWindow(
  circle: CircleRound,
  locks: readonly CircleShareLock[],
): number {
  return circleLocks(circle, locks)
    .filter(lock => lock.lockedAtSec !== null && lock.lockedAtSec < circle.fillDeadlineSec)
    .length;
}

export function circleStatus(
  circle: CircleRound,
  locks: readonly CircleShareLock[],
  nowSec: number,
): CircleStatus {
  if (nowSec < circle.fillDeadlineSec) return "filling";
  if (seatsLockedInWindow(circle, locks) < circle.seatThreshold) return "refund-due";
  return nowSec < circle.roundEndSec ? "running" : "complete";
}

/** The one rollup every surface reads. Pure; time is an argument. */
export function circleProgress(
  circle: CircleRound,
  locks: readonly CircleShareLock[],
  nowSec: number = Math.floor(Date.now() / 1000),
): CircleProgress {
  const mine = circleLocks(circle, locks);
  // "returned" still counts as a seat that WAS locked — a completed round's
  // history must not read as an empty circle after healing runs.
  const lockedSeats = mine.filter(l => l.status === "locked" || l.status === "returned" || l.status === "paid");
  const seatsLocked = lockedSeats.length;
  const seatsReserved = mine.filter(l => l.status === "reserved").length;
  const status = circleStatus(circle, locks, nowSec);
  const filled = seatsLocked >= circle.seatThreshold;

  // The healing worklist: which escrows are owed back to their owners RIGHT
  // NOW. Only ever "locked" shares — reserved seats locked nothing, and
  // returned/refunded shares are already healed. The refund path reuses the
  // escrow engine's expiry healing; this list is its input, nothing more.
  const dueBackEscrowIds =
    status === "refund-due" || status === "complete"
      ? mine
          .filter(l => l.status === "locked" && l.escrowId !== null)
          .map(l => l.escrowId as string)
      : [];

  return {
    status,
    seatsLocked,
    seatsReserved,
    seatsOpen:
      circle.seatCap === null
        ? null
        : Math.max(0, circle.seatCap - seatsLocked - seatsReserved),
    filled,
    potMsats: seatsLocked * circle.shareMsats,
    secsToFillDeadline: Math.max(0, circle.fillDeadlineSec - nowSec),
    secsToRoundEnd: Math.max(0, circle.roundEndSec - nowSec),
    dueBackEscrowIds,
  };
}

/** May this member take a seat right now? One seat per member (equal shares
 *  law), joins close at the fill deadline OR the cap — whichever first. */
export function canTakeSeat(
  circle: CircleRound,
  locks: readonly CircleShareLock[],
  memberPubkey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  hostSeat: boolean = CHAMA_RING_WRITER_ENABLED,
): { ok: true } | { ok: false; reason: SeatRefusal } {
  if (nowSec >= circle.fillDeadlineSec) return { ok: false, reason: "closed" };
  const mine = circleLocks(circle, locks);
  const member = memberPubkey.toLowerCase();
  // Host seats (ring witnessing, docs/chama-host-seat-spec.md): with the
  // writer OFF, the v1 law stands — a share seats the member as BUYER and
  // the creator as witness-SELLER, and one pubkey cannot be both. With the
  // writer ON, hosts lock LAST: the host takes a seat only once another
  // member's LOCKED share exists to witness theirs. The engine gate
  // (chamaCreateError) is the law; refusing HERE means callers never offer
  // a button the chain would reject.
  if (circle.creatorPubkey.toLowerCase() === member) {
    if (!hostSeat) return { ok: false, reason: "host" };
    const witnessed = mine.some(l => l.status === "locked" && l.memberPubkey.toLowerCase() !== member);
    if (!witnessed) return { ok: false, reason: "host-waits" };
  }
  const seated = mine.some(
    l =>
      l.memberPubkey.toLowerCase() === member
      && (l.status === "reserved" || l.status === "locked"),
  );
  if (seated) return { ok: false, reason: "already-seated" };
  if (circle.seatCap !== null) {
    const taken = mine.filter(l => l.status === "reserved" || l.status === "locked").length;
    if (taken >= circle.seatCap) return { ok: false, reason: "full" };
  }
  return { ok: true };
}

// ── Punctuality standing (the credit signal v2 rotation reads) ────────────

/** Chain-derived, per the locked brief rulings: early earns a bonus that
 *  DECAYS TO ZERO across the fill window (the urgency gradient with zero
 *  injustice — on-time is never negative), and everything is weighted in
 *  sat-days committed so standing cannot be farmed with dust shares in toy
 *  circles. A lock stamped outside the window clamps into it: chain
 *  validation upstream guarantees a lock cannot precede its circle, and a
 *  late-stamped lock reads as the deadline — zero bonus, never negative. */
export function lockPunctuality(
  circle: CircleRound,
  lockedAtSec: number,
): LockPunctuality {
  const windowSec = Math.max(1, circle.fillDeadlineSec - circle.createdAt);
  const clampedLock = Math.min(
    Math.max(lockedAtSec, circle.createdAt),
    circle.fillDeadlineSec,
  );
  const fillWindowFraction = (clampedLock - circle.createdAt) / windowSec;
  const earlyBonus = EARLY_LOCK_BONUS_MAX * (1 - fillWindowFraction);
  const satDaysCommitted =
    (circle.shareMsats / 1000) * ((circle.roundEndSec - clampedLock) / 86_400);
  return {
    fillWindowFraction,
    earlyBonus,
    satDaysCommitted,
    standingWeight: satDaysCommitted * (1 + earlyBonus),
  };
}

// ── Auto-re-entry (the bridge from commitment pool to rotation) ───────────

/** The template for a circle re-forming after a successful round: same
 *  terms, same DURATIONS (the pulse), next roundIndex, lineage threaded.
 *  The caller supplies the new start and its own fresh circleId — id
 *  minting is the chain layer's job, not this contract's. */
export function nextRoundTemplate(
  circle: CircleRound,
  input: { circleId: string; startSec: number },
): CircleRound {
  const fillWindowSec = circle.fillDeadlineSec - circle.createdAt;
  const roundSec = circle.roundEndSec - circle.createdAt;
  return {
    ...circle,
    circleId: input.circleId,
    createdAt: input.startSec,
    fillDeadlineSec: input.startSec + fillWindowSec,
    roundEndSec: input.startSec + roundSec,
    roundIndex: circle.roundIndex + 1,
    prevCircleId: circle.circleId,
  };
}
