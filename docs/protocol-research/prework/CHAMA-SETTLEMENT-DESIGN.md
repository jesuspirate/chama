# Chama settlement redesign

2026-09-10 — proposed architecture, not a production protocol or completed Chama integration.

**Recommendation:** build a portable client-side contract and recovery engine. Keep principal in individual wallets, confirmed per-trade contracts, or established self-custodial Lightning channels. Federations offer services around these contracts. They do not obtain a shared master spending key over users' principal.

This preserves the useful intent of Hourglass while replacing its unsafe off-chain ownership ledger. Names and APIs below are proposed integration boundaries; no Chama source was available to map them to existing files.

## 1. The guarantee to implement

For an honest participant with uncompromised keys and authentic local recovery data:

1. No coalition consisting only of service providers can redirect that participant's uncommitted BTC.
2. Every funded contract has a locally verified resolution path requiring no new service signature after setup, subject to that contract's conditions and deadlines.
3. Once a transfer is confirmed to its required depth, the previous owner has no spending authority over the replacement output, conditional on the assumed reorganization bound.
4. Outsourced watchers can execute bounded recovery actions without being able to redirect principal.
5. Applications label oracle dependence, mint custody, timeout races, and channel monitoring requirements explicitly.

These are conditional security properties. They require correct implementations, signature/hash security, access to Bitcoin, affordable fees, sufficient monitoring where required, and eventual transaction inclusion. No fixed number of blocks guarantees inclusion, and Bitcoin block intervals do not guarantee a wall-clock exit deadline.

**An exit is the payout authorized by the current contract.** A seller who has been paid cannot also retain an unconditional right to reclaim the sold BTC. Similarly, being able to leave a trade cannot mean escaping obligations after the other party performed.

For fiat, goods, chargebacks, or subjective disputes, perfect fairness cannot follow from Bitcoin keys alone. Consider two worlds with identical signed messages: delivery occurred in one and did not in the other. Bitcoin sees the same witnesses and cannot choose different outcomes. An oracle introduces external information and the associated trust. More oracles can distribute this dependence; they do not remove it.

## 2. Components and separation of authority

```
Chama UI / other federation clients
              |
     local contract verifier + signer
              |
     durable recovery artifact store
              |
    +---------+--------------+----------------+
    |                        |                |
Bitcoin transaction      user's existing   optional existing
builder + watcher       Lightning node    Cashu/Fedimint wallet
    |
Bitcoin Core

Nostr relays: discovery and encrypted delivery
Oracles: contract-specific attestations
Federation services: offers, liquidity, fee sponsorship, backups, watching
```

Do not make an aggregate key simultaneously a mint key, Nostr identity, Lightning identity, and Bitcoin spending key. Bind distinct public keys through a signed manifest. A service can rotate its identity without changing ownership of a user's UTXOs.

Nostr carries authenticated messages, not a universally ordered balance ledger. Use immutable contract IDs, domain separation, explicit network and protocol versions, and local replay protection. Keep private contract metadata inside encrypted envelopes. A missing relay message is not proof of wrongdoing. [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).

## 3. Three contract profiles

### A. Confirmed BTC settlement and objective conditions — first implementation

Idle funds stay in the owner's wallet. There is no reason to require a federation signature just to hold them. A single Bitcoin transaction can atomically exchange multiple Bitcoin inputs into agreed outputs: every contributor signs the same transaction committing to the complete allocation. Off-chain signatures authorize funding; they do not make an unconfirmed trade final.

For a one-way conditional payment from A to B, use this illustrative Taproot descriptor, compiled and verified through a maintained Miniscript library:

```
tr(NUMS,{
  and_v(v:pk(B),sha256(h)),
  and_v(v:pk(A),after(H_refund))
})
```

`NUMS` denotes a transparently derived internal point with no known private key, not a participant-selected public key. The wallet verifies every leaf and recomputes the actual output address. The hash witness is a 32-byte secret. These are template placeholders, not an import-ready descriptor. Miniscript supplies analysis of script conditions; it does not validate the economic protocol around them. [Miniscript](https://bitcoin.sipa.be/miniscript/).

Before funding, the payer verifies its refund branch and the receiver verifies the claim branch. The receiver waits for the agreed funding confirmation depth and refuses commitments near the timeout. Refund and claim compete once refund becomes valid; the hash branch does not expire. Successful completion means the claim transaction confirms, not merely that someone reveals the secret.

An HTLC is not by itself a fair exchange for fiat, goods, arbitrary files, or another payment rail. For a two-leg swap, specify who initially knows the secret, exact hash compatibility, both funding transactions, the observation mechanism, and staggered refund deadlines. Require the responder's claim to become actionable with enough time remaining to claim the other leg. Include reorganization and fee budgets. For a multiparty cycle, use a separately analyzed atomic-swap graph; copying the bilateral template across edges is not sufficient.

### B. Oracle-dependent trades — constrained outcomes through DLCs

Use established Discreet Log Contract mechanisms instead of giving an arbiter a general transaction signature key. Parties A and B fund a 2-of-2 output. Before either releases its funding signatures, it obtains and verifies:

- A fully signed timeout refund splitting funds into agreed participant outputs.
- Verified adaptor signatures for every permitted contract execution transaction (CET).
- Oracle announcements binding the event, outcome encoding, keys, and nonce commitments.
- Full funding transaction data, fee strategy, and all recovery dependencies.

A valid oracle attestation enables a corresponding fixed payout. The oracle cannot substitute its own address. A colluding oracle and counterparty can still select a false allowed payout: destination constraints reduce custody authority, not truth dependence. Multiple-oracle DLCs distribute this risk. [DLC transaction specification](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Transactions.md), [multiple-oracle specification](https://github.com/discreetlogcontracts/dlcspecs/blob/master/MultiOracle.md).

Use the transaction format supported by the selected maintained DLC implementation; do not require an improvised Taproot adaptation. The 2-of-2 funding path can support cooperative settlement. An oracle must never be added as a third arbitrary-spend key.

For multiple contributors, a fallback is a single pre-agreed allocation transaction with separate outputs, not an independent right for each contributor to seize the entire input. The m-party form needs all-party setup, signature-distribution, abort, and cost analysis; the first release should limit oracle contracts to bilateral trades, with larger groups operating independent contracts.

Refund availability is not fair compensation for an already delivered external asset. Oracle silence can produce the agreed fallback and still harm a participant. Display that fallback before commitment.

### C. Frequent BTC payments — existing Lightning

Use a user's self-custodial Lightning node and its native channel state machine, backup discipline, and monitoring. Lightning places the response delay on the commitment output created when an old state is published, rather than aging a deposit in advance. Its revocation machinery handles old states. [BOLT 3](https://github.com/lightning/bolts/blob/master/03-transactions.md).

Do not implement a new multiparty channel in this release. Do not treat FROST as a replacement for every existing Lightning cryptographic interface. A federation-owned channel remains federation custody from the customer's perspective; an invoice does not change this.

Hold invoices, where supported by the selected node, can coordinate settlement but introduce timeout and liquidity-griefing exposure. They do not prove fiat delivery. Each adapter must specify its actual node capabilities and failure behavior.

## 4. The transaction lifecycle

```
OFFER -> TERMS_VERIFIED -> RECOVERY_READY -> FUNDING_SIGNED
      -> FUNDING_PENDING -> ACTIVE -> RESOLUTION_PENDING -> RESOLVED
```

Required behavior:

| Stage | Local acceptance condition |
|---|---|
| TERMS_VERIFIED | Network, counterparties, amounts, fees, all payout destinations, oracle set, deadlines, and trust profile match user intent. |
| RECOVERY_READY | Every required signature/adaptor signature and dependency is verified and durably stored. A successful disk write is part of setup. |
| FUNDING_SIGNED | No funding signature is released before local recovery is ready. Signing sessions cannot be replayed across contracts. |
| FUNDING_PENDING | Monitor the exact funding transaction. Conflicts or reorgs return the contract to unresolved funding; do not deliver an external asset prematurely. |
| ACTIVE | Required confirmation depth reached; enforce claim/refresh deadlines and a fee reserve. |
| RESOLUTION_PENDING | Broadcasting is not settlement. Continue monitoring conflicts, refunds, and confirmations. |
| RESOLVED | Record a confirmed spend and resulting outputs; retain records and handle reorg rollback. |

Before funding signatures are released, abort can be local. Afterwards, a counterparty may still broadcast the valid funding transaction: local cancellation does not revoke a signature. Preserve recovery data and monitoring until inputs are provably spent elsewhere or the contract resolves. A timed-out signing coordinator does not establish that its signatures were never delivered.

The recovery export includes raw transactions/PSBTs, prevout amounts and scripts, descriptors/control blocks where applicable, contract/oracle announcements, completed and adaptor signatures as applicable, participant destinations, timelocks, funding txid, fee-bump method, and state-machine version. Encrypt it with a user-controlled recovery secret. Never include reusable live signing nonces in a general backup.

Changing counterparties or obligations creates a new funded contract. Migrating active positions requires a cooperative spend or completing the old contract. A Nostr membership update does not change a Bitcoin script.

## 5. Time and slashing

Use time for reaction windows, refund eligibility, and capital lockup. It does not prove misconduct or make an irrational attacker honest.

An economic condition can be written as `p * B_effective > G_attack`, where `p` is the probability of timely evidence collection and confirmed penalty, `B_effective` is collateral actually lost by the attacking coalition, and `G_attack` includes all gains from its simultaneous positions. This is an assumption-dependent deterrent, not an invariant. A penalty paid to a colluding account may not cost the coalition anything.

### Optional research extension: a separate equivocation bond

For a binary oracle event, publish a dedicated public key `X = xG` and a fixed nonce point `R = rG`. Accepted attestations must use that announced nonce and bind the contract and outcome. Two contradictory Schnorr attestations give:

```
s_release = r + e_release*x (mod n)
s_refund  = r + e_refund*x  (mod n)
x = (s_release - s_refund)/(e_release - e_refund) (mod n)
```

Each signature and its event binding must be checked before extraction. This is deliberately accountable one-event signing, not ordinary nonce reuse. Never share X with a wallet, node, mint, or general Nostr identity. Nonce commitments in oracle events have existing precedent in the [DLC oracle specification](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Oracle.md).

An arbiter can fund a separate bond for a designated beneficiary V:

```
tr(NUMS,{
  and_v(v:pk(V),pk(X)),
  and_v(v:pk(arbiter_refund),after(H_bond))
})
```

After extracting x, V supplies both required signatures and takes the bond. The arbiter knows x already, but cannot take that immediate branch without V. V cannot frame the arbiter alone. The arbiter can voluntarily cooperate with V or leak x; only its own separately funded bond is exposed. The trader's principal is never in this output.

If either participant can be harmed, use separate dedicated beneficiary allocations; a single first-claimer bond can be drained by a colluding claimant. Track concrete outpoints, confirm them before treating them as collateral, and exclude concurrent reuse within the client's accepted contracts. A claimed global exposure cap without an enforceable reservation system is not security. Per-contract keys and explicitly bound bonds avoid accidental cross-contract slashing authority.

Limitations are decisive:

- One false verdict is not equivocation. Honest-looking false statements remain unslashable by this mechanism.
- Both signatures must be obtainable. A counterparty can withhold evidence.
- Refund competes after H_bond; evidence discovered too late may recover nothing. Arrange settlement/evidence windows before bond maturity and do not promise coverage against unbounded censorship or delayed evidence.
- Identifying the victim of a single false ruling requires external truth. This construction pays a designated beneficiary for demonstrable conflicting attestations, not a universally established injured party.
- This descriptor and extraction are a candidate construction. They require actual script tests, adversarial review, signer isolation, and deadline/fee analysis before deployment. The included executable check verifies only the extraction algebra.

For penalties for bad judgment, the design must name who adjudicates that judgment. Adding a second committee moves the trust boundary. Bitcoin cannot slash from a plain Nostr accusation or arbitrary evidence hash alone.

## 6. Cashu and federation integration

Keep existing ecash implementations and label balances as claims on their mint. Cashu spending conditions are checked by the mint; they are not Bitcoin reserve withdrawal rights. A P2PK or HTLC note cannot stop a malicious reserve custodian stealing BTC. [Cashu NUT-10](https://github.com/cashubtc/nuts/blob/main/10.md).

There are two distinct integration choices:

| Choice | Enforcement and deployment |
|---|---|
| Portable Chama contract client | Works alongside federation apps. Bitcoin enforces principal contracts. No federation-wide custody module is required for that layer. |
| Trading mint-issued notes | Uses the mint's supported spending conditions or a federation module. Mint consensus and reserve-custody assumptions remain. Every participating backend must support the required operations. |

Do not claim a client plugin can retrofit unilateral Bitcoin redemption onto existing federation notes. Conversion between ecash and a Bitcoin contract is itself a settlement step with the mint's availability and honesty assumptions until the on-chain side is secured. Merely giving the note holder another key does not encumber the reserve UTXO.

Use explicit wallet exposure budgets for optional ecash. These bound what that wallet voluntarily deposits; they do not cryptographically cap all federation liabilities. Fedimint describes its custody model as community custody. [Fedimint](https://fedimint.org/).

FROST plus dealerless DKG can be useful for a group announcement identity or a contract-specific oracle, subject to threshold assumptions. It is optional for the principal layer. Start with explicit signatures when they make the authorization policy easier to inspect. Do not replace mint consensus with Nostr gossip or derive denomination keys by public additive tweaks.

## 7. What to reuse from other protocols

| Mechanism | Useful part | Remaining cost or assumption |
|---|---|---|
| Bitcoin + Miniscript | Inspectable conditions and confirmed ownership changes | On-chain fees, latency, reorg and inclusion assumptions |
| Lightning | Existing revocation and unilateral close | Liquidity, monitoring, fee management, safe backups |
| DLCs | Fixed outcomes without arbitrary arbiter withdrawal power | External truth and oracle availability |
| Cashu/Fedimint | Private small-value payment UX and existing implementations | Mint reserve custody and consensus |
| Spark | Owner-plus-operator authorization and transferable outputs | Its documented transfer trust involves operator key deletion; this does not meet an all-colluding-operators goal |
| Ark variants | Pre-signed exit trees and batching | Analyze the specific variant's transfer/refresh, signer, forfeit, expiry, and exit-cost assumptions |

Spark's own [trust model](https://docs.spark.money/learn/trust-model) identifies deletion assumptions. Arkade's [operator-failure description](https://docs.arkadeos.com/learn/faq/what-if-the-operator-disappears-or-acts-maliciously) and [glossary](https://docs.arkadeos.com/glossary) describe its exit and signer mechanisms; these are vendor descriptions, not independent proofs. Do not combine names from different variants into an unreviewed security claim.

Potential covenant or state-replacement upgrades deserve a separate transaction-level design if selected. A new opcode does not itself solve external truth, mint insolvency, data availability, or deployment adoption. This proposal does not depend on activating one.

## 8. Concrete Chama implementation sequence

Proposed modules:

```
contract-core: canonical terms, profiles, pure local verifier, lifecycle
bitcoin-backend: descriptors, PSBT construction, prevout checks, broadcast
recovery-store: encrypted durable artifacts and offline export
chain-watcher: funding/resolution tracking, reorgs, deadlines, fee actions
nostr-transport: delivery, identity binding, replay protection
lightning-adapter: existing node API, payment status and timeout handling
ecash-adapter: existing wallet/mint API with explicit custody profile
oracle-adapter: selected DLC implementation and attestation validation
```

Priority order:

1. Map Chama's actual key ownership, trade lifecycle, and stored recovery data. Identify where an app balance is currently treated as settled money. This requires the repository.
2. Implement the confirmed BTC profile and the local funding gate first. Test all spending paths on regtest. Display exact refund allocations before signing.
3. Package a watcher/coordinator service that connects to Bitcoin Core with least-privilege RPC access. Watch-only operation should not receive seeds. Allow a user to export recovery data and use a different service.
4. Integrate existing Lightning and ecash wallets without changing their cryptography or misstating their trust models.
5. If fiat/goods trades are required, select a maintained DLC backend, specify the permitted outcomes and oracle panel, and implement the constrained oracle profile.
6. Evaluate the equivocation bond as a separately reviewed extension. Add FROST only where distributing a particular signing role has a demonstrated operational benefit.

A Start9-style package can make the service installable. It does not require a Bitcoin consensus change. Actual packaging needs the target platform's current manifest/build requirements, pinned dependencies, RPC permissions, health checks, durable storage, restore tests, and an update policy. No Start9 package is claimed complete here.

Suggested backend interface:

```
verify_terms(terms, local_intent) -> VerifiedTerms
prepare_contract(VerifiedTerms, prevouts) -> FundingDraft + RecoveryRequirements
verify_recovery(draft, received_artifacts) -> RecoveryReady
persist_recovery(RecoveryReady) -> DurableRecoveryHandle
authorize_funding(draft, DurableRecoveryHandle) -> FundingSignatures
observe_chain(contract_id, chain_evidence) -> LifecycleUpdate
build_resolution(contract_id, witness, fee_policy) -> VerifiedResolution
export_recovery(contract_id) -> EncryptedRecoveryBundle
```

The implementation must prevent callers from fabricating `RecoveryReady` or bypassing persistence checks. RPC/UI assertions are not substitutes for local validation. Interfaces here specify responsibilities, not a claim that typed APIs by themselves ensure safety.

## 9. Validation and current status

The accompanying Python file passes 12 checks covering counterexamples and illustrative algebra. It is neither a Bitcoin interpreter nor an implementation of these profiles. No regtest, descriptor compilation, wallet integration, FROST ceremony, DLC execution, or production audit has been run.

Required release gates: funding abort at every message boundary; mature and boundary-height refunds; malicious internal keys/leaves; incorrect payout/fee/input metadata; every oracle outcome and missing oracle; old-owner conflicts; reorg during setup and settlement; recovery after losing all relays; signing crash and backup rollback; invalid/replayed attestations; fee spikes, pinning, and mass exits; equivalent results from independent contract verification. Pin the Core release and test actual transaction packages against its relay policy.

The defensible product is a family of explicitly scoped settlement contracts with local recovery. It can remove federation custody from BTC principal and constrain arbiter authority. It cannot make an external asset observable to Bitcoin or make a custodial ecash reserve noncustodial by changing its signing algorithm.
