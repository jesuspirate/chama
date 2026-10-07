# Stack — named stacks on one wallet (brief)

Status: BRIEF. Premises for review; no code yet.

> Jet's ruling, 2026-10-07: "Reuse the same wallet and logically
> compartmentalize it instead." Stack comes back, not as a vertical with its
> own money, but as named stacks over the wallet Chama already has.

## Why now, and what we are and are not copying

Strike launched **Stacks** on 2026-10-07: up to five named buckets of
bitcoin inside one account, each with its own goal and its own recurring
buy schedule. Moving between a stack and the main balance is free and
unlimited; sending bitcoin out of Strike has to go back through the main
balance first. The same day Strike also launched 3.6% interest on cash,
paid in sats.

The Stacks shape fits Chama almost one to one, and it is what Jet ruled.
What differs is custody: Strike holds the bitcoin. Chama's version keeps
the sats in the user's own wallet and offers to move a grown stack to keys
the user holds. The interest product is not copied: paying yield, or
holding fiat balances for people, is the operator underwriting something,
which `docs/chama-circle-brief.md` already ruled out ("No price promises.
Ever."). Strike runs the recurring buys itself; Chama does not buy for
anyone, so a schedule here is a reminder into a buy the user makes.

## The concept

One wallet, a **Main** balance and up to five **stacks** the user names
("House", "Rainy day", "School fees"). A stack is a label on part of the
balance, nothing more. No stack holds its own ecash, its own federation,
or its own seed.

```
 wallet spendable balance  (the only source of truth)
 ├── House        120,000 sats   goal 500,000 · weekly · 4-week streak
 ├── School fees   40,000 sats   goal 150,000 · monthly
 └── Main          31,300 sats   (balance − sum of stacks, never negative)
```

## Laws (do not drift)

1. **The wallet balance is truth; stacks are intent.** Stack amounts are a
   local allocation that must always sum to ≤ spendable. Main is computed,
   never stored.
2. **Stacks never touch the money path.** Claims, payouts, refunds and
   recovery (`balance-recovery.ts`, `paid-lock-recovery.ts`,
   `rejected-lock-recovery.ts`) ignore stacks entirely. A stack can never
   block, delay, or redirect a recovery. Fail-closed stays fail-closed.
3. **Shrink deterministically when the balance falls.** If spendable drops
   below the allocated sum (a send from elsewhere, a federation quirk),
   shrink stacks in a fixed order (open question 1) and say so once in
   plain words. Never show a stack total the wallet cannot back.
4. **Stacks belong to a wallet, not to an npub.** The device-local browser
   wallet and the native bridge's wallet are separate (AGENTS.md). Stacks
   are keyed by npub + wallet + federation, stored with
   `storage/user-scope`, and are not synced over Nostr in v1. A Nostr
   identity is not a bearer-ecash backup, and stack labels are not either.
5. **Sats leave from Main, as on Strike.** Locks and sends draw from Main.
   If Main is short, Chama offers to move the difference from a stack
   first ("Move 20,000 sats from House to pay this?"), free and instant.
   A stack is a guard, not a vault: we never pretend a label is a lock.
6. **Long-term savings leave the federation.** Fedimint is federated custody
   and the circle brief caps holds at about two weeks for a reason. When a
   stack passes a user-chosen threshold, Chama *offers* to sweep it to the
   user's own on-chain address (peg-out; the native bridge already quotes
   `pegOutFeeSats`). Never automatic. Swept sats leave the stack; its card
   keeps a "moved to your keys" history and the goal can count them.
7. **No yield, no fiat balances, no buys executed for the user.**

## How sats move

- **Incoming** (claims, payouts, Lightning receives) land in Main.
  Optional per-stack rule: "put X% of every claim into House". Applied
  locally when the balance is observed to grow, recorded in the existing
  `sats-trace` audit trail.
- **Manual move**: "Move sats" between Main and a stack. Pure ledger edit,
  no fee, no limit.
- **Spending / locking**: from Main (law 5). `canLockFromBalance` is
  unchanged — stacks add an offer to move sats, never a refusal.
- **Per-stack schedule** (Strike's recurring buy, without Chama buying):
  each stack can have a weekly or monthly amount. On that cadence a
  reminder opens an Exchange buy for it (reuses the CBP recurrence timer in
  `escrow-engine/cbp-recurrence.ts`). The user completes the buy with a
  person; arriving sats go straight to that stack.

## What gets reused

| Piece | From | Change |
|---|---|---|
| Spendable balance | Fedimint wallet / native bridge | none |
| Goal, cadence, streak | `src/stack/` | drop the honor-system claims; compute progress from real stack inflows |
| Schedule rhythm | Circles, CBP recurrence | reuse timer, no new scheduler |
| Audit of why sats moved | `payments/sats-trace.ts` | add a `stack` source |
| Peg-out to own keys | native bridge peg-out | browser-wallet path to confirm |
| Create tile | `CreateForm.tsx:158` (commented) | not a vertical anymore — stacks live on Me, next to the balance |

## UI

- **Me** shows the balance split into Main and stacks with one bar; tap a
  stack to move sats or set its goal and schedule.
- **Stack card**: progress to goal, streak, "move to your keys" when over
  threshold.
- Anything worth seeing from every screen (e.g. "House is ready to move to
  your keys") goes through `decideChamaBarLabel`, below `stranded`, per
  the chama-bar skill. No new banners.
- Streaks are private. They are never shown next to a person in a trade
  (proof-of-conduct: reputation is verifiable conduct only, and a savings
  streak is self-custody, not conduct toward anyone).

## Phased plan

1. **Ledger** — pure `src/stack/ledger.ts`: create (max five), rename,
   move, shrink-on-drop, Main; regression tests for every law above.
2. **Me screen** — split, move sats, goals, the move-from-a-stack offer
   when Main is short.
3. **Schedules + inflow rule** — per-stack cadence reminder into an
   Exchange buy; % of claims to a stack.
4. **Move to your keys** — peg-out offer above threshold, native first.

## Open questions

1. Shrink order when the wallet drops on its own: most recently filled
   stack first, or let the user rank them?
2. Browser-wallet peg-out: available today, or native only for v1?
3. Should stacks follow a native-bridge restore to a second device, or
   does restore start with everything in Main?
