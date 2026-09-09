# Chama money path — implementation design (Fable-planned, 2026-09-07)

Status: DESIGN LOCKED — written to be executed mechanically by any session.
Engine contract: src/chama/ (54 tests green) is the pure source of truth for
fill-or-refund arithmetic; this doc wires its share locks into real escrows.

## The decision: standard share escrows + a REFUND-only policy gate

Neither candidate fork alone. A v1 share needs NO transfer machinery — the
member ALWAYS gets their own sats back — so each seat becomes a bog-standard
ecash escrow constrained so money can only flow BACKWARD:

- Member = BUYER (the locking role; marketplace expectedLockerRole already
  = BUYER). Creator = SELLER seat (witness; can never be paid — see gate).
- Arbiter: deterministic pool assignment, auto-seated exactly like
  PLAN_START's frozen-arbiter precedent (no arbiter JOIN needed).
- `expiresAt = roundEndSec`. The OUTER promise ("back by <date>") is thereby
  enforced UNCONDITIONALLY by the EXISTING expiry-healing machinery — even
  if every other layer fails, healing votes REFUND and notes return.

### The REFUND-only law (the one new engine gate)

CREATE for a chama share carries `chamaPolicy: "share-v1"` (precedent:
slicePolicy). State-machine + parser gates (style: slice-create-gate):

1. On a chamaPolicy escrow, ANY vote/resolution with outcome RELEASE is
   INVALID — rejected at parse and at canVote/handleVote. REFUND is the only
   lawful outcome. Money physically cannot move to the seller/creator.
2. chamaPolicy requires: category "chama-share", a `circleId` parent ref,
   amountMsats === parent's shareMsats (equal-shares law), and the parent's
   validateCircleRound() errors empty (malformed circles unrepresentable).
3. chamaPolicy forbids: slicing fields, onchain mode (ecash only in v1),
   menu items, ranges.

### Two deadlines, three return layers (all existing machinery)

Fill fails (chain-derivable: sibling locked shares < threshold at
fillDeadlineSec — the chama CLIENT layer reads circleProgress, exactly how
the slice-funding loop does cross-child sequencing client-side):

- Layer 1 (fast): every member's client auto-publishes its REFUND vote on
  refund-due; creator's client likewise. Two agreeing principals = instant
  resolution, no arbiter (existing rule).
- Layer 2 (ghost creator): after the one-sided escalation window, the pool
  arbiter rules — and the REFUND-only gate means there is exactly one lawful
  ruling. Arbitrating a chama share is a no-judgment act.
- Layer 3 (absolute): roundEndSec expiry healing (all heal votes REFUND,
  pool-open). Worst case = sats late by (roundEnd − fillDeadline), NEVER lost.

Round completes: same three layers fire at roundEndSec (expiry healing IS
the return path — the brief's original instinct, kept).

## Event shapes (reuse, no new kinds)

- Circle parent = CREATE 38100, category "chama", browsable (how strangers
  find circles). Payload adds `chamaCircle: { shareMsats, seatThreshold,
  seatCap, fillDeadlineSec, roundEndSec, roundIndex, prevCircleId }` —
  validated by validateCircleRound at the parser gate.
- Share = CREATE 38100, category "chama-share", `chamaPolicy: "share-v1"`,
  `parent: <circleId>`, deterministic id (H3 precedent):
  shareEscrowId = hash(circleId ‖ memberPubkey ‖ roundIndex) — retry-stable,
  one seat per member enforced by id collision.
- Shares are EXCLUDED from public Browse (pausedShape/tranche-child filter
  precedent) and from needs-you until actionable.
- Seat flow: member publishes share CREATE (self as BUYER via JOIN-in-CREATE
  pre-seat like tranche children), funds + LOCKs via the normal atomic
  funding path. `lockedAtSec` = the LOCK event timestamp → lockPunctuality.

## File-by-file execution plan

1. `src/escrow-engine/types.ts`: `chamaPolicy?: "share-v1"`, `chamaCircle?`
   payload types; category unions gain "chama" | "chama-share".
2. `src/escrow-engine/event-parser.ts`: CREATE gates (validateCircleRound on
   parents; policy requirements 1–3 on shares). Style: slice-create-gate.
3. `src/escrow-engine/state-machine.ts`: the REFUND-only law in canVote /
   handleVote / handleResolve (reject RELEASE on chamaPolicy). ~30 lines.
4. `src/chama/wiring.ts` (new, client layer): sharesForCircle(escrows) →
   CircleShareLock[] adapter (escrow status → reserved/locked/returned/
   refunded; LOCK timestamp → lockedAtSec); refund-due watcher that
   auto-publishes this device's REFUND vote (mirrors the slice-funding
   loop's client-side orchestration + the zombie-resilient publish()).
5. `src/chama/tests.ts`: adapter mapping cases. NEW
   `src/escrow-engine/chama-gate.tests.ts` (style: slice-create-gate.tests):
   RELEASE rejected on shares (vote+resolve+heal), share amount mismatch
   rejected, malformed circle parent rejected, legacy escrows untouched,
   deterministic share id stability, duplicate seat = same id (idempotent),
   onchain/slicing on shares rejected. Wire into package.json test chain.
6. Browse exclusion: add "chama-share" to the tranche-child/paused filter in
   decisions.ts browsable logic + needs-you neutrality until refund-due.

DO NOT in this phase: guided flow, live surface, notifications, rotation,
auto-re-entry publishing (nextRoundTemplate stays client-side until v1 ships).

## Invariants the tests must scream about

- No chain of events can EVER move a share's sats to anyone but the member.
- A share cannot exist without a lawful parent circle.
- Every share's outer return date ≤ parent.roundEndSec ≤ created+14d.
- The adapter never counts a reserved (unfunded) share as locked.
- All existing 4,113 tests stay green — chama gates must be invisible to
  every non-chama escrow.

## The arbiter seat: keep it, neuter it (clarification, 2026-09-07)

DO NOT remove the arbiter seat from a chama share "because it can only rule
REFUND". The seat is STRUCTURALLY required: the ecash escrow is 2-of-3
Shamir shares, so a third key holder must exist. What the REFUND-only law
removes is DISCRETION, not the seat:

- cannot steal — no lawful chain of events pays anyone but the member;
- cannot judge — exactly one lawful ruling exists, so there is nothing to
  weigh, no story to believe, no side to favour (arbitrating a chama share
  is a mechanical act, and reputation/bond stakes should treat it as such);
- cannot block — if the arbiter never appears, roundEnd expiry healing is
  pool-open and returns the sats regardless.

Their absence costs LATENCY (at most roundEnd − fillDeadline), never money.

Scaling consequence, and the reason this matters: weekly circles at any real
membership would flood the arbiter pool if each share were an ordinary
escrow needing judgment. Judgment-free shares keep the pool's bonded
attention available for the trades that actually need human wisdom.


## Implementation notes (2026-09-07)

All six execution steps are implemented. `src/chama/policy.ts` shares the
CREATE checks between parsing and replay; `EscrowClient.createChamaShare()`
creates a deterministic, pre-seated share for the normal atomic funding bridge.
The parser receives locally resolved parent state, never parent facts copied
from an untrusted share payload. Parent lookup reads only CREATE events, so
malicious cyclic parent references cannot recursively hydrate forever.

Additional integration requirements found in the existing code:

- Refund routing explicitly treats shares as buyer-funded. RELEASE is refused
  before vote-share encryption, in contextual parsing, and before the reducer's
  expiry shortcut as well as its vote/resolve handlers.
- Share LOCK preserves the original round-end deadline instead of restarting
  the ordinary trade timeout. The bridge checks the funding window and member
  identity before touching the wallet. Share LOCK requires zero fees and
  holder-only encryption, including the deterministic eligible pool backups.
- A lone principal REFUND opens the existing bounded escalation window for a
  share. Ordinary escrows retain their RELEASE-only escalation rule.
- APPROVED means money is still owed; the adapter marks it returned/refunded
  only after CLAIM. The early/round-end distinction uses resolution time.
- The periodic watcher refreshes child chains and uses the existing vote
  publisher. Overlapping passes are suppressed and failed publishes retry.
  Slow child refresh does not block the independent absolute-expiry sentinel.
- Creator, member, and assigned arbiter must be distinct keys, as required by
  the escrow's existing three-party custody model.

Limits of this phase: fill/cap decisions are client-derived from relay-visible
child chains, not an atomic global seat registry. Missing relay evidence can
produce an early refund; simultaneous seats can exceed a locally observed cap.
The REFUND-only rule guarantees the recipient for accepted protocol events;
it does not turn bearer ecash into a covenant or prevent two share holders
from colluding outside the protocol. Expiry enables recovery votes but cannot
guarantee wall-clock redemption while clients, relays, or the federation are
offline. The guided flow, dedicated live surface, notifications, and automatic
next-round publishing remain out of scope as specified above.

## Review findings (Claude verification pass, 2026-09-07)

Implementation reviewed adversarially against the spec. Two defects found and
FIXED — both originated in the ENGINE CONTRACT (src/chama/circle.ts), not in
the wiring, and were faithfully implemented as specified:

1. **Fill cascade (fixed).** circleStatus derived the fill from CURRENT lock
   status, so one member's early exit flipped a healthy `running` circle to
   `refund-due` and cascaded refunds through everyone else. Fill is now
   latched on the historical chain fact (a LOCK stamped inside the fill
   window), which the CREATE/LOCK gates already enforce. Monotone: a filled
   circle can never un-fill; a failed one stays failed after its refunds
   settle. Probe-proven before and after.
2. **Thin-view self-eviction (fixed).** A client whose relays returned only
   its own share read "below threshold" at the deadline and voted itself out
   of a circle that had actually filled. The early REFUND is only ever an
   optimisation (roundEnd healing is unconditional), so the watcher now waits
   when it can see fewer than two shares in the circle. Never strip a member
   from a healthy circle to save days on a dead one.

Verified sound, no change needed: REFUND-only is enforced at five
independent layers (parser, applyEvent, handleVote, handleResolve, canVote)
AND `payoutRecipientFor` returns null for any non-REFUND outcome on a share,
so no chain of events has a payout destination other than the member;
circle parents cannot hold funds; fees are pinned to zero at CREATE; share
expiry is pinned to roundEnd; share ids are deterministic (double-seating is
a hash collision); arbiter is pool-picked excluding member and creator;
shares are excluded from Browse; legacy escrows are provably untouched
(4,113 engine tests unchanged).

### OPEN PRODUCT DECISION — the creator cannot hold a seat

`chamaCreateError` rejects a share where member === creator ("Share must seat
distinct member and creator"), because the share escrow seats the member as
BUYER and the creator as witness-SELLER, and one pubkey cannot hold both.
Consequence: **the person who opens a circle cannot save in it.** In a real
chama the organiser is normally a member too. Options: (a) for the creator's
own share, seat a different member as the witness-SELLER (representable, but
breaks the "seller === creator" uniformity the gate currently enforces);
(b) accept it — the creator is Mwenyeji, the host who administrates;
(c) revisit when rotation lands, where the creator must be a collector.
Not a code defect — a design consequence needing Jet's ruling.

### Thin-view guard, refined (2026-09-07)

The first cut of the guard would have made a circle where only ONE person
ever locked wait until roundEnd for its refund — the most common early-
adoption failure. The watcher now accepts `viewComplete(circleId)`: the
escrow client sets it once `loadChildren` for that circle has RESOLVED (a
throw unwinds the pass, so reaching it means the refresh really completed).
A trusted view acts immediately; an untrusted thin view still waits. The
≥2-shares heuristic remains the fallback for callers that cannot say.

### Third defect found and fixed: host offered an impossible button

`canTakeSeat` did not know the member !== creator law (it lived only in the
engine gate), so a host would be shown "Lock your share" and then rejected
by the chain. The law now lives in `canTakeSeat` with its own refusal reason
("host"), so every caller — the surface selector AND
`escrow-client.createChamaShare` — refuses early and honestly.

## Cross-version hazard: old clients and chama shares (Jet, 2026-09-07)

Observed live: signing into getchama.app (v6.3.3, no chama code) with the
same nsec surfaced a chama SHARE as an ordinary trade and offered its normal
vote buttons. Old code has no category allowlist, so `category:
"chama-share"` parses as a generic escrow — and its `payoutRecipientFor`
computes a NON-marketplace direction, i.e. REFUND → SELLER (the circle
creator). That is exactly backwards from the chama law (REFUND → member).

New clients are safe in BOTH directions, verified:
- RELEASE is rejected by the outcome gate (parser, applyEvent, handleVote,
  handleResolve, canVote);
- REFUND is rejected by `validateVoteShareEnvelope`, because the old client
  addresses the key-share envelope to the creator while the engine-computed
  recipient is the member.

So a stray old-client vote never enters a new client's chain, and the round
proceeds untouched. The residual harm is a LEAK, not a theft path in the
engine: an old-client REFUND vote publishes the voter's key share encrypted
to the creator, and two of three shares reconstruct the notes.

Exposure is transient and self-closing: a share can only be CREATED by a
client that has the chama code, so no ordinary user is ever a circle
participant on an old client. Only a tester running one nsec across two
versions can reproduce it. It disappears when chama ships to production.

Rule while that gap exists: do not vote on a chama trade from a client
without chama support.
