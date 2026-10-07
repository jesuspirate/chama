# Stack — buckets on one wallet (brief)

Status: BRIEF. Premises for review; no code yet.

> Jet's ruling, 2026-10-07: "Reuse the same wallet and logically
> compartmentalize it instead." Stack comes back, not as a vertical with its
> own money, but as named buckets over the wallet Chama already has.

## Why now, and what we are not copying

Strike announced (2026-10-06) 3.6% on US dollar balances, paid out in sats.
That product needs a partner bank, custody and a license. Chama has none of
them and should not: paying yield, or holding fiat balances for people, is
the operator underwriting something, which `docs/chama-circle-brief.md`
already ruled out ("No price promises. Ever.").

What we take is the habit: put sats somewhere on purpose, on a rhythm, and
watch the Stack grow. Your keys, your sats — the copy the Stack tile always
had.

## The concept

One wallet, several **buckets**. Default set: **Spend**, **Bills**,
**Stack**. A bucket is a label on part of the balance, nothing more. No
bucket holds its own ecash, its own federation, or its own seed.

```
 wallet spendable balance  (the only source of truth)
 ├── Stack     120,000 sats   goal 500,000 · weekly · 4-week streak
 ├── Bills      40,000 sats
 ├── Spend      25,000 sats
 └── Unassigned  6,300 sats   (balance − sum of buckets, never negative)
```

## Laws (do not drift)

1. **The wallet balance is truth; buckets are intent.** Bucket amounts are
   a local allocation that must always sum to ≤ spendable. Unassigned is
   computed, never stored.
2. **Buckets never touch the money path.** Claims, payouts, refunds and
   recovery (`balance-recovery.ts`, `paid-lock-recovery.ts`,
   `rejected-lock-recovery.ts`) ignore buckets entirely. A bucket can never
   block, delay, or redirect a recovery. Fail-closed stays fail-closed.
3. **Shrink deterministically when the balance falls.** If spendable drops
   below the allocated sum (a lock, a send from elsewhere, a federation
   quirk), shrink Unassigned, then Spend, then Bills, then Stack last, and
   say so once in plain words. Never show a bucket total the wallet cannot
   back.
4. **Buckets belong to a wallet, not to an npub.** The device-local browser
   wallet and the native bridge's wallet are separate (AGENTS.md). Buckets
   are keyed by npub + wallet + federation, stored with
   `storage/user-scope`, and are not synced over Nostr in v1. A Nostr
   identity is not a bearer-ecash backup, and bucket labels are not either.
5. **Stack is a guard, not a vault.** Spending from Stack is allowed; it
   asks once ("This takes 20,000 sats from your Stack. Continue?"). We do
   not pretend a label is a lock.
6. **Long-term savings leave the federation.** Fedimint is federated custody
   and the circle brief caps holds at about two weeks for a reason. When
   Stack passes a user-chosen threshold, Chama *offers* to sweep it to the
   user's own on-chain address (peg-out; the native bridge already quotes
   `pegOutFeeSats`). Never automatic. Once swept, those sats are no longer
   in any bucket — the Stack screen shows "moved to your keys" history.
7. **No yield, no fiat balances, no auto-buys executed for the user.**

## How sats move between buckets

- **Incoming** (claims, payouts, Lightning receives) land in Unassigned.
  Optional per-user rule: "put X% of every claim into Stack". Applied
  locally at the moment the balance is observed to grow, recorded in the
  existing `sats-trace` audit trail.
- **Manual move**: drag or "Move sats" between buckets. Pure ledger edit.
- **Spending / locking**: `lockFromBalance` and every send pick a source
  bucket (default Spend, then Unassigned). `canLockFromBalance` is
  unchanged — buckets add a confirmation, never a refusal.
- **Weekly stack nudge**: on the user's cadence, a reminder opens an
  Exchange buy for their weekly amount (reuses the CBP recurrence timer in
  `escrow-engine/cbp-recurrence.ts`). The user completes the buy; arriving
  sats can go straight to Stack.

## What gets reused

| Piece | From | Change |
|---|---|---|
| Spendable balance | Fedimint wallet / native bridge | none |
| Goal, cadence, streak | `src/stack/` | drop the honor-system claims; compute progress from real Stack inflows |
| Weekly rhythm | Circles, CBP recurrence | reuse timer, no new scheduler |
| Audit of why sats moved | `payments/sats-trace.ts` | add a `bucket` source |
| Peg-out to own keys | native bridge peg-out | browser-wallet path to confirm |
| Create tile | `CreateForm.tsx:158` (commented) | not a vertical anymore — Stack lives on Me, next to the balance |

## UI

- **Me** shows the balance split into buckets with one bar; tap a bucket to
  move sats or set its goal.
- **Stack** card: progress to goal, streak, "move to your keys" when over
  threshold.
- Anything worth seeing from every screen (e.g. "Stack ready to move to your
  keys") goes through `decideChamaBarLabel`, below `stranded`, per the
  chama-bar skill. No new banners.
- Streaks are private. They are never shown next to a person in a trade
  (proof-of-conduct: reputation is verifiable conduct only, and a savings
  streak is self-custody, not conduct toward anyone).

## Phased plan

1. **Ledger** — pure `src/stack/buckets.ts`: allocate, move, shrink-on-drop,
   unassigned; regression tests for every law above.
2. **Me screen** — bucket split, move sats, goals. Spend confirmation on
   Stack.
3. **Inflow rule + weekly nudge** — % of claims to Stack; CBP-timer
   reminder into an Exchange buy.
4. **Move to your keys** — peg-out offer above threshold, native first.

## Open questions

1. Default shrink order: is Bills more sacred than Stack?
2. Browser-wallet peg-out: available today, or native only for v1?
3. Should a bucket ever sync to a second device holding the same wallet
   (native bridge restore), or does restore start with one Unassigned pile?
