# Chama without honest arbiters

*A design study against v5.7.0. Written to answer one question: what would have to
be true before I would lock real money into a trade with a stranger, on a client
where the arbiter is a random person who may be trying to rob me?*

This is not a critique of the direction. The v5.7 accountability work — exposure
caps, dual-signed fault attestation, ruling concentration, legible exits — is
better reasoning about arbiter incentives than most escrow products ever do. The
argument here is about **ordering**: those are third-layer mechanisms, and two
lower layers are not yet load-bearing. Fixing an arbiter's incentives does
nothing while a principal can walk away with the pot, and constraining *which*
arbiter is seated does nothing while every arbiter already holds a share.

**Method, and what it cost me.** Three adversarial reviews were run against the
draft of this document. They confirmed §1.1, corrected §1.2 in a way that
invalidated my headline fix, and destroyed one of my proposals outright. The
withdrawn material is kept rather than deleted — §0.5's "what I withdraw", §2.2,
and §4.2 — because the reasons those ideas fail are sharper constraints than the
ideas that survived. Anywhere this document says "I was wrong," that is load
bearing, not throat-clearing.

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

Fedimint OOB notes are **bearer tokens**, and `spend_notes_with_selector` has no
recipient parameter — the spend keys are derived from the spender's own root
secret at issuance. Shamir-splitting a bearer token after you already have it
does not take it away from you.

Chama does clear its own copy on a confirmed LOCK
(`src/fedimint/escrow-bridge.ts:521-524`), so "we delete the stash" is a real
answer to a weaker version of this claim. It is not an answer to this one. The
funder retains the material three independent ways: they can read
`localStorage["chama_pending_native_locks_v1"]` during the spend→publish window,
their Fedimint client DB *must* retain the OOB spend state to back the 90-day
auto-refund, and the wallet seed is theirs — a second client on the same BIP-39
seed reaches the same notes.

The strongest evidence is that **the repo already ships the exploit primitive as
a supported feature**. `reabsorb()` in
`src/fedimint/pending-native-locks.ts:583-639` calls
`deps.redeemNotes(entry.oobNotes)` — bound to `redeemWithRetry` at
`escrow-bridge.ts:356` — a tested code path in which the locker reissues the
exact notes they spent for a lock, back into their own wallet. The only thing
dividing "crash recovery" from "theft" is a client-side `if` on relay state
(`pending-native-locks.ts:543-575`). The stash is also explicitly not cleared by
wallet resets, and says why:

> "Deliberately NOT cleared by wallet resets: the entries reference bearer value
> the federation still honors."
> — `src/fedimint/pending-native-locks.ts:57-62`

So the comment in the neighbouring file —

> "After this, the money is in escrow — no one can move it alone."
> — `src/fedimint/escrow-bridge.ts:417`

— is true of the arbiter and true of the counterparty, and **false of the
funder**. That is not only an internal comment. It ships to users verbatim:

> "The sats are locked in **2-of-3 escrow** — no one can move them alone."
> — `src/i18n/en/trade.ts:356-358`

**And there is no race.** I originally framed this as the funder racing the
winner's claim. That is too generous to the design. Nothing in the codebase ever
checks that the locked notes are still spendable: verification is `hashNotes`,
SHA-256 over the note *string*, which stays valid forever after the notes are
burned; `parseNotes` is a pure local decode with no federation query; and
`verifyClaim` — the natural place for a liveness probe — is both offline and
dead code, never called from `src/ui` or `src/hooks`. Nor could the counterparty
probe if they wanted to: they hold one share and cannot reconstruct the note
string at all.

The consequence is the bad one. The funder can reissue at LOCK+1s. The chain
still marches CREATED → LOCKED → votes → APPROVED, the counterparty ships goods
or sends fiat against a "Sats locked in escrow" badge derived from the LOCK
event alone, and the loss surfaces only at the winner's redeem — after the
off-platform leg is irreversible. The attacker beats no clock, needs no timing,
and pays no fee.

**On `try_cancel`: I had this backwards.** The 90-day
`LOCK_SPEND_TRY_CANCEL_SECS` is the *mitigation*, not a co-equal hole. Fedimint's
defaults are 1 day (browser) and 7 days (native), so before that fix Chama
shipped an escrow that silently refunded itself to the funder inside a week with
no malice required at all. Stretching the horizon past the maximum trade life
(12h Exchange / 3d Marketplace / 7d Lending, `trade-durations.ts:44-54`) was the
right repair. What remains is that the funder's unilateral clawback is deferred,
not removed: a trade that stalls past day 90 — absent arbiter, winner who never
opens the app — still auto-pays the funder. And the lazy version of the attack
needs no tooling whatsoever: fund, let the counterparty deliver, never resolve,
collect on day 90.

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

**Consequence for the product — and it is not abstract.** The locker per category
is pinned by `expectedLocker` in `src/escrow-engine/state-machine.ts:632-647`.
Cross it against who performs the irreversible off-platform leg:

| Category | Who locks | Who performs off-platform | Who can walk |
| --- | --- | --- | --- |
| p2p-trade (Exchange) | seller | buyer (sends fiat) | seller |
| bill-pay | seller | buyer (pays the bill) | seller |
| marketplace | buyer | seller (ships goods) | buyer |
| storefront child purchase | buyer | seller (ships goods) | buyer |
| lending | seller (lender) | buyer (repays later) | seller |
| raw-escrow | anyone | — | the locker |

In every live category except lending, the unilateral-destruction power sits with
**exactly the party that has already collected the counterparty's irreversible
leg**. Motive and capability are the same person. That is the worst possible
assignment, and p2p-trade — the flagship vertical — is the clearest case.

Worse, on the p2p-trade path the two outcomes are RELEASE → buyer and REFUND →
seller, so once the seller has drained the notes there is no vote combination —
no arbiter ruling, no unanimous panel — that returns anything to the buyer who
already sent fiat. **The arbiter is irrelevant to the largest loss scenario in
the system.**

The repo's own threat model reaches for this and stops one step short.
`TradeDetail.tsx:1805-1806` reasons about "the PERFORMER — the non-locker whom
RELEASE pays — is the party a colluding arbiter can rob." It contemplates the
locker colluding with an arbiter *on the votes*. It does not contemplate the
locker acting alone, on the notes, with no arbiter at all.

So the signal `LOCKED`, today, is a statement of intent, not of custody.

### 1.2 The seat is choosable — but the seat is not where the money is

`generateEscrowId()` returns a client-chosen string, `sm_<base36 ts>_<random>`
(`src/escrow-engine/escrow-client.ts:3348-3356`), which reaches the wire as a raw
d-tag with **no format, length, or derivation check anywhere**
(`event-parser.ts:522-532`, `state-machine.ts:323`). `pickArbiterFromPool`
reduces it with

```ts
for (let i = 0; i < escrowId.length; i++) hash = (hash + escrowId.charCodeAt(i)) | 0;
const idx = Math.abs(hash) % candidates.length;
```

— `src/arbiters/pool.ts:432-437`

I called this "grindable." It is weaker than that: because the sum is linear and
the d-tag is unvalidated, appending **one** base36 character shifts the residue
to any value. It is a one-shot algebraic solve, not a search — a one-character
d-tag selects any seat. But this turns out to be the *least* interesting of four
ways to control the seat, and the whole line of attack matters less than I
thought. In order of increasing severity:

**(a) Solve the checksum.** As above. Detectable in principle; costs nothing.

**(b) Reorder the pool.** `classifyArbiterAssignment` unconditionally accepts
`pool[0]` as a valid basis (`pool.ts:524`), the creator controls the order of
`communityArbiters` on the wire, `handleCreate` stores it verbatim
(`state-machine.ts:348`), and there is no `.sort()` anywhere in `pool.ts`.
Meanwhile `classifyArbiterProvenance` compares as a **set** (`pool.ts:390-405`),
so a reordered official trio still reads fully "recognized." Put the confederate
at index 0 and hand-seat them: provenance green, assignment `as-assigned`, no
solving required.

**(c) Forge the `bondedArbiters` stamp.** It is a creator-controlled CREATE field
stored unverified (`state-machine.ts:349`). Stamp a single confederate;
`pickPreferredArbiter` intersects with the pool, gets a set of size one, and
short-circuits at `pool.ts:431` with no hash involved at all. `TradeDetail.tsx:510`
feeds the unverified stamp into the classifier **without comparing it to the
chain-verified bonded set it fetched forty lines earlier** (`:466-469`). The
honest counterparty's own locker client then seats it automatically
(`escrow-bridge.ts:230`) — the attacker need not even be the locker.

**(d) Just hand-seat in LOCK.** Arbiters do not JOIN in the normal flow; the seat
is set in the LOCK payload, and `handleLock` has **no assignment gate at all**
(`state-machine.ts:690-697` says so). The JOIN gate I described as "certifying
the grind" is real, but it is a door next to an open wall.

**And now the part that reframes all of it.** `ARBITER_POOL_SHARE_CAP = 3`, and
the default pool is *exactly three* — `BLF_CABINET_NPUBS`
(`pool.ts:30-38`), handed to every non-hidden registry community and every
user-created community (`pool.ts:216-230`). So `arbiterPriorityOrderFor` returns
**the entire pool** on every trade, and `escrow-bridge.ts:278-296` NIP-44-encrypts
share index 2 to every recipient in that order.

> **Every cabinet member holds a decryptable arbiter share on every pooled trade
> in the system, seated or not.**

A colluding principal plus *any* cabinet member is two distinct shares →
`shamirCombine` → redeem (`fedimint-client.ts:1901-1909`). No seat, no vote, no
RESOLVE, no state machine involvement whatsoever. Controlling the seat buys the
attacker immediate vote priority instead of a ≤4h wait, the arbiter fee, and a
green badge. **It does not buy the money — the money was already reachable.**

That is the correction that matters, and it invalidates the fix I reached for
first: no seat-selection change of any kind alters the theft economics while the
share is pre-issued to everyone.

One more thing found en route, worth fixing on its own: the comment at
`TradeDetail.tsx:4137-4138` claims the Fund moment carries a louder version of
the arbiter check. It does not — `AtomicFundingModal.tsx` contains no arbiter
provenance or assignment logic, and the classifier is passed
`committedArbiter: null` pre-LOCK (`:505-507`), so it *structurally cannot* warn
before funding. The at-risk party's first and only warning arrives after the sats
are locked, and in marketplace and child-purchase flows after they have already
paid.

### 1.3 The bond is not collateral, and none of this is switched on

The bond is a Taproot CLTV leaf paying the arbiter's own key
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

**Two facts that change how §1.3 should be read.** First, the whole
accountability model is dormant: `BONDS_ENFORCED = false` (`exposure.ts:50`),
`ARBITER_FAULT_READS_ENABLED = false` (`arbiter-fault.ts:45`), and the 38130 bond
is "DECLARATION ONLY, UNBACKED" (`bonds.ts:10-16`). Nobody has observed this
model failing, because it has never run. That is an argument for *finishing* it
before replacing it — and against my own instinct to reach for a new mechanism.

Second, the arbiter has essentially no revenue to put at risk. `fees.ts:6-9` says
the 0.5%/1.5% helpers "describe the policy"; the only real money path is the
38113 premium note, which is "Default-ON with a one-uncheck decline"
(`arbiter-premium.ts:8`). **The arbiter's income is a declinable tip.** Any
scheme that asks arbiters to post destructible principal is asking them to stake
capital against a gratuity, and that arithmetic never closes.

---

## 2. Five rules I would write on the wall

1. **No party holds a unilateral exit from a funded escrow.** Until this is
   true, nothing else is escrow. (Violated today — §1.1.)
2. **No single arbiter is ever cryptographically sufficient.** Not "the seat is
   unpredictable" — that is a UI property. What matters is that holding one
   arbiter share plus one principal must not move money. (Violated today — every
   arbiter holds a share on every trade, §1.2.)
3. **One adjudication never controls more value than the arbiter stands to
   lose.** Loss caps come from arithmetic — tranche size — not from promises.
4. **Every availability failure resolves to refund, never to a third party's
   discretion.** (Largely honoured today; keep it.)
5. **Never price a judgement call.** Slash only what is machine-detectable;
   handle everything else with structure. (Honoured today, deliberately — §4.2 is
   the record of me violating it and being argued back.)

Rule 3 is the one that actually answers the original question. You do not become
comfortable trading with strangers because the arbiter is virtuous. You become
comfortable because the worst case is a number you picked in advance.

Rule 2 is the one I got wrong first, and it is worth being precise about why. I
wrote "the seat is bound after the money, never before" — a rule about
*selection*. Selection is a consent-layer nicety. The security property lives in
*share distribution*, and no amount of clever seating fixes a share that was
already handed to everyone.

---

## 3. The ladder, in feasibility order

Each tier is independently shippable and independently valuable. Nothing below
requires a softfork except where stated.

### Tier 0 — corrections to what has already shipped
*Days. No new cryptography. No protocol break.*

**0.1 — Fix the share distribution, not the seat.** This is the only Tier 0 item
that changes who can steal, and it is why my original ordering was wrong.

`ARBITER_POOL_SHARE_CAP = 3` against a three-member pool pre-issues the arbiter
share to every arbiter in the system on every trade (§1.2). Two options, and the
project has to pick one honestly:

- Cap recipients strictly below pool size — `Math.min(CAP, pool.length - 1)` —
  so that being unseated means something; or
- accept the design and **stop describing the seat as a security control** in the
  UI and in comments.

What is not acceptable is the current combination: a seat presented as a
meaningful assignment, over a share every candidate already holds.

The better version, once the pool is larger than three: **nested Shamir**. Split
`S₂` again, 2-of-3, across the drawn panel, so the pot needs one principal plus
two of three panelists and no single arbiter is ever sufficient. That is the only
construction here that makes collusion *harder* rather than more expensive, and
hardness is robust against an attacker with capital in a way that pricing never
is. It needs real work in `holder-shares.ts`, `event-parser.ts`,
`state-machine.ts` and the LOCK/VOTE envelope wire, and it needs the pool to
actually be bigger than the cap — so it is Tier 1 work gated on Tier 0's honesty
fix.

**0.2 — Canonicalise the pool and drop the `pool[0]` basis.** Sort
`communityArbiters` (lowercase hex ascending) *inside `handleCreate`*, exactly as
it already normalises `fulfillment` (`state-machine.ts:314-317`) and
`paymentMethods` (`:334`), so replay neutralises a hostile ordering. Then remove
`pool[0]` as an accepted assignment basis (`pool.ts:524`), or gate it behind a
`createdAt < <cutoff>` era check so genuine old chains still classify cleanly
without granting index 0 a permanent free pass. This closes attack (b) in §1.2
and costs almost nothing.

**0.3 — Verify the `bondedArbiters` stamp at the consent layer.**
`TradeDetail.tsx:466-469` already fetches the chain-verified bonded set, then
never compares it against the creator's stamp before passing that stamp to the
classifier at `:510`. Intersect them and flag a stamp naming a non-bonded key. Do
the same at `escrow-bridge.ts:230` — do not honour an unverified stamp when a
live set is available. The reducer cannot do this without breaking purity, and
that is fine: this is a consent-layer control, which matches the repo's own
doctrine. Closes attack (c).

**0.4 — Warn before the money moves, not after.** Fix the stale comment at
`TradeDetail.tsx:4137-4138` and give `AtomicFundingModal` a real arbiter
provenance/assignment check. A warning that arrives after funding is not a
warning.

**0.5 — Replace the charcode checksum with SHA-256 anyway.** Not because it
fixes the threat — it does not — but because `pool.ts:432-437` has essentially no
avalanche, anagrams collide, and the sum is tunable one character at a time.
`idx = SHA256(escrowId)[0..3] % N` removes the algebraic solve and leaves an
ordinary search. **Bound the rollout by a `createdAt` era check** rather than
adding another entry to accept-either-basis: with a three-member pool the accepted
set is already one-to-two of three, and every additional accepted basis pushes it
toward "the whole pool," at which point `ARBITER_NOT_ASSIGNED` and
`off-assignment` stop discriminating at all.

**What I withdraw here.** My first instinct was
`seat = pool[SHA256(escrowId ‖ lockEventId) mod |pool|]`, on the theory that the
seller picks the escrow id and the buyer picks the LOCK event id so neither can
grind alone. It fails three ways, each fatal:

1. **It is circular.** The LOCK content carries `arbiterPubkey`
   (`escrow-client.ts:1273`) *and* the shares already encrypted to the arbiter
   priority order (`:1260`). The arbiter is an input to the LOCK event id. And
   the JOIN gate runs pre-LOCK, when no LOCK exists.
2. **The premise is false.** Adding hash inputs only removes grindability from
   parties who contribute none. Both principals contribute one, so both grind
   independently and the last committer wins — a Nostr event id costs about three
   SHA-256 attempts to steer, with `created_at` as unlimited free entropy. Worse,
   in the dominant flows there is no split at all: p2p-trade and bill-pay have the
   **seller both create and lock**, and storefront child purchases have the
   **buyer both create and lock**. One party owns both inputs.
3. **It would launder the existing hole.** Today a hand-seat classifies
   `off-assignment` and raises a red banner. Making the seat a function of the
   locker's own event id renders the locker's chosen seat `as-assigned` *by
   construction* — converting a red-flagged attack into a green-badged one. That
   is strictly worse than doing nothing.

If an anti-grind primitive is wanted later, the only shape that survives is
**commit–reveal**: buyer commits `H(r_b)` in JOIN, seller commits `H(r_s)` in
CREATE, both reveal in LOCK, `seed = SHA256(escrowId ‖ r_b ‖ r_s)`. Neither sees
the other's preimage before committing, and it stays pure and replayable. It
needs a reveal-timeout rule with a deterministic fallback plus an
`off-assignment` mark so withholding is visible rather than free. It is still
worth less than 0.1.

**Block-hash entropy: withdrawn entirely.** Reading a block hash inside selection
breaks the reducer's stated contract — `applyEvent` is synchronous and
`replayEventChain` must work offline (`state-machine.ts:1-14`, `:1448-1451`) —
and it installs mempool.space as the silent judge-appointer for high-value
trades, over a plain `fetch` with no header-chain or PoW verification
(`fund-watcher.ts:38-87`). On fetch failure there is no honest answer, so you
either strand the trade or fall back to the grindable path, and the fallback is
what an attacker forces. A 1–2 block reorg would change the seat after the shares
were already encrypted to the old order, making the trade unclaimable. If chain
entropy is ever wanted for auditability, it belongs in the consent layer as an
advisory attestation that never affects replay.

I was right about only one thing there: miner grinding is not the problem.
Withholding a block to bias a 1-in-3 draw costs ~3.1 BTC against a
`HIGH_VALUE_CONSENT_MSATS` threshold of 2,000,000 sats — off by about 150×. The
proposal dies on purity and on the trusted explorer, not on miners.

**0.6 — Let ruling concentration bite.** `src/arbiters/arbiter-pattern.ts` already
computes each arbiter's top-beneficiary share. Promote it from display to a
**soft assignment gate**: skip an arbiter whose top-beneficiary share exceeds a
threshold over at least N rulings, using the same never-empty fallback as
`assignablePool`. Descriptive statistics that nobody acts on are a very expensive
way to be right.

**0.7 — Turn on the dormant work, and weight seating by bond × term × tenure.**
`ARBITER_FAULT_READS_ENABLED = false` and `BONDS_ENFORCED = false` mean two
finished, tested subsystems do nothing today. Ship the dual-sign flow and flip
both.

Then fix what is actually weak about the commitment-bond model. It is not that
the bond returns — it is that **identity is free**, which the repo states plainly
itself. The remedy for free identity is not destructible per-trade capital (§3.4
explains why that fails); it is capital-at-risk-per-identity that *takes time to
accrue*. Make seating priority and per-trade cap a function of
(bond size × remaining term × continuous tenure). A fresh key with a fresh bond
stays assignable — entry remains permissionless — but low-priority and low-cap,
and it takes months to reach large trades. That is costly signalling done
correctly, it is most of the way built already between `exposure.ts` tiers,
`roster.ts` and `bonds.ts`, and it is the baseline any fancier mechanism has to
beat.

**0.8 — Say what the escrow actually guarantees.** While §1.1 stands, the product
should not imply custody it does not have. The claim currently ships as:

> "The sats are locked in **2-of-3 escrow** — no one can move them alone."
> — `src/i18n/en/trade.ts:356-358`

Replace it with something true: *"Your counterparty funded this escrow. Chama
cannot prevent them reclaiming it before you claim; only trade amounts you are
willing to extend on trust."* Unglamorous, and it does more for real user safety
than any mechanism in this document, because it stops people taking risks they
believe they are insured against.

I would ship 0.8 **first**, on its own, today. It is a string change.

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

**It is also the only item here that provides *detection*.** Per §1.1 there is no
probe: `parseNotes` is offline, `verifyClaim` is dead code, and the counterparty
holds one share and cannot reconstruct the note string to test it. A hollowed
escrow is invisible until claim time. Tranching converts that into a signal —
tranche 1's claim either succeeds or does not, *before* the off-platform leg of
tranche 2 — so a total silent loss becomes a bounded, observed one. The critical
design detail is that the at-risk party must be free **not** to fund the next
tranche, and each tranche should draw a fresh arbiter, so an attacker has to
corrupt `N` of them rather than one.

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

**2.2 — Threshold-keyed ecash notes: I proposed this as a spike; the answer is
already no.** The idea was to issue escrow notes to a MuSig2/FROST aggregate over
{buyer, seller, arbiter}, so nobody holds a spending key alone and 2-of-3 becomes
real inside ecash. Adversarial review of the actual API surface closed it:

- Browser SDK mint surface is `spendNotes` / `redeemEcash` /
  `reissueExternalNotes` / `parseNotes` (`src/fedimint/sdk-adapter.ts:59-77`).
- Native bridge exposes `/spend-notes`, `/reissue-notes`, `/parse-notes`
  (`native/fedimint-bridge/.../main.rs:2357-2359`), over
  `MintClientModule::spend_notes_with_selector` and `reissue_external_notes`.
- `spend_notes_with_selector` takes `(selector, amount, try_cancel_after,
  include_invite, extra_meta)`. **There is no recipient parameter.** The emitted
  `OOBNotes` carry `SpendableNote { signature, spend_key }`, and those spend keys
  are derived from the spender's root secret at issuance.

There is no API to mint a note whose spend key you do not know, and no way to
hand over a note's spend key without handing over the note. This is not a Chama
gap — **a 2-of-3-controlled ecash note is not expressible in Fedimint's mint
module.** Delete the spike; do not schedule it.

The two remaining ecash-native routes both have real costs:

- **LNv2 contracts.** `fedimint-lnv2-client` is already registered in the bridge
  module registry and carries genuine federation-side contract primitives —
  incoming/outgoing contracts with `claim_pk`, `refund_pk`, expiration. It is the
  only contract-shaped thing in the dependency tree. It is scoped to Lightning
  payment settlement rather than general escrow, and Chama touches none of it
  today. Worth a scoping pass; not obviously a fit.
- **A custom Fedimint escrow module.** Correct, and blocked by ownership: BLF is
  a Fedi G-Bot federation, so Chama cannot ship a module to the federations its
  users are on. This only becomes available if Chama runs its own federation —
  which is a strategy decision, not an engineering one.

Net effect: **weight moves onto 2.1.** The on-chain path is not the fallback, it
is the path.

### Tier 3 — make misconduct cost money

The governing principle, which I did not have when I started and which the
red-team pass forced out:

> **You can only slash what is machine-detectable. Everything that requires a
> judgement call must be handled by structure, never by money.**

"Was that ruling wrong?" is not machine-decidable. Any mechanism that tries to
price it ends up pricing something else — usually the willingness of a
counterparty to click a button. The existing design already got this right by
keeping `arbiter-fault.ts` testimonial and `arbiter-pattern.ts` descriptive.
That was the correct instinct and I would not overturn it.

**3.1 — Equivocation slashing via nonce reuse.** The one form of arbiter
misconduct that *is* cryptographically detectable: signing two conflicting
rulings. Have the arbiter publish each ruling as a Schnorr signature under a
per-escrow **committed nonce** `R`. Signing two different outcomes under the same
`R` leaks the private key by BIP-340 arithmetic, and the bond becomes spendable
by whoever catches it. No covenant, no oracle, no cabinet, no softfork — just the
key-leak property of nonce reuse.

Scope it honestly: this punishes equivocation, not bad-faith-but-consistent
rulings. That is a narrow target, and narrow is the point — it is the only target
that can be hit without a judge.

**3.2 — Appeal to a fresh seat.** A losing party posts a fee and escalates to a
newly drawn arbiter, excluded from the first arbiter's beneficiary cluster (the
concentration data in `arbiter-pattern.ts` is exactly the exclusion input);
2-of-2 agreement finalizes, disagreement escalates again. This attacks collusion
at the root rather than pricing it — a colluding arbiter cannot deliver a *final*
ruling alone, so the winner cannot buy one.

The catch, and it is decisive for ordering: **on the bearer-ecash path an appeal
window is advisory, not enforced.** The winner needs one counterpart share
re-encrypted to them, which arrives in a VOTE share envelope; a colluding arbiter
simply publishes that envelope immediately and the money moves. Nothing in the
substrate can hold it. The window binds honest clients only. On the Tier 2.1
chain path it is a `CSV` on the arbiter leaf and it is real.

So appeals are a Tier 2 dependant, and on the ecash path the *cryptographic*
version of the same idea is §0.1's nested panel — a corrupt minority cannot
settle at all, which needs no window and no cooperation.

**3.3 — Covenant slashing (CTV / CSFS).** Not activated, and — worth saying
because it is a common roadmap mistake — even if it were, CTV gives "this output
may only pay a precommitted destination set." It cannot evaluate whether
misbehaviour occurred. It is not a slashing primitive. Do not design for it and
do not put it on a roadmap.

**3.4 — What I proposed here and now withdraw: the per-trade performance
deposit.** The idea was a deposit `D ≥ tranche`, returned on principal unanimity,
forfeited by inaction — the appeal being that forfeiture pays nobody, so
extortion has no payoff. Adversarial review broke it on three independent
grounds, any one of them sufficient. It is recorded in §4.2 rather than deleted,
because the reasons it fails are the most useful constraints in this document.

---

## 4. What I would cut, rename, or stop counting

### 4.1 In the existing design

- **The commitment bond is not collateral.** Keep it — as a sybil cost and a
  liquidity signal it is genuinely useful, and the collusion-impossible
  single-key construction is good work. But *call it what it is*. Naming it a
  bond invites users to size trades against a number that will never pay them.
  "Locked capital, 3-month term" is honest; "bonded arbiter" is not.
- **The dual-signed fault attestation is not the collusion answer** and the repo
  already knows it. Keep it for two-sided misconduct, stop presenting it as the
  accountability story, and promote ruling concentration (§0.6) into that slot.
- **The aggregate exposure cap** bounds *simultaneous* theft, not lifetime
  theft. An arbiter who steals one trade per term, forever, never trips it. It is
  a good capital-management tool and a weak security control; it is also dormant.
- **`ARBITER_POOL_SHARE_CAP = 3` against a 3-member pool** is not a "tripled
  collusion surface," which is how I first described it. It is a *total* one:
  every arbiter holds a share on every trade (§1.2). Fix it (§0.1) or stop
  calling the seat a control.

### 4.2 In my own proposal — the per-trade performance deposit, withdrawn

I proposed a deposit `D ≥ tranche`, returned on buyer-and-seller unanimity,
forfeited by inaction, on the theory that burning pays nobody so extortion has no
payoff. It fails on three independent grounds, and the reasons are the most
useful constraints in this document:

1. **The burn is fake, for the same reason §1.1 is true.** The arbiter originates
   the deposit's OOB notes, so the arbiter can reissue them — using the very
   `reabsorb()` path the repo ships as crash recovery. Nobody can even detect it:
   `parseNotes` returns only an amount, offline. And `tryCancelAfterSecs` is
   chosen by the spender and not recoverable from the note bytes, so an arbiter
   posts with a one-hour horizon and gets an automatic refund without touching
   their phone. The general law:

   > **Fedimint OOB ecash can hold your own money conditionally. It cannot hold
   > money against you.**

   That is tolerable for the trade escrow, where the depositor is the buyer.
   It is fatal for a *penal* deposit, where the depositor is the party being
   penalised. Routing around it requires a neutral originator, which is a
   custodian — the thing the project deliberately deleted.

2. **Shamir cannot name a payee, so my thresholds were incoherent.** I specified
   2-of-3 topology with 3-of-3 semantics. At 2-of-3 the arbiter plus *either*
   principal returns the deposit (no unanimity), and worse, **buyer + seller is
   also two shares** — so the "burn" is actually a payout to the two principals,
   and a sybil running both sides seats an arbiter, completes a normal trade, and
   pockets `D ≥ A`. That is a money printer, not a deterrent. At 3-of-3 the
   semantics work and any single holder's inaction destroys `D`.

3. **Forfeit-by-inaction reopens a threat this codebase already closed.**
   `arbiter-fault.ts:164-181` gates attestation to *after* settlement precisely
   so it cannot become "rule my way or we both sign." A unilateral, financial,
   mid-dispute trigger is a strict regression against a threat the project has
   already identified and mitigated. And "only spite" was wrong: the modal
   non-signer is not spiteful, they are **asleep** — post-settlement voluntary
   re-engagement on a serverless mobile app is the thing every try-cancel horizon
   and the entire substitution machinery exist to work around.

The economics confirm it. Break-even fee is `f* ≈ q + r·T/365` where `q` is the
probability the deposit does not return. `q` is not the dispute rate; it is
P(both principals come back and click), realistically 15–35%. That puts `f*` near
20% — against an income that is currently a declinable tip.

And the clean impossibility, which holds even if problems 1–3 were solved:

> `dDamage/dD = 1`, `dGriefCost/dD = 0`.

Raising `D` to deter collusion raises the griefing payoff one-for-one, while the
griefing *cost* stays pinned at the time-value of the attacker's own fully
recoverable trade float — about 0.3% of notional at a 15% hurdle over a week, for
roughly 350:1 leverage. **There is no `D` that works.** A single griefing
principal, riding an otherwise honest trade and simply never signing, gets
infinite leverage at zero marginal cost.

The generalisable lesson, which I would now put above every mechanism in §3:
**you can only slash what is machine-detectable.** Judgement calls must be
handled by structure, never by money.

---

## 5. If I could only do four things

1. **§0.8** — tell users the truth about what LOCKED means. Today; it is a
   string change.
2. **§0.1 + §0.3** — stop pre-issuing the arbiter share to the entire pool, and
   verify the `bondedArbiters` stamp before honouring it. This week. These are
   the only cheap changes that alter who can actually take the money.
3. **§1.1** — tranching. This quarter. The cheapest route to "my worst case is a
   number I chose," and — because the loss surfaces at each tranche's claim — the
   only thing on this list that gives the victim *detection*, which no probe can
   (§1.1).
4. **§2.1** — on-chain 2-of-3 Taproot escrow above a size threshold. This is the
   one that changes the answer to the original question from *no* to *yes*, and
   with §2.2 closed it is not the fallback, it is the path.

Everything else here is worth doing and none of it substitutes for those four.

---

## 6. The honest summary

The question was whether there is a design that makes it comfortable to trade
with anyone while arbiters may be adversarial. There is, and it does not involve
trusting arbiters at all:

> **Bound every adjudication to a slice you chose (Tier 1), make sure no single
> arbiter is ever cryptographically sufficient (Tier 0/1), and for anything large
> enough to hurt, hold the value somewhere no single party can reach (Tier 2).**

Note what changed between my first draft of that sentence and this one. I began
by wanting to make the *seat* unpredictable, and three adversarial passes moved
the answer twice: first to "the funder can walk, so the arbiter is not the main
risk," then to "the share is pre-issued to every arbiter anyway, so the seat was
never the control." Both times the fix I reached for was aimed one layer above
the problem. That is the failure mode this document is really about, and the
existing v5.7 work has the same shape — excellent reasoning about arbiter
incentives, resting on an escrow primitive that does not yet hold.

Under the design above, the worst a corrupt arbiter can do is take one tranche,
without being cryptographically sufficient to do it alone, on a trade whose size
the victim set — and above the threshold, they cannot do it at all. That is not
perfect. It is bounded, and bounded is what makes strangers tradeable.

Three things I would not change: keeping testimony testimonial, keeping
statistics descriptive, and refusing a standing cabinet. Those were right, and
the temptation to price a judgement call — which I fell for in §3.4 and had to be
argued out of — is exactly what they protect against.
