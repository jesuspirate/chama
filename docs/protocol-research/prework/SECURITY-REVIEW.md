# Hourglass v0.1 security review

Date: 2026-09-10. Scope: the supplied `HOURGLASS-SPEC.md`, not a Chama implementation. No Chama source files, Bitcoin Core binary, or build manifest were available in the workspace. Original draft preserved for comparison. This is a design review, not an implementation audit or a security proof.

**Decision: do not implement v0.1 as written.** The personal deposit construction can protect an unspent deposit from a quorum acting alone. The proposed transfer protocol does not preserve that guarantee for a subsequent owner. See `CHAMA-SETTLEMENT-DESIGN.md` for the replacement architecture and `check_constructions.py` for executable counterexamples.

## Critical findings

### 1. A matured deposit is not a challenge output

Draft §4.4, original line 178, claims an immediate cooperative transaction necessarily confirms ahead of a delayed owner exit. CSV measures the age of the output, not the time since a withdrawal request. A depositor can wait until maturity and submit a conflicting withdrawal directly to a miner. No advance announcement is required. The protocol cannot choose the miner's ordering. The distinction between deposit age and a newly published commitment is explicit in [BIP 112](https://github.com/bitcoin/bips/blob/master/bip-0112.mediawiki).

Counterexample: Alice's deposit is confirmed at height 100, with a 20-block delay. Alice signs a payment to Bob that remains unconfirmed. At height 120 or later, both that payment and Alice's old-owner refund may be eligible. If the refund confirms, Bob's payment is invalid. Signing time and Nostr state numbers do not give Bob priority.

A scheduled settlement can reduce exposure if every dependent transaction confirms before the root deadline; that is a deadline-dependent construction, not the claimed fresh challenge window. Acceptance would need to check the age of the confirmed root, force settlement early, and reject mature roots. This still does not repair conflicting cooperative signatures under quorum collusion.

### 2. A past owner plus quorum can sign a competing spend immediately

Draft §§4.3–4.5. Alice and G retain authority over the original output until it is spent. After signing Alice-to-Bob, they can sign Alice-to-Alice with no delay. Bob's signature is not required by Alice's original UTXO. This attack works even before the timeout. It directly breaks the advertised protection against a malicious quorum plus a previous owner.

Giving Bob a descendant transaction does not revoke Alice's authority. Confirm the transfer, or use an independently specified channel revocation/state replacement construction. Cut-through also creates conflicts: after signing a shortcut, a counterparty can publish an older branch and invalidate the shortcut's descendants. All surviving branches need a safe resolution, not just the preferred branch.

### 3. Public additive Cashu denomination tweaks permit denomination conversion

Draft §7.2, original line 316. Suppose denomination keys are `k_a = k + d_a` with public `d_a`. For a token point `Y`, a holder with `C_a = k_a Y` computes:

```
C_b = C_a + (d_b - d_a) Y = k_b Y
```

The holder has transformed a low-value signature into a high-value signature without learning a mint private key. A mint that performs the base redemption check accepts it under the high denomination if the secret is unspent. This attack assumes the publicly known scalar differences specified in the draft. It does not apply to ordinary independently derived Cashu keys. NUT-00 defines the underlying verification equation; the conversion is our algebraic counterexample. [Cashu NUT-00](https://github.com/cashubtc/nuts/blob/main/00.md).

Use independent denomination secrets or a reviewed distributed derivation with no public scalar relationship. Do not improvise a threshold mint from FROST shares. Requiring an additional independently verified proof might change acceptance, but is not a justification for this unsafe key schedule or standard-wallet compatibility.

### 4. Refresh does not disable a complete historical quorum

Draft §§1.1, 3.2–3.3. A Shamir-sharing polynomial can be generated distributively; SSS is not synonymous with a trusted dealer. FROST itself uses Shamir shares. DKG avoids a party initially choosing and retaining the entire secret. It does not prevent an authorized threshold from signing or reconstructing that secret. [RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html).

If old and refreshed shares have the same constant term, a complete threshold of either generation reconstructs the same secret. Proactive refresh protects against a mobile adversary only with the applicable per-period corruption and erasure assumptions. Members retaining an old threshold are not cryptographically expelled from the unchanged public key. Move assets to a new key to remove old authority. Recovery artifacts and deterministic seed recovery must be included in that erasure analysis. [ChillDKG specification](https://github.com/BlockstreamResearch/bip-frost-dkg).

### 5. Universal contributor refunds defeat conditional ownership

Draft §4.8 gives the contributor an extra CSV exit alongside an agreed refund deadline. If CSV matures earlier, it bypasses the negotiated commitment. If two contributors can each take the whole UTXO alone, the first confirmed spend takes both contributions.

Recovery must mean the contractually authorized residual payout, not permanent recovery of the original deposit. A payment cannot both transfer ownership and preserve the sender's unconditional right to take the same value back. Use separate refund outputs in a fully signed transaction when multiple parties contributed. Ordinary timelocks enable paths; they do not expire competing paths.

## High-severity findings

| Draft location | Finding | Required change |
|---|---|---|
| Summary; §4.1 | Summary says G is the internal key; §4.1 says an aggregate including the owner. If G alone is the actual internal key, a quorum bypasses every leaf. | Reconstruct the entire Taproot output locally. Start with a verifiable NUMS internal key and explicit script paths. |
| §§6–8 | A quorum software policy is presented as enforcing future outputs and treasury caps against that same quorum. | Distinguish current-input authorization from output restrictions. Only committed signatures or applicable consensus rules constrain destinations. |
| §7.2 | Reachability plus spent-secret gossip is not a consensus protocol. | Keep a reviewed mint consensus implementation. For threshold certificates, quorum intersection must include honest participants: `2t - n > f` is a necessary intersection condition, not a complete consensus design. |
| §7.2 | Single master key reused across signing, transport, and mint services. | Separate key domains and permissions. A blind-signing oracle is a different interface from Schnorr signing. |
| §7.1 | A BIP-340 group key is assumed to replace all Lightning signing. | Existing Lightning includes ECDSA signature formats, ECDH transport, and channel-specific keys. A FROST signer is not a drop-in node replacement. Use ordinary node APIs first. |
| §§4.9, 5 | An eight-deep unconfirmed TRUC chain is assumed relayable. | TRUC constrains unconfirmed topology to a parent and child, with size and other restrictions. Validate the selected Core release and each actual package. |
| §§7.2, 8 | Epochs, reserve attestations, and policy caps are claimed to bound theft under full quorum compromise. | A malicious signing quorum can bypass its policy and issue unreported liabilities. Rotation alone does not cap forged issuance or reserve theft. Count shared underlying reserves once when measuring loss. |

The internal-key recommendation follows [BIP 341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki). Lightning interfaces are specified in [BOLT 1](https://github.com/lightning/bolts/blob/master/01-messaging.md) and [BOLT 8](https://github.com/lightning/bolts/blob/master/08-transport.md). TRUC topology is specified in [BIP 431](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki).

## Other corrections

- A missing heartbeat cannot prove malicious withholding. A partition and a silent signer can look identical. Signed contradictory statements are evidence; an accusation about silence is not equivalent evidence.
- Nostr encryption does not hide public tags or all traffic metadata. NIP-44 does not supply forward secrecy. Stable pool tags on outer messages leak linkage. [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md).
- Nested FROST/MuSig2 is not specified by saying their aggregate nonces are equal. Challenges, coefficients, key tweaks, parity, participant sets, and abort behavior require a reviewed composition. Avoid it in the first implementation.
- Nonce safety requires crash and rollback handling, including cloned backups. Volatile nonces alone are not a proof of safety.
- A deposit timeout provides no fresh protection after device compromise once the deposit is mature.
- `T_deg < T_exit` in §4.7 contradicts the constants table.
- Lightning HTLCs use SHA-256 payment hashes. The draft's `hash160(H)` is not a plug-compatible Lightning hash condition.
- A six-block margin is a risk parameter, not a bound on deep reorganizations or confirmation delay.
- Miners are not required to include a transaction because an anchor exists. Public fee-bump outputs need an adversarial pinning and replacement analysis. [Core package policy](https://github.com/bitcoin/bitcoin/blob/master/doc/policy/packages.md).

## What survives

Owner-controlled keys, full descriptor verification, locally stored recovery artifacts, Nostr transport, narrow per-trade authority, and separating personal BTC from optional ecash exposure are useful. The central replacement is ownership transfer by confirmed spending or a sound channel protocol, rather than retaining an old owner's withdrawal branch beneath an off-chain balance ledger.
