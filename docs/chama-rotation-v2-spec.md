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

### One cycle = N chained circles

A cycle is N rounds; each round is a circle escrow, chained by prevCircleId,
roundIndex 1..N. The MEMBER SET SEALS when round 1 fills: rounds 2..N admit
exactly the round-1 members. Round r's circle id is DETERMINISTIC:
sha256(["chama-round", round1CircleId, r]) — so ANY member can publish the
next round's CREATE (no host liveness dependency), duplicates are
structurally impossible, and readers can walk the chain both ways.
Round r's circle CREATE is lawful only if: prevCircleId = round r-1's id,
identical shareMsats/member terms, roundIndex increments by one, and the
previous round SETTLED (all its shares CLAIMED or REFUNDED).

### Turn order: lock order, host last

The rotation is the round-1 lock order — first to lock collects first —
with the host pinned LAST regardless (hosts lock last, hosts collect last:
the leadership gesture, decided 2026-09-15). Chain-derived from round-1
LOCK timestamps; no new events needed. Collector for round r =
orderedMembers[r-1].

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
