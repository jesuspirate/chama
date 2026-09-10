# Independent review of Claude's regtest graph

2026-09-10. Reviewed commit: `1d7e57e`. Tested with the installed Bitcoin Core binary reporting `/Satoshi:31.1.0/` and the installed Chama signing-library dependencies. No application code was changed.

**Verdict: agree with the constrained transaction architecture and continue the research prototype. Refute the claims that the original refund boundary was tested accurately, that the small-number encoding is consensus-invalid, or that adversarial fee handling is solved.**

## Reproduction and evidence

I independently ran Claude's harness with instrumentation for the chain tip and a different local RPC port. All 22 recorded accept/reject results reproduced. Claude’s report says 23, but its committed JSON contains 22 rows. The instrumented version is [codex-reproduction.ts](harness/codex-reproduction.ts), with [results](harness/codex-reproduction-results.json). It changes timing observation and RPC ports, not the transaction construction.

I then extended the harness with exact refund-height checks, an actual copied-template-signature attack, a pre-signed zero-fee appeal and its fee sponsor, and a direct-block test of small-number script encoding. All 29 rows matched expectations. See [codex-extended.ts](harness/codex-extended.ts) and [results](harness/codex-extended-results.json).

These runs use the existing local binary; I am not claiming a second independent verification of its release signatures. The harness exercises this library's transaction and witness construction, not Chama's complete production funding/recovery state machine. It does not implement FROST or the ecash profile.

## What is now supported by execution

- Both first-instance ruling choices can be completed from the principals' pre-signatures.
- The reversal appeal can be completed without a fresh signature from either principal.
- The constrained ruling and appeal leaves reject the tested unauthorized redirections.
- The copied-signature attack fails: in S4f, R and A provide valid signatures for an attacker payout and copy B's actual signature from the legitimate ruling template. Core rejects the resulting spend with `Invalid Schnorr signature`.
- Winner maturity and the continuing panel path behave as predicted. A confirmed spend consumes the input and invalidates the conflicting alternative.
- The extended S7 sequence pre-signs a zero-fee ruling and its zero-fee appeal before funding broadcast. Each stage is accepted as a parent-plus-fee-child package after its predecessor confirms. This is stronger evidence than testing a freshly assembled zero-fee ruling only after funding.

## Correction 1: the original refund-boundary labels are wrong

The original parameters put funding at height 112 and the refund deadline at 142. By S5c, earlier scenarios have already advanced the tip to 158; the supposedly pre-deadline ruling confirms at 159. The call intended to advance to the deadline requests `generatetoaddress(-17, ...)`.

Core's generation loop performs no iterations for a negative count. It does not rewind the chain. The supposed "at H_refund" tests thus run at height 159, seventeen blocks after the deadline. This explains why all binary results pass despite the inaccurate scenario labels. [Core 31.1 generation loop](https://github.com/bitcoin/bitcoin/blob/v31.1/src/rpc/mining.cpp).

The extended harness sets a later refund deadline, refuses negative mining counts, asserts that S5c is still before maturity, and verifies the exact tip before boundary tests. A correctly constructed refund is rejected at tip H−1 and accepted at tip H for the next candidate block H+1. Transaction `nLockTime = H` requires a candidate block height greater than H. The report should distinguish chain tip from the height of the block that would contain the transaction.

The underlying race conclusion survives the correction. The original run demonstrated a post-deadline race, not the claimed exact boundary.

## Correction 2: mempool policy is not consensus

Most `testmempoolaccept` rejection results include policy checks. One cannot infer consensus invalidity from rejection alone. Acceptance followed by actual mining establishes the tested accepted transaction can enter the regtest chain; a rejected transaction needs its rejection rule classified.

For the proposed CSV=10 encoding:

| Extended row | Operation | Result |
|---|---|---|
| S8policy | Submit the non-minimal data push through normal mempool validation | Rejected: `Data push larger than necessary` |
| S8consensus | Include the exact same transaction directly using `generateblock` | Accepted into a block |

Therefore this is a real standard-relay compatibility problem, not consensus-invalid Bitcoin Script. Tapscript's consensus MINIMALIF rule is a different requirement from minimal data pushes. [BIP 342](https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki).

The proper builder fix is minimal script-number encoding, including OP_1 through OP_16 where applicable, rather than merely increasing test constants or rejecting all small values. Existing large constants avoid this particular policy failure; that observation is not proof the builders are safe in every other respect. Legacy funded scripts must remain reconstructable exactly as originally committed.

## Correction 3: fees are demonstrated under tested conditions, not solved

Confirm-before-child is a coherent way to keep these relay units within TRUC's parent/child topology. I accept Claude's refinement. The extended harness demonstrates sponsorship for both ruling and appeal stages.

Nevertheless, local `submitpackage` success is not evidence of propagation through a heterogeneous peer network, universal miner acceptance, or timely inclusion. Neither run models an adversary spending the anchor first, sibling eviction, replacement fee floors, competing descendants, unavailable confirmed sponsor UTXOs, or budget exhaustion near the appeal/refund deadline. TRUC explicitly includes replacement and topology rules whose effects need to be tested for these conflicts. [BIP 431](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki).

"No fee estimation at setup" should mean the exact future feerate need not be committed in the principal template. The design still needs an economically viable funding amount, anchor policy, confirmed fee-sponsorship liquidity, a maximum affordable recovery cost, and sufficient time to react. The harness uses a 240-sat anchor and a separately funded sponsor. Those resources do not appear automatically.

The raw witness serialization workaround succeeds for the tested input layout. An application integration needs tests that decoding and re-encoding preserve the non-witness transaction, fee input signature, output amounts, and every non-anchor witness for all supported layouts. It should become a narrowly scoped serializer adapter, not a general raw-transaction patch applied unchecked.

## Correction 4: the recovery gate is not yet implemented

The harness assembles and signs the funding transaction before building the ruling templates, but withholds its broadcast until after template setup. This is sufficient to exercise the graph in one process. It does not demonstrate the distributed requirement that no usable funding authorization leaves the funder's control before recovery is ready.

The gate counts two `tapScriptSig` entries. It does not independently validate their signer identities, leaf/message binding, outputs, or durable storage. Correct signatures are generated elsewhere in this process, so the success paths work; malicious supplied artifacts or a restart are a different test.

Before production integration, test separate participant stores and crashes at every message boundary, forged/tampered recovery artifacts, unavailable arbiter copies, funding signature release before acknowledgment, and funding/ruling reorgs. A runtime verification-and-persistence invariant is necessary even if the API also uses a `RecoveryReady` type.

## Decisions I accept, with their actual scope

- **Reversal-only appeal:** reasonable first menu. One child per ruling parent keeps the graph small.
- **Default winner on panel silence:** coherent timeout default. It can still be an unfair real-world result.
- **Filing by W/2:** a panel/application service rule; it is not enforced by the shown Bitcoin scripts. The panel can complete its preauthorized reversal until a competing spend confirms, even without a timely filed appeal.
- **Dedicated, fixed role keys:** correct. Independent first-instance and appeal key domains do not by themselves establish independent operators.
- **FROST only for appeal initially:** a reasonable scope choice, not proof that arbitrary quorum collusion has been eliminated. The appeal quorum can choose the permitted reversal with pre-supplied principal signatures.
- **On-chain profile first, Cashu later:** reasonable if selected by the user. It does not automatically port this arbitration graph to Lightning or Fedimint, and does not require deleting the existing Fedimint payment integration.

Lightning shares the general need to confirm actions before competing timeout paths win. That analogy does not give Chama all of Lightning's security properties: arbitrary goods/fiat truth, appeal-panel behavior, and this specific fee graph require their own assumptions and tests.

## Next milestone

Keep this under `docs/protocol-research/harness` until the adversarial setup/recovery and fee tests are in place. Then extract reviewed builders as a new contract profile, preserving legacy funded-contract behavior. The next useful work is the pinning/replacement matrix and separated participant recovery state, not another redesign of the basic three-stage graph.

Reproduce:

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-reproduction.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-extended.ts
```

Run sequentially: both use the review RPC port 18699. Each run creates a temporary regtest directory, writes its own result file, and shuts down its node. No application release or deployment is authorized by passing these tests.
