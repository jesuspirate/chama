// ══════════════════════════════════════════════════════════════════════════
// Chama — Assisted Chama canvas: the routing core (A5 · S1)
// ══════════════════════════════════════════════════════════════════════════
//
// One question this module answers, and nothing else:
//
//     "I have X and I want Y" → which market is that, and do I publish or pick?
//
// No UI, no relay, no async. It exists as its own module BECAUSE getting it
// wrong is worse than any visual mistake the canvas could make: a wrong answer
// confidently walks someone into the wrong side of a market — writing a listing
// when they meant to buy, or waiting for a counterparty who was never going to
// come. Every rule below is therefore a testable statement about how Chama's
// markets actually work, not a UI convenience.
//
// ⭐ THE DOCTRINE (PHILOSOPHY §9). Marketplaces traditionally open by asking
// "are you buying or selling?". That question is an admission the software does
// not know how its own markets work. Chama does: in every vertical exactly one
// side has nothing to react to and therefore must speak first.
//
//   Exchange    → the sats-holder publishes a price; cash reacts.
//   Bill pay    → the person with the bill publishes; volunteers react.
//   Stores      → the seller lists goods; buyers react.  (publisher ≠ funder)
//   Work        → BOTH sides publish. The only two-sided market.
//
// So the canvas never asks which mode the user is in. It derives it.

/** What a person can bring to, or want from, a trade. Deliberately four plain
 *  nouns — this is the vocabulary a newcomer already has. */
export type CanvasAsset = "sats" | "cash" | "work" | "goods";

/** Chama's internal vertical ids. Unchanged from the escrow engine on purpose:
 *  the canvas is a new front door, not a new house. */
export type CanvasVertical = "p2p-trade" | "bill-pay" | "marketplace" | "work";

export type CanvasRoute =
  /** The user must speak first. Exactly ONE vertical — you cannot publish into
   *  two markets at once. */
  | { kind: "publish"; vertical: CanvasVertical; twoSided: boolean }
  /** Someone else already spoke. MAY span several verticals: a person holding
   *  cash who wants sats can take an Exchange offer OR pay someone's bill, and
   *  from where they stand those are the same act. On the match side the
   *  vertical is an implementation detail — the user picks a PERSON, and the
   *  vertical follows from whose listing it is. */
  | { kind: "match"; verticals: readonly CanvasVertical[] }
  /** Not a market. Carries where to send the user instead — a dead end with no
   *  onward route is the thing this whole design exists to abolish. */
  | { kind: "blocked"; reason: BlockedReason; goVia: CanvasAsset | null };

export type BlockedReason =
  /** Same thing on both sides. */
  | "same-asset"
  /** Stores are sats-only, so cash cannot buy goods directly. */
  | "stores-are-sats-only"
  /** Neither side of the pair is bitcoin. Chama settles in sats; a trade with
   *  no sats leg is not something the escrow can hold. */
  | "no-sats-leg";

/**
 * Route a (bring, want) pair.
 *
 * Total: every one of the sixteen pairs returns something, and nothing throws.
 * A pair with no market returns `blocked` WITH an onward asset, never silence.
 */
export function routeCanvasIntent(bring: CanvasAsset, want: CanvasAsset): CanvasRoute {
  if (bring === want) return { kind: "blocked", reason: "same-asset", goVia: null };

  // ── Work is special and must be tested FIRST ────────────────────────────
  // It is the only two-sided market: the person offering their labour and the
  // person hiring BOTH publish, and neither is waiting on the other. Whichever
  // side of it you are on, you speak first.
  if (bring === "work" || want === "work") {
    // …but only against a bitcoin leg. Work-for-goods is barter; the escrow has
    // no sats to hold, so there is nothing for Chama to protect.
    if (bring === "sats" || want === "sats") {
      return { kind: "publish", vertical: "work", twoSided: true };
    }
    if (bring === "cash" || want === "cash") {
      // Cash-for-work is a real trade in the world, but not one this escrow can
      // secure. Send them via sats rather than refusing flatly.
      return { kind: "blocked", reason: "no-sats-leg", goVia: "sats" };
    }
    return { kind: "blocked", reason: "no-sats-leg", goVia: "sats" };
  }

  // ── Goods ───────────────────────────────────────────────────────────────
  if (bring === "goods") {
    // The seller lists their store listings. Always. A shop exists before
    // demand for any particular item does.
    if (want === "sats") return { kind: "publish", vertical: "marketplace", twoSided: false };
    // Selling goods for cash is not a Chama trade — the escrow would hold
    // nothing. Route via sats.
    return { kind: "blocked", reason: "stores-are-sats-only", goVia: "sats" };
  }
  if (want === "goods") {
    // Buying goods. Stores are sats-only (Create refuses payment rails on
    // marketplace), so cash must become sats first — and saying so is more
    // useful than "no results".
    if (bring === "sats") return { kind: "match", verticals: ["marketplace"] };
    return { kind: "blocked", reason: "stores-are-sats-only", goVia: "sats" };
  }

  // ── The sats ↔ cash pair ────────────────────────────────────────────────
  if (bring === "sats" && want === "cash") {
    // ⭐ The sats-holder names the price. This is the single most common
    // publish in Chama, and the user is never told they are "creating a
    // listing" — they said they had sats and wanted cash.
    //
    // Bill pay rides here too: someone holding sats who wants a fiat obligation
    // discharged IS the bill-poster. Same side, same act, one vertical chosen
    // later by whether they name a bill.
    return { kind: "publish", vertical: "p2p-trade", twoSided: false };
  }

  // bring cash, want sats.
  // ⭐ TWO markets answer this, and the user should not have to know that.
  // They can take a published Exchange offer, or pay someone's bill and earn
  // the sats that way. Both are "give cash, get sats". Merging them here is
  // what makes Community Bill Pay discoverable to someone who never went
  // looking for it — the stealth-onboarding property in PHILOSOPHY §5.
  return { kind: "match", verticals: ["p2p-trade", "bill-pay"] };
}

/** Does this pair make the user the one who speaks first? */
export function userPublishesFirst(bring: CanvasAsset, want: CanvasAsset): boolean {
  return routeCanvasIntent(bring, want).kind === "publish";
}

/**
 * Which listings would satisfy this user — i.e. what the counter-demand count
 * on the canvas is counting.
 *
 * ⚠ Deliberately EMPTY on the publish side. Someone bringing sats to sell is
 * not served by other people also selling sats: those are competitors, not
 * counterparties. Counting them would show "3 waiting" to a person nobody is
 * waiting for, which is the exact lie this design exists to avoid. `guided/`
 * already refuses this ("does not pretend current seller listings can fulfil a
 * sell-sats intent"); this keeps the canvas honest by the same rule.
 */
export function matchableVerticalsFor(
  bring: CanvasAsset,
  want: CanvasAsset,
): readonly CanvasVertical[] {
  const route = routeCanvasIntent(bring, want);
  return route.kind === "match" ? route.verticals : [];
}
