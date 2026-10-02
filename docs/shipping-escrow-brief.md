# Shipped goods — sats locked through delivery and inspection (design brief)

Status: DESIGN BRIEF. Nothing here is implemented. The buildable version,
with the open questions below resolved into proposals, is
`docs/shipping-escrow-spec.md`. Money-path change — same
discipline as `chama-money-path-design.md`: implement against an agreed spec,
then adversarial verification before wiring.

## The idea

A buyer on a marketplace page taps **Buy with escrow**. On that same page they
lock sats. The seller is told at once and adds the tracking number. Both
sides watch one screen: *locked → shipped → in transit → delivered →
inspecting → paid*. The seller is paid when the buyer approves, or when the
item was delivered and the buyer stayed silent through the inspection window.
If the seller never ships, the buyer gets the sats back.

Nobody holds the money. Today's fiat version of this flow (a platform holds
the funds and decides) is what Chama replaces.

## How it maps onto the existing protocol

| Step | Protocol | Exists today? |
|---|---|---|
| Seller lists item, with ship-by date and inspection window | CREATE (38100), NIP-99 `30402` listing | Listing: yes. Shipping terms: **new fields** |
| Buyer commits | JOIN (38101) | Yes |
| Buyer locks sats | LOCK (38102) | Yes (ecash and on-chain) |
| Shipping address to seller | Encrypted envelope / trade chat | Transport yes, address form **new** |
| Tracking number to buyer | Encrypted envelope | **New payload**, existing transport |
| Shipped / in transit / delivered | Watcher-observed carrier status | **New** (see Watcher) |
| Seller claims performance | VOTE RELEASE (38103) by seller | Yes |
| Buyer approves | VOTE RELEASE by buyer → RESOLVE → CLAIM | Yes |
| Buyer disputes | VOTE REFUND by buyer → arbiter decides | Yes |
| Buyer silent after delivery | Arbiter votes with the evidence | Mechanism yes, **rule new** |
| Seller never ships | Expiry refund to the locker (buyer) | Yes |

## The trap: a silent buyer must not win by default

Chama's default at expiry refunds the locker. In shipping the locker is the
buyer, so a buyer who receives the item and simply never votes would get the
sats back. The flow must default to the seller *after proven delivery*,
like every working marketplace does.

The building block exists in `src/escrow-engine/arbiter-substitution.ts`:

- `isPerformanceContest` — when the non-locker (seller) has a standing
  RELEASE vote, the expiry refund to the locker is **suppressed** until an
  arbiter rules REFUND.
- `oneSidedEscalationAt` — opens the arbiter's window over a one-sided
  standing RELEASE.

So the shipping rule is:

1. Seller ships; once the carrier reports **delivered**, the seller votes
   RELEASE. (The UI can prompt this from the watcher's delivered status.)
2. Buyer approves → paid now. Buyer disputes → arbiter adjudicates.
3. Buyer silent past the inspection window → the arbiter, seeing a
   delivered scan and no dispute, votes RELEASE. Seller + arbiter = 2 of 3.
4. Seller never ships by the ship-by date → no seller RELEASE → normal
   expiry refund to the buyer.

### Open questions on the rule

- **Inspection window vs. escalation timing.** `oneSidedEscalationAt` opens
  the arbiter's window at `min(grace ≤ 4h, half the remaining life)` after
  the seller's RELEASE. An inspection window is days. Either the arbiter's
  *policy* waits for the committed inspection window (no reducer change), or
  the listing commits an `inspectionSeconds` term the reducer enforces.
  Backup arbiters (`substitutionEligibleAt`) must follow the same rule.
- **On-chain refund is enforced by Bitcoin, not by the reducer.** The
  Taproot REFUND leaf (`onchain-escrow.ts`, `REFUND_CLTV_BLOCKS` ≈ 30 days)
  lets the funder spend unilaterally after the committed height, whatever
  the app thinks about a performance contest. Seller + arbiter must settle
  *before* that height. Rule: ship-by + max transit + inspection + arbiter
  latency must fit comfortably inside the refund height, and the create
  form must refuse terms that don't.
- **Ecash lock duration.** Shipping keeps ecash locked for days or weeks,
  so the buyer trusts the federation for that whole period. On-chain should
  be the recommended default above a size threshold.
- **Arbiter liveness.** If the seller voted RELEASE and no arbiter ever
  rules, the suppressed refund leaves funds stuck until one does (on-chain:
  until the refund height). The arbiter service needs an availability
  commitment.

## Evidence

"Delivered" proves a box arrived, not what was in it.

- Seller: photo of the item and the sealed package before shipping, plus
  carrier, tracking number and declared weight.
- Buyer, on dispute: photos of what arrived, opened.
- Refund after a dispute should be conditioned on **return shipping with
  tracking**, otherwise a buyer keeps the item and the sats.
- Evidence travels encrypted to the trade participants and the seated
  arbiter only. Never in clear on relays.
- Outcomes feed proof-of-conduct (`.agents/skills/proof-of-conduct`):
  verifiable conduct only, no invented scores.

## Privacy

The shipping address is the most sensitive datum in the whole flow.

- Encrypted to the seller only, entered after LOCK, never in the listing.
- The tracking number is encrypted to buyer, seller and arbiter.
- The watcher service learns tracking numbers. That is a disclosure the user
  must be told about, and it must not learn names or addresses.

## Watcher service (tracking)

Carriers (FedEx, UPS, USPS, DHL…) are data sources, not partners. A
shipping aggregator (EasyPost, Shippo and similar) offers one API for many
carriers plus tracking webhooks.

- Webhooks need an always-on server — the same shape as the existing
  wake/web-push watcher in `scripts/vps-webpush-watcher/`.
- The watcher publishes signed status observations (carrier, status,
  timestamp) that clients display and arbiters cite. It never holds funds or
  keys and never votes.
- This is a natural paid service for integrators.

## Version 1 (smallest useful)

- Listing terms: `shipping: true`, ship-by date, inspection window, who pays
  shipping.
- Seller pastes the tracking number (no label purchase).
- Watcher polls or receives webhooks and publishes status.
- Trade screen timeline: locked → shipped → in transit → delivered →
  inspecting (countdown) → paid.
- Delivered-and-silent rule executed by an arbiter following written policy.
- Create form refuses terms whose windows don't fit inside the refund
  horizon.

Later: label purchase inside the flow, automatic seller prompt on delivered,
an automated arbiter with human escalation, insured shipping.

## Embedding surfaces

The shipping flow reaches other sites through the same surfaces as any
other trade.

| Surface | What a developer does | Where the wallet lives | Status |
|---|---|---|---|
| **Inside Chama** | Nothing — users trade in the app | Chama | Exists (web, Android, desktop) |
| **Hand-off link** | Link to `https://getchama.app/?trade=sm_…` (or a future "create" intent) | Chama, first-party | `?trade=` exists (`src/ui/share-link.ts`); create intent and return URL **new** |
| **Checkout popup** | Open Chama in a popup/redirect, get the result back | Chama, first-party | **New** |
| **Iframe widget** | Drop an `<iframe>` on a page | Risky — see below | **New**; status widget first |
| **SDK** | Use `@chama/escrow-core` in their own UI | Their app | **New**; needs engine extraction |

### Links: prefer https over `chama://`

A custom scheme like `chama://` can be claimed by any installed app (so it
can be hijacked) and does nothing when Chama isn't installed. An https link
(`https://getchama.app/...`) opens the web app everywhere and can be verified
as Chama's on Android (App Links) and desktop. Android today registers no
Chama link handler — only `lightning:` and `bitcoin:` queries. Recommend:
https links as the contract, `chama://` as an optional alias, and a
NIP-89 handler so Nostr clients offer "open in Chama" for escrow events.

### Iframes and wallets don't mix

Browsers partition storage for third-party iframes by top-level site. A
browser ecash wallet inside an iframe on `shop.example` would be a different,
separate wallet from the one on `getchama.app`, and could vanish when the
user clears that site's data. That conflicts with the rule never to strand a
possibly funded wallet. So:

- Iframe: read-only trade status and the timeline. Showing a Lightning
  invoice the buyer pays from any wallet is attractive, but today's
  fund-and-lock path mints ecash into the payer's own wallet before locking
  (`src/payments/fund-and-lock.ts`), so that wallet would sit in partitioned
  storage. Verify before offering funding inside an iframe.
- Anything that holds, locks or claims money: the popup/hand-off flow, where
  Chama runs first-party.
