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
