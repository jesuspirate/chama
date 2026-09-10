# HOURGLASS
## A dealerless, time-arbitrated threshold custody protocol for Bitcoin and Nostr

Version 0.1 — design draft — 2026-09-10

---

## 0. One-paragraph summary

Hourglass is a protocol in which a group of n peers jointly hold a FROST threshold key **G** generated without any dealer (ChillDKG), and every peer i additionally holds a private **exit key E_i** that never leaves their device. Every unit of value a peer brings into the group sits in its own Taproot output whose cooperative path needs **both** G and E_i, and whose fallback path needs **only E_i after a delay T_exit**. Because of this, no quorum, however large, can ever move a peer's funds without that peer, and no peer can ever be trapped: the worst any adversary can do is make you wait. Trades between peers are pre-signed transactions that are valid immediately, while every "cheat" path is delayed, so time itself arbitrates every dispute. Nostr is the transport and identity layer; the group key G is simultaneously the Taproot internal key, the Nostr pubkey of the group, the Lightning node key, and the root of the Cashu mint keysets. Nothing in the protocol needs a soft fork.

---

## 1. Goals, non-goals, and the one honest limit

### 1.1 Goals

| # | Goal | How Hourglass meets it |
|---|------|------------------------|
| G1 | **Zero backdoor.** No party, ever, holds or can reconstruct the group key. | Group key comes from ChillDKG, not from Shamir Secret Sharing (SSS). SSS has a dealer who knows the whole secret; a DKG has no dealer. SSS is used only where the "dealer" is you (personal backup of your own seed). |
| G2 | **Inseparable exit.** A peer's ability to leave cannot be stripped by anyone. | Every deposit output has a script-path spendable by E_i alone after T_exit. E_i is derived from the peer's own seed, not from the group. |
| G3 | **Time is the only deterrent.** No penalty keys, no slashing, no third-party arbiter, no mandatory watchtower. | Honest paths are undelayed; dishonest paths are delayed; anyone can complete an honest path. Misbehaviour can only delay, and delays are attributable via signed Nostr events. |
| G4 | **On-chain looks like single-sig.** | Cooperative spends use the Taproot key path (MuSig2 of G and E_i). Only unilateral exits reveal a script. |
| G5 | **Relays are dumb.** | Nostr relays carry encrypted, signed messages. Every artefact a peer needs to exit is stored locally and mirrored encrypted on multiple relays. Losing every relay loses nothing. |
| G6 | **Conditional trades.** Peers enter and leave trades under conditions they signed. | A trade is a state transition co-signed by every peer whose balance changes, plus the quorum. Conditions live in two places: the quorum's deterministic policy, and Miniscript in the trade outputs themselves (hashlocks, deadlines). |
| G7 | **Bitcoin can ride on it, and so can Nostr alone.** | Layers 0 and 1 (identity, DKG, threshold signing, refresh) work with no chain. Layer 2 adds Bitcoin. Layers 3 and 4 add Lightning and Cashu. |
| G8 | **No soft fork.** | Uses Taproot, MuSig2, FROST, relative timelocks, P2A anchors and TRUC (v3) transactions. CTV / CSFS / APO / CAT are upgrade paths, not requirements. |

### 1.2 The one honest limit

Threshold cryptography has an arithmetic fact you cannot design around: **t colluding share-holders are the key.** Hourglass therefore refuses to put anything under G alone that belongs to a specific peer. Peer funds are under G **and** E_i. What sits under G alone is only *pooled* value: the Lightning liquidity treasury and the reserves backing ecash. That value is at threshold risk, and the protocol bounds it in time (epochs) and in size (policy caps) rather than pretending otherwise. Section 8 gives the full table.

### 1.3 A note on Chama

I treated Chama as the collective-savings / group-custody idea (rotating contributions, shared control) and used it only as inspiration. Hourglass is not restricted to that shape: any set of peers who want to hold, trade and issue against value together, with each peer's exit guaranteed, is a valid Hourglass group.

---

## 2. Layer 0 — Identity and transport (Nostr)

### 2.1 Keys

| Key | Holder | Curve / format | Purpose |
|-----|--------|----------------|---------|
| n_i / N_i | peer i | secp256k1, BIP-340 x-only | Nostr identity. Signs every protocol message. NIP-44 encryption. |
| s_i | peer i | scalar share of G | FROST signing share (from ChillDKG). |
| E_i | peer i | secp256k1, BIP-340 | Exit key. BIP-32 path `m/86'/0'/0'/1337'/pool_index'/*` from the peer's own seed. Never transmitted, never derived from anything shared. |
| K_i | peer i | secp256k1 | Optional script-path key for the degraded-quorum leaf (Section 4.5). |
| G | group | BIP-340 x-only | Group key. Taproot internal key, Nostr pubkey of the group, Lightning node id, root of Cashu keysets. |

A peer's Nostr key and exit key may be the same seed but MUST be different derived keys, so that posting on Nostr never exposes anything about the exit path.

### 2.2 Message envelope

Every protocol message is a Nostr event signed by n_i with tags:

```
["h", <pool_id>]            pool_id = SHA256(manifest)
["s", <state_no>]           monotonically increasing per pool
["p", <recipient>, ...]     for encrypted messages
["expiration", <unix>]      NIP-40, for ephemeral rounds
```

Payloads that are secret (DKG rounds, nonces, partial signatures, exit-transaction copies) are NIP-44 encrypted and gift-wrapped (NIP-59) so relays learn nothing but a random sender and a pool id.

### 2.3 Event kinds (proposal)

| Kind | Name | Addressable? | Content |
|------|------|--------------|---------|
| 39100 | Pool manifest | yes (d = pool_id) | n, t, participant N_i list, T_exit, T_settle, T_epoch, policy hash, Layer flags |
| 9101 | DKG round message | no | ChillDKG round 1/2/3 payload (encrypted) |
| 9102 | DKG certificate | no | Signature over the ChillDKG transcript hash (equivocation prevention) |
| 9103 | Recovery blob | no | ChillDKG public recovery data, plus the peer's own encrypted artefact bundle |
| 9110 | State proposal | no | Proposed transition (PSBT + balances) signed by the affected peers |
| 9111 | Nonce commitment | no | FROST round-1 nonce commitments for a proposal |
| 9112 | Partial signature | no | FROST round-2 partial signature |
| 9113 | Final artefact | no | Fully signed transaction, distributed to every party who may need to broadcast it |
| 9120 | Heartbeat | no | Signed liveness ping, every T_beat |
| 9121 | Blame | no | "Peer X did not deliver round R for proposal P by deadline D" — signed, verifiable from relay logs |
| 39130 | Epoch checkpoint | yes | Threshold-signed by G: keysets, proof of liabilities, on-chain reserve outpoints |

Relays are interchangeable. A peer publishes to at least three, and additionally accepts direct delivery over any transport (Tor hidden service, local network, QR) because a message is valid by its signature, not by where it came from.

### 2.4 Time in Layer 0

| Constant | Default | Meaning |
|----------|---------|---------|
| T_beat | 10 min | Heartbeat interval |
| T_liveness | 24 h | Peer silent longer than this is marked *inactive*; a resharing to exclude them may begin |
| T_round | 60 s | Max wait for a signing round before a blame event is emitted |

---

## 3. Layer 1 — Key ceremony and key hygiene

### 3.1 Distributed key generation

Run **ChillDKG** (BIP draft, Blockstream Research) among the n peers with threshold t, over Nostr as the (insecure) broadcast channel. ChillDKG is chosen because it:

- has no dealer (G1),
- works without a secure broadcast channel, using a certification step in which every peer signs the transcript hash so no two peers can end up with inconsistent views,
- produces public **recovery data** from which a peer can re-derive s_i using only their seed, so a peer who loses their device but keeps their seed recovers with no help from the group.

Output: G, shares s_1..s_n, recovery data R. R is posted as kind 9103 and stored locally.

### 3.2 Why not SSS for the group key

Shamir Secret Sharing produces the same share structure as a DKG but requires someone to hold the full secret at split time. That someone is a backdoor by construction, even if they promise to delete. Hourglass uses SSS exactly once: a peer MAY split their **own** seed into shares for their **own** recovery (e.g. 2-of-3 across their devices or trusted people). There the dealer is the owner, which is not a backdoor.

### 3.3 Proactive refresh, resharing, and enrollment

The group key G is the on-chain key, the Nostr identity, and the Lightning node id. It must not change every time a peer joins or leaves. Three sub-protocols keep G fixed while the share set changes:

| Sub-protocol | Effect | On-chain footprint |
|--------------|--------|--------------------|
| **Refresh** (Herzberg-style, every T_epoch) | All shares re-randomised; old shares become useless. Limits the window an attacker has to collect t shares. | none |
| **Reshare** (change t or n) | Each current holder shares its share with a fresh polynomial to the new set. New set holds shares of the same G with new (t', n'). | none |
| **Repair / enroll** | A new or recovering peer receives a share of G computed by t existing holders without any of them learning it (share repair, Herzberg / Stinson-Wei). | none |

Because membership of the *signer set* is decoupled from membership of the *fund set* (Section 4), a peer can be removed as a signer while their funds remain safe under E_i.

### 3.4 Signing

Threshold signatures follow the BIP-FROST signing draft (BIP-340 output). Rules that are non-negotiable:

1. Nonces are generated fresh per session, bound to the share, the message, and the signer set; never persisted; never reused after a crash (regenerate, never resume).
2. A signer contributes a partial signature only after its **policy function** (Section 6) returns `ALLOW` for the exact message being signed.
3. When G signs together with a single peer key (the MuSig2 key path of Section 4), the FROST group acts as one MuSig2 co-signer. The nested nonce is the FROST aggregate nonce. Implementations MUST treat the nested session as a single atomic signing session and abort entirely on any inconsistency.

### 3.5 Nostr-only mode

Layers 0 and 1 alone give: a group Nostr identity G whose posts require t of n peers; threshold-signed NIP-59 group chats, DAO-style announcements, and shared moderation; time-rotated shares; recoverable membership. This is the minimum viable Hourglass and needs no Bitcoin. Everything below adds value on top without changing G.

---

## 4. Layer 2 — On-chain construction

### 4.1 The output that makes exit inseparable

Every deposit by peer i creates an output O_i:

```
tr(
  AGG_i,                                            # key path: MuSig2(G, E_i)
  {
    and_v(v:pk(E_i), older(T_EXIT)),                # unilateral exit, delayed
    and_v(v:pk(G),   pk(E_i))                       # cooperative path without nested signing (optional)
  }
)
```

- **Key path** AGG_i = MuSig2-KeyAgg(G, E_i). Spending needs the quorum and the owner. On chain it is indistinguishable from a single-sig spend.
- **Leaf 1** is the inseparable exit: the owner alone, after T_exit blocks relative to confirmation of O_i.
- **Leaf 2** is a plain two-signature cooperative path for implementations that prefer not to nest FROST inside MuSig2. It costs more bytes and reveals two keys if used.

There is deliberately **no** recovery key, no third-party leaf, and no leaf spendable by G alone. That is what "no backdoor" means at Layer 2.

### 4.2 Deposit ordering rule

A peer's funding transaction may create O_i only after the peer holds everything needed to leave. Since Leaf 1 requires nothing but E_i and time, a deposit is safe the moment it confirms. There is no pre-signed exit transaction to obtain first. This is the main simplification over channel and factory designs: exit is a *script*, not a *pre-signed transaction*, so it cannot be withheld.

### 4.3 Trades are pre-signed, undelayed transactions

A trade between peers i and j (any value transfer inside the group) is a transaction TX_k:

```
inputs : O_i (key path, sig by AGG_i), O_j (key path, sig by AGG_j)
outputs: O_i' (new balance i), O_j' (new balance j), P2A anchor
version: 3 (TRUC)  locktime: none  sequences: none
```

- Signed by E_i, E_j, and the quorum (through FROST inside MuSig2). Every peer whose balance changes must sign; nobody else can move their balance.
- TX_k is **fully valid immediately**. Copies go to i, j, every quorum member, and (encrypted) to relays.
- It is **not broadcast** yet. Peers keep trading; O_i' is the input to the next trade. This is an off-chain chain of valid transactions.

### 4.4 Why old states cannot be used to cheat

Suppose i later tries to exit with the *old* O_i via Leaf 1, ignoring TX_k. Leaf 1 is delayed T_exit blocks after O_i confirmed. TX_k spends O_i with no delay. Anyone holding TX_k (j, any quorum member, or anyone who can decrypt the relay copy) broadcasts it and it confirms first. The cheat attempt was visible on chain for the whole T_exit window, so the honest side needs to be online only once per T_exit, not continuously, and no penalty is needed: the cheater simply gets the honest state and paid the fees.

This replaces both Lightning's penalty mechanism and Spark's "operators promise to forget the old key" with a single, time-only rule: **honest paths are undelayed, dishonest paths are delayed.**

### 4.5 Settlement and cut-through

The policy (Section 6) requires that no unsettled chain be older than **T_settle < T_exit**. Before then the quorum performs a **settlement**:

- **Cut-through** (cooperative): every peer with an unconfirmed output signs one transaction that spends the *confirmed* outputs directly into the *latest* outputs, skipping the chain. Key-path signatures only. Looks like one single-sig-style transaction.
- **Broadcast** (fallback): if a peer is unreachable, their chain is broadcast as is, using anchors for fees. TRUC limits package size, so chains are additionally capped at policy depth D_max between settlements.

Settlement resets every T_exit clock, since the new outputs are freshly confirmed.

### 4.6 Withdrawals and unilateral exit

- **Cooperative withdrawal**: a state transition whose output for i pays to any address i chooses. Undelayed.
- **Unilateral exit**: i broadcasts a spend of their latest *confirmed* O_i via Leaf 1 after T_exit. If i has unconfirmed later state, i first broadcasts that chain (i holds every transaction in it), waits for confirmation, then Leaf 1 on the final output. Nobody can prevent either step.

### 4.7 Optional degraded-quorum leaf

Groups that fear losing signers faster than they can reshare may add a third leaf:

```
and_v(v:pk(E_i), and_v(v:multi_a(t', K_1, ..., K_n), older(T_DEG)))     # t' < t, T_DEG < T_EXIT
```

It still needs the owner, so it introduces no backdoor. It lowers the quorum for *cooperative* action after a visible period of inactivity. It is optional because Leaf 1 already guarantees exit; this leaf only shortens the wait when the full quorum is dead.

### 4.8 Conditional trades in script

The "conditions" a peer enters and leaves trades under can be enforced by Bitcoin itself, not only by policy. A trade's output may be an **escrow output**:

```
tr(
  AGG_ij,                                            # MuSig2(G, E_i, E_j): everyone agrees
  {
    and_v(v:pk(E_j), hash160(H)),                    # j gets it by revealing the preimage (atomic with Lightning)
    and_v(v:pk(E_i), after(DEADLINE)),               # i gets it back if the condition is not met in time
    and_v(v:pk(E_i), older(T_EXIT))                  # i's inseparable exit never disappears
  }
)
```

Any Miniscript condition may be used (thresholds of oracle keys, multiple deadlines, hash chains). The invariant the policy checks is only that **every escrow output contains a leaf spendable by each contributor alone after a bounded time**, so no trade can trap value.

### 4.9 Fees and mempool policy

- All pre-signed transactions are version 3 with a Pay-to-Anchor output, so any party can CPFP without keys.
- Exit leaves add T_exit margin for fee spikes; T_exit ≥ 2016 blocks is recommended.
- Settlement transactions are ordinary and fee-estimated at signing time.

### 4.10 Pooled variant (large groups)

For groups where n outputs per settlement is too costly, a single pooled UTXO under G with a **decrementing-timelock exit tree** (Decker-Wattenhofer) is a valid Hourglass variant. It trades away the "t colluders cannot touch my funds" property for fee efficiency, so this document treats it as a downgrade and does not specify it further. With CTV or APO the pooled variant regains most of the guarantees (Section 9).

---

## 5. Timing constants (the hourglass)

| Constant | Default | Constraint | Role |
|----------|---------|------------|------|
| T_exit | 2016 blocks (~2 weeks) | ≥ 2 × T_settle | Unilateral exit delay; liveness requirement for honest settlement |
| T_settle | 1008 blocks (~1 week) | < T_exit | Max age of an unsettled off-chain chain |
| D_max | 8 | TRUC package limits | Max unconfirmed depth between settlements |
| T_epoch | 1 week | any | Share refresh, keyset rotation, checkpoint |
| T_deg | 4032 blocks | > T_exit if used | Degraded-quorum activation (optional) |
| T_grace | 4 epochs | any | Old ecash keysets remain redeemable |

The invariants that make time sufficient as deterrent:

1. Every honest completion (trade, settlement, cooperative withdrawal) is **undelayed**.
2. Every unilateral action by a single party is **delayed by T_exit**.
3. Every off-chain state is **forced on chain within T_settle < T_exit**.
4. Every delay is **attributable** through signed heartbeats, round messages and blame events.

Hence a cheating attempt is (a) visible for at least T_exit − T_settle blocks, (b) reversible by anyone holding the honest state, and (c) recorded against the cheater's Nostr identity.

---

## 6. Policy: what the quorum will and will not sign

Every signer runs the same pure function before contributing a partial signature:

```
function policy(pool, proposal) -> ALLOW | REJECT(reason)

  // 1. Authorship: every balance that decreases is signed by its owner
  for each input output O_x consumed by proposal:
      require proposal.signatures contains N_x

  // 2. Conservation
  require sum(inputs) == sum(outputs) + fee, fee within [fee_min, fee_max]

  // 3. Every output belonging to a peer is an Hourglass output
  for each output O_y assigned to peer y:
      require O_y.has_leaf( and_v(v:pk(E_y), older(T_EXIT)) )
      require O_y.keypath == MuSig2(G, E_y)  or  escrow form of 4.8

  // 4. Escrow outputs give each contributor a bounded-time unilateral leaf
  for each escrow output:
      for each contributor c: require has_leaf(pk(E_c) after/older <= T_ESCROW_MAX)

  // 5. Time discipline
  require age(oldest unconfirmed ancestor) < T_SETTLE
  require depth(unconfirmed chain) <= D_MAX

  // 6. Group caps (configurable)
  require treasury_after <= TREASURY_CAP
  require ecash_liabilities_after <= RESERVE_RATIO * treasury_after

  // 7. State number strictly increases and hashes the previous state
  require proposal.state_no == pool.state_no + 1
  require proposal.prev_hash == pool.state_hash

  return ALLOW
```

Policy is enforced as long as fewer than t signers are corrupt. When t or more are corrupt, rules 1, 3 and 4 remain enforced by **Bitcoin script** rather than by policy, which is the entire point of putting E_i into every output.

---

## 7. Layers 3 and 4 — Lightning and Cashu ride on G

### 7.1 Lightning (unchanged)

The group runs one Lightning node whose node key is G (BIP-340, so FROST signs channel messages and commitment transactions). Channels are funded from **treasury outputs** `tr(G)` that belong to the group, not to a peer. Peers move value between their O_i and the treasury through ordinary cooperative transitions. Lightning itself is untouched: the node simply has a threshold-signed identity.

Treasury value is under G alone and therefore at threshold risk. Policy rule 6 caps it. Treasury is a *liquidity* budget, not a *custody* location.

### 7.2 Cashu with a threshold mint

Cashu's blind signature (BDHKE) computes `C' = k · B'`, a scalar multiplication. Scalar multiplication is linear, so a Shamir-shared k yields a threshold blind signature in **one round with no nonces**:

```
each signer j:      C'_j = s_j(k) · B'
combiner:           C'   = Σ λ_j · C'_j        (Lagrange coefficients over the signer set)
```

- **Keysets**: Cashu needs one key per amount 2^0 .. 2^m. Derive each from G by an unhardened BIP-32-style additive tweak: every signer adds the public tweak to their share, so the group key moves by exactly the tweak. No new DKG per keyset.
- **DLEQ proofs (NUT-12)**: each signer attaches a Chaum-Pedersen proof for its partial; the wallet verifies each and combines. Wallets that want a single proof can be served a threshold Chaum-Pedersen (two rounds, FROST-style nonce commitments).
- **Double-spend set**: each signer keeps its own spent-secret set and refuses to sign a proof it has already seen or has seen acknowledged by any other signer. Signers gossip spends over Nostr (kind 9113 with the secret hash) before signing. A spend is final when t partials exist. This is weaker than Fedimint's BFT consensus under a network partition: a determined attacker who partitions signers could double-spend up to the partition duration. Mitigation: signers refuse to sign if they cannot reach at least t − 1 peers within T_round.
- **Epoch checkpoint (kind 39130)**: every T_epoch, G signs the active keysets, a **proof of liabilities** for issued ecash (Cashu's PoL scheme), and the outpoints of treasury outputs backing them. Anyone can verify reserves ≥ liabilities × reserve ratio by looking at the chain.
- **Keyset rotation**: a new keyset per epoch, old ones redeemable for T_grace. This bounds how much an old, possibly compromised share set can ever have signed.

### 7.3 The trust ladder (say it plainly)

| Where your value sits | Who can move it | If the quorum vanishes | If t signers collude |
|-----------------------|-----------------|------------------------|----------------------|
| O_i (Hourglass output) | you + quorum, or you alone after T_exit | you exit after T_exit | you exit after T_exit |
| Escrow output | per its script | you get your refund leaf | you get your refund leaf |
| Lightning channel (your own node) | you | you force-close | unaffected |
| Treasury / Lightning liquidity | quorum | frozen | lost |
| Ecash | quorum signs melts | worthless | lost |

Hourglass makes the top rows large and the bottom rows small, bounded and visible. It does not claim ecash is non-custodial.

---

## 8. Threat model

| Threat | Effect | Bound |
|--------|--------|-------|
| One peer's device fully compromised (n_i, s_i, E_i) | Attacker can exit that peer's funds via Leaf 1 after T_exit | Victim (with quorum) sweeps to a new E_i' before T_exit. Time here protects the victim. |
| Fewer than t signers malicious or offline | Can only refuse to sign: delays | Bounded by T_exit for exits and T_settle for settlement; attributable via kind 9121; excluded by reshare |
| t or more signers collude | Can sign anything under G alone: treasury, ecash | Cannot touch any O_i or escrow refund leaf; loss ≤ TREASURY_CAP + outstanding ecash of ≤ T_grace epochs |
| Peer broadcasts an old state | Visible for ≥ T_exit − T_settle blocks | Anyone holding the honest transaction broadcasts it; cheater pays fees, gains nothing |
| All relays censor or die | No transport | Every artefact is stored locally; any transport works; exit needs no messages at all |
| Fee spike during exit | Exit transaction stuck | P2A anchor CPFP by anyone; T_exit margin |
| Share loss | Peer cannot sign | Recover from seed + recovery data; or repair protocol issues a fresh share; funds unaffected regardless |
| Nonce reuse / crash mid-signing | Key leakage | Nonces never persisted, sessions never resumed; nested session atomic |
| DKG sabotage | No key | ChillDKG aborts safely; restart without the saboteur (identifiable abort is in the BIP's roadmap) |
| Relay-level metadata | Group membership graph | Gift wrap; random per-message keys; multiple relays; optional Tor |
| Deep reorg | Timelock accounting shifts | All constants carry ≥ 6-block margins; T_settle ≪ T_exit |

---

## 9. Upgrade paths (not requirements)

| Soft fork | What Hourglass gains |
|-----------|----------------------|
| OP_CTV | Pooled variant with committed exit trees: one UTXO per group, exit tree enforced by consensus rather than pre-signing |
| OP_CSFS / APO (BIP-118) | Eltoo-style symmetric state: unbounded off-chain updates without settlement pressure; T_settle can grow |
| OP_CAT | Vault-style re-lock conditions and on-chain enforced treasury caps (rule 6 in script) |

None changes the layer-0/1 design or the exit guarantee; they only make settlement cheaper.

---

## 10. Protocol flows

### 10.1 Group creation

```
1. Initiator publishes kind 39100 manifest (n, t, N_i list, constants, policy hash)
2. Each peer acknowledges by signing the manifest hash
3. ChillDKG rounds over kind 9101; certification via kind 9102
4. Each peer stores s_i, publishes recovery blob kind 9103
5. G is now: Taproot key, Nostr pubkey, LN node id, Cashu root
```

### 10.2 Deposit

```
1. Peer i derives E_i, computes AGG_i = MuSig2(G, E_i), builds O_i descriptor
2. Peer i funds O_i on chain (from anywhere)
3. Peer i publishes kind 9110 "deposit" with descriptor + outpoint; quorum verifies and records
```

### 10.3 Trade

```
1. i and j agree terms off-band, build TX_k (inputs O_i, O_j; outputs per 4.3 or 4.8)
2. Both sign the proposal (kind 9110)
3. Quorum members run policy(); nonces (9111); partials (9112)
4. Coordinator (any signer, round-robin) assembles; MuSig2 finalises with E_i, E_j
5. Fully signed TX_k distributed as kind 9113 to i, j, all signers; encrypted copy to relays
6. Not broadcast; state_no += 1
```

### 10.4 Settlement (every ≤ T_settle)

```
1. Coordinator proposes cut-through transaction spending confirmed outputs to latest outputs
2. Every affected peer signs; quorum signs; broadcast
3. Peers unreachable within T_round: their chain is broadcast as is
4. On confirmation: all T_exit clocks reset
```

### 10.5 Unilateral exit

```
1. Peer i broadcasts any unconfirmed chain leading to their latest O_i (they hold every tx)
2. Waits T_exit blocks after confirmation
3. Spends O_i via Leaf 1 with E_i only
No message to anyone is required.
```

### 10.6 Epoch

```
1. Proactive refresh of shares (G unchanged)
2. Reshare/repair for joins, leaves, threshold changes
3. New Cashu keyset derived; old keyset enters T_grace
4. Kind 39130 checkpoint signed by G: keysets, proof of liabilities, treasury outpoints
```

---

## 11. Roadmap

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| 0 | Nostr-only: ChillDKG over Nostr, threshold-signed events, refresh, heartbeats, blame | libsecp256k1 FROST module, ChillDKG reference |
| 1 | Layer 2 with Leaf 1 + Leaf 2 (no nested signing), trades, settlement, exit | Bitcoin Core 28+ (TRUC, P2A), Miniscript descriptors |
| 2 | MuSig2 key path with nested FROST; escrow templates | careful nonce engineering, audits |
| 3 | Threshold Cashu mint, epoch checkpoints, proof of liabilities | NUT-12 partial DLEQ extension |
| 4 | Threshold Lightning node on G, treasury policy | LDK/CLN external signer with FROST |
| 5 | Covenant upgrades if activated | CTV / CSFS / CAT |

---

## 12. Prior art and what was borrowed

- **ChillDKG / BIP-FROST** (Blockstream Research): dealerless key generation, recovery data, certified transcripts.
- **Spark**: the user-plus-operators 2-of-2 shape with a timelocked unilateral leaf. Hourglass replaces operators with the peers themselves and replaces "operators forget old keys" with pre-signed undelayed transactions.
- **Lightning / Decker-Wattenhofer**: undelayed honest paths versus delayed dishonest paths; decrementing timelocks for the pooled variant.
- **Ark**: batch settlement and the idea that exits are always available but slow.
- **Fedimint**: threshold blind signing for ecash; Hourglass simplifies the consensus at a stated cost.
- **Cashu**: BDHKE, keysets, NUT-12 DLEQ, proof of liabilities.
- **Frostsnap**: one FROST key serving Bitcoin and Nostr simultaneously.
- **Miniscript**: every condition expressed as an analysable policy with a guaranteed unilateral leaf.
