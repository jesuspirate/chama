import { DEFAULT_ROUND_SEC, type CircleRound } from "./types.js";
import { validateCircleRound } from "./circle.js";

export function circleCanvasRound(input: {
  shareSats: number; threshold: number; cap: number | null;
  durationSec?: number; createdAt: number; creatorPubkey: string;
  community: string; mintUrl: string; name: string; previous?: CircleRound;
}): CircleRound {
  const duration = input.durationSec ?? DEFAULT_ROUND_SEC;
  return { version: 1, circleId: "", creatorPubkey: input.creatorPubkey,
    community: input.community, mintUrl: input.mintUrl, name: input.name,
    shareMsats: input.shareSats * 1000, seatThreshold: input.threshold, seatCap: input.cap,
    createdAt: input.createdAt, fillDeadlineSec: input.createdAt + Math.round(duration * .4 / 86400) * 86400,
    roundEndSec: input.createdAt + duration, roundIndex: input.previous?.roundIndex ?? 1,
    prevCircleId: input.previous?.prevCircleId ?? null };
}

export function circleCanvasErrors(circle: CircleRound): string[] {
  return validateCircleRound(circle);
}
