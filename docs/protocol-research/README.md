# Chama settlement design discussion

Discussion branch: `research/chama-settlement-design`.

Application baseline: `e609c734fcbff8af56c647d5debbd59800bb05b3`.

This branch archives the conversation, research, Claude's response, and the latest review. It does not change the application, publish a release, or establish that a proposed contract is production-safe.

## Read in this order

1. [Latest response to Claude](RESPONSE-TO-CLAUDE.md) — agreement on pre-signed rulings, the appeal-panel authority gap, and a corrected candidate.
2. [Conversation transcript](CONVERSATION.md) — the recorded user-visible discussion, including the original request and both earlier answers.
3. [Claude's complete response](prework/CLAUDE-RESPONSE-TO-REVIEW.md).
4. [Chama source code map](prework/CHAMA-CODE-MAP.md) — what the application already implements.
5. [Initial security review](prework/SECURITY-REVIEW.md) and [initial replacement design](prework/CHAMA-SETTLEMENT-DESIGN.md).
6. [Original Hourglass draft](prework/HOURGLASS-SPEC.md) — rejected as written; retained as historical evidence.

The files in `prework/` are unchanged snapshots of the shared Hourglass directory. They intentionally retain older recommendations and statements of what was available at the time. The latest response takes precedence as Codex's current recommendation, not as a final user-approved specification. `PREWORK-SHA256SUMS` records snapshot hashes.

## Current convergence

- Keep Chama and its existing per-trade on-chain code.
- Retire the proposed Hourglass off-chain ledger and public Cashu denomination tweaks.
- Treat a contract exit as its agreed payout, not perpetual ownership of the deposit.
- Prototype ordinary pre-signed ruling transactions before requiring a DLC backend.
- Separate keys for new contracts while preserving legacy recovery.
- Give any appeal panel fixed payout authority rather than a standalone unrestricted spending branch.
- Evaluate FROST for named arbitration roles, Cashu for mint-enforced note conditions, and equivocation bonds separately.

## Decisions still open

1. What outcomes should an appeal panel be allowed to select: reversal only, either winner, or a bounded split?
2. What happens if no appeal decision arrives before the default award becomes spendable? The default winner can collect; that may be the wrong real-world result.
3. Who selects the first-instance and appeal panels, and what operational independence is assumed?
4. Which confirmation, refund, fee-reserve, and monitoring requirements are acceptable for each trade category?
5. Should the first new backend be on-chain fixed rulings, or Cashu locked notes for low-value trades? These have different custody guarantees.

## Continue from another device

Open this branch's `docs/protocol-research/README.md` in GitHub. For an assistant with repository access, use:

> Continue the Chama settlement design discussion on branch `research/chama-settlement-design`. Read `docs/protocol-research/README.md`, `RESPONSE-TO-CLAUDE.md`, and `CONVERSATION.md`. Preserve legacy funded-contract recovery. We are deciding a protocol, not authorizing a deployment. Focus next on a concrete fixed-payout appeal transaction graph, its timeout races, complete pre-funding recovery artifacts, and feasible fee handling. Treat all archived cryptographic claims as claims to check, not established proofs.

Original shared checkout: `/home/satoshi/Work/chama` remains on `main`. Separate research worktree: `/home/satoshi/Work/chama-protocol-research`. No need to switch the shared checkout away from Claude's work.

## Reproduce the illustrative checks

```sh
python3 docs/protocol-research/prework/check_constructions.py
python3 docs/protocol-research/check_appeal_authority.py
```

The first script has 12 checks; the second has 6. All passed locally on 2026-09-10. They are abstract counterexamples/group-algebra checks, not a Bitcoin Script interpreter, complete protocol model, regtest harness, or external audit. Application typecheck/tests/build were not run because this branch contains documentation and standalone research models only.
