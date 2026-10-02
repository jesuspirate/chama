# Replay hardening: who may write into a trade (brief)

Status: FINDINGS + PLAN. No code changed. Consensus and money-path work:
implement in the order below, each step with its own adversarial review.

## Findings (2026-10-02)

Cold load (`loadEscrowAttempt`, `escrow-client.ts`) fetches every escrow
event with `kinds` + `#d: [escrowId]` and **no `authors` filter**
(`fetchEscrowEvents`, `relay-manager.ts`), decrypts, parses, then runs
`sortEventChain` + `replayEventChain` (`state-machine.ts`). The escrow id is
public (`d` tag on every listing) and anyone can NIP-44-encrypt an envelope
to the parties, so a stranger can craft events that decrypt and parse.

Probed directly against `sortEventChain` + `replayEventChain` with crafted
parsed events. The full `loadEscrow` path (signature check, decrypt) was not
run end to end; reproduce through it first.

### 1. A stray event makes the whole trade fail to load

Baseline p2p-trade chain (CREATE, LOCK, buyer RELEASE, seller RELEASE,
RESOLVE) replays to APPROVED/release. One extra event fails the replay:

| Extra event | Replay result |
|---|---|
| Arbiter VOTE before either principal voted | `ARBITER_TOO_EARLY` |
| Non-participant VOTE claiming buyer | `NOT_PARTICIPANT` |
| Non-participant VOTE claiming arbiter | `NOT_PARTICIPANT` |
| Non-participant CANCEL after RESOLVE | `INVALID_STATE` |

Live clients apply events one by one and reject these, so they're hit on a
fresh device or a reload. The durable-cache repair pass merges the same
events and doesn't help.

### 2. A stranger's backdated CREATE replaces the real listing

`generateEscrowId` makes `sm_<time>_<random>` and nothing binds it to the
creator. `sortEventChain` roots the chain at the earliest-timestamped CREATE,
and the real one is then skipped as `DUPLICATE_CREATE` (benign):

| Events | Replay result |
|---|---|
| Real CREATE (seller S, 100,000 sats) | CREATED, seller S, 100,000 sats |
| + stranger's CREATE, same id, 10 s earlier (seller X, 1 sat) | CREATED, **seller X, 1 sat** |
| + real seller's LOCK | fails `NOT_PARTICIPANT` |

So an unlocked listing loaded by id (trade link, Browse tap) can show the
impostor's terms with the impostor as seller; a locked one fails to load.

**Checked (step 0, below):** Browse and trade links both present the
impostor's state, and a buyer-funded listing reads as open and fundable.

### 3. Two CREATEs under one id can be legitimate

`createNextRotationRound` derives a deterministic round id that **any sealed
circle member** may publish ("deterministic id makes duplicates
impossible"). Concurrent members produce distinct CREATE events (different
authors and signatures) under one `d`. Share escrows use
`shareEscrowId(parent, pubkey, round)`, one author per id.

## Step 0 results (2026-10-02)

`src/escrow-engine/replay-hardening.tests.ts` reproduces every row above
through the real cold-load path: relay REQ, nostr-tools signature
verification, decrypt, parse, sort, replay. Each event is signed by its own
key, and strangers use only public data. The tests pin today's behaviour, so
the assertions marked STEP 1 / STEP 2 are the ones those steps change.

- **Finding 1:** all four rows fail `loadEscrow` with the codes in the table
  (`chain-incomplete`). Plaintext payloads are accepted (decrypt "shape 1"),
  so a stranger doesn't even need to encrypt.
- **Finding 2, unlocked:** the backdated stranger CREATE loads as CREATED
  with the stranger as seller and their amount. A stranger CREATE dated
  *after* the real one is harmless (`DUPLICATE_CREATE`).
- **Finding 2, locked:** fails `NOT_PARTICIPANT` on the real seller's LOCK.
  Fail-closed, as the brief said.
- **Browse is exposed, not only links.** A public CREATE for an unseen id is
  not shown directly: `handleIncomingEvent` queues listing hydration, which
  is `loadEscrow(id)`. So the Browse tile for the real listing's id shows the
  impostor's terms, and there is no second tile to compare against.
- **Severity: a buyer can be invited to fund the impostor.** In
  `marketplace` the buyer locks (`funderRole`). An impostor can copy the
  real title and price and name their own arbiter, holding seller and
  arbiter (2 of 3). The test shows the fresh device presents exactly that as
  an open listing. What stands in the way today is UI only: TradeDetail's
  arbiter provenance check flags an arbiter outside the roster / bonded /
  device-trusted pool, and `requiresVerifiedRosterConsent` turns that into a
  hard consent gate only for fee-bearing trades or amounts of 2,000,000 sats
  and up (`src/arbiters/pool.ts`). A small no-fee trade gets a warning.
  *Inferred, not tested in the UI:* if the impostor instead copies the real
  roster arbiters, the buyer's refund vote with an honest arbiter recovers
  the lock, so the loss is the listing, not the money.
- For `p2p-trade` and `bill-pay` the seller locks, so the impostor would have
  to fund the escrow themselves; the harm there is a hijacked listing and a
  confused buyer, not a theft path.

This raises step 1 from griefing to a money-path fix for buyer-funded
categories. It does not change the order: step 2 alone is still worse.

## Why the order matters

Fixing finding 1 alone (skip events from non-entitled authors) makes
finding 2 worse. With a stranger's CREATE at the root, the real seller's
LOCK becomes a "non-participant" event and would be skipped instead of
failing the replay. The trade would read as an open listing owned by the
impostor, inviting a buyer to fund it. Today's failure is the fail-closed
outcome. So:

1. **Bind a trade to its creator.**
2. **Then** drop invalid events from non-entitled authors.

## Step 1: a trade's identity is (creator pubkey, d)

Same idea as NIP-01 addressable coordinates. Proposed:

- Every place that names a trade carries the creator's pubkey: Browse
  already has it from the listing event; trade links gain it
  (`?trade=sm_…&by=<npub>`); notifications, caches and `#parent` lookups
  carry it.
- `loadEscrow` takes the expected creator and roots replay only at a CREATE
  by that author. Other CREATEs under the same `d` are noted and ignored.
- Old trade links without `by`: if exactly one CREATE exists, use it; if
  several, refuse with a clear "conflicting listings" state rather than
  guess.
- Rotation rounds: the id is deterministic and the author is any sealed
  member, so identity is the round id plus the cycle context. Accept a
  CREATE only from a sealed member of the cycle (the context parser has the
  cycle), and among valid ones pick deterministically (earliest, then id).
  Their payloads are derived from the same cycle, so equivalent.

Needs a decision: whether new escrow ids should also *derive* from the
creator (e.g. include a short hash of the pubkey), which lets the parser
reject a mismatched CREATE without extra context. Cheap for new trades,
can't help old ones.

## Step 2: invalid events are dropped, not fatal

With the root bound, replay classifies each failure:

- **Drop with a note** (matches what a live client does when it rejects the
  same event):
  - any VOTE failure once a LOCK is in the chain;
  - any CANCEL failure;
  - a RESOLVE, CLAIM, LOCK or other funds event whose author is not a party
    the bound CREATE and accepted events have seated (and, for CLAIM after
    resolution, is not the winner).
- **Stay strict** (custody in doubt, or the chain is visibly incomplete):
  - funds events (LOCK, CLAIM, SUBSCRIBE, PERIOD_RELEASE) from an entitled
    author;
  - a RESOLVE from a party that fails its threshold or outcome check (votes
    probably missing: repair from cache);
  - a VOTE with no LOCK in the chain.

Consensus safety: these changes only turn today's failures into skips, so
any chain that replays OK today replays to the identical state. Old clients
keep failing to load griefed trades; they never compute a different state.

## Tests to add (`src/escrow-engine/tests.ts`)

- Each row of finding 1 replays to the baseline state, with a replay note.
- Stranger's backdated CREATE: with the expected creator, replay roots at
  the real CREATE; without it and with two CREATEs, "conflicting listings".
- Real LOCK under a stranger's root is never skipped into an "open listing".
- Rotation round with two members' CREATEs replays identically whichever
  arrives first.
- Outsider LOCK on a locked trade, outsider CLAIM, outsider RESOLVE with a
  wrong outcome: skipped. Winner's failing CLAIM: still strict.
- Every existing replay test unchanged.
