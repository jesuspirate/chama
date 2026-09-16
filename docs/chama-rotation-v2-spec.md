# Rotation v2 — the collection (merry-go-round) spec, for implementation review

Status: SPEC ONLY. Money-path change of the largest kind: it deliberately
relaxes the REFUND-only law for a new share policy version. Same discipline
as the money-path spec and the host-seat spec: implement against this
document, then adversarial verification before wiring. Nothing here touches
"share-v1", which stays REFUND-only forever.

## The product (Jet, 2026-09-15)

"Users will expect a collection, not to play this for the fun of getting
their sats back." Correct. v1 fill-or-refund proved the rails don't steal;
v2 is the actual chama: every round the members pay in and ONE member
collects the pot, rotating until everyone has collected once. Ships together
with the host seat (CHAMA_RING_WRITER_ENABLED) as one sealed upgrade, so a
single field-test week proves both.

## What the REFUND-only law protected, and what replaces it

v1's law: no chain of events can EVER move a share's sats to anyone but the
member. That is what made every seat judgment-free — one lawful outcome,
nothing to weigh, nothing to steal. v2 cannot keep the law (collection IS
other people's sats arriving), so it keeps the PROPERTY instead:

  THE DETERMINISTIC-OUTCOME LAW: at every moment, chain-visible facts
  (the round's fill evidence + the clock) admit EXACTLY ONE lawful
  outcome for a share-v2 escrow. No seat ever exercises discretion.

  - Before fillDeadline: no resolution is lawful (funding window).
  - Fill FAILED (any expected share unlocked at fillDeadline): REFUND is
    the only lawful outcome, immediately and forever. (v1's machinery.)
  - Fill SUCCEEDED: RELEASE-to-collector is the only lawful outcome,
    votable from roundEndSec. The collector claims each share.
  - Collector never claims: after roundEndSec + COLLECT_WINDOW_SEC,
    REFUND becomes the only lawful outcome again (healing; notes must
    never rot because one person vanished).

Arbitration stays mechanical: the arbiter checks facts any client can
check, exactly as v1's healing does. The pool's judgment stays reserved
for trades.

## The design

### One cycle = a commitment round + N collection rounds (amended 2026-09-15)

Round 1 is the COMMITMENT ROUND: exactly the shipped v1 product — every
member locks, everyone's own sats return at roundEnd, standing minted. Its
job is sealing the MEMBER SET and the ROTATION (lock order, host last)
before anyone's money moves sideways. The rotation cannot be derived from a
round it is needed in (round 1's collector would be its first locker, who
cannot hold a seat paying themselves), so the handshake round is structural,
not ceremonial. v1 is never deprecated: it is the opening ceremony of every
merry-go-round, already field-proven.

Rounds 2..N+1 are the COLLECTION rounds — one payday per member, collector
for circle roundIndex r = rotation[r-2]. Round r's circle id is
DETERMINISTIC: sha256(["chama-round-v2", round1CircleId, r]) — so ANY member
can publish the next round's CREATE (no host liveness dependency),
duplicates are structurally impossible, and readers can walk the chain both
ways. Round r's circle CREATE is lawful only if: prevCircleId = round r-1's
id, identical shareMsats and member terms, roundIndex increments by one,
and the previous round FILLED AND ENDED (its outcome is determined; claims
proceed independently — decision 3's immediate cadence must not wait on the
collector's 7-day claim window). Deadlines are anchored to the SCHEDULE
(round 1's clock), never to publish time: fillDeadline and roundEnd of
round r are round 1's offsets shifted by (r-1) round-durations. A round
published too late to fill simply fails and ends the cycle — deterministic,
and the watcher publishes rounds on time in practice.

### The pot arithmetic (worked, 5 members × 10,000 sats)

Round 1: five lock 10,000 each, five get 10,000 back. No pot.
Rounds 2..6: the collector sits out, the other FOUR lock 10,000, and the
collector receives exactly 40,000 = (N-1) × share. EVERY payday is
identical. Per member per cycle: 4 × 10,000 paid in, 40,000 collected
once — net zero, with the lump arriving in your round.

### Turn order: THE WEEKLY RACE (amended 2026-09-15, Jet)

The queue is not sealed once — it re-runs every round. Collector for
circle roundIndex r (r ≥ 2) = the FASTEST LOCKER OF ROUND r-1 among the
sealed members who have not yet collected this cycle, host excluded until
the final round (hosts collect last, regardless of speed — the leadership
gesture survives the race). Round 1 has NO collector; round 2's collector
is therefore the fastest commitment locker, and from then on every round
is a fresh race: your queue position is bought with exactly one currency,
how fast you locked THIS week. Ties break by pubkey.

Why this is lawful with zero new machinery: round r+1 opens at round r's
roundEnd, and round r's fill window closed long before — every LOCK
timestamp is final and on-chain when the next collector must be named.
Deterministic for every client, no negotiation event exists (order-swap
arguments are structurally unexpressible), nobody collects twice (the
candidate pool shrinks), and fast fills — the classic ROSCA liveness
risk — become the thing that pays. Standing alignment is free: early
locks already mint the punctuality bonus; now they buy position too.

KNOWN BOUND, accepted for v2: Nostr created_at is self-declared, so a
cheating client can backdate a LOCK toward the round-open second. This
buys AT MOST an earlier slot (never amounts, never a second collection,
never a release the law forbids). v1 punctuality standing already accepts
the same exposure. Dashboards may expose relay receipt lag socially;
small circles police the rest. Do not pretend the clock is stronger than
it is anywhere in product copy.

### The share, v2: the collector sits in the seller seat

chamaPolicy "share-v2". In round r, every member EXCEPT the collector locks
one share; sellerPubkey = the round's collector (deterministic from the
chain, verified by readers — not trusted from the payload). RELEASE pays
the seller: the escrow engine already knows how to do this; v2 is a policy
change, not new custody machinery. The collector sits out their own round
(their contribution to themselves is a wash), which also preserves
buyer ≠ seller for free. Per cycle each member pays N-1 shares and collects
N-1 shares once: fair, and the pot per round is (N-1) × shareMsats claimed
as N-1 ordinary claims (the durable-claim queue from 6.4 already handles
publication persistence).

2-of-3 custody: member (buyer) + collector (seller) + pool arbiter, all
distinct. Nobody holds two keys. Member+collector releasing early only
moves the member's own sats to the collector sooner — victimless. The
collector alone can take nothing.

### Fill-or-refund is what protects the rotation

Every round is ATOMIC: you pay in only when the whole round is locked.
A member who collected early and then defaults (never locks again) cannot
steal from the failing round — it refunds. What they keep is what earlier
rounds already paid them; the loss to others is bounded, attributed on the
chain forever, and burned into standing. This is exactly the real-world
chama failure mode, minus the ambiguity about who did it. v2 policy:
a failed fill ENDS the cycle (no retry round) — remaining rounds never
open, everyone's locked sats refund, the defaulter's standing takes the
burn, everyone else's punctuality is minted.

### The max penalty: post-collection default (decided 2026-09-16, Jet)

A member who COLLECTED and then failed to lock in a later round of the
same cycle gets the maximum consequence the system can inflict:

1. TOTAL STANDING FORFEITURE — not a deduction: everything they ever
   accumulated zeroes at once. Standing never goes negative (unchanged),
   but it can be lost whole. Deterministic from chain facts alone:
   collected in round r + a later round of the cycle failed + they are
   among its missing lockers. No judgment, no arbiter, just arithmetic.
2. THE MARK — zero standing alone would make them indistinguishable from
   a newcomer, so clients also derive a distinct "collected, then broke
   the circle" fact (with date) from the same chain evidence, surfaced to
   hosts and members whenever that pubkey approaches a future circle.

Asymmetric mercy, on purpose: a PRE-collection no-show forfeited their
own payday and takes only the normal burn — they mostly punished
themselves. The pot creates the duty; the max consequence sits exactly
where the pot was taken. Non-custodial means sats can never be clawed
back — standing and the mark are the whole lever, and a fresh npub
escapes them only into newcomer coldness (no standing, no history, no
vouchers) in invite-first circles.

### Round 1 is the most load-bearing round (named 2026-09-16)

The commitment round seals the member set, proves every member can lock,
mints the first standing, bootstraps the witness ring, AND is heat one of
the race — its lock order IS the round-2 queue. Pole position collects
the first pot. Product copy: "the race starts the moment the circle
opens." Never call it ceremonial.

### Standing is the collection-order collateral

Nothing changes in the standing math; what changes is what it's FOR. The
post-collection rounds are the trust signal: a member who keeps locking
after their payday is provably reliable. Suggested v2 mint: locking in a
round AFTER your own collection earns the early-lock bonus at its maximum
(the sacrifice round is the loyalty proof). Hosts collecting last means
the host is in sacrifice rounds for the entire cycle — the strongest
standing engine in the design, for the person who convened it.

## Engine deltas (for the implementing agent)

1. chamaPolicy "share-v2" in the CREATE gate: same structural checks as
   share-v1 (deterministic id, amounts, deadlines, pool, zero fees) PLUS
   sellerPubkey must equal the chain-derived collector for this round
   (walk prevCircleId to round 1; order by LOCK timestamps; host last).
   Buyer must be a sealed round-1 member who is not the collector.
2. Vote/resolve law by policy version: share-v1 keeps REFUND-only at all
   five layers. share-v2 implements the deterministic-outcome law above
   (REFUND before fill / after failed fill / after collect-window lapse;
   RELEASE-to-collector from roundEndSec after a successful fill).
   Fill evidence = LOCKs on all N-1 deterministic share ids, visible to
   any client that fetches them (same viewComplete caveats as v1; the
   conservative side is REFUND, never RELEASE).
3. COLLECT_WINDOW_SEC constant (proposed: 7 days). Healing after it is
   REFUND, pool-open, mechanical.
4. Round chaining: deterministic round ids, round-CREATE gate (prev round
   settled, terms identical, member set sealed), any-member publication.
5. Watcher: extend the refund watcher into a round watcher — auto-vote
   RELEASE for the collector's payday exactly as it auto-votes REFUND for
   failed fills today; both are mechanical.
6. Readers first, writers later (hard sequencing): 6.4.x readers REJECT
   chamaPolicy "share-v2" outright ("Invalid share policy/category"), so
   the ENTIRE v2 reader law must ship and deploy before any writer. The
   plan: implement the full v2 engine now, ship it reader-complete in
   6.4.1 alongside the ring readers (writer flags off: CHAMA_RING_WRITER_
   ENABLED and a new CHAMA_ROTATION_ENABLED), let the fleet update, then
   flip both flags in 6.5 as the product release. One engine, one test
   week, two flag flips.

## Explicit non-goals for v2

- No standing-weighted or biddable turn order (v3 candidate).
- No auto-lock of next-round shares (the weekly ritual IS the product;
  reminders yes, custody automation no).
- No partial pots, no variable share amounts, no mid-cycle joins.
- No covenant claims: bearer ecash outside the protocol stays bearer ecash.

## Decisions (Jet, 2026-09-15 — all five sealed)

1. COLLECT_WINDOW_SEC = 7 days. Tighten later only if it proves a risk.
2. Collector SITS OUT their own round. The traditional everyone-pays ritual
   was social proof for chains that had no chain; ours does. Buyer ≠ seller
   preserved structurally, no self-payment round-trip.
3. Round r+1 opens IMMEDIATELY at round r's roundEndSec. "Mining a block
   kickstarts the new race" (Jet). The fill window is the built-in grace;
   an idle gap would only delay everyone's payday.
4. A failed fill ENDS the cycle. No retry round. Members who still locked
   earn exactly the standing their sats sat for — the standard mint, no
   sweetener (loot is the motive; the record just must not treat those who
   showed up like those who didn't). No-shows take the burn.
5. SACRIFICE-ROUND MINT: a member who locks in any round AFTER their own
   collection earns the punctuality bonus at its MAXIMUM regardless of when
   in the window they lock. Post-payday locking is the only act with zero
   financial motive, hence the strongest possible promise-keeping evidence,
   hence pointed at the exact spot every real-world chama dies. "The only
   weapon we have" (Jet).
