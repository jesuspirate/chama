import { DEFAULT_ROUND_SEC, type CircleRound } from "./types.js";
import { validateCircleRound } from "./circle.js";

/** Accept a shared trade URL or a bare escrow id, never a partial match. */
export function circleInviteId(value: string): string | null {
  const raw = value.trim();
  let id = raw;
  try {
    const url = new URL(raw);
    id = url.searchParams.get("trade") ?? url.searchParams.get("escrowId") ?? "";
  } catch { /* A bare escrow id does not need a URL. */ }
  return /^sm_[a-z0-9_]+$/i.test(id) ? id : null;
}

export function circleCanvasRound(input: {
  shareSats: number; threshold: number; cap: number | null;
  durationSec?: number; createdAt: number; creatorPubkey: string;
  community: string; mintUrl: string; name: string; previous?: CircleRound;
  /** "Just us": invite-link only, hidden from Browse. */
  unlisted?: boolean;
}): CircleRound {
  const duration = input.durationSec ?? DEFAULT_ROUND_SEC;
  // Day-scale rounds keep the day-quantized 40% fill window; sub-day rounds
  // (sim-mode test drives) take HALF the round, floored at a minute — five
  // REAL minutes to gather browser tabs on a ten-minute drive (Jet,
  // 2026-09-18: 40% of five minutes was two, and two is not enough).
  const fillWindow = duration >= 86_400
    ? Math.round(duration * .4 / 86_400) * 86_400
    : Math.max(60, Math.round(duration * .5));
  return { version: 1, circleId: "", creatorPubkey: input.creatorPubkey,
    community: input.community, mintUrl: input.mintUrl, name: input.name,
    ...(input.unlisted ? { unlisted: true } : {}),
    shareMsats: input.shareSats * 1000, seatThreshold: input.threshold, seatCap: input.cap,
    createdAt: input.createdAt, fillDeadlineSec: input.createdAt + fillWindow,
    roundEndSec: input.createdAt + duration, roundIndex: input.previous?.roundIndex ?? 1,
    prevCircleId: input.previous?.prevCircleId ?? null };
}

// Runway #9: the round clock is createdAt + duration, so a circle's payday is
// its birthday — a Monday-night circle "everyone said completes Sunday"
// honestly returns Monday night. If the pulse is "lock in the week, back by
// Sunday", OFFER a duration that lands roundEnd on the next Sunday evening.
// Pure and tz-explicit so it's testable: pass the viewer's offset (UI:
// -new Date().getTimezoneOffset()). A Sunday closer than MIN_DAYS gives the
// day-quantized fill window no room, so it rolls to the Sunday after. The
// fixed-clock law is untouched — this is a default on offer, not a new rule.
export const SUNDAY_SNAP_HOUR = 18; // 6 pm local — evening, unambiguous
const SUNDAY_SNAP_MIN_SEC = 3 * 86_400;

export function sundaySnapDurationSec(createdAt: number, tzOffsetMinutes: number): number {
  const local = (createdAt + tzOffsetMinutes * 60) * 1000;
  const d = new Date(local);
  const daysToSunday = (7 - d.getUTCDay()) % 7; // 0 when today is Sunday
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToSunday, SUNDAY_SNAP_HOUR, 0, 0);
  let duration = Math.round(target / 1000) - tzOffsetMinutes * 60 - createdAt;
  while (duration < SUNDAY_SNAP_MIN_SEC) duration += 7 * 86_400;
  return duration;
}

export function circleCanvasErrors(circle: CircleRound): string[] {
  return validateCircleRound(circle);
}
