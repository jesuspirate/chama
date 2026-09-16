import { DEFAULT_ROUND_SEC, type CircleRound } from "./types.js";
import { validateCircleRound } from "./circle.js";

export function circleCanvasRound(input: {
  shareSats: number; threshold: number; cap: number | null;
  durationSec?: number; createdAt: number; creatorPubkey: string;
  community: string; mintUrl: string; name: string; previous?: CircleRound;
  /** "Just us": invite-link only, hidden from Browse. */
  unlisted?: boolean;
}): CircleRound {
  const duration = input.durationSec ?? DEFAULT_ROUND_SEC;
  // Day-scale rounds keep the day-quantized 40% fill window; sub-day rounds
  // (sim-mode test drives — a week in five minutes) take 40% unquantized
  // with a one-minute floor so the window is never empty.
  const fillWindow = duration >= 86_400
    ? Math.round(duration * .4 / 86_400) * 86_400
    : Math.max(60, Math.round(duration * .4));
  return { version: 1, circleId: "", creatorPubkey: input.creatorPubkey,
    community: input.community, mintUrl: input.mintUrl, name: input.name,
    ...(input.unlisted ? { unlisted: true } : {}),
    shareMsats: input.shareSats * 1000, seatThreshold: input.threshold, seatCap: input.cap,
    createdAt: input.createdAt, fillDeadlineSec: input.createdAt + fillWindow,
    roundEndSec: input.createdAt + duration, roundIndex: input.previous?.roundIndex ?? 1,
    prevCircleId: input.previous?.prevCircleId ?? null };
}

export function circleCanvasErrors(circle: CircleRound): string[] {
  return validateCircleRound(circle);
}
