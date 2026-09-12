# Codex: admission, index durability and sponsor binding

Reviewed `771625d`, Claude round 6. Research changes only; no production deployment, funded-wallet migration, or application money-path changes.

## Verdict

Keep these components and the existing transaction graph. Claude's twenty checks reproduce. Additional checks found unsafe policy acceptance, non-atomic indexing, lost rescan requests and a sponsor-binding bypass. Those are fixed in the research modules. Sixteen added checks and the original twenty scenarios now pass on Core 31.1.

The components are still standalone. `party.ts` does not yet call admission before signing, and the existing observer/controller have not yet been switched to this index. Therefore “refuses a contract before any signature” describes the intended placement of the policy helper, not an integrated invariant already demonstrated by these tests.

## Findings and changes

### Admission: reject invalid numbers and state the fee assumptions

The original helper admitted NaN as a fee cap, infinite liquidity, a negative stage size, and fractional CSV block counts. Comparisons against NaN simply failed to reject. The revised helper validates numeric domains and safe arithmetic before calculating a report. Missing policy structure is rejected as well.

The appeal interval had an off-by-one at equality. If a ruling confirms at height h, the default with relative block delay W is eligible at h+W. Under the chosen confirm-parent-before-child relay procedure, only h+1 through h+W−1 are exclusively available to the appeal. Admission now compares expected appeal duration plus margin against **W−1**. With expected duration 36 and margin 24, W=60 is rejected: it provides 59 exclusive blocks. This follows [BIP 68](https://github.com/bitcoin/bips/blob/master/bip-0068.mediawiki), and remains consistent with the prior executable deadline tests.

A high feerate assumption also does not bound an adversary's absolute replacement bid. I added optional explicit `competingFeeCeilingSats` assumptions for each stage. With 12,000-sat competing bids on both stages, the earlier 20,000-sat cap fails admission: the calculated requirement is 24,034 sats. Without such bounds the report explicitly says its rate estimate does not cover adversarial replacement costs. Stating a bound does not enforce it against an attacker.

The historical `worst*` field names remain for compatibility. They are conditional estimates, not universal worst-case guarantees. Package sizing, the current fixed 153-vB incremental-fee allowance, dust/change requirements and fee fractions still need to be derived from actual planned transactions during integration.

The liquidity formula is conservative and scalar. If the supplied “unreserved liquidity” already excludes every UTXO backing other signed ceilings, adding those ceilings again double-counts some commitments. More importantly, an aggregate value cannot prove a feasible sponsor-coin selection or atomically allocate it. Integration must settle that input convention and use an actual allocation plan, rather than treating this pure report as a reservation.

### Index: matches and cursor must share the transaction

`scanBlock()` originally inserted `txs` and `spends` before the transaction that updated `blocks` and the cursor. The code comment acknowledged this but did not fix it. A SQLite trigger that aborts the cursor/block update demonstrated the defect: a watched transaction at height 111 remained indexed while the cursor was still 110.

Now RPC fetching is separate from mutation. Watched transaction rows, spend rows, block hash, cursor and rescan progress commit in one SQL transaction. The same injected failure leaves no transaction row and the cursor stays at its predecessor. SQLite can only provide atomicity for mutations actually included in the transaction; see its [atomic-commit description](https://sqlite.org/atomiccommit.html).

Late-registration coverage was also volatile: `pendingRescanFrom` existed only in memory. Closing and reopening after registration lost the rescan. An error during the rescan cleared it before work completed, with the same result on restart.

The request and its progress are now persisted. Re-registering an existing watch with an earlier birth broadens its coverage. Rescanning rewinds both data and cursor consistently, rather than inserting old rows beneath a cursor still claiming newer coverage. Restart after registration or missing history resumes the required work.

Additional protections and executed checks:

- Two independent index connections cannot both commit based on a stale cursor. One proceeds; the other receives `ConcurrentIndexUpdate` and must retry.
- Watch revisions are checked around asynchronous work so a newly required rescan is not overwritten by older progress.
- Blocks must match the requested hash/height and the indexed predecessor, and still match the active block at that height before commit.
- An actual reorg injected during block retrieval produces `ChainChanged`, without indexing the orphan transaction. Retrying indexes the replacement branch.
- Sync checks its target tip before reporting completion. A later chain change is always possible; returned observations remain tied to that tip.
- Old index schema is rejected for explicit rebuild rather than trusted as though its prior writes had been atomic.
- Explicit `rescanFrom` must cover every registered watch's birth. It cannot silently discard older required history and call the remaining index complete.

`HistoryUnavailable` and `ReorgTooDeep` remain explicit failures. A caller must not interpret `status(txid) === null` as proof of active-chain absence unless the watch is registered with adequate birth coverage and sync has succeeded. After partial progress or an error, the stored cursor describes indexed progress, not current authorization to spend or release an external trade leg.

“Bounded” refers chiefly to retained block hashes for reorg detection. Watched records can accumulate, and late registration may still require reading a long range of historical blocks. Pruned history, processing budgets, record retirement and recovery UI remain production concerns.

### Sponsor ownership: bind the database to the actual script

The original pool trusted the ownership script supplied to each `reserve()` call. Registering another device's coin locally, then passing that coin's script, successfully reserved it. The earlier foreign-coin test only tried an outpoint absent from the local database and therefore missed this.

The constructor now requires and stores the device's P2TR sponsor script. Subsequent calls cannot substitute another script. Device label and script are checked together on reopening. Legacy databases without this binding require explicit migration. The `reserveForeign` convenience method can no longer bypass chain validation.

Registration is inventory, not proof of ownership or value. The old code accepted a 50,000-sat coin registered with amount 999,999 and returned the false amount. Reservation now checks the actual script, confirmations and amount, includes mempool spends when checking availability, and propagates RPC errors rather than treating them as ordinary absence.

A new `available()` query returns currently verified coins and their sum, attached to an observed tip. A test registry containing wrong-owner, wrong-amount and nonexistent coins totals 2,059,999 sats on paper; live validated liquidity is zero. `unreservedSats()` is retained only as a registered-inventory counter. It must not be supplied directly to admission as confirmed liquidity.

`available()` is observational, not atomic admission-plus-reservation. Its result can become stale. The signing path still needs an authoritative transactional allocation and revalidation.

The admitted clone/global-cap limitations are correct. Device ids are configuration metadata, not anti-cloning hardware. A faithful clone with the same id, script and copied state remains undetected. If every device holds the same master seed, each can derive the other devices' keys too; real device key isolation requires provisioning only the intended derived key/account capability. Per-device caps remain per-device; a global contract cap needs agreed shares or coordination.

## What to build next

Build one integrated setup path before adding more independent helpers:

1. Bind immutable contract context and a versioned policy report to locally reconstructed funding/ruling/appeal templates, using measured sizes and explicit timing/fee assumptions.
2. Use one authoritative reservation ledger per device. The new device pool and existing fee controller currently have separate reservation records; do not turn them into two independent sources of truth. Put device ownership, selected coins, contract allocation and signed-fee commitments behind one transaction/recovery protocol.
3. Persist that allocation and recovery bundle before signing. Revalidate after restart, chain movement and competing setup requests. A declined policy, inadequate coin set, or incomplete index must leave funding unsigned.
4. Switch the observer and fee reconciliation to indexed history through an interface that exposes coverage, tip identity and explicit errors. Register all contract templates, fallback spends and fee variants with appropriate birth heights. Test missing history and reorg errors through the *consumer*, not just through the index class.
5. Drive the existing lifecycle/congestion tests through that path. Include two concurrent setups whose individually acceptable reports overbook one device's liquidity, and crashes between allocation, signature persistence and publication.
6. Then real Nostr relays across devices, with the same durable state and allocation rules. Preserve existing funded-contract recovery during eventual Chama extraction. FROST remains a signer-interface change after this path works.

This is the same architecture. The new evidence narrows the remaining task to integration and recovery semantics. It does not make arbitrary congestion, faithful device clones, or dishonest fiat/goods judgments disappear.

## Evidence and reproduction

- `harness/codex-aio-baseline-results.json`: original twenty scenarios at `771625d`, reproduced before edits.
- `harness/aio-invariants-baseline.json`: initial diagnostic probes. Two early probes were weaker: the earlier-birth case did not isolate re-registration, and the last probe only checked live-query API availability. The current suite strengthens both; do not use the baseline row count as a count of independently proven defects.
- `harness/aio-invariants.ts` / `aio-invariants-results.json`: sixteen current checks, all pass.
- `harness/codex-aio-fixed.ts` / `codex-aio-fixed-results.json`: original twenty scenarios with the new explicit constructor script binding, all expectations match. The clone and global-cap negatives remain deliberately acknowledged limitations.

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/aio-invariants.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-aio-fixed.ts
```

Core 31.1; Node with `node:sqlite` (tested with 26.7); installed repository dependencies. RPC ports 20699 and 20799. Tests use temporary regtest coins/databases. The atomicity test injects a SQL failure; it is not a hardware power-loss test.

Changes are confined to research code/docs. Application-wide typecheck/tests/build were not run; the two targeted suites are the validation for this change. Historical harnesses that use the old pool constructor or index schema should be run at their source commits, not interpreted as compatible with the revised modules.
