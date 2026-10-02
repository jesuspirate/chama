NIP-XX
======

Three-party escrow
------------------

`draft` `optional`

> Chama draft, 2026-10-02. Not submitted. Written from the reference
> implementation in `src/escrow-engine/` (Chama 6.4.17). Where this draft
> deliberately differs from what Chama ships today, a **Migration** note
> says so. Kind numbers are proposals: 8100–8117 were unassigned in the
> NIPs registry on 2026-10-02.

This NIP defines a public, replayable protocol for a two-party trade held in
escrow with a third party, the arbiter, who only decides when the two
principals disagree. Any client can create, join, fund, vote on and settle an
escrow, and any client can independently compute its current state from the
signed events alone. No server holds the money or decides the outcome.

The protocol separates three things that are often merged:

1. **Agreement** — signed Nostr events: who the parties are, the terms, the
   votes. Defined here.
2. **Custody** — where the money sits while locked. Defined by a *money
   module*. This NIP defines two: Fedimint ecash with Shamir shares, and a
   Bitcoin Taproot output.
3. **Settlement** — moving the money to the winner. Done by the money module,
   and only after the agreement says who won.

## Roles and outcomes

Every escrow has exactly three roles:

- `buyer`
- `seller`
- `arbiter`

The **locker** is the role that funds the escrow. The other principal is the
**non-locker**. Which principal locks depends on the `category` (below).

There are exactly two outcomes:

- `release` — the money goes to the non-locker (they performed).
- `refund` — the money goes back to the locker.

An outcome is decided when **two of the three roles vote for it**. The arbiter
may vote only under the timing rules in [Arbitration](#arbitration).

### Categories

`category` fixes who locks and therefore who each outcome pays:

| `category` | Locker | `release` pays | `refund` pays | Typical use |
|---|---|---|---|---|
| `p2p-trade` | seller | buyer | seller | Seller escrows sats, buyer pays fiat off-chain |
| `bill-pay` | seller | buyer | seller | Someone pays a bill for you in exchange for sats |
| `marketplace` | buyer | seller | buyer | Goods, services, digital items |
| `lending` | seller | buyer | seller | Reserved |

Clients MUST derive payees from this table and MUST NOT accept a payout
address or recipient that contradicts it.

## Event kinds

All escrow events are **regular** (non-replaceable) events. A trade's history
must survive relays intact; nothing in it may be replaced.

| Kind | Name | Consensus | Content |
|---|---|---|---|
| `8100` | CREATE | yes | plaintext JSON |
| `8101` | JOIN | yes | plaintext JSON |
| `8102` | LOCK | yes | encrypted envelope |
| `8103` | VOTE | yes | encrypted envelope |
| `8104` | RESOLVE | yes | encrypted envelope |
| `8105` | CLAIM | yes | encrypted envelope |
| `8106` | COMPLETE | yes | plaintext JSON |
| `8107` | CANCEL | yes | plaintext JSON |
| `8108` | CHAT | no | encrypted envelope |
| `8114` | SETTLEMENT | no | encrypted envelope (on-chain module) |
| `8117` | SETTLEMENT_STALLED | yes | encrypted envelope (on-chain module) |

`8109`–`8113` and `8115`–`8116` are reserved for extensions (subscriptions,
tranches, arbiter premiums) that are out of scope for this NIP.

> **Migration.** Chama today publishes these as `38100`–`38117`, in the
> *addressable* range, where a compliant relay keeps only the newest event per
> `(pubkey, kind, d)`. Repeated events by one author in one trade (chat, a
> JOIN followed by an order update) can be silently dropped. Chama's own
> retention probe confirmed this on public relays
> (`docs/escrow-retention-migration-brief.md`). Moving to regular kinds
> `8100`–`8117` (old kind − 30000) is the fix. Readers MUST accept both
> ranges during migration and normalise to one internal kind.

## Tags

| Tag | On | Meaning |
|---|---|---|
| `["d", <escrow-id>]` | every event | Escrow identifier, chosen by the CREATE author. Used for `#d` filtering only; it implies no replacement on regular kinds. |
| `["e", <event-id>, <relay>, "reply"]` | every consensus event except CREATE | The previous consensus event this one builds on. |
| `["p", <pubkey>]` | as needed | Participants the event concerns, for discovery. |
| `["t", <payload type>]` | every event | e.g. `escrow:vote`. Advisory. |
| `["cat", <category>]` | CREATE | For filtering. |
| `["amount", <msats>]` | CREATE | For filtering. |
| `["currency", <ISO 4217>]` | CREATE | If a fiat price is shown. |
| `["mint", <invite or url>]`, `["fed", <federation id>]` | CREATE, ecash module | Federation; see NIP-87. |
| `["a", "30402:<pubkey>:<d>"]` | marketplace CREATE | The NIP-99 listing this escrow offers. |

Escrow ids SHOULD be random and at least 64 bits. Chama uses the `sm_` prefix.

## Encrypted envelopes

Event content that only the trade's parties may read is a JSON envelope:

```json
{ "encryptedFor": { "<pubkey>": "<NIP-44 ciphertext>", "...": "..." } }
```

The author encrypts the same cleartext separately to each recipient with
NIP-44 and adds a `p` tag per recipient. A recipient decrypts their entry
with the author's pubkey. Unless a section says otherwise, recipients are the
buyer, the seller, the arbiter and the author.

A client that cannot decrypt a consensus event it needs MUST treat the trade
as unknown rather than guess.

## Payloads

All payloads carry `type` (`"escrow:<name>"`) and the author's timestamp field.
Unknown fields MUST be ignored unless this NIP or a declared
`settlementPolicy` says otherwise.

### CREATE (`8100`)

Published by the creator. Opens the trade.

```jsonc
{
  "type": "escrow:create",
  "description": "Hand-made leather bag",
  "title": "Leather bag",                       // optional
  "amountMsats": 150000000,
  "fiatAmount": 95, "fiatCurrency": "USD",      // optional, display only
  "category": "marketplace",
  "fulfillment": "physical",                    // physical | service | digital
  "escrowMode": "onchain",                      // ecash | onchain; absent = ecash
  "settlementPolicy": "onchain-full-collateral-single-settlement-v1", // see Versioning
  "expirySeconds": 86400,                       // > 0; listing life, then trade life after LOCK
  "communityArbiters": ["<pubkey>", "..."],     // optional arbiter pool
  "mintUrl": "fed11…",                          // ecash module only
  "createdAt": 1790000000
}
```

The author of CREATE takes the `seller` seat, except in `lending`, where
they take `buyer`. (Chama extensions such as multi-unit purchases also seat
the author as buyer; they are out of scope here.) So in `marketplace` the
seller lists and the buyer locks; in `p2p-trade` the seller lists and locks.

### JOIN (`8101`)

Records a participant before LOCK. Does not change state.

```jsonc
{ "type": "escrow:join", "role": "buyer", "joinedAt": 1790000100,
  "holdExpiresAt": 1790000400,   // optional seat hold
  "escrowXonly": "<hex>"         // on-chain module: this party's escrow key
}
```

A role already seated by someone else is rejected while their hold is live.
An arbiter JOIN, when the CREATE names a pool, MUST come from the pool.

### LOCK (`8102`)

Published by the locker after funding. `CREATED → LOCKED`.

```jsonc
{
  "type": "escrow:lock",
  "buyerPubkey": "<hex>", "arbiterPubkey": "<hex>",
  "sellerReceivesMsats": 148500000, "arbiterFeeMsats": 1500000,
  "lockedAt": 1790000500,
  "substitutionGraceSeconds": 14400,  // optional, clamped to [0, 4h]
  // money module fields: see Money modules
}
```

After LOCK the trade's deadline becomes `lockedAt + expirySeconds`.

### VOTE (`8103`)

```jsonc
{ "type": "escrow:vote", "role": "seller", "outcome": "release",
  "reason": "Delivered 2026-10-09",   // optional
  "votedAt": 1790400000
  // money module fields: see Money modules
}
```

Each pubkey votes at most once. The author MUST hold the role it claims.

### RESOLVE (`8104`)

Published once two roles agree, usually by whichever client notices first;
several identical RESOLVEs are harmless. `LOCKED → APPROVED`, or
`EXPIRED → APPROVED` when healing votes settle an expired trade.

```jsonc
{ "type": "escrow:resolve", "outcome": "release",
  "majority": ["seller", "arbiter"], "arbiterInvolved": true,
  "resolvedAt": 1790450000 }
```

Clients MUST recompute the outcome from the votes and reject a RESOLVE that
disagrees.

### CLAIM (`8105`) and COMPLETE (`8106`)

The winner claims through the money module (`APPROVED → CLAIMED`), then
COMPLETE marks the trade finished (`→ COMPLETED`).

```jsonc
{ "type": "escrow:claim", "claimerRole": "seller",
  "notesHashVerification": "<hex>", "claimedAt": 1790450100 }
{ "type": "escrow:complete", "completedAt": 1790450200 }
```

### CANCEL (`8107`)

Only before LOCK. `CREATED → CANCELLED`.

```jsonc
{ "type": "escrow:cancel", "cancellerRole": "seller",
  "reason": "Sold elsewhere", "cancelledAt": 1790000050 }
```

### CHAT (`8108`)

Not consensus. No `e` tag. Envelope to buyer, seller, arbiter and author.

```jsonc
{ "type": "escrow:chat", "senderRole": "buyer", "message": "Shipped?",
  "attachments": [ { "id": "…", "kind": "image", "mimeType": "image/jpeg",
                     "dataUrl": "data:image/jpeg;base64,…" } ],
  "sentAt": 1790100000 }
```

## State machine

```
CREATED ──LOCK──▶ LOCKED ──RESOLVE──▶ APPROVED ──CLAIM──▶ CLAIMED ──COMPLETE──▶ COMPLETED
   │                 │                   ▲  └───────────COMPLETE────────────────▲
   │                 │ (deadline)        │ RESOLVE (healing)
   │                 ▼                   │
   │              EXPIRED ───────────────┘
   ├──CANCEL──▶ CANCELLED
   └──(deadline, never locked)──▶ EXPIRED
```

`COMPLETED` and `CANCELLED` are terminal. `EXPIRED` is terminal for a trade
that was never locked; a locked trade that expired unresolved still holds
money and can be settled by healing votes (see [Arbitration](#arbitration)).
An event that would cause any other transition is invalid and MUST be
ignored.

### Replay

A client computes state by replaying the trade's consensus events:

1. Fetch every event with the trade's `#d`, from several relays.
2. Verify each signature and parse its payload; drop anything invalid.
3. Order topologically by the `e` tag. Among events that are ready at the
   same time, order by `created_at`, then by kind (CREATE, JOIN, LOCK, VOTE,
   RESOLVE, CLAIM, COMPLETE, CANCEL), then by event id.
4. Apply each event in order. **The first valid event wins**: a later event
   that conflicts with accepted state is rejected, never merged.

Two clients that see the same events MUST compute the same state. Relays are
a source of evidence, never of authority.

## Arbitration

The arbiter is not a co-owner of the trade. They may vote only when:

1. **Two-sided dispute** — buyer and seller have both voted and disagree.
   The assigned arbiter may vote at once.
2. **Silent locker** — the non-locker has voted `release`, the locker has not
   voted, and the escalation time has passed:
   `releaseVoteAt + min(grace, (deadline − releaseVoteAt) / 2)`,
   where `grace` is the LOCK's `substitutionGraceSeconds`, clamped to
   `[0, 4h]`, default 4h.
3. **After the deadline** (healing) — see below.

While the non-locker has a standing `release` vote and the arbiter has not
voted `refund`, the trade is a **performance contest**: the deadline does
**not** refund the locker automatically. This stops a locker from receiving
the goods or fiat, staying silent, and taking the money back at the
deadline.

**Healing.** After the deadline, an unresolved trade can still be settled.
Outside a contest, the only valid healing outcome is `refund`. During a
contest, the arbiter (or a backup, below) rules on the merits.

### Backup arbiters

When the CREATE names a `communityArbiters` pool, clients derive a
deterministic priority order: the assigned arbiter first, then backups picked
from the pool, excluding the principals. A backup may cast the arbiter vote
once `disputeStart + min(grace, (deadline − disputeStart)/2)` has passed. The
assigned arbiter's vote outranks a backup's until the trade is resolved. The
exact pick function is part of this NIP's test vectors.

> **Known gap.** A *locker* whose counterparty goes silent cannot bring in
> the arbiter early; they wait for the deadline. Policies MAY close this
> (the shipped policy below does, after its ship-by date).

## Money modules

A trade's `escrowMode` names its money module. A client MUST refuse to fund
a mode or `settlementPolicy` it does not implement.

### `ecash`: Fedimint with 2-of-3 shares

The locker obtains Fedimint ecash for the amount, splits the note secret into
three Shamir shares (threshold 2), and publishes them in LOCK:

```jsonc
"notesHash": "<sha256 of the notes>",
"sharePolicy": "holder-only-v1",
"shares": [
  { "shareIndex": 0, "encryptedFor": { "<buyer>":   "<nip44>" } },
  { "shareIndex": 1, "encryptedFor": { "<seller>":  "<nip44>" } },
  { "shareIndex": 2, "encryptedFor": { "<arbiter>": "<nip44>" } }
]
```

Under `holder-only-v1` each share is readable only by its holder. A voter
attaches their own share, re-encrypted to the winner of the outcome they
vote for, as `shareEnvelope` on VOTE. The winner combines their share with
one agreeing voter's share and redeems.

**Limits that implementations MUST disclose to users:** ecash is a bearer
instrument issued by a federation. The locker saw the whole note before
splitting it, and any two share holders can redeem together. Federation
guardians, note custody and collusion remain trust assumptions.

### `onchain`: Bitcoin Taproot output

The parties' escrow keys (`escrowXonly` from JOIN, never their Nostr keys)
define a Taproot output with an unspendable internal key and three script
paths:

- **Cooperative:** buyer + seller.
- **Dispute:** any 2 of 3, after a relative delay (`disputeCsvBlocks`).
- **Refund:** the funder alone, after an absolute height (`refundLockUntil`).

LOCK carries the terms in `onchain` so every client can rebuild the address
and check the funding output itself:

```jsonc
"onchain": { "address": "bc1p…", "buyerXonly": "…", "sellerXonly": "…",
  "arbiterXonly": "…", "funder": "buyer", "refundLockUntil": 870000,
  "disputeCsvBlocks": 144, "network": "mainnet",
  "fundingTxid": "…", "fundingVout": 0, "amountSats": "150000" }
```

Signed transactions travel in SETTLEMENT (`8114`) events. The refund path is
enforced by Bitcoin, not by this NIP's state machine: **after
`refundLockUntil`, the funder can take the money regardless of any vote.**
Policies MUST size every deadline to finish well before it.

## Versioning

`settlementPolicy` names the rules a trade runs under. A client MUST reject
a CREATE whose `settlementPolicy` it does not implement. That rejection is
what makes new rules safe: a client that doesn't know a policy never replays
the trade, so it can never compute a different outcome from one that does.
Chama's current values are `ecash-mutual-slices-v1` and
`onchain-full-collateral-single-settlement-v1`; an absent policy means the
mode's default.

### Profile: shipped goods

`ecash-shipped-v1` and `onchain-shipped-v1` add signed shipping terms,
derive the trade life from them, hold the arbiter back for the buyer's
inspection window, and let the buyer reach the arbiter after a missed
ship-by date. Specified in Chama's `docs/shipping-escrow-spec.md`; to be
split into its own NIP.

## Interoperability

- **NIP-99 classified listings.** A marketplace CREATE links to its `30402`
  listing with an `a` tag. A marketplace client can show "Buy with escrow"
  on any listing that has a matching CREATE.
- **NIP-69 peer-to-peer orders.** A `p2p-trade` CREATE can be offered as a
  `38383` order, so order-book clients can display it.
- **NIP-87 Fedimint announcements.** Clients can show which federation backs
  an ecash escrow.
- **NIP-89 app handlers.** Clients that don't implement this NIP can offer
  "open in" a handler for kinds `8100`–`8117`.
- **NIP-17 direct messages.** A "propose escrow" message can carry a link to
  a CREATE so the recipient can join from their own client.

## Security considerations

- Votes, shares and settlement data are encrypted, but event timing, kinds
  and `p` tags reveal who trades with whom.
- A relay can withhold events. Clients SHOULD query several relays and keep
  their own copy of every event of trades they take part in.
- An arbiter colluding with one principal can always decide a dispute. This
  NIP limits *when* an arbiter may act, not *whether* they are honest; public
  conduct records are the deterrent.
- Event `created_at` is self-asserted. Timing rules clamp anchors to the
  trade's deadline so a future-dated vote cannot freeze a trade.
- A money operation may succeed even when its confirmation is lost. Clients
  MUST NOT treat an error as proof that no money moved.

## Out of scope

Menus and multi-unit storefronts, tranche plans, subscriptions, savings
circles, arbiter rosters and bonds, ratings and arbiter premiums. Chama
implements these as extensions; each needs its own NIP.

## Test vectors

To be published with Chama's reducer tests: a set of signed event chains and
the state each must replay to, including the contest, healing and backup
arbiter cases.
