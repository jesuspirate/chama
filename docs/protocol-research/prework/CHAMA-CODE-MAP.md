# Chama code map and revised implementation recommendation

Reviewed checkout: `/home/satoshi/Work/chama`, cloned from `https://github.com/jesuspirate/chama` at commit `e609c734fcbff8af56c647d5debbd59800bb05b3` on 2026-09-10.

This supersedes the earlier statement that Chama source was unavailable. The earlier Hourglass review remains a review of that separate draft; its proposed Cashu key schedule and off-chain transaction chain must not be attributed to Chama. This pass is static source inspection, not a full application security audit. No application behavior was changed or tested.

## Revised decision

**Reuse Chama's existing on-chain foundation. Replace or extend its arbitration contract, not the whole application.** The repository already contains explicit Taproot leaves, NUMS internal keys, local address reconstruction, confirmed-funding checks, settlement PSBT verification, Nostr settlement transport, and recovery handling.

The remaining hard problem is the authority granted to an arbiter and one colluding principal. A client-side vote check cannot restrict a Bitcoin spend made outside the client. For external trades, constrained oracle outcomes can reduce that authority, but cannot establish the truth of fiat transfers or physical delivery.

## Verified code paths

| Area | Source | What exists and what it implies |
|---|---|---|
| Ecash lock | `src/fedimint/fedimint-client.ts:1519` (`buildEscrowLockBundle`) | Receives the complete bearer string, hashes it, then calls `shamirSplit(notesBytes, 3, 2)`. The funder has already known the bearer capability. |
| SSS implementation | `src/fedimint/fedimint-client.ts:2153` | Dynamically imports the Shamir package. Swapping this library for a threshold signing library would not alter what the mint requires to redeem an existing note. |
| Existing disclosure | `src/escrow-engine/lock-custody.ts:1` | Explicitly acknowledges funder knowledge and identifies the exposed non-funder. Some comments refer to an older verification method; inspect live code rather than treating every comment as current. |
| Lock orchestration | `src/fedimint/escrow-bridge.ts:419` | Coordinates mint spend, durable pending-lock recovery, share construction, and LOCK publication. Preserve crash-recovery behavior for existing funded trades. |
| Reissuance | `src/fedimint/reabsorb-bearer-notes.ts:1` | Explicitly describes consumption-based recovery. Reissuing is not a read-only health check and cannot prove the original note stays available later. |
| On-chain policy | `src/bond-multisig/onchain-escrow.ts:193` | Builds a 2-of-3 buyer/seller/arbiter dispute leaf, optionally prefixed by CSV. |
| Address construction | `src/bond-multisig/onchain-escrow.ts:251` | Constructs NUMS Taproot with cooperative, dispute, and funder-refund leaves. No group-only key-path bypass is present in this construction. |
| Funding integration | `src/hooks/useEscrow.ts:2818` | Builds funding terms from participant keys, supplies `DISPUTE_CSV_BLOCKS`, checks confirmed outputs, and publishes on-chain LOCK. |
| Settlement verification | `src/bond-multisig/onchain-escrow-settle.ts:257` | Checks supplied inputs against known escrow UTXOs, amounts/scripts, sighash policy, dispute sequence, destination, and fee ceiling. These are valuable local protections. |
| Nostr settlement transport | `src/escrow-engine/onchain-settlement-transport.ts:189` | Combines verified settlements and checks winner/arbiter signatures. Signed settlement evidence is explicitly distinguished from confirmation. |
| Current arbiter bond | `src/bond-multisig/commitment-bond.ts:1` | Single owner signature after CLTV maturity. There is no penalty branch. The bond is a capital commitment, not confiscatable collateral. |

Line numbers describe the pinned checkout and are navigation aids; function names are the more durable references.

## Three distinctions that change the design

### 1. The on-chain mode solves the initial bearer-copy problem

An honest observer can verify that BTC was confirmed to the prescribed script. The funder's old wallet key does not independently spend it before the refund path matures. This is a meaningful improvement over SSS-splitting bearer notes.

It does not eliminate the authorized 2-of-3 coalition. After dispute maturity, an arbiter plus one principal can construct an arbitrary destination spend directly. `verifySettlementPsbt` protects an honest signer from approving the wrong transaction; a coalition holding both required keys can bypass it. This is a limitation of the chosen authorization model, not evidence that this verifier fails its intended check.

### 2. The dispute delay is a funding-age delay

`DISPUTE_CSV_BLOCKS` is 144. `buildDisputeLeaf` prefixes the threshold leaf with CSV. `onchainSettlementContext` computes maturity from funding height. A ruling on a sufficiently old output gets no fresh 144-block appeal interval.

Increasing the constant changes the earliest arbitration time but does not create a post-ruling challenge mechanism. For such a mechanism, specify an actual notice transaction and the output it creates, plus an objectively enforceable challenge path. A losing party's unconditional veto would just recreate indefinite deadlock. Do not deploy a two-stage design until both the challenge predicate and transaction constraints are fully specified.

### 3. A time commitment is not a misconduct penalty

The current bond locks the arbiter's sats equally whether the arbiter behaves honestly or cheats. Its opportunity cost may support reputation and entry friction; it does not impose a new financial loss when cheating occurs. Reusing it as slashable collateral is impossible without moving coins into a different script with the owner's authorization.

An additional complication: `onchainFundingPlan` can use the arbiter's public bond key when an auto-seated arbiter has not published a separate escrow key. Therefore a future same-nonce accountability scheme must **never** use that existing key: extraction could expose unrelated bonds and arbitration authority. Introduce dedicated per-event oracle keys and distinct wire types.

## Proposed implementation boundaries in this repository

1. Preserve `state-machine.ts`, existing category/participant commitments, transport, wallet storage, and all legacy claim/recovery readers. Chama supports real fiat, bill-pay, and goods trades, so the external-truth limitation is central rather than hypothetical.
2. Extend the contract discriminant in `src/escrow-engine/types.ts` and validation in `event-parser.ts` with a separately versioned constrained-outcome profile. Old on-chain and ecash contracts must continue resolving by their original rules.
3. Reuse `onchain-escrow-funding.ts` and the existing transaction verification patterns. Add a selected DLC backend and require verified, durable refund/CET artifacts before releasing funding signatures. Do not imply the existing arbitrary-spend dispute leaf becomes constrained merely by adding new frontend checks.
4. Replace the monolithic hook's new-profile orchestration with a narrow contract service that owns setup, recovery persistence, and resolution; the hook calls it. Preserve existing mode selection rather than silently converting ecash users to fee-paying on-chain trades.
5. Treat the optional equivocation bond as a new contract type with dedicated keys and explicit beneficiary outputs. Keep current commitment bonds unchanged. The earlier design document contains the candidate construction and its limitations.
6. Adapt existing Lightning/Fedimint interfaces for payment entry and exit. Federation-native conditional ecash remains a separate backend feature requiring participating federation support; the on-chain profile does not require it.

This sequence is a proposal, not an implemented migration. Library selection, complete transaction format, fee/reorg behavior, and regression coverage remain to be completed before modifying any live money path.

## Shared workspace and packaging

Claude can use the same `/home/satoshi/Work/chama` checkout and the documents in `/home/satoshi/Work/hourglass`. The application checkout is clean after this inspection.

Follow `AGENTS.md`: StartOS packaging belongs only in `https://github.com/Start9-Community/chama-startos`. Do not add packaging files to the application or use the retired `Start9-Community/chama` fork. No packaging repository was cloned or changed in this pass.

When implementation changes are made, the repository requires `npm run typecheck`, `npm test`, and `npm run build`, with regression coverage for money paths. These were not run for this clone-and-static-review pass; dependencies were not installed.
