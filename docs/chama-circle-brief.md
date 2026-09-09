# Chama — the savings circle (brief, premises locked 2026-09-03)

> Jet's ruling, late-night session 2026-09-03: retire **Stack (soon)** from the
> Create verticals and replace it with **Chama (soon)** — the app finally doing
> the thing it is named after. This brief locks the premises so nothing is lost.

## The concept

A pure chama, with Bitcoin: a group locks sats **together** for one bounded
round. Either the circle fills and everyone completes the round, or it doesn't
and **everyone automatically gets their exact sats back**. Nobody is ever the
only one who showed up.

## Mechanics (round 1 — the only round for v1)

1. A creator opens a Circle: per-share amount, participant threshold
   (and optionally a cap), and a deadline agreed **before** any lock.
2. Each participant locks their share into escrow.
3. **Fill-or-refund:** if the participant threshold is not met by the deadline,
   every locked share auto-returns at the deadline. No partial circles.
4. If the circle fills, shares stay locked for the round duration, then return
   to their owners at round end.

## Hard constraints (do not drift)

- **Round duration ≤ ~2 weeks** — bounded by what the federation can safely
  hold locked without redeem. The bound is a *feature*, said out loud:
  "locked together, guaranteed back by <date>."
- **No price promises. Ever.** Stack's "refund the downside" idea is retired:
  promising to cover a BTC price drop means the operator underwrites market
  risk (a liability, and it starts to look like a security/derivative).
  Participants lock sats and get **sats** back — their own, exact amount.
  Users measure BTC price risk themselves. (Jet's call, affirmed 2026-09-03.)
- Non-custodial, all-or-refund, deadline agreed before the first lock.

## The engine already exists: Chip In

The parked **chip-in** module is this mechanism, tested and green:
"locked counts; pledged does not meet the goal", "goal met when locked sum
reaches target", "expired when past deadline and unmet". Chama is Chip In
reframed: threshold + deadline + auto-refund, with per-share amounts and the
circle identity on top. Build on it; do not rebuild it.

## Naming & identity

- Vertical id: `chama`. Label: **Chama** — sharing the app's name is the point,
  not a collision (the flagship feature IS the namesake).
- In running copy use "Circle" to keep sentences clean:
  "start a Circle", "your Circle fills or everyone is refunded."
- Mark: three figures around one shared pot (orange dot = the pooled sats) —
  `VerticalIcon` `chama` branch, same ink/paper style as the other marks.

## Shipped tonight (2026-09-03)

- Create verticals: Stack (soon) → **Chama (soon)** tile, same tile style.
- ConnectScreen use-case row swapped to Chama.
- `VerticalIcon` chama mark. i18n: `create.verticalChama(+Desc)`,
  `connect.useCaseChama(+Blurb)`.

## Phased plan (when we build for real)

1. **Protocol shape**: a Circle parent (create: shareMsats, threshold, cap?,
   deadline, roundEnd) + per-participant share locks. Reuse chip-in's
   goal/threshold/expiry reducers; refund path = the existing expiry healing.
2. **Guided flow**: canvas-native — "How much per person? · How many of you? ·
   When does the round end?" Always suggested defaults, never a blank field.
3. **Live surface**: the LiveTradeSurface idiom — one status, one move:
   "3 of 5 seats filled · 9 days left" → lock your share / wait / refunded.
4. **Notifications**: circle filled / circle failed-refunded / round complete —
   rides the existing VPS wake plumbing.

## Morning additions (Jet, 2026-09-04)

- **Cadence**: every chama runs a preselected **2-week round by default**
  (configurable). The rhythm is the product: circles pulse every two weeks.
- **Open to the world**: any chama is joinable by anyone who chooses to step in.
- **Chamacitos** (the members): anyone who completed a *successful* chama is
  **auto-entered into the next one two weeks later** — free to sit a round out,
  *unless it's their turn to collect*.
- **Reputation is load-bearing**, not decorative: your chama history is your
  standing, and it should gate/weight who circles trust.

### What "turn to collect" implies (flagged honestly)

"Their turn to collect" is the classic rotating chama — each round the pot pays
ONE member. That is the full ROSCA, and it re-enters scope as the north star.
Name the cost plainly: rotation means members extend **credit** to whoever
collects early — an early collector who stops contributing defaults on the
circle. That is exactly why reputation + bonds must be load-bearing here, and
why the safe build order is:

1. **v1 — the commitment pool** (this brief's core): fill-or-refund, everyone
   gets their own sats back. Zero credit risk. Ships the identity, the cadence,
   the auto-re-entry, and starts accruing chama reputation.
2. **v2 — rotation**: turns to collect, gated by the reputation earned in v1
   (and possibly bonds for large circles). Defaulter handling designed on top
   of the arbiter/bond machinery, not improvised.

Auto-re-entry bridges the two beautifully: successful v1 circles build the
trust graph that makes v2 rotation safe to open to the world.

## Open questions (decide before phase 1)

- Equal shares only in v1? (Recommended: yes — simplest honest circle.)
- Bounded membership (cap) or open until deadline?
- Who may open a circle — anyone, or bonded/reputable members first?
- Auto-re-entry mechanics: opt-out window before each new round? How is the
  next round announced (VPS wake ping: "your circle re-forms in 48h")?
- Reputation inputs: completed circles, on-time locks, defaults — same
  kind:38123 primitive or a chama-specific record?

## Punctuality standing (Jet + Claude, locked 2026-09-06)

Standing is earned on a punctuality gradient, derived entirely from chain
timestamps — nothing self-reported:

- **Early lock → bonus.** The early locker bears real cost (sats illiquid
  longest while the circle fills), so earliness is genuine skin in the game.
  Weight the bonus by **sat-days committed**, never by count of early locks —
  sat-days cannot be Sybil-farmed with dust shares in toy circles.
- **The bonus DECAYS to zero across the fill window; on-time is NEVER
  negative.** Jet's first instinct was to demote last-minute lockers; rejected
  on principle after discussion: someone who locks on day 13 of 14 did exactly
  what they agreed to do, and punishing compliance silently moves the real
  deadline earlier, destroys trust in the stated rules, and scores cash-flow
  rhythms (paid on the 1st, market-day money) as character flaws. The decaying
  bonus keeps the urgency gradient with zero injustice. Rule of the system:
  **never penalize someone for doing what the protocol asked.**
- **Declared sit-out in the opt-out window → zero penalty.** Opting out must
  stay honorable and free, or people stop declaring and start ghosting — the
  worse failure mode.
- **Silent no-show on a COMMITMENT → the heavy penalty.** The penalty attaches
  to a held seat, or an auto-re-entry left standing past the opt-out window,
  that then goes unlocked. Absence without commitment costs nothing.
- A no-show never kills the circle: the seat reopens to the world for the rest
  of the fill window, and fill-or-refund still backstops everyone.

## Flexibility: flex the person, never the deadline

The two-week round stays rigid — it is the product's honesty ("locked
together, guaranteed back by this date") and the federation's safety bound;
stretching it makes the punctual wait on stragglers. Support for someone who
misses THIS round but can lock next round comes from elastic reputation:

- Missing a round drops standing but never exiles — the member is invited to
  the very next round.
- **Clean rounds repair damage**: penalties decay (e.g. halve) per consecutive
  completed round. The record is immutable; the score forgives.
- **Grace token**: one per N rounds, converts a life-event miss into the light
  penalty instead of the heavy one. Bounded mercy — real life is absorbed,
  serial defaulters cannot hide behind it.

Why this matters beyond v1: the early / on-time / declared-out / no-show
gradient is exactly the underwriting data v2 rotation needs. This is not a
points system bolted on — it is the credit signal for turns-to-collect,
accumulating two weeks at a time.

## Morning rulings (Jet, 2026-09-07)

- **Cadence: WEEKLY rounds** (was two-week default). Lock Monday, back by
  Sunday. Sits deeper inside the federation safe-hold bound, doubles the
  reputation data rate, and carries the old Stack instinct with zero
  liability: if BTC rises by Sunday the member won BY THEMSELVES, because they
  held sats — Chama promised nothing. The rhythm is the marketing.
- **Loot penalties: NEVER.** Docking sats from a refund/payout breaks the core
  promise ("your exact sats back"), invents seizure semantics, and contradicts
  the bond ceremony's own language. Monetary consequences, if ever, live in
  explicit v2 bonds agreed upfront — never in the pot.
- **Collection-order demotion IS the v2 penalty surface** (Jet's idea,
  adopted): shaky standing collects LATER in the rotation. Non-monetary,
  matches real chama practice (newcomers collect last), and self-securing —
  the last collector has already paid every round before touching the pot, so
  the least-trusted seat is the one that cannot hurt anyone. Standing decides
  WHEN you collect; the pot is sacred.

## Baseline: the traditional chama / tontine (what users already know)

Naming: East Africa "chama"/"merry-go-round", West Africa "tontine",
economists "ROSCA" — one machine. Recognized rules: fixed socially-vetted
membership set at formation (5–30, invitation + vouching); equal fixed
contribution on a fixed weekly/monthly rhythm, due at the (often mandatory)
meeting; each cycle the whole pot pays exactly ONE member; a full cycle ends
when everyone has collected once, then the group re-forms and often reshuffles
order; order agreed upfront (lottery, seniority, negotiation, need) with
newcomers collecting last; no interest, no profit — the value is timing
(forced savings + interest-free lump sum; early collectors are net borrowers,
late collectors net savers); chairperson/treasurer/secretary + written
constitution in formal chamas; fines for lateness and absence; enforcement is
social collateral. Known failure modes: treasurer absconds with the pot, early
collector stops paying, one missed contribution breaks the chain.

The product mapping: escrow replaces the treasurer, the chain replaces the
book, standing replaces the vouch, fill-or-refund replaces the broken chain,
and deadline-agreed-before-first-lock is the constitution. Chama is the circle
users' grandmothers ran, minus every failure story they grew up hearing.

## The collector's exit (Jet + Claude, 2026-09-07)

Premise (Jet): the v2 collector will usually sell for fiat immediately
(Chapsmart in TZ, Tando in KE) and should not have to think about exit fees.
Goal endorsed; mechanism redirected:

- **Never bake fees into the lock at protocol level.** Fees are unknowable at
  lock time (exit day, rate, tier all move), a baked cushion taxes savers to
  subsidize a spend that may never happen (a collector who HOLDS pockets
  everyone's cushion), and computing "what you'll really need in fiat" edges
  into the forbidden fiat-outcome-promise territory. Escrow moves exact sats,
  always. (v1 has no collector at all — this whole section is v2.)
- **Net-pot targeting at creation instead**: the guided create flow offers
  "make the pot NET <round fiat number> after a typical <rail> exit" and
  suggests the grossed-up share (e.g. 10,230 sats instead of 10,000). Priced
  once, at creation, in the open; agreed by all before the first lock; a
  holding collector keeps a slightly fatter pot everyone knowingly signed.
  A transparent term of the circle, not invisible protocol math.
- **The real exit is Chama itself**: "Collect & cash out" prefills a guided
  Exchange SELL with the collector's pot, rails, and saved handles — local
  buyers pay them mobile money directly, frequently at a premium, so the exit
  fee becomes exit premium. Structural flywheel: every circle mints one
  natural, motivated seller into the marketplace every week. The chama is the
  Exchange's liquidity heartbeat, not a feature beside it.

## Addenda (Jet, 2026-09-07, after the exit discussion)

- **Prepaid-fee rails refine net-pot targeting**: where the collector's rail
  has KNOWABLE fees (Chapsmart bundles in TZ prepay the service for a period),
  the creation-time suggestion can price the exit exactly, not just typically.
  TZ is the incubator; elsewhere the suggestion factors "possible fees" into
  the preset share. Still creation-time and transparent — never runtime.
- **Open locks earn placement**: locking voluntarily "in the open" earns the
  reputation that later decides placement in the collection ranking/grid.
  (This is the punctuality-standing gradient doing double duty — standing IS
  the placement input; no second system.)
- **The flywheel, both sides**: every lock needs sats, so circles create
  DAILY buy-side demand on the Exchange, and every collection mints a weekly
  seller — the chama feeds both sides of the market. And as members watch
  sats appreciate week over week, spending them in the Market becomes the
  natural next step: recurring, sat-holding customers are the pitch that
  attracts businesses to sell there. Weekly chama parties, market included.

## Correction (Jet, 2026-09-07): TWO parents, not one

Big Boss Chama remodels BOTH parked satellites, which together sparked the
idea: **Chip In** contributes the money engine (threshold + deadline +
auto-refund = fill-or-refund), and **Stack** contributes the rhythm and the
streak — its weekly-goal + consecutive-periods-hit logic is literally the
cadence and the "clean rounds repair damage" standing mechanic. Reuse both;
rebuild neither.

## Who opens, who collects (Jet's ruling, 2026-09-07, encoded in levels.ts)

Five tiers from COMPLETED circles (refunded rounds count for nothing, cost
nothing): 1 Mgeni (0) · 2 Mwanachama (1) · 3 Mwenyeji (3) · 4 Mzee (6) ·
5 Bosi Mkubwa (12). Coarse levels gate CAPABILITIES; continuous
standingWeight orders COLLECTION — "may you?" vs "when do you?".

- v1 circle creation stays open to EVERYONE — a commitment pool has no
  collector, so it is riskless, and open creation is the ladder itself
  (gating it at level 3 would deadlock the cold start). The gate keeps
  people IN circles building the graph: creation is a graduation, not an
  entry point.
- Opening a ROTATING chama requires level 3 (Mwenyeji): three completed
  circles, in anyone's chamas, all combined.
- WHO COLLECTS FIRST: never the creator by right. Rotation order =
  standingWeight descending (ties: earlier lock, then pubkey — every client
  derives the identical queue). The creator's power is the terms; the queue
  is earned. A joining Mzee rightfully collects before a Mwenyeji creator.
