---
name: chama-bar
description: Use the top status bar (ChamaBar, top-right label) as Chama's one always-visible signal. Read before adding any loading indicator, "needs you" state, warning, or status text anywhere in the app.
---

# The bar is the signal

`src/ui/panels/ChamaBar.tsx` renders one label at the top right of every
screen, on every device. `decideChamaBarLabel` in `src/ui/decisions.ts` is
the pure function that chooses it. Jet, 2026-09-26: "always find a smooth
way to reuse that bar for important information, always visible."

## Rule

Before adding a spinner, a banner, a toast, a badge or a status line
anywhere, ask: is this something the person needs to know from any screen?
If yes, it belongs in the bar, through `decideChamaBarLabel`, not in a new
widget. If it only matters on one screen (a button's own busy state, a
field error), keep it local.

## Priority (top wins, one label at a time)

1. `unreachable` — the federation can't be reached. Amber, tap = reconnect.
2. `needs-you` — a trade is waiting on this person: sign, confirm, claim,
   re-post, reply to a dispute. Orange, tap opens the most urgent trade.
   **Every state that stalls a trade until this person acts must count
   here** — on-chain included (deposit to send, payout to sign, key to
   publish). If a trade can be stranded because nobody told the person,
   the bar was wrong.
3. `stranded` — sats recoverable. Amber, tap = recover.
4. `in-trade` — N active trades, sats in escrow. Purple, tap = the trade.
5. `syncing` — the initial trade read from relays is still running
   (`myTradesLoading`). The spinning wordmark dot, small, no text needed
   beyond "Syncing…". Never for background refreshes.
6. `ready` — "Chama: ready". Muted.

A new state slots into this list with a reason; it never sits beside the
bar as a second indicator.

## Copy

One short line, plain words, what it is and what tapping does. Numbers
only when they are true on every device (a count of this person's own
trades is; a count of someone else's disputes is not). No jargon
("PSBT", "Esplora", "relay"): say "payout", "block explorer", "network".
This follows the same rule as the normies-simplification skill; when in
doubt, the simpler sentence wins.

## Tests

`decideChamaBarLabel` is pure: add a case for every new state in
`src/ui/decisions.tests.ts` (or the existing bar suite), including the
priority against its neighbours.
