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

export function circleCanvasErrors(circle: CircleRound): string[] {
  return validateCircleRound(circle);
}
