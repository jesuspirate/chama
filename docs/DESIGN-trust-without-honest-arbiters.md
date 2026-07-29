# Chama without honest arbiters

*A design study against v5.7.0. Written to answer one question: what would have to
be true before I would lock real money into a trade with a stranger, on a client
where the arbiter is a random person who may be trying to rob me?*

This is not a critique of the direction. The v5.7 accountability work — exposure
caps, dual-signed fault attestation, ruling concentration, legible exits — is
better reasoning about arbiter incentives than most escrow products ever do. The
argument here is about **ordering**: those are third-layer mechanisms, and two
lower layers are not yet load-bearing. Fixing an arbiter's incentives does
nothing while a principal can walk away with the pot, and randomising an arbiter
does nothing while the arbiter is chosen by one's counterparty.

---

## 0. The premise I am designing against

> "Something that would make you feel comfortable to trade with anyone, while
> random arbiters have the ability to coerce trades or [lack] the ability to rule
> you fairly."

Taken literally that asks for an escrow that is safe **even when the arbiter is
an adversary**. That is achievable, but only by giving up on the arbiter as a
source of safety. So the thesis of this document:

> **Stop trying to make arbiters trustworthy. Make them structurally unable to
> matter very much.**

Every mechanism below does one of three things: removes the arbiter from the
common path, shrinks what a single adjudication can move, or makes the seat
impossible to choose or predict. Slashing arbiter capital comes *last*, not
first — it is the least feasible lever and the most gameable, and it is the one
the current design has spent the most thought on.

### Threat model

The adversary controls:

- my counterparty;
- one or more members of the arbiter pool (identity is free; bonds return to
  their owner regardless of conduct);
- a modified client — nothing client-side is a constraint on them;
- the escrow id and the content of every event they author;
- time, and the willingness to lose reputation on a key they will discard.

The adversary cannot break NIP-44, Schnorr, the federation's threshold, or
Bitcoin consensus.

The property I want: **my maximum loss is bounded by something I chose, not by
someone else's honesty.**

---

## 1. What v5.7 actually guarantees today

Three findings, in descending order of importance. The first is the one that
matters; the arbiter questions are downstream of it.

### 1.1 The party who funds an escrow can take the money back

The lock flow is: spend Fedimint ecash out-of-band → receive the raw OOB note
string → SHA-256 it → Shamir-split *that string* 2-of-3 → NIP-44 encrypt one
share each to buyer, seller, arbiter → publish LOCK
(`src/fedimint/escrow-bridge.ts:339-430`, `lockAndPublishInner`;
`src/fedimint/fedimint-client.ts:1157-1230`, `spendNotesForLock`).

Fedimint OOB notes are **bearer tokens**. The funder minted them, so the funder
holds the full note bytes. Shamir-splitting a bearer token after you already
have it does not take it away from you. Any of:

- reissuing the retained notes into a fresh set,
- letting the client-side `try_cancel_after` horizon fire,

recovers the entire pot unilaterally, and the winner's later claim fails as
already-spent. The repo documents the second path itself:

> "fedimint OOB spends carry a CLIENT-SIDE auto-cancel: after this window the
> spender's own client refunds the notes to itself."
> — `src/fedimint/fedimint-client.ts:214-225`

So the comment three files away —

> "After this, the money is in escrow — no one can move it alone."
> — `src/fedimint/escrow-bridge.ts:417`

— is true of the arbiter and true of the counterparty, and **false of the
funder**. The 2-of-3 is real cryptography protecting everyone except the one
person it needs to bind. What actually stops the funder walking is that the
shipped client does not offer the button.

There is a second, simpler statement of the same fact that needs no Fedimint
semantics at all: **the locker performs the split and encrypts every share**, so
the locker transiently holds all three plaintext shares. The escrow engine says
so where it decrypts them —

> "LOCK shares were encrypted by the locker → decrypt with locker = sender."
> — `src/escrow-engine/escrow-client.ts:1355`

A 2-of-3 whose dealer keeps all three shares is 1-of-1 for the dealer.

This is not a coding defect. It is a property of *Shamir-over-bearer-ecash*: the
construction cannot escrow value against the party who originated the token. No
amount of arbiter reform touches it. It is rule zero.

**Consequence for the product — and it is not abstract.** The locker is the sats
side of every trade, and per `payoutRecipientFor`
(`src/escrow-engine/recipients.ts:20-26`) that is:

| Category | Who locks | Who performs off-platform | Who can walk |
| --- | --- | --- | --- |
| p2p-trade | seller | buyer (sends fiat) | seller |
| bill-pay | seller | buyer (pays the bill) | seller |
| marketplace | buyer | seller (ships goods) | buyer |
| lending | seller (lender) | buyer (repays) | seller |

In every category the funder is the party who **receives the counterparty's
irreversible performance first**. Motive and capability are held by the same
person. Worse, on the p2p-trade path the two outcomes are RELEASE → buyer and
REFUND → seller, so once the seller has drained the notes there is no vote
combination — no arbiter ruling, no unanimous panel — that returns anything to
the buyer who already sent fiat. The arbiter is irrelevant to the largest loss
scenario in the system.

So the signal `LOCKED`, today, is a statement of intent, not of custody.

### 1.2 The trade creator can choose their own arbiter

`generateEscrowId()` returns a client-chosen string, `sm_<base36 ts>_<random>`
(`src/escrow-engine/escrow-client.ts:3348-3356`). `pickArbiterFromPool` reduces
it with

```ts
for (let i = 0; i < escrowId.length; i++) hash = (hash + escrowId.charCodeAt(i)) | 0;
const idx = Math.abs(hash) % candidates.length;
```

— `src/arbiters/pool.ts:432-437`

That is a checksum, not a hash, over a string the CREATE author freely picks. To
seat a chosen confederate the author regenerates ids in a loop: expected tries ≈
pool size, wall-clock ≈ nothing. `pickPreferredArbiter`
(`src/arbiters/pool.ts:449-462`) inherits the property inside the bonded subset.

The reducer's front-running defence recomputes the same function and rejects any
pool member who is *not* the computed pick
(`src/escrow-engine/state-machine.ts:540-560`). It defends the wrong direction:
it stops a third party stealing the seat, and in doing so **certifies the
grind**. The LOCK-side gate is explicitly not enforced
(`src/escrow-engine/state-machine.ts:690-697`).

Combined with 2-of-3 — arbiter plus one principal moves 100% of the pot — a
malicious creator with a single confederate in the pool can rob every
counterparty, while the UI presents the seating as neutral and deterministic.
"Random arbiter" is, today, "counterparty-selected arbiter."

### 1.3 The arbiter share is copied three times, and the bond is not collateral

`ARBITER_POOL_SHARE_CAP = 3` — the assigned arbiter plus two backups each hold a
**copy** of arbiter share index 2
(`src/escrow-engine/arbiter-substitution.ts:29-33`). Availability was bought by
tripling the collusion surface: an attacker needs to corrupt any *one* of three,
not the one who was seated.

And the bond is a Taproot CLTV leaf paying the arbiter's own key
(`<T> CLTV DROP <ownerXonly> CHECKSIG`,
`src/bond-multisig/commitment-bond.ts:1-30`). It always returns. The repo is
candid about this:

> "This pays nobody and seizes nothing — the bond still returns to its owner at
> term end."
> — `src/arbiters/arbiter-fault.ts:14-16`

So the cost of cheating is the *carry* on locked capital for the rest of the
term, plus a reputation on a key that cost nothing to make. Order of magnitude:
a 1,000,000-sat bond at, say, 8%/yr opportunity cost over a 90-day remaining
term is ~20,000 sats. Stealing one 1,000,000-sat trade pays fifty times that.
The deterrent is not close.

The dual-signed fault attestation (`src/arbiters/arbiter-fault.ts`) requires
**both** principals to sign. In a collusion the winner is the beneficiary and
never signs, so the pair never forms. The repo already states this precisely, in
the header of `arbiter-pattern.ts`:

> "The loser signs; the winner never will, because the winner is the
> beneficiary. So the pair never forms and the attestation never exists."

That is exactly right, and it means the attestation catches incompetence and
two-sided extortion — real things — but is blind by construction to the attack
that costs users money. Ruling-concentration statistics are the honest answer to
that, and they are already computed; they are just not yet allowed to *do*
anything.

---

## 2. Five rules I would write on the wall

1. **No party holds a unilateral exit from a funded escrow.** Until this is
   true, nothing else is escrow. (Violated today — §1.1.)
2. **The seat is bound after the money, never before.** Nobody may know or
   choose who will judge them. (Violated today — §1.2.)
3. **One adjudication never controls more value than the arbiter stands to
   lose.** Loss caps come from arithmetic — tranche size — not from promises.
4. **Every availability failure resolves to refund, never to a third party's
   discretion.** (Largely honoured today; keep it.)
5. **Every privilege is priced.** A privilege that is free to hold is free to
   abuse. Seats, shares, and pool membership are privileges.

Rule 3 is the one that actually answers the original question. You do not become
comfortable trading with strangers because the arbiter is virtuous. You become
comfortable because the worst case is a number you picked in advance.

---

## 3. The ladder, in feasibility order

Each tier is independently shippable and independently valuable. Nothing below
requires a softfork except where stated.

### Tier 0 — corrections to what has already shipped
*Days. No new cryptography. No protocol break.*

**0.1 — Make the seat unpredictable.** Replace the charcode checksum with
SHA-256, and seed it with material from *both* principals:

```
seat = pool[ SHA256(escrowId ‖ lockEventId) mod |pool| ]
```

The seller chooses `escrowId`; the buyer chooses the LOCK event id (its content,
tags and timestamp are theirs). Neither can grind the seat alone. Both grinding
together implies both are colluding, in which case there is no victim. Ship it
under the repo's existing accept-either-basis doctrine so mixed-version replay
cannot diverge — that pattern is already written down in the
`ARBITER_NOT_ASSIGNED` comment and is exactly the right tool.

Cost: one consensus-visible change, gated behind version acceptance. This is a
few hours of work and it removes the single most exploitable property in the
system.

**0.2 — Stop copying the arbiter share.** Nest the Shamir: split arbiter share
`S₂` again, 2-of-3, across the drawn panel `{A₀, A₁, A₂}`. Now the pot needs one
principal **plus two of three panelists**. Collusion cost triples; the
availability story becomes "two of three respond," which is what the liveness
signal (`src/arbiters/liveness-coordinator.ts`) and the paid premium
(`src/arbiters/arbiter-premium.ts`) exist to buy. Expiry-refund healing remains
the backstop, so an unresponsive panel still cannot strand anyone.

Scale the panel with the amount: 1-of-1 below the unbonded floor, 2-of-3 above
it, 3-of-5 at Gold. This makes `exposureTier` mean something operational instead
of decorative.

**0.3 — Let ruling concentration bite.** `src/arbiters/arbiter-pattern.ts` already
computes each arbiter's top-beneficiary share. Promote it from display to a
**soft assignment gate**: skip an arbiter whose top-beneficiary share exceeds a
threshold over at least N rulings, using the same never-empty fallback as
`assignablePool`. Descriptive statistics that nobody acts on are a very expensive
way to be right.

**0.4 — Turn on the dormant work.** `ARBITER_FAULT_READS_ENABLED = false` and
`BONDS_ENFORCED = false` mean two finished, tested subsystems currently do
nothing. Ship the dual-sign flow and flip both. They do not solve collusion, but
they are built and paid for.

**0.5 — Say what the escrow actually guarantees.** While §1.1 stands, the
product should not imply custody it does not have. A concrete label on the trade
screen — *"Your counterparty funded this escrow. Chama cannot prevent them
reclaiming it before you claim; only complete trades with people you are willing
to extend that to"* — is unglamorous and does more for real user safety than any
mechanism in this document, because it stops people taking risks they believe
they are insured against.

I would ship 0.5 **first**, on its own, today.

### Tier 1 — bound the blast radius
*Weeks. Application layer only, no new primitives.*

**1.1 — Tranching.** A trade of amount `A` becomes `N` sequential child escrows
of `A/N`, each with an **independently drawn** panel. Deliver, settle, repeat.
Maximum loss to any single corrupt adjudication — or any single funder walking —
is `A/N`, and the victim stops after the first bad tranche.

This is the highest impact-to-effort item in the document, because the machinery
already exists: the storefront child-purchase pattern (`parent` + carried
`sellerPubkey`, buyer publishes the child CREATE) and the chip-in goal/contribution
model are both N-escrows-under-one-parent constructs. Tranching is an
orchestration layer over primitives that are written, shipped and tested.

Limits, stated honestly: it only applies to divisible value — fiat/BTC exchange,
remittance, recurring bills, lending. A single physical item cannot be tranched,
and for those trades Tier 2 is the only answer. It also multiplies round trips,
so it wants a good "continue" UX, which is exactly what the resumable-order work
already built.

**1.2 — Amount ladder on ratings.** The rating primitive (kind 38123) exists and
is verified against settled escrows; spending it on tiered assignment is deferred
as #73. Cap first-trade exposure with a stranger to the unbonded floor and let it
rise with mutual history. This is not a trust system, it is a rate limiter — but
rate limiting is what makes sybil attacks unprofitable.

**1.3 — Don't hand out the arbiter share until there is a dispute.** Today the
panel receives its shares at LOCK. If the shares are only distributed once a
DISPUTE event exists, the window in which any arbiter can be bribed is the
dispute window, not the whole trade — and combined with 0.1 the panel is
unknowable until then. This is a real change to the share-distribution flow and
needs an offline-safe fallback (pre-encrypt to the drawn panel, publish the
unlock at dispute time), so it is the hardest item in Tier 1.

### Tier 2 — fix rule zero
*Weeks to months. This is the important tier.*

**2.1 — On-chain 2-of-3 Taproot escrow above a size threshold.**

```
keypath : MuSig2(buyer, seller)              — cooperative settle, cheap, private
leaf A  : 2-of-3 {buyer, seller, arbiter}    — dispute
leaf B  : <T> CLTV DROP <buyer> CHECKSIG     — timeout refund to funder
```

Chain-enforced, no bearer copy, no unilateral exit for anybody. The honest
version of what the ecash path currently claims.

Feasibility is much better than it looks, because `src/bond-multisig/` already
contains most of it: Taproot leaf construction and NUMS-internal-key p2tr
(`commitment-bond.ts:98-125`), PSBT construction and signing for script-path
spends (`commitment-bond.ts:293-310`), address validation, fee-rate and dust
handling, an Esplora funding watcher (`fund-watcher.ts`), and a durable
announcement/verification path. The team has already written and shipped the hard
parts against a different output script.

Tradeoffs, plainly: on-chain fees and confirmation latency make this uneconomic
below roughly 100–200k sats, and it gives up ecash privacy. So it is a **tier,
not a replacement** — ecash below the threshold (with §1.1 disclosed and Tier 1
bounding it), chain above. That tiering is coherent, it maps onto a concept the
codebase already has, and it means large trades stop depending on anyone's good
behaviour.

**2.2 — Spike: threshold-keyed ecash notes.** The bearer problem exists because
the funder chooses the note spend key. If Fedimint's mint module will accept a
client-chosen note keypair and verify a Schnorr signature on reissue, then escrow
notes can be issued to a **MuSig2/FROST aggregate over {buyer, seller,
arbiter}** — nobody holds a spending key alone, and 2-of-3 becomes real inside
ecash, with ecash's privacy and fee profile intact.

If it works, it obsoletes 2.1 for most trades and is the best outcome available
to this project. I have **not** verified that Fedimint exposes note keypair
selection, and I am not going to guess: this is a two-week spike against the
mint module and the WASM/native bridge surface, with a binary outcome. It should
be scheduled as a spike precisely because the payoff is large and the
uncertainty is real.

### Tier 3 — make misconduct cost money
*Months. Do this last, and only after Tier 2.*

**3.1 — Appeal to a fresh seat, with finality delay.** A losing party posts a
fee and escalates to a newly drawn panel; latest ruling wins. Corrupting one
random panel stops working, because the attacker must corrupt every successive
draw while the victim only has to be right once.

This requires **settlement finality to be delayed**, which the bearer-ecash path
structurally cannot provide — once two shares meet, the money is gone. On the
Tier 2.1 chain path it is a `CSV` on the arbiter leaf and nothing more. That
dependency is the strongest single argument for doing Tier 2 before Tier 3.

**3.2 — Per-trade performance deposit.** The seated panel posts a deposit `D ≥
tranche`, returned on principal unanimity, forfeited by inaction. Because
forfeiture pays nobody, extortion has no payoff — only spite. Under
red-team review this idea has a specific and serious problem, recorded in §4.

**3.3 — Covenant slashing (CTV / CSFS).** Correct, elegant, and softfork
dependent. Park it; do not let it shape today's architecture.

---

## 4. What I would cut, rename, or stop counting

- **The commitment bond is not collateral.** Keep it — as a sybil cost and a
  liquidity signal it is genuinely useful, and the collusion-impossible
  single-key construction is good work. But *call it what it is*. Naming it a
  bond invites users to size trades against a number that will never pay them.
  "Locked capital, 3-month term" is honest; "bonded arbiter" is not.
- **The dual-signed fault attestation is not the collusion answer** and the repo
  already knows it. Keep it for two-sided misconduct, stop presenting it as the
  accountability story, and promote ruling concentration (§0.3) into that slot.
- **The aggregate exposure cap** bounds *simultaneous* theft, not lifetime
  theft. An arbiter who steals one trade per term, forever, never trips it. It is
  a good capital-management tool and a weak security control; it is also dormant.
- **`ARBITER_POOL_SHARE_CAP = 3`** buys availability with a tripled collusion
  surface. Nested Shamir (§0.2) buys the same availability at the opposite sign.

---

## 5. If I could only do four things

1. **§0.5** — tell users the truth about what LOCKED means. Today.
2. **§0.1** — SHA-256 seeded with both principals' material. This week.
3. **§1.1** — tranching. This quarter. It is the cheapest route to "my worst
   case is a number I chose."
4. **§2.1 / §2.2** — real escrow for large trades: the chain path, or the
   threshold-note spike if it lands. This is the one that changes the answer to
   the original question from *no* to *yes*.

Everything else in this document is worth doing and none of it substitutes for
those four.

---

## 6. The honest summary

The question was whether there is a design that makes it comfortable to trade
with anyone while arbiters may be adversarial. There is, and it does not involve
trusting arbiters at all:

> **Bound every adjudication to a slice you chose (Tier 1), make the slice's
> judge unpredictable and un-chosen (Tier 0), and for anything large enough to
> hurt, hold the value somewhere no single party can reach (Tier 2).**

Under that design the worst a corrupt panel can do is take one tranche, from a
seat they could not have arranged to occupy, on a trade whose size the victim
set. That is not perfect. It is bounded, and bounded is what makes strangers
tradeable.

The current design has been reasoning hard about layer three while layers one
and two are open. That is an ordering problem, not a judgement problem — and
ordering problems are the cheap kind to fix.
