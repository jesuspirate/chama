# The host's seat — peer-witnessed shares (v1.1 spec, for implementation review)

Status: SPEC ONLY. Not in the 6.4 launch engine. Money-path change — same
discipline as the money-path spec: implement against this document, then
adversarial verification before wiring.

## The problem (Jet, launch night 2026-09-15)

v1 law: member ≠ creator — the host cannot hold a seat in their own circle.
Jet: "The creator of the Chama is external to the locker. I'm not keen on
that." He's right that it's a product wound: the person who cares enough to
open a circle is the person most likely to want to save in it.

## Why the law exists (do not delete it without replacing what it protects)

Every share escrow seats the CREATOR as counterparty (seller). A host-held
share would put TWO of the three SSS key shares of that escrow in one
person's hands: the host could reconstruct and exit mid-round while every
other member stays truly locked. Fill-or-refund's entire promise is
SYMMETRIC commitment — "locked together" must be equally true for everyone.
The law is not host-exclusion; it is two-keys-one-person exclusion.

## The design: the ring — a circle witnesses itself

Generalize the gate from "member ≠ creator" to "share buyer ≠ share seller",
and assign each share's counterparty seat to ANOTHER MEMBER instead of
always the creator:

- Order members by lock time (the chain already stamps it). Share i's
  counterparty = member i+1 (mod N). The last share is witnessed by the
  first member.
- The HOST, when seated, is a member like any other: their share is
  witnessed by the next member. No share ever has buyer == seller. Nobody
  holds two keys to any escrow.
- Bootstrap: the FIRST share in an empty circle has no peer yet — its
  counterparty starts as the creator (exactly today's shape) and the ring
  property still holds for it (buyer ≠ seller) unless the creator is also
  that first member. RULE: the host may take a seat only once at least one
  other member's share exists to witness theirs. Product copy: "hosts lock
  last" — which is also a leadership gesture worth marketing.
- The arbiter seat is unchanged (community pool, REFUND-only healing).

## What this buys beyond the host seat

- Every member gains a PEER as their second REFUND voter, fixing completion
  finding 3 (returns currently wait for the CREATOR's client to come online
  — observed live at the first completion). Ring-witnessing spreads that
  liveness across the whole circle.
- The host's My-Trades no longer accumulates counterparty rows for every
  share in every circle they open (the "Your share" mislabel class of
  confusion shrinks structurally).
- Rotation-ready: v2 turn order and the witness ring can share the same
  member ordering.

## Engine deltas (for the implementing agent)

1. shareCreatePayload: counterparty parameter (pubkey) instead of implicit
   creator; gate: buyer ≠ counterparty, counterparty ∈ {creator} ∪ current
   locked members of the same circle.
2. chamaCreateError: replace member≠creator with buyer≠seller + the
   host-locks-last rule (host share requires ≥1 existing locked share).
3. canTakeSeat: "host" refusal becomes conditional (allowed once a witness
   exists).
4. REFUND-only law, deterministic share ids, zero fees: unchanged.
5. Cross-version — VERIFIED (policy.ts line ~46): today's gate PINS
   sellerPubkey === circle.creatorPubkey, so 6.4 readers will REJECT ring
   shares. Task ONE of v1.1 is therefore the reader relaxation (accept
   seller ∈ {creator} ∪ locked members of the same circle, seller ≠ buyer)
   shipped and DEPLOYED BEFORE any writer produces a ring share — readers
   first, writers later. Until then, mixed-version circles with ring shares
   would present thin views to old clients; the viewComplete guard prevents
   wrongful refund-due declarations, but do not lean on it as a plan.

## Open questions for Jet before implementation

- Host-locks-last: acceptable ceremony, or should a solo host be able to
  open + lock immediately with the arbiter as bootstrap witness?
- Ring reassignment when a witness's seat lapses pre-lock: re-ring at fill
  deadline, or fix witnesses only at lock time (recommended: at lock time,
  immutable after).
