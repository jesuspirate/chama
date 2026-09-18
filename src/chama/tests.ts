import { sharesForCircle } from "./wiring.js";
import { EscrowEventKind, EscrowStatus, Outcome, Role, type EscrowState } from "../escrow-engine/types.js";
import { circleCanvasRound, sundaySnapDurationSec, SUNDAY_SNAP_HOUR } from "./canvas.js";
import { collapseCircleShares } from "./wiring.js";
import { circleLockContextFor } from "./lock-notify.js";
import { notificationForTransition } from "../notifications/trade-notifications.js";
import {
  canTakeSeat,
  circleProgress,
  circleStatus,
  lockPunctuality,
  nextRoundTemplate,
  validateCircleRound,
} from "./circle.js";
import {
  DEFAULT_ROUND_SEC,
  EARLY_LOCK_BONUS_MAX,
  MAX_ROUND_SEC,
  type CircleRound,
  type CircleShareLock,
} from "./types.js";
import {
  MANUAL_REFUND_GRACE_SEC,
  circleCardModel,
  circleSurfaceModel,
} from "./surface.js";
import {
  LEVEL_NAMES,
  canOpenRotatingChama,
  circlesToNextLevel,
  levelFor,
  rotationOrder,
} from "./levels.js";

let passed = 0;
let failed = 0;

function assert(condition: unknown, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// A lawful weekly circle: opens Monday, fills by Wednesday, back by Sunday.
const T0 = 1_900_000_000;
const FILL = T0 + 2 * 86_400;
const END = T0 + DEFAULT_ROUND_SEC;
const CIRCLE: CircleRound = {
  version: 1,
  circleId: "circle_1",
  creatorPubkey: "amina",
  community: "tz-tzs",
  mintUrl: "fed1",
  name: "Mama Mboga collective",
  shareMsats: 10_000_000,
  seatThreshold: 3,
  seatCap: 5,
  fillDeadlineSec: FILL,
  roundEndSec: END,
  roundIndex: 1,
  prevCircleId: null,
  createdAt: T0,
};

const seat = (
  memberPubkey: string,
  status: CircleShareLock["status"],
  lockedAtSec: number | null = status === "reserved" ? null : T0 + 3_600,
  circleId = "circle_1",
): CircleShareLock => ({
  circleId,
  memberPubkey,
  escrowId: status === "reserved" ? null : `esc_${memberPubkey}`,
  status,
  lockedAtSec,
});

console.log("\n── Chama circle: validation ──");
assert(validateCircleRound(CIRCLE).length === 0, "a lawful weekly circle validates clean");
assert(validateCircleRound({ ...CIRCLE, shareMsats: 0 }).length > 0, "zero share rejected");
assert(validateCircleRound({ ...CIRCLE, shareMsats: 1000.5 }).length > 0, "fractional msats rejected");
assert(validateCircleRound({ ...CIRCLE, seatThreshold: 1 }).length > 0,
  "a circle of one is not a circle — threshold 1 rejected");
assert(validateCircleRound({ ...CIRCLE, seatThreshold: 2, seatCap: 2 }).length === 0,
  "the smallest honest circle: 2 of 2");
assert(validateCircleRound({ ...CIRCLE, seatCap: 2 }).length > 0, "cap below threshold rejected");
assert(validateCircleRound({ ...CIRCLE, seatCap: null }).length === 0, "capless (open to the world) is lawful");
assert(validateCircleRound({ ...CIRCLE, fillDeadlineSec: T0 }).length > 0,
  "fill deadline must be after creation");
assert(validateCircleRound({ ...CIRCLE, roundEndSec: FILL }).length > 0,
  "round end must be after the fill deadline");
assert(validateCircleRound({ ...CIRCLE, roundEndSec: T0 + MAX_ROUND_SEC }).length === 0,
  "exactly the two-week federation bound is lawful");
assert(validateCircleRound({ ...CIRCLE, roundEndSec: T0 + MAX_ROUND_SEC + 1 }).length > 0,
  "one second past the federation bound is not");
assert(validateCircleRound({ ...CIRCLE, roundIndex: 0 }).length > 0, "roundIndex 0 rejected");
assert(validateCircleRound({ ...CIRCLE, prevCircleId: "ghost" }).length > 0,
  "a first round cannot claim a previous circle");
assert(validateCircleRound({ ...CIRCLE, roundIndex: 2 }).length > 0,
  "a re-formed round must name its previous circle");
assert(validateCircleRound({ ...CIRCLE, roundIndex: 2, prevCircleId: "circle_0" }).length === 0,
  "round 2 with lineage validates");

console.log("\n── Chama circle: fill-or-refund status ──");
const threeLocked = [seat("a", "locked"), seat("b", "locked"), seat("c", "locked")];
assert(circleStatus(CIRCLE, threeLocked, FILL - 1) === "filling",
  "before the deadline the circle is filling — even at threshold (fixed round clock: no early start)");
assert(circleStatus(CIRCLE, threeLocked, FILL) === "running",
  "at the deadline second, a filled circle is running");
assert(circleStatus(CIRCLE, [seat("a", "locked"), seat("b", "locked")], FILL) === "refund-due",
  "below threshold at the deadline: refund-due — everyone gets their exact sats back");
assert(circleStatus(CIRCLE, threeLocked, END) === "complete",
  "round end reached from running: complete");
assert(circleStatus(CIRCLE, [seat("a", "reserved"), seat("b", "reserved"), seat("c", "reserved")], FILL) === "refund-due",
  "reserved seats count for nothing — Chip In's pledged/locked honesty");

console.log("\n── Chama circle: progress + the healing worklist ──");
const mixed = [
  seat("a", "locked"),
  seat("b", "locked"),
  seat("c", "reserved"),
  seat("d", "locked", T0 + 100, "other_circle"),
];
const fillingNow = circleProgress(CIRCLE, mixed, T0 + 3_700);
assert(fillingNow.seatsLocked === 2 && fillingNow.seatsReserved === 1,
  "locks from another circle are invisible here");
assert(fillingNow.seatsOpen === 2, "cap-aware open seats count reserved AND locked as taken");
assert(fillingNow.potMsats === 20_000_000, "pot = locked seats × share, nothing else");
assert(fillingNow.dueBackEscrowIds.length === 0, "nothing is owed back while filling");
assert(circleProgress({ ...CIRCLE, seatCap: null }, mixed, T0 + 3_700).seatsOpen === null,
  "a capless circle reports open seats as boundless");

const refunding = circleProgress(CIRCLE, mixed, FILL);
assert(refunding.status === "refund-due"
  && refunding.dueBackEscrowIds.length === 2
  && refunding.dueBackEscrowIds.includes("esc_a")
  && !refunding.dueBackEscrowIds.includes("esc_c"),
  "refund worklist is exactly the locked escrows — a reserved seat locked nothing, so it is owed nothing");

const healed = [seat("a", "returned"), seat("b", "returned"), seat("c", "returned")];
const done = circleProgress(CIRCLE, healed, END + 10);
assert(done.status === "complete" && done.seatsLocked === 3 && done.dueBackEscrowIds.length === 0,
  "returned seats still count as the seats they were — a completed round's history is not an empty circle");

const completing = circleProgress(CIRCLE, threeLocked, END);
assert(completing.status === "complete" && completing.dueBackEscrowIds.length === 3,
  "at round end every still-locked share is owed back");

console.log("\n── Chama circle: the fill latch (no cascade) ──");
const exited = [seat("a", "refunded"), seat("b", "locked"), seat("c", "locked")];
assert(circleStatus(CIRCLE, exited, FILL + 86_400) === "running",
  "one member exiting early does NOT flip a filled circle to refund-due — fill is a moment, not a mood");
assert(circleProgress(CIRCLE, exited, FILL + 86_400).dueBackEscrowIds.length === 0,
  "and no cascade: the remaining members are not refunded out from under themselves");
assert(circleStatus(CIRCLE, [seat("a", "reserved"), seat("b", "locked")], FILL) === "refund-due",
  "a genuinely short circle still fails at the deadline");
assert(circleStatus(CIRCLE, [seat("a", "refunded"), seat("b", "refunded")], FILL + 100) === "refund-due",
  "a failed circle stays failed after its refunds settle — the latch is monotone");

console.log("\n── Chama circle: taking a seat ──");
assert(canTakeSeat(CIRCLE, threeLocked, "dora", FILL - 1).ok,
  "a stranger can take an open seat until the last second — open to the world");
assert(!canTakeSeat(CIRCLE, threeLocked, "dora", FILL).ok
  && (canTakeSeat(CIRCLE, threeLocked, "dora", FILL) as { reason: string }).reason === "closed",
  "the fill deadline closes joins");
assert((canTakeSeat(CIRCLE, threeLocked, "A", T0 + 10) as { reason: string }).reason === "already-seated",
  "one seat per member, case-insensitively — equal shares law");
const atCap = [...threeLocked, seat("d", "locked"), seat("e", "reserved")];
assert((canTakeSeat(CIRCLE, atCap, "fatu", T0 + 10) as { reason: string }).reason === "full",
  "the cap counts reserved seats too — no overbooking");
assert((canTakeSeat(CIRCLE, threeLocked, "amina", T0 + 10) as { reason: string }).reason === "host",
  "the host cannot seat themselves — refused HERE so no screen offers a button the chain rejects");
assert(canTakeSeat(CIRCLE, [seat("a", "refunded")], "a", T0 + 10).ok,
  "a refunded member may seat again — a refund is not a mark");

console.log("\n── Chama circle: punctuality standing ──");
const atOpen = lockPunctuality(CIRCLE, T0);
const midway = lockPunctuality(CIRCLE, T0 + (FILL - T0) / 2);
const atDeadline = lockPunctuality(CIRCLE, FILL);
assert(atOpen.earlyBonus === EARLY_LOCK_BONUS_MAX, "locking at open earns the full early bonus");
assert(atDeadline.earlyBonus === 0, "locking at the deadline earns zero — and NEVER negative");
assert(atOpen.earlyBonus > midway.earlyBonus && midway.earlyBonus > atDeadline.earlyBonus,
  "the bonus decays monotonically across the window — urgency with zero injustice");
assert(lockPunctuality(CIRCLE, FILL + 999).earlyBonus === 0,
  "a lock stamped past the deadline clamps to zero bonus, not below");
const doubleShare = lockPunctuality({ ...CIRCLE, shareMsats: CIRCLE.shareMsats * 2 }, T0);
assert(Math.abs(doubleShare.satDaysCommitted - atOpen.satDaysCommitted * 2) < 1e-9,
  "sat-days scale linearly with the share — dust cannot farm standing");
assert(atOpen.standingWeight > atDeadline.standingWeight,
  "early skin-in-the-game outranks deadline skin-in-the-game");
assert(atDeadline.standingWeight > 0,
  "on-time still EARNS — the protocol never punishes compliance");

console.log("\n── Chama circle: the pulse (auto-re-entry lineage) ──");
const round2 = nextRoundTemplate(CIRCLE, { circleId: "circle_2", startSec: END + 48 * 3_600 });
assert(round2.roundIndex === 2 && round2.prevCircleId === "circle_1",
  "the next round threads its lineage");
assert(round2.fillDeadlineSec - round2.createdAt === FILL - T0
  && round2.roundEndSec - round2.createdAt === END - T0,
  "the pulse preserves the durations — same rhythm, new dates");
assert(validateCircleRound(round2).length === 0, "the re-formed round is lawful as generated");

console.log("\n── Chama circle: the five tiers ──");
assert(levelFor(0) === 1 && LEVEL_NAMES[levelFor(0)] === "Mgeni", "zero completions: Mgeni, the guest");
assert(levelFor(1) === 2 && levelFor(2) === 2, "one kept circle makes a Mwanachama");
assert(levelFor(3) === 3, "three completions, all combined: Mwenyeji — may open a rotating chama");
assert(levelFor(5) === 3 && levelFor(6) === 4 && levelFor(11) === 4, "six for Mzee");
assert(levelFor(12) === 5 && LEVEL_NAMES[5] === "Bosi Mkubwa", "twelve kept circles: Bosi Mkubwa");
assert(levelFor(-3) === 1 && levelFor(2.9) === 2, "garbage counts clamp down, never up");
assert(!canOpenRotatingChama(2) && canOpenRotatingChama(3),
  "the rotation gate opens at exactly three completed circles — v1 circles stay open to all");
assert(circlesToNextLevel(0) === 1 && circlesToNextLevel(1) === 2
  && circlesToNextLevel(3) === 3 && circlesToNextLevel(12) === 0,
  "the ladder always says how many circles remain");

console.log("\n── Chama circle: who collects first ──");
const queue = rotationOrder([
  { memberPubkey: "creator", standingWeight: 40, lockedAtSec: 1 },
  { memberPubkey: "elder", standingWeight: 90, lockedAtSec: 5 },
  { memberPubkey: "newer", standingWeight: 40, lockedAtSec: 9 },
]);
assert(queue[0] === "elder",
  "standing collects first — a joining elder outranks the creator; terms are the creator's power, the queue is earned");
assert(queue[1] === "creator" && queue[2] === "newer",
  "equal standing breaks by earlier lock — punctuality again");
const q1 = rotationOrder([
  { memberPubkey: "b", standingWeight: 10, lockedAtSec: 3 },
  { memberPubkey: "a", standingWeight: 10, lockedAtSec: 3 },
]);
const q2 = rotationOrder([
  { memberPubkey: "a", standingWeight: 10, lockedAtSec: 3 },
  { memberPubkey: "b", standingWeight: 10, lockedAtSec: 3 },
]);
assert(q1.join() === q2.join(),
  "dead ties settle by pubkey — every client derives the identical queue");

// Adapter reads accepted chain facts, never the mutable LOCK payload clock.
const adapterShare = {
  id: "adapter-share", parent: "adapter-circle", chamaPolicy: "share-v1",
  chamaCircle: { roundEndSec: END }, participants: { buyer: "member" },
  status: EscrowStatus.CREATED, eventChain: [], resolvedOutcome: null,
  claim: { claimedAt: null },
} as unknown as EscrowState;
const reservedShare = sharesForCircle([adapterShare])[0];
assert(reservedShare.status === "reserved" && reservedShare.escrowId === null && reservedShare.lockedAtSec === null,
  "adapter never counts a CREATE reservation as a lock");
const fundedShare = { ...adapterShare, status: EscrowStatus.LOCKED,
  eventChain: [{ kind: EscrowEventKind.LOCK, timestamp: T0 + 10, payload: { lockedAt: T0 + 999 } }] } as unknown as EscrowState;
assert(sharesForCircle([fundedShare])[0].lockedAtSec === T0 + 10,
  "adapter uses the accepted LOCK event timestamp");
const returnedShare = { ...fundedShare, status: EscrowStatus.CLAIMED, resolvedOutcome: Outcome.REFUND, resolvedAt: END };
assert(sharesForCircle([returnedShare])[0].status === "returned", "round-end claim maps to returned");
assert(sharesForCircle([{ ...returnedShare, resolvedAt: FILL }])[0].status === "refunded", "early claim maps to refunded");
assert(sharesForCircle([{ ...returnedShare, status: EscrowStatus.APPROVED }])[0].status === "locked", "unclaimed approval stays on the return worklist");
assert(sharesForCircle([{ ...returnedShare, status: EscrowStatus.APPROVED }])[0].readyToClaim === true,
  "an approved refund is COLLECTIBLE — resolution landed, redemption pending");
assert(sharesForCircle([fundedShare])[0].readyToClaim !== true,
  "a share still voting is not collectible");
assert(sharesForCircle([returnedShare])[0].readyToClaim !== true,
  "a share already redeemed has nothing left to collect");
assert(sharesForCircle([fundedShare], "another-circle").length === 0, "adapter keeps circles separate");

console.log("\n── Chama circle: one status, one move ──");
const filling2 = [seat("a", "locked"), seat("b", "locked")];
const move = (shares: CircleShareLock[], who: string, at: number) =>
  circleSurfaceModel(CIRCLE, shares, who, at).move;

assert(move(filling2, "dora", T0 + 3_600) === "lock",
  "a stranger with an open seat is offered the lock");
assert(move(filling2, "a", T0 + 3_600) === "invite",
  "a seated member's move is to help the circle fill, not to lock twice");
assert(move([seat("a", "reserved")], "a", T0 + 3_600) === "lock",
  "a RESERVED seat is unfunded — the move is still lock, because no money has moved");
assert(move(filling2, "amina", T0 + 3_600) === "invite",
  "the host cannot seat themselves, so their move is to bring people in");
assert(circleSurfaceModel(CIRCLE, atCap, "fatu", T0 + 10).refusal === "full",
  "a full circle offers no move and says why");
assert(move(threeLocked, "amina", FILL + 86_400) === "wait",
  "a running circle is calm on purpose — there is nothing to do");
assert(move(filling2, "a", FILL + 60) === "returning",
  "a failed fill returns the share automatically; do not prompt");
// The COLLECT move — the missing last leg found at the first real completion
// (2026-09-14): both devices said "your sats are coming back" while READY TO
// CLAIM shares sat unclaimed with no button anywhere in the app.
const collectible = (base: CircleShareLock): CircleShareLock => ({ ...base, readyToClaim: true });
assert(move([collectible(seat("a", "locked")), seat("b", "locked")], "a", FILL + 60) === "collect",
  "refund-due + resolution landed = COLLECT, not a moot manual vote");
assert(move([collectible(seat("a", "locked")), seat("b", "locked")], "a", FILL + MANUAL_REFUND_GRACE_SEC) === "collect",
  "collect outranks the manual escape hatch once the vote is already resolved");
assert(move([collectible(seat("a", "locked")), seat("b", "locked"), seat("c", "locked")], "a", END + 10) === "collect",
  "a completed round with an approved share offers COLLECT — the sats come home by a tap, not a promise");
assert(move(threeLocked.map(x => x.memberPubkey === "a" ? collectible(x) : x), "b", END + 10) === "returning",
  "another member's collectible share changes nothing for me");
assert(move(filling2, "a", FILL + MANUAL_REFUND_GRACE_SEC) === "return-now",
  "after the grace, the manual refund escape hatch appears");
assert(move(filling2, "dora", FILL + 86_400) === "none",
  "someone with no seat in a failed circle is owed nothing and offered nothing");
assert(move(filling2, "amina", FILL + 60) === "next-round",
  "a host with no funded seat can retry a failed fill");
assert(move([seat("amina", "locked")], "amina", FILL + 60) === "returning",
  "a funded host must recover their share before retrying");
assert(move([collectible(seat("amina", "locked"))], "amina", FILL + 60) === "collect",
  "a host's available refund takes priority over retrying");
assert(move([seat("amina", "refunded")], "amina", FILL + 60) === "next-round",
  "a host can retry once their failed-fill refund is claimed");
assert(move([seat("a", "returned"), seat("b", "returned"), seat("c", "returned")], "amina", END + 10) === "next-round",
  "a completed round offers the host the next pulse");
assert(move([seat("a", "returned"), seat("b", "returned"), seat("c", "returned")], "a", END + 10) === "none",
  "a member whose sats came back has nothing left to do");
assert(circleSurfaceModel(CIRCLE, threeLocked, "AMINA", T0 + 10).isHost,
  "host detection is case-insensitive");

assert(circleSurfaceModel(CIRCLE, threeLocked, "a", T0 + 3_600).filled,
  "threshold met is reported as filled so copy stops counting down to zero");
const cappedFull = { ...CIRCLE, seatCap: 3 };
assert(circleSurfaceModel(cappedFull, threeLocked, "a", T0 + 3_600).move === "wait",
  "a circle at its cap has nobody left to invite — it is sealed, not soliciting");
assert(circleSurfaceModel(cappedFull, threeLocked, "amina", T0 + 3_600).move === "wait",
  "the host of a full circle waits too");
assert(circleSurfaceModel(CIRCLE, threeLocked, "a", T0 + 3_600).move === "invite",
  "threshold met but seats open (cap 5) still welcomes people — filled is not full");
assert(circleSurfaceModel({ ...CIRCLE, seatCap: null }, threeLocked, "a", T0 + 3_600).move === "invite",
  "an uncapped circle keeps welcoming people right up to the deadline");

console.log("\n── Chama circle: the audience split (just us vs anyone) ──");
{
  const base = { shareSats: 1000, threshold: 5, createdAt: T0, creatorPubkey: "amina",
    community: "tz-tzs", mintUrl: "fed1", name: "Mama Mboga" } as const;
  const friends = circleCanvasRound({ ...base, cap: 5, unlisted: true });
  assert(friends.seatCap === friends.seatThreshold && friends.unlisted === true,
    "'just us' collapses floor and ceiling into ONE number — all of you, by invite, unlisted");
  assert(validateCircleRound(friends).length === 0, "a just-us circle is lawful as generated");
  const anyone = circleCanvasRound({ ...base, cap: null });
  assert(anyone.seatCap === null && anyone.unlisted !== true,
    "'anyone' keeps only the go-ahead floor: open to the world, listed in Browse");
  assert(validateCircleRound(anyone).length === 0, "an open circle is lawful as generated");
}

console.log("\n── Chama circle: the Browse card ──");
assert(circleCardModel(CIRCLE, [], T0 + 10).seatsLocked === null,
  "with no children loaded the card says 'open' — never a confident wrong zero");
assert(circleCardModel(CIRCLE, [], T0 + 10, { childrenLoaded: true }).seatsLocked === 0,
  "a client that KNOWS the circle is empty may say zero");
assert(circleCardModel(CIRCLE, filling2, T0 + 10).seatsLocked === 2,
  "loaded children give the honest count");
assert(circleCardModel(CIRCLE, filling2, T0 + 10, { childrenLoaded: false }).seatsLocked === null,
  "an explicitly-incomplete view stays humble even with shares in hand");

console.log("\n── Chama circle: one card per circle (runway #14) ──");
{
  const parentId = CIRCLE.circleId;
  const parent = { id: parentId, category: "chama", chamaCircle: CIRCLE,
    initiator: { pubkey: CIRCLE.creatorPubkey }, community: CIRCLE.community,
    mintUrl: CIRCLE.mintUrl, description: CIRCLE.name, createdAt: CIRCLE.createdAt } as unknown as EscrowState;
  const share = (id: string) => ({ id, chamaPolicy: "share-v1", parent: parentId } as unknown as EscrowState);
  const stranger = { id: "unrelated-trade" } as unknown as EscrowState;

  const host = collapseCircleShares([parent, share("s1"), share("s2"), stranger]);
  assert(host.length === 2 && host[0].id === parentId && host[1].id === "unrelated-trade",
    "a host's list collapses parent + N shares to the parent card alone");

  const member = collapseCircleShares([share("s1"), stranger]);
  assert(member.length === 2,
    "a member whose list lacks the parent keeps their share card — one card either way");

  const orphan = collapseCircleShares([share("s1")]);
  assert(orphan.length === 1, "a lone share never vanishes");
  assert(collapseCircleShares([]).length === 0, "empty in, empty out");
}

console.log("\n── Chama circle: the host locks last — seat notifications ──");
{
  // The host (amina) seals the round by locking LAST. Every member seat that
  // lands is their cue; the last one before theirs is unmissable.
  const parent = { id: CIRCLE.circleId, category: "chama", chamaCircle: CIRCLE,
    initiator: { pubkey: CIRCLE.creatorPubkey }, community: CIRCLE.community,
    mintUrl: CIRCLE.mintUrl, description: CIRCLE.name, createdAt: CIRCLE.createdAt } as unknown as EscrowState;
  const shareOf = (id: string, member: string, locked: boolean) => ({
    id, chamaPolicy: "share-v1", parent: CIRCLE.circleId,
    status: locked ? EscrowStatus.LOCKED : EscrowStatus.CREATED,
    participants: { [Role.BUYER]: member, [Role.SELLER]: CIRCLE.creatorPubkey },
    eventChain: locked ? [{ kind: EscrowEventKind.LOCK, timestamp: T0 + 60 }] : [],
    claim: {},
  } as unknown as EscrowState);

  // seatThreshold is 3: two member seats + the host's.
  const first = shareOf("s1", "bruno", true);
  const ctxFirst = circleLockContextFor(first, [parent, first], CIRCLE.creatorPubkey);
  assert(ctxFirst?.viewerIsHost === true && ctxFirst?.lockedSeats === 1 && ctxFirst?.hostTurn === false,
    "the first seat gives the host quiet progress, not a false 'your turn'");

  const second = shareOf("s2", "carla", true);
  const ctxSecond = circleLockContextFor(second, [parent, first, second], CIRCLE.creatorPubkey);
  assert(ctxSecond?.hostTurn === true && ctxSecond?.lockedSeats === 2,
    "everyone else in → the host's turn: their lock is what seals the round");

  const hostSeat = shareOf("s3", CIRCLE.creatorPubkey, true);
  const ctxAfterHost = circleLockContextFor(second, [parent, first, second, hostSeat], CIRCLE.creatorPubkey);
  assert(ctxAfterHost?.hostTurn === false,
    "a host who already locked is never told it is their turn");

  const ctxMember = circleLockContextFor(second, [parent, first, second], "bruno");
  assert(ctxMember?.viewerIsHost === false && ctxMember?.hostTurn === false,
    "members are not the ones who seal the round");

  assert(circleLockContextFor(second, [first, second], CIRCLE.creatorPubkey) === null,
    "a thin view without the circle parent invents nothing");
  assert(circleLockContextFor(parent, [parent], CIRCLE.creatorPubkey) === null,
    "the circle itself is not a seat lock");

  // Copy + dedup: the host-turn notice is keyed per ROUND, seat progress per
  // SEAT, and a circle never falls through to storefront 'new order' copy.
  const prev = shareOf("s2", "carla", false);
  const turn = notificationForTransition(prev, second, CIRCLE.creatorPubkey, 0, ctxSecond);
  assert(turn?.tag === `${CIRCLE.circleId}:host-turn:1` && turn?.escrowId === CIRCLE.circleId,
    "the your-turn buzz is one per round and opens the CIRCLE, not the share");
  const progress = notificationForTransition(shareOf("s1", "bruno", false), first, CIRCLE.creatorPubkey, 0, ctxFirst);
  assert(progress?.tag === "s1:circle-seat" && /1 of 3/.test(progress?.body ?? ""),
    "seat progress buzzes once per seat and counts honestly");
  const ownLock = notificationForTransition(shareOf("s3", CIRCLE.creatorPubkey, false), hostSeat, CIRCLE.creatorPubkey, 0,
    circleLockContextFor(hostSeat, [parent, first, second, hostSeat], CIRCLE.creatorPubkey));
  assert(ownLock === null || !ownLock.tag.includes("circle-seat"),
    "the host's own lock never buzzes the host");
}

console.log("\n── Chama circle: the Sunday snap offer (runway #9) ──");
{
  // Mon 2026-09-14 21:25 UTC, viewer in UTC (offset 0): next Sunday 18:00 is
  // 2026-09-20 18:00 UTC.
  const mon = Math.floor(Date.UTC(2026, 8, 14, 21, 25, 0) / 1000);
  const durMon = sundaySnapDurationSec(mon, 0);
  const endMon = new Date((mon + durMon) * 1000);
  assert(endMon.getUTCDay() === 0 && endMon.getUTCHours() === SUNDAY_SNAP_HOUR,
    "a Monday-night circle offered the snap comes back Sunday 6 pm local");
  assert(durMon > 3 * 86_400 && durMon < 7 * 86_400,
    "the Monday snap lands inside the week (between 3 and 7 days out)");

  // Sat 2026-09-19 12:00 UTC: tomorrow's Sunday is too tight for a
  // day-quantized fill window — the offer rolls to the Sunday after.
  const sat = Math.floor(Date.UTC(2026, 8, 19, 12, 0, 0) / 1000);
  const durSat = sundaySnapDurationSec(sat, 0);
  const endSat = new Date((sat + durSat) * 1000);
  assert(endSat.getUTCDay() === 0 && durSat >= 3 * 86_400,
    "a Saturday circle skips tomorrow's too-tight Sunday for the one after");

  // Timezone honesty: the same instant in Nairobi (UTC+3) must land on
  // Sunday 18:00 NAIROBI time, i.e. 15:00 UTC.
  const durNairobi = sundaySnapDurationSec(mon, 180);
  const endNairobi = new Date((mon + durNairobi) * 1000);
  assert(endNairobi.getUTCDay() === 0 && endNairobi.getUTCHours() === SUNDAY_SNAP_HOUR - 3,
    "the snap is Sunday evening in the VIEWER'S timezone, not UTC's");

  // The offered duration produces a lawful round with a sane fill window.
  const snapped = circleCanvasRound({ shareSats: 1000, threshold: 5, cap: 5, unlisted: true,
    durationSec: durMon, createdAt: mon, creatorPubkey: "amina",
    community: "tz-tzs", mintUrl: "fed1", name: "Mama Mboga" });
  assert(validateCircleRound(snapped).length === 0 && snapped.fillDeadlineSec > mon,
    "a Sunday-snapped round is lawful as generated");
}

console.log(`\nChama circle results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
