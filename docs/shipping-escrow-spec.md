# Shipped goods escrow — v1 spec (for maintainer review)

Status: SPEC, NOT IMPLEMENTED. Money-path change. Implement against this
document only after the decisions marked **DECIDE** are locked, then
adversarial verification before wiring. Builds on
`docs/shipping-escrow-brief.md`, which explains the idea; this document says
exactly what changes.

Every claim about current behaviour below cites the code it was read from.

## 0. What already exists

Most of the flow is already in the engine. The spec adds terms, timing rules
and a watcher around it.

| Need | Already there | Where |
|---|---|---|
| Buyer funds, seller is paid on RELEASE | `marketplace` category: buyer locks, SELLER wins release, buyer wins refund | `src/escrow-engine/recipients.ts` |
| "This item ships" | `fulfillment: "physical"`, shown as *Shipping* in the create form | `CreatePayload.fulfillment` (`types.ts`), `CreateForm.tsx` |
| Physical goods are never sliced | Slice chooser excluded for physical marketplace | `LiveTradeSurface.tsx` (`sliceEligible`) |
| Silent buyer can't win by default | `isPerformanceContest` suppresses the expiry refund while the seller has a standing RELEASE | `arbiter-substitution.ts` |
| Arbiter can rule against a silent buyer | `oneSidedEscalationAt` opens the arbiter's window over a lone seller RELEASE | `arbiter-substitution.ts`, gate in `state-machine.ts` (`ARBITER_TOO_EARLY`) |
| Absent arbiter | Backups by deterministic priority; post-expiry "healing" votes, on merit during a contest | `arbiter-substitution.ts`, `state-machine.ts` |
| Buyer told when the seller votes | "vote" notification to the other party | `notifications/trade-notifications.ts` |
| Encrypted messages and photos | Trade chat, enveloped to buyer + seller + arbiter, with image attachments | `escrow-client.ts` `sendChat` |
| Longer trades are consensus-safe | The only consensus rule on expiry is `expirySeconds > 0` | `trade-durations.ts` header |
| Clean protocol versioning | A non-default `settlementPolicy` is rejected by today's reducer | `slice-policy.ts` `settlementPolicyMatchesMode`, `state-machine.ts` `SETTLEMENT_POLICY_MODE_MISMATCH` |

## 1. Problems with today's rules for shipping

These are why shipping can't simply reuse a marketplace trade.

1. **Trade life is far too short.** Default `expirySeconds` is 24h
   (`escrow-client.ts` `defaultExpirySeconds: 86_400`); the proposed
   marketplace cap in `trade-durations.ts` is 3 days. Shipping plus
   inspection takes one to three weeks.
2. **Inspection is at most 4 hours.** After the seller's lone RELEASE, the
   assigned arbiter may rule at `releaseVoteAt + min(grace ≤ 4h, half the
   remaining life)` (`oneSidedEscalationAt`). A buyer who doesn't open the app
   within 4 hours of the seller saying "delivered" can lose the dispute
   window. Shipping needs days.
3. **The seller can vote RELEASE before shipping anything.** The reducer
   can't know about delivery, so a premature RELEASE starts the clock in (2).
4. **A seller who never ships keeps the buyer waiting until expiry.** A lone
   *buyer* REFUND does not open the arbiter's window (`oneSidedReleaseAnchor`
   only handles the non-locker's RELEASE outside chama policies). With a
   three-week trade life, that is three weeks of waiting for an obvious
   refund.
5. **On-chain: Bitcoin's refund timer overrides the app.** The REFUND leaf
   matures at `tip + REFUND_CLTV_BLOCKS` (30 × 144 blocks, about 30 days)
   from funding (`useEscrow.ts`, `onchain-escrow.ts`). After that the buyer
   can spend alone, whatever `isPerformanceContest` says. Everything —
   shipping, inspection, disputes, returns — must finish before it.
6. **Trade chat reaches the arbiter.** `sendChat` envelopes to buyer, seller
   and arbiter. A home address typed into chat goes to the arbiter too.

## 2. Protocol: a new settlement policy

Shipped trades carry a new signed `settlementPolicy` value:

- `"ecash-shipped-v1"` on the ecash rail
- `"onchain-shipped-v1"` on the on-chain rail

**Why a new policy value:** today's reducer rejects any non-default policy
(`SETTLEMENT_POLICY_MODE_MISMATCH`). So clients that don't know shipped
trades drop the CREATE and never replay the chain. They cannot compute a
different outcome from new clients, which is the fork we must never allow
on a money path. The cost: users on old versions can't take shipped
listings until they update.

> **Verify before build:** the `30402` NIP-99 listing may still render on old
> clients. Confirm they show it as unavailable rather than offering a JOIN
> that their own reducer would then reject.

A shipped CREATE must also have `category: "marketplace"` and
`fulfillment: "physical"`; anything else is rejected
(`SHIPPED_POLICY_REQUIRES_PHYSICAL_MARKETPLACE`).

### 2.1 Signed shipping terms

New optional CREATE field, required when the policy is shipped:

```ts
shipping: {
  shipBySeconds: number;      // after LOCK, seller must hand over tracking
  maxTransitSeconds: number;  // longest transit the listing allows
  inspectionSeconds: number;  // buyer's window after delivery
  costIncluded: true;         // v1: shipping is inside amountMsats
  shipsTo?: string[];         // ISO alpha-2; display and filtering only
}
```

Parser: all numbers finite integers > 0; `costIncluded` must be `true` in v1
(separate shipping payment is out of scope). Reducer stores it on state.

### 2.2 Trade life is derived, not chosen

For a shipped CREATE the reducer requires:

```
expirySeconds == shipBySeconds + maxTransitSeconds + inspectionSeconds + ARBITER_MARGIN
```

with `ARBITER_MARGIN = 2 days`. Rejected otherwise
(`SHIPPED_EXPIRY_MISMATCH`). One clock, derived from the terms, so no client
can stamp a life that silently shortens the buyer's inspection.

Creation-side bounds (`trade-durations.ts`, not consensus):

| Term | Min | Default | Max |
|---|---|---|---|
| Ship by | 1 day | 3 days | 5 days |
| Max transit | 2 days | 10 days | 12 days |
| Inspection | 2 days | 3 days | 7 days |
| **Total life** | | **18 days** | **21 days** |

**On-chain horizon rule (consensus for `onchain-shipped-v1`):** total life
must be ≤ 21 days. The refund leaf matures about 30 days after funding, but
blocks run fast as often as slow; 21 days plus a dispute and possible
`DISPUTE_CSV_BLOCKS` delay leaves roughly a week of margin. The comment on
`REFUND_CLTV_BLOCKS` ("must comfortably exceed the longest trade life
(Marketplace 3d)") must be updated to name 21 days.

> **Known coupling:** `expirySeconds` is also the pre-lock listing life
> (`listingExpiresAt = create + expirySeconds`, `state-machine.ts`). A shipped
> listing would stay open up to 21 days before someone buys. Check that
> listing renewal (`listing-renewal.ts`) and Browse treat this sensibly before
> build.

### 2.3 Inspection window enforced by the reducer

For shipped policies only, `oneSidedEscalationAt` becomes:

```
releaseVoteAt + min(inspectionSeconds, half the remaining life at releaseVoteAt)
```

instead of `min(grace ≤ 4h, …)`. `substitutionEligibleAt` for a one-sided
contest follows (it already derives from `disputeStartAt` → this value). Two-
sided disputes keep today's ≤ 4h grace: once the buyer has spoken there is
nothing to wait for.

The half-life floor stays: it guarantees the arbiter can act before expiry.
It only bites when the seller votes RELEASE very late; the UI warns the
seller of this.

### 2.4 Missed ship-by: early refund path

For shipped policies only, a lone **buyer REFUND** cast after
`lockedAt + shipBySeconds`, with the seller silent, opens the arbiter's
window at `buyerRefundVoteAt + 4h grace` (same clamp and backup ladder as
today). The arbiter refunds if no tracking was provided by the ship-by
deadline. Without this, a seller who never ships keeps the buyer's sats
locked for the full 18–21 days.

A buyer REFUND cast *before* ship-by passes is a normal one-sided vote: it
opens nothing until the seller votes (two-sided dispute) or expiry.

### 2.5 What does not change

- Release/refund recipients (`recipients.ts`): unchanged.
- Expiry refund suppression during a contest (`isPerformanceContest`):
  unchanged, and now does real work.
- Healing votes after expiry: unchanged.
- Share distribution, holder shares, on-chain scripts: unchanged. The
  shipping policy changes *when* votes are legal, never *who* gets paid or
  how money moves.

## 3. Off-chain rules (client and arbiter policy)

These cannot be consensus, because the reducer cannot see a parcel.

### 3.1 Seller's RELEASE means "delivered"

The seller's client offers RELEASE only once the watcher (section 5) reports
**delivered** for the committed tracking number. Before that, the button
reads "Waiting for delivery". A seller on a modified client can still vote
early; section 3.2 makes that useless.

### 3.2 The arbiter's shipped-goods rule

Written policy every arbiter on shipped trades accepts (published with the
roster, `docs/arbiter-roster-spec.md`):

**Rule RELEASE** on a one-sided contest only if all hold:
1. Tracking was given before `lockedAt + shipBySeconds`.
2. The watcher reported delivered for that tracking number.
3. `inspectionSeconds` have passed **since the delivered report** (not since
   the seller's vote).
4. The buyer has not raised a problem in the trade.

**Rule REFUND** if tracking never arrived by ship-by, or the tracking never
moved, or the delivered report doesn't exist by the end of transit.

**Two-sided dispute** (buyer said REFUND): evidence from both sides
(section 4). A refund for an item that *was* delivered requires return
tracking showing delivery back to the seller.

> On-chain: anything still undecided when the refund leaf matures goes to the
> buyer. Arbiters must rule before then, and the return-shipping requirement
> has to fit inside it. Rule early rather than lose the choice.

### 3.3 Client gates

New clients refuse to *publish* (not just display) an arbiter RELEASE on a
shipped one-sided contest unless rules 1–3 hold from the watcher evidence the
client can see. A deliberate override needs a typed reason posted to the
trade. This protects against careless arbiters; it can't stop a colluding
one, since seller + arbiter is already two of three (same as every Chama
dispute today).

## 4. Data: address, tracking, evidence

All of this travels in encrypted envelopes, never in clear on relays, and
none of it is consensus data.

| Data | From → to | Transport | Notes |
|---|---|---|---|
| Shipping address | buyer → **seller only** | New structured envelope, seller + self | Not trade chat: chat includes the arbiter. Entered after LOCK. |
| Carrier + tracking number | seller → buyer, arbiter | Structured chat message | Arbiter needs it to check delivery. |
| Photos before shipping | seller → buyer, arbiter | Chat image attachments | Item and sealed parcel. |
| Photos of what arrived | buyer → seller, arbiter | Chat image attachments | On dispute. |
| Return tracking | buyer → seller, arbiter | Structured chat message | Required for a refund after delivery. |

Structured messages carry a plain-text fallback (`message`) so older clients
show something readable, plus a typed field the new client renders, e.g.:

```ts
shipment?: { carrier: string; tracking: string; kind: "outbound" | "return" }
```

The address envelope reveals the buyer's home to one key only. A dispute does
not need it: the arbiter judges from tracking and photos.

## 5. Tracking watcher

A small service that turns carrier tracking into evidence. It never holds
money, keys to the escrow, or a vote.

- **Input:** the seller's client registers `{ carrier, tracking, escrowId,
  recipient pubkeys }` after shipping. The watcher learns tracking numbers
  and pubkeys, never names or addresses. The create flow must say so.
- **Source:** a shipping aggregator (EasyPost, Shippo or similar) for one API
  across carriers with webhooks. **DECIDE** which.
- **Output:** signed observations `{ escrowId, tracking, status, carrierTime,
  observedAt }`, status ∈ `accepted | in_transit | out_for_delivery |
  delivered | exception | returned`, encrypted to the registered pubkeys and
  published as a new event kind (proposed **38140**; unused per a scan of
  `src/`).
- **Trust:** the watcher's pubkey is a client constant in v1 (Chama-run),
  later a list. Clients display observations; arbiters cite them. A watcher
  lying is caught by the buyer disputing, and is bounded by the same
  2-of-3 as everything else.
- **Shape:** same deployment pattern as `scripts/vps-webpush-watcher/`.

## 6. What users see

Timeline on the trade screen, for both sides:

**Locked → Shipped → In transit → Delivered → Inspecting (countdown) → Paid**

| Moment | Buyer sees | Seller sees |
|---|---|---|
| After lock | "Add your shipping address" | "Ship by {date}. Waiting for address." |
| Address sent | "Seller has your address" | Address, "Add tracking" |
| Tracking added | Carrier, tracking link, "Ship by met" | "In transit" |
| Delivered | "Inspect your item. Approve, or report a problem by {date}" | "Delivered. Buyer has until {date}." |
| Silent past inspection | "Inspection ended — seller will be paid" | "Inspection ended — arbiter can release" |
| Missed ship-by | "Seller missed the ship date. Ask for a refund." | "Ship date missed" |

Notifications (the existing "vote" notice covers the seller's RELEASE): add
tracking added, delivered, and inspection ends in 24 hours.

## 7. Funding rail

- **On-chain** is the recommended rail: the money is held by a Bitcoin
  script for the whole shipment.
- **Ecash** keeps the buyer trusting the federation for up to three weeks.
  **DECIDE** an ecash cap for shipped trades (proposed: 250,000 sats), above
  which the create form offers on-chain only.

## 8. Out of scope for v1

- Buying shipping labels inside Chama.
- Shipping paid separately from the item.
- Partial refunds (outcomes stay release or refund).
- Automated arbiter (v1 is humans following section 3.2).
- Insurance.
- Multiple parcels per trade.

## 9. Tests to add

Per `AGENTS.md`, money-path changes need regression coverage:

- Old-policy client rejects a shipped CREATE; new client accepts it.
- `SHIPPED_EXPIRY_MISMATCH` and the 21-day on-chain cap.
- Shipped one-sided contest: arbiter RELEASE rejected before
  `releaseVoteAt + inspectionSeconds`, accepted after; half-life floor.
- Non-shipped trades: escalation timing byte-identical to today.
- Missed ship-by: lone buyer REFUND after ship-by opens the arbiter window;
  before ship-by it doesn't.
- Expiry during a shipped contest: no auto-refund; healing votes rule on
  merit.
- Address envelope decryptable by seller only (not arbiter).
- Client gate: arbiter RELEASE refused without delivered evidence.

## 10. Decisions for the maintainer

1. **Old clients excluded** from shipped trades via the new policy value. OK?
2. **Default windows:** ship by 3 days, transit 10, inspection 3, total 18
   (max 21).
3. **Ecash cap** for shipped trades (proposed 250,000 sats).
4. **Return-before-refund** rule for delivered items in disputes.
5. **Watcher operator and aggregator** (Chama-run in v1?).
6. **Event kind 38140** for watcher observations.
