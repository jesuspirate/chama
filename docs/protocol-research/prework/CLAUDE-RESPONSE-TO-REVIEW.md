# Response to the adversarial review — verdict and revised direction

2026-09-10. Author: Claude (Fable 5.1). Inputs: `SECURITY-REVIEW.md`, `CHAMA-SETTLEMENT-DESIGN.md`, `CHAMA-CODE-MAP.md`, `check_constructions.py` (all 12 checks re-run, all pass), and direct reading of the Chama checkout at e609c73.

## 1. Verdict in one line

**Do not start over. Keep Chama. Kill the Hourglass off-chain ledger. Keep three Hourglass ideas and fold them into Chama's existing per-trade contracts.**

## 2. What I concede (Hourglass v0.1)

All five critical findings hold. In order of how badly they hurt:

| # | Finding | Status | Why it is fatal, in my words |
|---|---------|--------|------------------------------|
| 2 | Old owner + quorum sign an undelayed competing spend | **Conceded, fatal** | O_i's key path is MuSig2(G, E_i). Bob's signature is not on Alice's UTXO. Alice and t signers can spend it anywhere at any time. Off-chain transfers were therefore custodial to sender-plus-quorum. The claim "no quorum can move your funds" held only for value never transferred. |
| 3 | Public additive Cashu tweaks allow denomination conversion | **Conceded, fatal, my error** | C_b = C_a + (d_b − d_a)·Y. Any public linear relation between denomination keys is convertible. Denomination keys must be independent secrets. |
| 5 | Universal contributor exit under a conditional contract | **Conceded** | "You can always take your deposit back" and "you sold it" cannot both be true. Exit must mean the contract's residual payout, never the original deposit. This reframes the original ask: "leave under conditions" means leave with what the conditions say. |
| 1 | Mature CSV output is not a challenge window | **Conceded** | CSV measures output age. T_settle < T_exit only narrows the race; it does not give the receiver priority. |
| 4 | Refresh does not expel an old threshold | **Conceded** | Same constant term, same secret. Removing authority means moving coins to a new key. |

Also conceded: nested FROST-in-MuSig2 is unspecified; a FROST key is not a drop-in Lightning node; TRUC does not permit an 8-deep chain; "SSS vs FROST" was the wrong axis (dealer vs dealerless is the axis, and even dealerless does not remove threshold authority).

The general lesson: without a covenant, a revocation secret, or a deletion assumption, **ownership transfer is confirmation.** Hourglass tried to have none of the three. That is not possible today.

## 3. Where I disagree with Codex

**3.1 A DLC backend is the wrong first move for Chama.** Chama's disputes are about fiat, bills, and goods. There, a DLC oracle attesting "buyer wins" *is* the arbiter with a fixed payout menu. The gain over the current 2-of-3 leaf is only that arbiter + one principal cannot pay a *third* address. Bribes move off-chain anyway. The DLC's real benefits (arbiter off the money path, slashable equivocation) are obtainable with plain pre-signed transactions and no new library. See 4.2.

**3.2 The equivocation bond is sound but low value.** It punishes an arbiter who sells both verdicts. A rational corrupt arbiter signs one lie. Build it last, if at all, and only with the per-trade keys Codex correctly insists on.

**3.3 "Federation services never hold a shared key" is too strong.** A community arbiter *panel* as a t-of-n FROST key, generated dealerless over Nostr, is a genuine improvement over a single arbiter key: the collusion bar for a ruling rises from "one arbiter + one principal" to "t arbiters + one principal". That is the surviving core of the user's original ask (mutual key exchange, no backdoor) and it fits Chama's dispute leaf with no other structural change. Threshold authority is fine where the *role* is already trusted; it was wrong only over principal.

## 4. Verified Chama findings and the concrete fixes

I read the code, not only the map. All four structural issues are real.

### 4.1 Ecash escrow is not escrow against the funder — fix with mint-enforced conditions

`fedimint-client.ts` `buildEscrowLockBundle` spends notes, hashes the bearer string, then Shamir-splits it. `lock-custody.ts` already admits the funder can reissue. No key-splitting scheme fixes this, because knowledge cannot be removed from the party who had it.

The fix is a spending condition the **mint** enforces. Cashu NUT-11 P2PK supports exactly the Chama shape: a `pubkeys` tag with buyer, seller and arbiter, `n_sigs = 2`, a `locktime`, and `refund` pubkeys with their own `n_sigs_refund`. The funder mints a token locked to those conditions and can no longer reabsorb it. NUT-14 adds HTLC conditions for Lightning-atomic release. Custody of the mint remains (Codex is right that no note gives a claim on reserves). What changes is that the ecash mode becomes real escrow against all three parties, which today it is not.

Cost: this is a backend question. Fedimint has no equivalent client-usable spending condition. Options are (a) a Cashu mint for locks while keeping Fedimint for payments, or (b) a federation module. Until one ships, the honest UI disclosure stays.

### 4.2 Arbiter authority — replace the 2-of-3 dispute leaf with 3-of-3 plus pre-signed ruling templates

Today: `buildDisputeLeaf` is `multi_a(2, buyer, seller, arbiter)` behind `144 CSV`. Arbiter + one principal can pay any destination; `verifySettlementPsbt` only protects an honest signer.

Proposed leaf:

```
and_v(v:pk(arbiter), multi_a(2, buyer, seller))     # arbiter AND both principals
```

At funding time, **buyer and seller each sign both ruling templates** (BUYER_WINS, SELLER_WINS), each a TRUC transaction with a P2A anchor, and hand them to the arbiter. At dispute time the arbiter adds one signature to one template and broadcasts. Consequences:

- The arbiter can choose *which* outcome, never *where* the money goes. Arbiter + one principal cannot construct a third destination, because the other principal's signature exists only on the two templates.
- Both principals colluding is the cooperative path, which they own anyway.
- The arbiter holds no live Bitcoin spending authority beyond a one-bit choice. This is the DLC property without adaptor signatures or a DLC library.
- If the arbiter signs with a per-trade committed nonce, signing both templates leaks their per-trade key. That is Codex's equivocation bond, obtained for free, and it never touches the bond key that `onchainFundingPlan` currently reuses.

Requirements: fee handling via anchors, refund CLTV must sit well after the latest possible ruling, and the templates go into the recovery store before the funder releases the funding signature (Codex's RECOVERY_READY gate, which I endorse).

### 4.3 The appeal window — make the ruling templates pay into a two-stage output

Verified: `DISPUTE_CSV_BLOCKS = 144` is counted from funding height in `onchainSettlementContext`. A ruling on an old escrow has no fresh window.

Fix: ruling templates do not pay the winner directly. They pay an appeal-stage output:

```
tr(NUMS, {
  and_v(v:pk(winner), older(APPEAL_BLOCKS)),          # uncontested: winner after the window
  multi_a(t, panel_1 ... panel_n),                     # contested: appeal panel overrides, undelayed
  multi_a(2, buyer, seller)                            # both agree: immediate
})
```

The window now starts when the ruling is published, which is Codex's own criterion: time that gives someone an enforceable response. The panel key is where Hourglass Layer 1 (ChillDKG over Nostr) belongs. Codex is right that this only binds because the templates were pre-signed; with a live 2-of-3 leaf the signers could skip the stage.

### 4.4 Bond key reuse — separate key domains now

Verified at `useEscrow.ts:2822`: an auto-seated arbiter's bond key stands in as the escrow key. Any accountability scheme must use per-trade keys. Cheapest fix: require a JOIN with a dedicated escrow key for on-chain trades, or derive a per-trade key from the arbiter seed under a separate path and publish it in the bond announcement.

### 4.5 Funder refund — keep, but document the race

`buildRefundLeaf` gives the funder everything after 30 days. That is the same "old owner beneath the contract" pattern Codex flagged in Hourglass. It is acceptable for a bilateral escrow because the counterparty's remedy is a ruling before day 30, but the ruling deadline must be enforced in the state machine with margin, and the UI must say so.

## 5. What survives from Hourglass

| Idea | Where it lands |
|------|----------------|
| Dealerless threshold key over Nostr (ChillDKG, refresh, heartbeats, blame) | Community arbiter panel key; appeal panel key |
| Owner-side full descriptor recomputation | Already in Chama (`recomputeOnchainEscrowAddress`); keep |
| Every artefact stored locally, relays are dumb | Recovery store gate before funding signature |
| Time ladder | Appeal window measured from ruling, not from funding |
| Cashu integration | NUT-11 P2PK 2-of-3 locks, not threshold blind signing |
| Nostr-only mode | Panel identity and threshold-signed announcements |

Dropped: the pooled ledger, off-chain transfer chains, G as Lightning node key, threshold Cashu mint with tweaked keysets, refresh as expulsion.

## 6. Sequence

1. Separate arbiter escrow keys from bond keys. Small, no money-path semantics change.
2. Replace the dispute leaf with 3-of-3 plus pre-signed ruling templates and the RECOVERY_READY gate. Regtest every path: both rulings, coop, refund at boundary, reorg during funding, fee spike.
3. Route rulings through the appeal-stage output. Start with a single appeal panel key; upgrade it to FROST t-of-n once ChillDKG tooling is stable.
4. Ecash locks via NUT-11 on a Cashu backend. Decide the mint strategy first.
5. Equivocation bond, optional.

None of this needs a soft fork. None of it changes `state-machine.ts` semantics beyond adding a contract profile version, per Codex's boundary advice, which I endorse.
