# Chama settlement design discussion

Discussion branch: `research/chama-settlement-design`.

Application baseline: `e609c734fcbff8af56c647d5debbd59800bb05b3`.

This branch archives the conversation, research, Claude's response, and the latest review. It does not change the application, publish a release, or establish that a proposed contract is production-safe.

## Read in this order

**Latest:** [Codex's admission/index/ownership review](CODEX-ADMISSION-INDEX-REVIEW.md), reviewing [Claude's round-6 response](RESPONSE-TO-CODEX-6.md) at `771625d`. Original twenty checks reproduce. Fixes pass sixteen added checks and the original twenty scenarios: validated admission inputs, correct exclusive appeal timing, atomic block matches/cursor, durable rescans, concurrent indexing guards, and sponsor scripts bound to device databases.

**Next:** one integrated setup path with an authoritative per-device allocation ledger, admission before signing, and consumers that require complete indexed history. These components are not yet wired into `party.ts` or the observer/controller. Real Nostr transport comes after that path is exercised.

Previous: [controller review](CODEX-CONTROLLER-REVIEW.md), [deadline/lifecycle review](CODEX-DEADLINE-LIFECYCLE-REVIEW.md).

0. [Claude's round-2 response with regtest evidence](RESPONSE-TO-CODEX-2.md) — the appeal gap conceded; the complete funding → ruling → appeal/refund graph executed on Bitcoin Core 31.1 regtest (22 recorded rows; original prose said 23). Harness: `harness/regtest-graph.ts`, results: `harness/regtest-results.json`.
1. [Codex's response to Claude](RESPONSE-TO-CLAUDE.md) — agreement on pre-signed rulings, the appeal-panel authority gap, and a corrected candidate.
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

> Continue Chama research on `research/chama-settlement-design`. Read `docs/protocol-research/README.md`, `CODEX-ADMISSION-INDEX-REVIEW.md`, `RESPONSE-TO-CODEX-6.md`, and `CONVERSATION.md`. Keep the transaction graph and preserve legacy funded recovery; no deployment is authorized. Latest validation: sixteen adversarial admission/index/pool checks and twenty original scenarios pass. Block matches and cursor now commit together; rescan requests survive restart; sponsor databases bind device id and script. Admission requires validated domains and uses W-1 for the exclusive appeal interval. Components are still standalone. Next integrate policy, actual coin allocation, recovery persistence and indexed observation before signatures; use one authoritative fee reservation ledger per device rather than independent pool/controller records. Exercise concurrent setups, missing history and allocation/signature crash boundaries before Nostr transport. Historical constructors/schemas changed; use source commits for old suites.

Original shared checkout: `/home/satoshi/Work/chama` remains on `main`. Separate research worktree: `/home/satoshi/Work/chama-protocol-research`. No need to switch the shared checkout away from Claude's work.

## Reproduce the regtest graph

```sh
npm install
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/regtest-graph.ts       # 22 rows, port 18599
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/codex-extended.ts     # 29 rows, port 18699
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/pinning-matrix.ts     # 18 rows, port 18799
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/distributed-setup.ts # 26 rows, port 18899 (party.ts v2)
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/controller-scenarios.ts # 8 scenarios, port 20099 (observer + fee controller)
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/admission-index-ownership.ts # 20 rows, port 20499 (admission, bounded index, sponsor ownership)
```

Use Bitcoin Core 31.1 for the recorded policy results; compatibility with other releases has not been established by these runs. Starts and tears down its own regtest node.

The independent review was tested on Core 31.1. To reproduce its instrumented and extended runs, sequentially:

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-reproduction.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-extended.ts
```

Results are recorded separately; the original Claude harness and results are preserved unchanged.

## Reproduce the illustrative checks

```sh
python3 docs/protocol-research/prework/check_constructions.py
python3 docs/protocol-research/check_appeal_authority.py
```

The first script has 12 checks; the second has 6. All passed locally on 2026-09-10. They are abstract counterexamples/group-algebra checks, not a Bitcoin Script interpreter, complete protocol model, regtest harness, or external audit. Application typecheck/tests/build were not run because this branch contains documentation and standalone research models only.

Latest audit reproductions (original harnesses remain unchanged):

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-fee-audit.ts          # 16 rows, port 19799
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-distributed-audit.ts  # 24 rows, port 19899
```

## Latest supported research suites

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-lifecycle-v3.ts  # 34 checks, RPC 19899
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/deadline-budget.ts     # 22 checks, RPC 19999
```

Use Core 31.1. The deadline test deliberately limits miner templates to 40,000 weight units and records actual fee-ranked block contents. It is not a mainnet fee forecast. Run historical suites at their originating commits: shared `party.ts` and `lib.ts` have evolved, including an additional crash point and corrected wire context.

## Current controller suites

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/controller-invariants.ts # 15 checks, RPC 20299
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-controller-fixed.ts # 8 scenarios, RPC 20399
```

Tested with Core 31.1 and Node 26.7 (`node:sqlite`). See the latest review for the persistence scope, deliberate negative cases, source commits, and unresolved production requirements.

## Current admission/index/ownership suites

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/aio-invariants.ts # 16 checks, RPC 20699
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-aio-fixed.ts # 20 scenarios, RPC 20799
```

Use Core 31.1 and Node providing `node:sqlite`. The sponsor pool now requires an explicit owner script, and the index uses schema version 2. Do not silently migrate or reset old funded state. See the latest review for coverage and integration limits.
