# Per-bond announcements and recovery — 2026-10-06

Branch: `codex/per-bond-announcements`, from `wip/trade-flow-fixes` at `45d7097b` (including the reviewed bug-3 native-lock recovery change). No push, merge or live bond transaction was performed.

## Behavior

Kind 38135 readers accept both addressing formats. The `.22` writer defaults to the legacy `d=community` shape, keeping its community in `c` and the signed payload. `PER_BOND_ANNOUNCEMENT_WRITER_ENABLED = false` in `src/escrow-engine/experimental-escrow-features.ts` gates only new per-bond writes. When enabled, the writer uses `d=bond address`. Community readers combine `#c=community` with legacy `#d=community`; worldwide and owner reads already query the kind without a community `d` restriction. Selection retains each recomputable bond descriptor, choosing the newest signed announcement for that bond/community. Legacy announcements remain valid history. A legacy and new-format announcement for the same bond contribute once.

Dashboard and Manage merge sources by bond address. Manage lists local records, recovered records and verified announcements, including expired/withdrawn history. Known remote bonds remain visible while their private key cannot be recovered. Their announce/renew/reclaim actions stay disabled with the reason and Retry; recovered rows open the existing per-bond actions. Additional bonds cannot inflate the count of distinct arbiters. Community commitment totals include each funded, active address once, and ratings remain once per person.

Recovery reads the existing seed only. It never generates or replaces a seed. Automatic opening does not prompt an extension to decrypt a locked seed; Retry is the explicit unlock gesture. Missing seed, missing derivation index, incomplete announcement reads, chain errors and unconfirmed funds produce explanations rather than silently returning an empty state. Bond renewal, reclaim and subsequent wallet credit also use the recovery-only seed read.

“Find my bonds” accepts an address and unlock block, rebuilds candidate addresses from seed-derived keys, and restores a record only when the address matches and confirmed funds exist at the bond or its return address. It does not broadcast, announce or move funds. Searches are bounded to indices 0–200 and report a failure explicitly; a different original seed or an index beyond that bound requires further recovery. A wrong network, address or unlock block cannot produce a reclaimable record.

## Rollout and review

Ship dual-format readers in .22 while leaving the per-bond writer flag off. Flip the flag only after the client-tag probe shows the fleet is on .22; there is no automatic flip or user-facing toggle. Find my bonds stays enabled and saves only a local recovered record. Older clients that only ask for `#d=community` cannot discover new per-bond announcements. Existing legacy events are not deleted or republished with a changed signature. Previously replaced events cannot be recovered from the relay by changing the query; the explicit address/unlock-block lookup covers that case.

No script, timelock, payout or wallet identity is changed. Private reclaim keys remain seed-derived and are not stored in the public announcement. A verified row without recovered key material never becomes a signing action. Per-bond claim and renewal retain fresh chain checks.

## Verification

- Typecheck, full application tests and production build passed.
- Writer regression confirms the shipped flag is off, default writes retain `d=community`, explicit flag-on fixtures use separate bond addresses, and readers accept those events while the production writer stays off.
- New signed-event regression verifies two bonds in one community, both query shapes, legacy history, deterministic order, chain-verified deposits, two Dashboard/Manage rows, summed commitment and distinct-person counts.
- Recovery regressions cover locked seed with visible Retry, key-index failure, failed chain reads, explicit historical lookup, wrong unlock block, unconfirmed funds, deduplication after recovery and no automatic seed prompt or publication.
- Disposable 390 × 844 browser review covered locked-seed rows, Retry into two recovered rows, lookup disclosure/fields, four languages, dark/light themes and Escape returning focus to the caller. No horizontal overflow was observed. Preview files/server were removed.
