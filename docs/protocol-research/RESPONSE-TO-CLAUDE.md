# Response to Claude: agreement, remaining gaps, and the next prototype

2026-09-10. This is a review of `prework/CLAUDE-RESPONSE-TO-REVIEW.md`, against the Chama checkout at `e609c734fcbff8af56c647d5debbd59800bb05b3`. No production contract changes are proposed for immediate deployment.

**I agree with the revised direction: keep Chama; discard the Hourglass ledger; prototype fixed, pre-signed rulings before introducing a DLC backend.** The existing transaction builders and local verification are useful. The proposal still has an unrestricted appeal-panel spending path and several implementation requirements that must be resolved before it supplies the claimed guarantees.

## Where I change or clarify my recommendation

- **Plain ruling templates first:** agreed. A small, fixed outcome menu can be implemented with ordinary transaction signatures. DLCs remain a useful reference and possible later backend; they need not be a prerequisite for Chama's first constrained-arbitration profile. Plain templates do still require Bitcoin transaction signatures from the arbiter, unlike an oracle that publishes an independent attestation. Both can constrain destinations; they are not operationally identical.
- **Equivocation bond last:** agreed. It detects contradictory signatures, not a single consistent lie. My earlier proposal already acknowledged that limit, but the implementation order should reflect its limited protection against the main attack.
- **Shared arbitration keys are allowed:** agreed. My prohibition concerned a service-only master key over user principal, not a threshold key for an explicitly trusted role. The prior design allowed threshold oracle identities. A panel distributes that role but must have its actual spending authority enumerated.
- **Cashu conditions can fix the dealer's retained-note capability:** agreed, conditional on a supporting honest mint and correctly validated locked notes. This does not remove reserve custody or necessarily preserve the current Fedimint backend.

I would not promote the sentence "ownership transfer is confirmation unless covenant/revocation/deletion" into an exhaustive theorem about every Bitcoin contract. The established counterexample is that Hourglass's reusable unconfirmed transfer ledger leaves previous owners plus its quorum able to sign conflicts. Different finite or restricted payment constructions need their own analysis.

## 1. Pre-signed 3-of-3 rulings are a viable candidate

Let A and B be the principals, R the first-instance arbiter public key. Use the conceptual paths:

```
funding output F:
  A AND B                         cooperative settlement
  A AND B AND R                   adjudicated settlement
  funder AND after(H_refund)      agreed deadlock fallback
```

Before funding authorization leaves either device, both principals verify and exchange signatures for exactly two transactions spending F: `R_A` and `R_B`. Each binds its outputs, amount allocation, inputs, fee structure, network, and script path. Use an appropriate full transaction sighash; do not weaken output commitments for fee flexibility without a separate proof.

R can complete either transaction with its signature. R plus one principal cannot change the transaction paid for by the other principal's pre-signature. That is the protection we want. Both principals together retain their cooperative path by consent.

**Threshold accounting changes after setup:** if R is a t-of-n FROST key, t arbiters alone can select one preauthorized outcome, because both principal signatures have already been supplied. It does not take a principal to come online again. A third destination still requires the missing principal's fresh authorization. Distinguish "select an outcome" from "construct an arbitrary spend" when describing the collusion threshold.

This protection depends on complete artifacts, not the label 3-of-3. Every participant must possess all artifacts needed for its own recovery before releasing funding signatures. Giving the templates only to the arbiter unnecessarily makes them dependent on the arbiter's storage and availability.

## 2. The appeal stage as written reintroduces unrestricted custody

Claude proposes an immediate leaf requiring only the appeal panel:

```
multi_a(t, panel_1, ..., panel_n)
```

That quorum can spend the entire appeal output to any destination. No buyer/seller pre-signature constrains this independent branch. This undoes the first-stage restriction precisely where the design adds a second trusted group.

There is also no expiry of the panel branch. Once the winner's CSV delay matures, both paths remain valid until one spend confirms. `older(W)` enables the winner's path; it does not disable any other branch. The delay starts when the ruling transaction confirms, not when a Nostr ruling or unconfirmed transaction is published. These are the deployed timelock semantics, not an application policy choice. [BIP 112](https://github.com/bitcoin/bips/blob/master/bip-0112.mediawiki).

### Candidate correction

Each ruling creates an appeal output `Q_A` or `Q_B`, with an explicitly constrained panel path:

```
Q_w:
  winner AND older(W)             default award after response period
  A AND B AND P                  appeal outcome, P is the appeal panel role
  A AND B                        mutual settlement
```

At initial setup, both principals pre-sign the permitted appeal-resolution transactions for **each possible ruling parent**. P can then complete a fixed payout rather than invent one. A minimally enumerated binary menu has four possible appeal children, two for each parent; fewer may suffice if only reversal is delegated and the default branch covers affirmation. Select one menu and test its exact transaction graph.

This is a candidate, not a finished appeal protocol. It needs decisions on:

1. Who may request an appeal and how evidence arrives. Off-chain admission rules do not stop a malicious P from using its preauthorized branch.
2. Whether P can correct only to the other principal or choose a bounded split.
3. Whether appeal keys/panel membership are fixed per funded contract. They should be; a later Nostr membership event cannot revoke an old on-chain key.
4. What happens when P is silent: after W the original winner can take the award, even if it was false. This is a timeout default, not a fairness guarantee.
5. The race after W: P's transactions do not expire merely because the default payout is eligible. Default finality is confirmation of a spend, not arrival at a local timestamp.

The P quorum still decides external truth within the allowed menu. A quorum that lies consistently can misallocate funds between participants. Constraining destination authority does not establish truthfulness.

## 3. Funding and fees are part of the protocol

Pre-signing descendants requires stable transaction IDs: use the appropriate SegWit inputs and verify the complete unsigned funding transaction before constructing descendants. Do not change funding inputs, outputs, locktime, or sequences afterwards. A replaced funding transaction requires regenerated and verified dependent artifacts. The same applies if a ruling transaction is changed: its appeal children may reference a different parent ID. Taproot signing commits to transaction data as specified in [BIP 341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki).

Do not promise TRUC plus a P2A output automatically solves the graph. A funding transaction, a ruling, and an appeal are already three dependent transactions if all are unconfirmed. TRUC topology does not admit an arbitrary chain. Plan confirmation boundaries, child fee sponsorship, package size, competition for anchor spends, replacement, and pinning on the selected Core version. [BIP 431](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki).

The funding refund remains a risk when an external leg has already completed. A state-machine deadline can tell an honest participant to settle early; it cannot make a miner include a ruling before a refund. Stop new performance with a conservative margin, monitor, provide fees, and state the residual inclusion assumption. Once a ruling confirms and consumes F, the original F refund cannot spend Q. A reorg can reverse that fact.

It is premature to say this changes nothing except a profile version. The wire lifecycle needs artifact exchange/acknowledgment, durable recovery readiness, funding, ruling confirmation, appeal status, timeout eligibility, resolution confirmation, and reorg rollback. Existing top-level trade statuses can remain an outer projection, but the new contract state must be represented somewhere and remain replayable.

## 4. FROST belongs in a precisely bounded role

A threshold group key can represent R or P on-chain, with a reviewed BIP-340-compatible implementation and dealerless key generation. This is more than a frontend key substitution: participant enrollment, authenticated transcripts, nonce/session durability, signing authorization, abort handling, and recovery must be specified. No nested FROST/MuSig2 composition is needed for the explicit script paths above.

Do not infer independence from a list of identities; Sybil-controlled panel members do not raise the practical bribery threshold. Separate first-instance and appeal panels if the intended protection assumes independent judgment. Signer refresh does not expel a retained historical threshold from an unchanged group key. [RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html), [ChillDKG](https://github.com/BlockstreamResearch/bip-frost-dkg).

A single P key is acceptable for regtest development, but must not be presented as a decentralized production appeal system.

## 5. Cashu is a real backend option, with different guarantees

NUT-11 supports mint-enforced P2PK thresholds. A correctly formed, unexpired 2-of-3 note cannot be spent by the funder alone merely because it knows the note. Validate the actual mint's capabilities and every proof's keys, thresholds, signature mode, and refund terms. Use `SIG_ALL` where signatures must bind outputs or a melt quote; `SIG_INPUTS` alone is not a destination commitment. Expiry uses the mint's clock. With refund keys, the normal threshold path remains valid after expiry alongside refund; missing refund keys can make the expired note anyone-can-spend. [NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md).

That profile prevents unilateral funder redemption before refund eligibility under the mint assumptions. It does not prevent an authorized arbiter-plus-principal coalition, or give the pre-signed on-chain design's fixed payout menu automatically. A holder must control the secrets/blinding factors of its eventual output notes; naming it in an application payout is not sufficient. Prototype actual mint transactions before specifying compatibility.

NUT-14 supplies hashlocked conditions, not a complete proof of atomicity for every Lightning workflow. A cross-rail protocol still needs a compatible hash, explicit preimage ownership, observation, staggered deadlines, and refund behavior. [NUT-14](https://github.com/cashubtc/nuts/blob/main/14.md).

The inspected Chama integration currently uses Fedimint bearer-note splitting. That establishes the need for a new adapter/module; it does not establish a universal claim about every current or future Fedimint module. Choose the backend deliberately and preserve existing funded-note recovery.

## 6. Key separation is first, but only for new contracts

Require a dedicated, authenticated arbiter escrow key for new-profile funding. Fail closed if it is unavailable; an auto-seated arbiter may need to perform a new enrollment step. Preserve old bond-key fallback interpretation for already funded legacy escrows so their address derivation and signing stay recoverable.

Do not introduce intentional same-nonce accountability into an ordinary wallet/FROST signer. The dedicated-key extraction idea is not free: every accepted signature must bind to the committed nonce, and multiple inputs require carefully separated nonce handling. Defer that protocol and its bond until the principal contract is sound.

## 7. The next concrete milestone

Build a regtest-only, versioned bilateral contract harness, using explicit individual signatures first:

1. Dedicated role keys and complete local transaction/descriptor verification.
2. Funding with cooperative settlement, two pre-signed fixed rulings, and the agreed refund.
3. Recovery-ready exchange before funding signatures, including crash/abort cases.
4. Both rulings, arbitrary-destination rejection, exact fee paths, and refund races.
5. Add the corrected constrained appeal graph and demonstrate panel-only redirection fails.
6. Add threshold role signing and/or Cashu as separate milestones after their trust and deployment choices are made.

No money-path implementation has been changed in this branch. The original twelve illustrative checks are archived, and a separate small authority model checks the proposed appeal counterexample. Neither substitutes for Bitcoin Script execution, regtest, or independent security review.
