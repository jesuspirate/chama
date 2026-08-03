// ══════════════════════════════════════════════════════════════════════════
// Work — matching a worker's offer to a client's request (A4 / Work phase 3)
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ A WANT IS A LISTING WITH THE ROLES FLIPPED. That is the whole trick, and it
// is why two-sided matching costs a scoring function rather than a protocol
// change: both sides are ordinary marketplace escrows carrying the same fields,
// so this module compares two `EscrowState`s and never touches the reducer, a
// relay, or a sat.
//
// SYMMETRIC BY CONSTRUCTION. `scoreWorkMatch` takes an offer and a request and
// does not care which one is "the viewer". Run it with a worker's offer as the
// subject to answer "who needs me", and with a client's request as the subject
// to answer "who can do this". One function, both directions — if it were two,
// they would drift, and a match would exist in one direction only.
//
// PRICE IS A RANGE, NOT AN EQUALITY. A worker naming 40,000 sats and a client
// budgeting 50,000 is a match, and a good one. Refusing anything but an exact
// number would leave almost every real pair unmatched, so the score rewards
// overlap and lets the two settle the rest in chat, where they were always
// going to.

import { EscrowStatus, Role, type EscrowState } from "../escrow-engine/types.js";
import { isWorkOffer, isWorkRequest } from "../ui/work-resume.js";

/** Weights. Same spirit as `match-listings.ts`: category dominates because a
 *  plumber and a tutor are not near-misses, then locality, then price fit. */
export const WORK_SCORE = {
  category: 300,
  community: 120,
  paymentRail: 80,
  priceFit: 200,
  reputation: 100,
} as const;

export type WorkMatchRejection =
  | "not-work"
  | "same-side"
  | "self-listing"
  | "not-open"
  | "expired"
  | "category-mismatch"
  | "budget-below-ask";

export interface WorkMatchReason {
  code: "category" | "community" | "payment-rail" | "price-fit" | "reputation";
  detail?: string;
}

export type WorkMatchResult =
  | { matched: true; score: number; reasons: WorkMatchReason[] }
  | { matched: false; reason: WorkMatchRejection };

function isOpenListing(state: EscrowState, nowSec: number): boolean {
  return state.status === EscrowStatus.CREATED && state.expiresAt > nowSec;
}

function authorOf(state: EscrowState): string | null {
  return state.participants[Role.SELLER] ?? state.initiator?.pubkey ?? null;
}

function sharedRails(a: EscrowState, b: EscrowState): string[] {
  const left = new Set((a.paymentMethods ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean));
  if (left.size === 0) return [];
  return (b.paymentMethods ?? [])
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r && left.has(r));
}

/**
 * Score one offer against one request. Order-independent: pass them either way
 * round.
 *
 * ⚠ `budget-below-ask` is a REJECTION, not a low score. A client whose whole
 * budget is under the worker's asking price is not a weak match, it is a
 * different conversation — and surfacing it as a match wastes the time of the
 * person with the least of it. The reverse (a budget well above the ask) is
 * fine and simply scores well.
 */
export function scoreWorkMatch(
  a: EscrowState,
  b: EscrowState,
  opts: {
    nowSec?: number;
    /** Verified positive-rating share (0..1) of the OTHER party, when known. */
    counterpartyPositiveRate?: number;
  } = {},
): WorkMatchResult {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const offer = isWorkOffer(a) ? a : isWorkOffer(b) ? b : null;
  const request = isWorkRequest(a) ? a : isWorkRequest(b) ? b : null;
  if (!offer || !request) {
    // Either one of them isn't Work at all, or they're the same side — two
    // workers advertising to each other is not a match.
    const bothWork = (isWorkOffer(a) || isWorkRequest(a)) && (isWorkOffer(b) || isWorkRequest(b));
    return { matched: false, reason: bothWork ? "same-side" : "not-work" };
  }

  const offerAuthor = authorOf(offer);
  const requestAuthor = authorOf(request);
  if (offerAuthor && requestAuthor && offerAuthor.toLowerCase() === requestAuthor.toLowerCase()) {
    return { matched: false, reason: "self-listing" };
  }
  if (!isOpenListing(offer, nowSec) || !isOpenListing(request, nowSec)) {
    const expired = offer.expiresAt <= nowSec || request.expiresAt <= nowSec;
    return { matched: false, reason: expired ? "expired" : "not-open" };
  }

  // Category is the hard gate. Two listings with no category in common are not
  // a weak match; they are unrelated work. The one exception is "other", the
  // free-text escape — it cannot be compared, so it never blocks, and instead
  // simply earns no category points.
  const offerCat = offer.workCategory ?? null;
  const requestCat = request.workCategory ?? null;
  const eitherIsOpenEnded = offerCat === "other" || requestCat === "other" || !offerCat || !requestCat;
  if (!eitherIsOpenEnded && offerCat !== requestCat) {
    return { matched: false, reason: "category-mismatch" };
  }

  // A client's budget below the worker's ask is a different conversation.
  if (request.amountMsats > 0 && offer.amountMsats > 0 && request.amountMsats < offer.amountMsats) {
    return { matched: false, reason: "budget-below-ask" };
  }

  const reasons: WorkMatchReason[] = [];
  let score = 0;

  if (!eitherIsOpenEnded && offerCat === requestCat) {
    score += WORK_SCORE.category;
    reasons.push({ code: "category", detail: offerCat ?? undefined });
  }
  if (offer.community && request.community && offer.community === request.community) {
    score += WORK_SCORE.community;
    reasons.push({ code: "community", detail: offer.community });
  }
  const rails = sharedRails(offer, request);
  if (rails.length > 0) {
    score += WORK_SCORE.paymentRail;
    reasons.push({ code: "payment-rail", detail: rails[0] });
  }
  if (request.amountMsats > 0 && offer.amountMsats > 0) {
    // Closer to the ask scores higher — a budget three times the ask is not
    // three times the match, it just means they can afford it.
    const ratio = offer.amountMsats / request.amountMsats; // ∈ (0, 1]
    score += Math.round(WORK_SCORE.priceFit * ratio);
    reasons.push({ code: "price-fit" });
  }
  const rate = opts.counterpartyPositiveRate;
  if (typeof rate === "number" && rate >= 0 && rate <= 1) {
    score += Math.round(WORK_SCORE.reputation * rate);
    reasons.push({ code: "reputation" });
  }

  return { matched: true, score, reasons };
}

/** Every counterpart of `subject` among `candidates`, best first.
 *
 *  Ties break on listing id so two clients showing the same page see the same
 *  order — an unstable ranking makes a shared decision impossible to talk about
 *  ("the second one" has to mean the same thing to both people). */
export function findWorkMatches(
  subject: EscrowState,
  candidates: readonly EscrowState[],
  opts: {
    nowSec?: number;
    positiveRateFor?: (npub: string) => number | undefined;
  } = {},
): Array<{ listing: EscrowState; score: number; reasons: WorkMatchReason[] }> {
  const out: Array<{ listing: EscrowState; score: number; reasons: WorkMatchReason[] }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === subject.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const author = authorOf(candidate);
    const result = scoreWorkMatch(subject, candidate, {
      nowSec: opts.nowSec,
      ...(author && opts.positiveRateFor
        ? { counterpartyPositiveRate: opts.positiveRateFor(author) }
        : {}),
    });
    if (result.matched) out.push({ listing: candidate, score: result.score, reasons: result.reasons });
  }
  return out.sort((x, y) => (y.score - x.score) || x.listing.id.localeCompare(y.listing.id));
}
