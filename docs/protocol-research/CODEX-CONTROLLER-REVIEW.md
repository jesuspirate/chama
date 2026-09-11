# Codex review: controller concurrency, history and signed fee liabilities

Reviewed Claude commit `444834f`. Research branch only; no production wallet changes or deployment.

## Verdict and evidence

The direction is right: keep the transaction graph, observe the chain, and enforce a bounded fee policy. The eight reported scenarios reproduce. However, their assertions missed intermediate accounting failures and actual concurrency. The initial independent eight-check audit failed seven checks; the corrected and extended audit now passes fifteen. The original eight congestion scenarios also pass through the revised modules.

Artifacts:

- `harness/codex-controller-reproduction-results.json`: original eight scenarios at `444834f`, reproduced before edits.
- `harness/controller-invariants-baseline.json`: initial eight checks, seven failures against `444834f`.
- `harness/controller-invariants.ts` and `controller-invariants-results.json`: latest fifteen checks, all pass.
- `harness/codex-controller-fixed.ts` and `codex-controller-fixed-results.json`: eight congestion scenarios, all pass after fixes.

The baseline absence test used simulated RPC failure and a synthetic parent; the latest version replaces that with a valid new parent and an actual process exit after persistence. Historical results name their source commit. Run the latest suites against current modules; use `444834f` for the original controller behavior.

## What broke

| Finding | Observed failure | Fix |
|---|---|---|
| Reservation read–await–write race | Concurrent calls both returned the same sponsor | Shared SQLite transaction with unique outpoint ownership; also tested from separate processes |
| Paid child reorged into mempool | Paid remained 2,000, offered remained zero | Recompute paid/offered from active transaction history on every reconcile |
| Paid child's change spent | Two reconciliations reduced paid from 2,000 to zero | Confirmation lookup survives consumption of every output |
| Ruling Q and anchor spent | Observer assigned the appeal's height to the ruling: 116 instead of 114 | Index the actual ruling transaction in its active block |
| Appeal recipient spends payout | Observer forgot the confirmed appeal and classified an escrow spend | Retain confirmed transaction history independently of UTXOs |
| Signed child absent from local mempool | Controller deleted the raw transaction and released its offer | Keep durable raw and exposure; retry unless confirmed conflicts invalidate it |
| Stale budget object saved | Older object overwrote a newer update | Revision checks inside the same transaction as persistence |

`gettxout` answers whether an output is unspent, not whether its transaction ever confirmed. A null result is insufficient to erase expenditure or derive a parent confirmation height. See the [Bitcoin Core RPC definition](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/).

Claude's C4 reorg row asserted the eventual total, not the intermediate paid-to-offered transition. Its final equality therefore passed even when accounting never reversed. Similarly, C5 called two controllers sequentially; it did not test simultaneous reservation.

## Revised persistence and accounting

The authoritative budget and reservation records now live in one SQLite database derived from the reservation-file path. `BEGIN IMMEDIATE`, a unique outpoint key, and budget revisions serialize mutations across connections/processes. WAL with synchronous FULL is configured. SQLite's [isolation documentation](https://www.sqlite.org/isolation.html) describes the transaction behavior relied upon here.

The previous JSON files are debug/compatibility projections only. They are never read to authorize a reservation or payment. Projection failure cannot undo a committed database transaction; callers must reload state after errors. A stale update fails rather than silently retrying with its stale object. Legacy JSON state without the new database is rejected for explicit migration, never reset automatically.

Sponsor candidates are checked against the node for confirmations, script ownership, amount and current unspent availability. Reservation ownership is checked again in the transaction that persists an offer. Signed transaction variants are retained. A process can exit immediately after that commit; a fresh controller reads the saved raw, retains the 2,000-sat exposure, submits it, and counts 2,000 paid once it confirms.

There are three distinct budget values:

1. **Paid:** our fee transactions confirmed on the active chain, even if their change has subsequently been spent.
2. **Offered:** still-live signed variants not confirmed on the active chain. Local mempool absence alone does not revoke them. Confirmed conflicting spends can invalidate them on that chain; a reorg can restore their exposure.
3. **Signed ceiling:** the sum of the highest fee ever signed for each stage. This conservatively limits future authorizations across reorgs, even when a cheaper variant happened to confirm.

The third value is necessary. The new test signs a 2,000-sat ruling child, then a 2,500-sat replacement, and explicitly mines the older 2,000-sat child. With a 3,000-sat contract cap, a 700-sat appeal child looks affordable if accounting considers only the currently paid fee. But after a reorg the 2,500-sat variant could confirm alongside that appeal, totaling 3,200. The revised controller retains the 2,500-sat commitment and rejects the 700-sat authorization.

This is deliberately conservative: it does not reclaim all unused authorization headroom when competitors pay or cheaper variants confirm. Signed-offer reservation garbage collection is not implemented. `release` refuses to discard reservations with signed histories. A production design needs an explicit finality/retention policy instead of casually deleting those records.

The hard cap is checked at persistence, not only in `decide()`. The audit also attempts a 2,000-sat appeal after paying 2,000 for a ruling under a 3,000-sat cap; it is rejected before broadcast and durable accounting remains unchanged.

## Observer and fee policy

`active-chain.ts` reads confirmed transaction history from an unpruned regtest node, caches blocks by hash, rebuilds active indexes after a reorg, and retries if the tip changes during observation. It does not need Core's optional txindex. Ruling and appeal heights come from their own blocks; output spending no longer erases their existence. Unknown remains unknown rather than turning into an assumed refund on the next poll.

The index also records actual confirmed spenders. Broad labels such as `default-or-coop-spent-q` describe a known non-template spend; they do not identify a beneficiary, prove which witness branch was used, or prove commercial fairness. Production needs richer payout attribution and registered fallback transactions. The mempool snapshot can change immediately after observation; every observation remains provisional.

Two policy details changed:

- The template cutoff groups dependent transactions. A zero-fee parent plus its paying child no longer produces a zero cutoff just because the parent has zero individual fee. A deterministic fixture checks this. Connected-component average rates are still a heuristic, not a miner-inclusion oracle.
- In the last two safe candidate blocks, a competitor merely clearing that estimated cutoff no longer automatically causes `wait`. The controller computes a replacement within the cap or reports inability to afford it. At the competing branch's eligibility boundary it retains the configured stop-paying policy. Neither choice guarantees the intended payout.

The padded-attacker observation remains valid within its tested topology: a padded replacement needed a higher offered fee to beat the small honest child. That is not necessarily a fee the attacker pays. If the padded bid is rejected or evicted, there is no confirmed expenditure from that transaction.

## What this does and does not establish

All fifteen current invariant checks and eight congestion scenarios pass on Core 31.1. The executed process-exit case is not a power-loss, disk-corruption, or backup-rollback test. The controller treats its local API callers as trusted code; mutable budget objects are not an authorization boundary for remote input.

SQLite exclusivity applies only to controllers using the same authoritative database on a supported local filesystem. Two independent devices with copied keys and copied databases can still sign conflicting transactions or exceed a combined policy cap. This is a central operational decision for fee sponsorship, not something Nostr encryption solves. A fee sponsor coordinates its own fee UTXOs; that does not require custody over the principals' escrow funds.

The observer is a correctness prototype, not a production index: initial sync walks the unpruned chain and cached history is not bounded/persisted for a mainnet deployment. Pruned history, long-lived indexing, recovery scans and subscription scheduling need implementation. `node:sqlite` uses the available Node runtime; this is not yet a browser-portable module. No full application typecheck/tests/build were run because only standalone research modules and docs changed; the targeted regtest suites validate this change.

## Next concrete step

1. Decide fee-sponsor ownership: one authoritative local service/database, or separate non-overlapping sponsor UTXOs for separate devices. Do not copy one writable fee wallet across devices and claim these locks coordinate it.
2. Add a setup admission report: stage sizes, an assumed fee range, confirmed liquidity, the per-contract signed ceiling, and time margins for both stages. Reject setups outside the chosen operating assumptions. Such a report is a policy check, not proof against arbitrary future congestion.
3. Replace the research chain scan with a bounded persistent index and explicit recovery/rescan behavior. Test dropped observations, pruned/missing history, disk failures and restored stale backups.
4. Run the existing participant protocol over real Nostr transport across devices. Keep trade keys local and fee-sponsor coordination explicit. Then consider production extraction and FROST behind the already-tested role signer interface.

No transaction-graph redesign is warranted by these findings. The difficult remaining work is consistent recovery and operation under stated availability/fee assumptions. Bitcoin still cannot judge truthful fiat or goods delivery, and finite fees/timeouts do not remove that boundary.

## Reproduce

Use installed repository dependencies, a Node runtime providing `node:sqlite` (tested with Node 26.7), and Core 31.1:

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/controller-invariants.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-controller-fixed.ts
```

RPC ports 20299 and 20399. Temporary wallets, SQLite databases and regtest nodes are created and removed by the harnesses. Only research results are committed.
