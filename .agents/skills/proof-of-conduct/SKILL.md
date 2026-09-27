---
name: proof-of-conduct
description: How Chama judges a key — by conduct every device can verify from relays and the timechain, never by opinion. Read before touching reputation, ratings, arbiter records, listing badges, "trusted" lanes, or any number shown next to a person.
---

# Proof of conduct

Jet, 2026-09-26: "let every key judge listings based on SERIOUS proof of
work and reputation." A key earns standing by doing things that cost time,
sats or patience, and that anyone can check. Nothing else counts.

## The rule

A fact may be shown next to a key only if every device, replaying the same
relay events and reading the same chain, arrives at the same fact. If two
devices can disagree, it is not a fact and it is not shown (brief 06 E:
"settled 0 disputes" here, "1" there, was worse than no number).

Verifiable sources, in order of strength:

1. **The timechain.** Bond deposits and their age, escrow deposits,
   settlement transactions, which leaf spent them (cooperative or
   arbitrated), block heights and therefore elapsed time. Cannot be faked
   or backdated.
2. **Signed events by the counterparty.** A seller's RELEASE vote, a
   buyer's "paid" event, an arbiter's ruling. Signed by someone else, so
   the key cannot invent them.
3. **Signed events by the key itself**, only where the chain of references
   bounds them: an event that references another cannot be earlier than
   it, so speed measured between a counterparty's event and the key's
   response is honest to within relay latency.

Not sources: thumbs, free-text reviews, self-reported counts, anything one
device saw and another didn't. Ratings may exist as colour, never as a
number that ranks.

## What earns standing

- **Age**: first verifiable act (first bond deposit height, first
  completed trade) — the older, the harder to fake.
- **Volume settled**: sats through completed escrows where this key was a
  party, on chain or ecash with a counterparty-signed COMPLETE.
- **Speed**: time from "the ball is in your court" to your signed answer —
  locking after a join, confirming after "paid", **signing a payout after
  approval**, an arbiter ruling after a dispute. Fast signers rank above
  slow ones. Arbiters already live by this; sellers and buyers do too.
- **Bond**: sats locked and for how long, verified on chain.
- **Disputes**: opened against the key vs. ruled in its favour, from
  arbiter rulings only.

## What costs standing — and is shown loudly

- **Approved, then didn't sign.** The key voted RELEASE, a winner-authored
  payout existed, and the escrow was spent through the arbitrated leaf
  instead. Three verifiable facts. Shown on every listing and card of that
  key, in red, for everyone: "Made a buyer wait for the arbiter after
  agreeing to pay — once / N times." No expiry.
- Lost disputes, expired locks the key was responsible for, listings that
  lapsed with a seated buyer.

A new key has none of this, which is the point: rotating away from a mark
also rotates away from the age, volume and bond that made the key worth
trading with. Say so on fresh keys: "New here · no history yet."

## Showing it

Plain words, one line per fact, the strongest facts first. The bar and the
listing card show the same thing (see `chama-bar`). Numbers appear only
with their source: "12 trades settled on chain", "bonded 100k sats for 41
days", "signs within 2 hours (median of 9)". No composite score in v1;
composites hide which fact did the work.

## Tests

Every displayed fact has a pure function from (events, chain reads) →
fact, with a test that two orderings of the same events give the same
fact, and that a missing chain read yields "unknown", never zero.
