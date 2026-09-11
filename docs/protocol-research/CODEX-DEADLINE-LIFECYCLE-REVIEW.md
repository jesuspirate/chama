# Codex: executable deadline limits and lifecycle fixes

2026-09-10. Reviewed Claude's `ed6b2ff` (round 4). No production application code, wallet migrations, deployment, or real funds changed.

## Verdict

Keep Chama and the fixed-payout transaction graph. Claude's 26 lifecycle rows and 18 fee rows reproduce on Bitcoin Core 31.1. The milestone was not complete: the contract hash omitted nested terms, and a terminal-state shortcut skipped an unpublished funding announcement. Both are fixed in the research participant, with further lifecycle tests.

The remaining fee/deadline experiment is now implemented. Under controlled fee-ranked congestion, an affordable but unconfirmed ruling can lose to a mature refund; an affordable but unconfirmed appeal can lose to the CSV default. A larger sponsored ruling can confirm before the refund boundary and prevent that refund. No signature constraint was bypassed in these experiments. Bitcoin enforced the alternative payouts exactly as scripted.

This separates payout authority from timely enforcement. The graph constrains unauthorized destinations; it cannot promise the intended commercial outcome against arbitrary congestion, censorship, unavailable signers, or dishonest real-world verdicts.

## Evidence inventory

| Evidence | Recorded checks | Meaning |
|---|---:|---|
| Claude `ed6b2ff` lifecycle reproduction | 26 | All original expectations reproduced before editing the participant |
| Claude `ed6b2ff` fee reproduction | 18 | All original expectations reproduced before editing the participant |
| `harness/codex-lifecycle-v3.ts` | 34 | Original scenarios plus context, publication, schema, live-status, and offline fallback checks |
| `harness/deadline-budget.ts` | 22 | Actual fee-ranked blocks, fixed budget, exact boundaries, alternate consensus outcome, and delayed ruling reconfirmation |

All recorded expectations match. The old-encoder collision row deliberately reproduces a defect; it is not a passing security invariant. The suites share Chama's signing library and research builders; this is not an independent cryptographic implementation or third-party audit. One inherited fee row is a structural statement rather than a node probe.

## Lifecycle findings and changes

### 1. Contract identity did not commit to the participants or funding outpoint

The old code used:

```ts
JSON.stringify(terms, Object.keys(terms).sort())
```

A JSON replacer array filters properties at every depth. The resulting encoding contained:

```json
{"W":20,"escrowSats":"100000","funderInput":{},"idKeys":{},"keys":{},"net":"regtest","refundHeight":511}
```

Changing the panel key, panel identity, funder txid, funder vout, or input amount left that encoding unchanged. The old replay test also changed a top-level refund height, so it did not isolate this flaw. This is an encoding collision, not a SHA-256 collision.

`contract-context.ts` now recursively sorts object keys while retaining every nested value. It preserves array order and rejects non-JSON values. The research wire version increments from 1 to 2 so old envelopes cannot silently enter the new protocol. N1 reproduces five old collisions; N2 checks those distinctions and nested insertion-order invariance with the corrected encoder. Existing transaction signatures still bound their own outputs: this finding alone was not an arbitrary-spend exploit.

This is a research wire change, not a migration strategy for funded Chama contracts. Production extraction must preserve historical contract versions and recovery.

### 2. An untested crash boundary could strand the counterparty

In the previous participant, A saved `phase=funded`, then published `FUNDED`. Crashing between those actions left A terminal; restart immediately returned success without publishing the message B was waiting for.

Added `A:funded-persisted-before-publish` to the crash matrix. On restart, the participant republishes persisted artifacts when the relay exists, then completes its terminal phase. An offline terminal restart still works without a relay. The new boundary passes, including B independently observing confirmed funding.

### 3. Envelope validation was not payload validation

A correctly authenticated but malformed `SIGS` message could claim the first message slot before payload validation, hiding a later valid signature set. Payload schemas are now checked before deduplication. N3 places an authentic malformed B message ahead of valid B signatures; all parties complete.

Terms also receive additional numeric/domain checks: block-based CSV within 1..65535, block-height CLTV, escrow amount bounds, and funder input format/range. This is not yet a complete production schema or backup integrity design.

### 4. Setup completion must not stand in for current confirmation

The previous reorg test invalidated funding and immediately re-mined it, without checking B's persisted confirmation flag in between. A completed setup's `fundingConfirmed=true` was a stale observation.

Added a read-only `status` command that queries the current chain and returns a fresh observation without racing the setup process to overwrite its state file. The stored confirmation flag remains historical; callers must use current status for current confirmation. N4 verifies it clears after invalidation; N5 verifies it returns after reconfirmation. A missing UTXO is reported as `spent-or-unknown`, not automatically as loss or cancellation. `run` returning success means setup completed; it does not mean the transaction remains confirmed. `status` is an explicit query, not a continuous chain watcher. RPC failure is an error, not an inferred safe state.

### 5. Offline fallbacks now execute

Added a funder-only `refund` command and exercised the existing `collect` command from copied stores after deleting relay and coordinator terms. Both transactions mine at their respective eligible heights. These research commands use a fixed 500-sat fee for construction tests; they are not the production fee-sponsorship policy.

## Deadline experiment and its scope

The node uses `-blockmaxweight=40000 -blockreservedweight=2000`. Background transactions each spend a confirmed 100,000-sat input, pay 20,000 sats, and return change. Contested blocks use ordinary `generatetoaddress`, with `getblocktemplate` captured before mining and actual txids/weights captured afterward. They contain about 38,600 weight units, with higher-fee background transactions selected ahead of the low-fee packages. This is scaled miner-capacity congestion, not full-size mainnet block simulation or a fee forecast.

Setup uses an explicit block for a large UTXO split that would not fit the deliberately small miner template. Explicit `generateblock` is also used for alternate-consensus and reorg experiments; those rows do not establish relay/miner selection policy. The main deadline races use ordinary fee-ranked mining.

### Funding to ruling versus refund

- Funding confirms at height 116; refund locktime is 120.
- On one ruling to B, the anchor bidder successively offers 1,300, 6,000 and 12,000 sats. The honest policy has a 2,000-sat cap. Its affordable replacement passes at the first bid and fails at the latter bids; the harness chooses to wait and does not broadcast those probe transactions. This models bid escalation against a fixed cap, not an alternating honest/attacker replacement ladder.
- Blocks 117–119 remain occupied and omit that ruling. The correctly signed refund is nonfinal at tip 119.
- A different contract's ruling, sponsored with a 90,000-sat fee, confirms in block 120 despite the same background traffic. Its later refund cannot spend the consumed funding output.
- At tip 120, the first contract's refund becomes final for candidate block 121. A 50,000-sat refund replaces the pending ruling package and confirms. The intended ruling to B loses; the scripted refund pays A.
- The anchor bidder's 500,000-sat sponsor remains unspent. Its offered anchor fee was not paid. A, the refund spender, paid 50,000 sats; the small-budget honest sponsor paid zero. The background traffic paid its own confirmed fees. This is not a claim of a universally free attack.
- After congestion clears, another attacker-sponsored ruling confirms without honest replacement: the bidder pays 12,000 sats and the honest side pays zero.

The 90,000-sat success is one tested operating point, not a minimum reserve, a recommended amount, or a universal defense. These values are deliberately extreme relative to the 100,000-sat test escrows.

### Ruling to appeal versus default

A ruling to A confirms at height 124 with W=4. A reversal to B and its 2,000-sat sponsor remain pending through occupied blocks 125–127.

- At tip 126, the default is not eligible for candidate block 127.
- At tip 127, the default becomes eligible for block 128 while the reversal remains pending.
- A 50,000-sat default replaces the appeal package and confirms at 128. A receives the default payout; B's intended reversal loses.
- In an explicit alternate block at that same height, the reversal instead confirms and pays B. The appeal branch has no expiry at default maturity. This last check proves consensus validity, not that ordinary relay will select that alternative.

These boundaries follow [BIP 68](https://github.com/bitcoin/bips/blob/master/bip-0068.mediawiki): a block-based relative delay W permits spending in block h+W when the parent confirms at h. Absolute `nLockTime=H` with enabled locktime first permits inclusion at H+1; see [BIP 65](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki) for the CLTV constraint on that transaction locktime. Avoid ambiguous phrases such as “spendable at H” without specifying chain tip versus candidate block.

### Actual delayed reconfirmation

Claude's M6c invalidated a block and mined one replacement block: it checked one confirmation again, but did not demonstrate a different numerical confirmation height or test a CSV spend.

The new R1–R3 sequence invalidates an earlier ruling block, inserts two explicit empty blocks, and reconfirms the ruling two heights later. The very same default transaction is rejected at the old first-eligible deadline and accepted at the recomputed deadline. The code using these heights still needs a continuous reorg-aware monitor; a test harness is not that monitor.

[TRUC/BIP 431](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki) improves replacement topology within adopting nodes. It does not promise cheap confirmation or prevent an authorized competing branch from winning during fee pressure.

## Concrete next build

Freeze this graph as the experimental candidate. Build the chain observer and bounded fee policy before replacing the directory transport:

1. **Chain observer:** track funding, both ruling alternatives, reversal/default/refund spends, best-block identity, confirmations, and eligibility heights. Separate setup completion, mempool observation, confirmed payout, and reorged payout. Unknown/spent state triggers investigation rather than an assumed refund. Recompute every timer from the active chain.
2. **Fee policy:** require confirmed sponsor liquidity; cap exposure per contract across both stages; distinguish offered fees from confirmed expenditure; decide whether an existing attacker-sponsored package is worth waiting for. Account for the lost time of confirm-parent-before-child. Persist every signed/broadcast bump and reservation so device restart cannot overspend or reuse a reserved input inadvertently.
3. **Replay the test scenarios through those components**, including an alternating replacement ladder, finite congestion that clears just before/after the deadline, insufficient budget, sponsor reorgs, and simultaneous contracts competing for one fee reserve. Assert the final authorized payout and budget accounting, not merely mempool acceptance.
4. **Then transport over Nostr across devices**, retaining the same contract encoding, validation, durable state, and chain observer. Add loss, duplication, reordering, censorship, and stale backups. Encryption alone is not session binding or delivery assurance.
5. **Then integrate the reviewed module into Chama and replace P's signer with FROST if warranted.** FROST must match Bitcoin's BIP-340 signatures and Taproot context; it changes who can authorize a verdict, not the fee/deadline result. Keep Fedimint's payment functionality; native ecash escrow remains a separate backend with separate trust assumptions.

Before production, choose a documented operating envelope: trade value, expected duration, arbitration/appeal response time, monitoring availability, confirmation policy, and affordable fee reserve. Larger windows and reserves improve tolerance within assumptions. No finite reserve or timeout gives guaranteed fair settlement under arbitrary fee pressure or censorship; removing a timeout trades that race for possible indefinite lockup.

## Reproduce and continue

Use Core 31.1, installed repository dependencies, and sequential commands:

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-lifecycle-v3.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/deadline-budget.ts
```

Ports: 19899 and 19999. Temporary regtest directories are removed at exit. JSON records include the new check results; the deadline report also includes actual contested-block txids and weights.

The original 26/18 reproduction JSON files name `ed6b2ff` as their source. To reproduce those exact baseline suites, use that commit in a separate worktree with installed dependencies. Historical audit scripts on the latest branch share a now-changed `party.ts`/`lib.ts`; use their originating commits for historical results. The latest supported continuation suite is `codex-lifecycle-v3.ts`.

Application-wide typecheck/tests/build were not run: changes are confined to research harnesses and documentation. The executed 34-row lifecycle and 22-row deadline suites are the relevant validation for this change.
