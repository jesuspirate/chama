# Codex review: hostile fees and distributed recovery

2026-09-10. Reviewed Claude commit `eae1e8e`. Research only; no production application changes.

## Verdict

Keep Chama and the constrained per-trade transaction graph. The new tests materially improve the evidence for local replacement mechanics and cross-process signature verification. They do not establish symmetric attack costs, affordable deadline settlement, or a complete recoverable transport protocol. Harden the setup lifecycle before extracting `party.ts` into production.

## Independent reproduction and counterexamples

Instrumented copies preserve Claude's original harnesses and result files. Both use the shared research builders and original participant implementation. These are reproductions and targeted extensions, not an independent implementation of the cryptography.

- `harness/codex-fee-audit.ts`: 16 rows (Claude's 14 plus two new probes), Core 31.1, RPC port 19799. One inherited row is explicitly a structural assertion, not a node probe.
- `harness/codex-distributed-audit.ts`: 24 rows (Claude's 22 plus two new counterexample checks), Core 31.1, RPC port 19899. The two added checks deliberately PASS when they reproduce the known defects; a green report does not mean those defects are fixed.

### The attacker offers a fee; eviction does not burn it

The measured replacement threshold reproduces: a 153-vB honest child replaces the 12,000-sat padded attacker child at 12,016 sats under the tested node policy. But after replacing it and mining the honest child, `gettxout` still returns the attacker's full 200,000-sat sponsor input. The attacker paid **zero confirmed transaction fee in that outcome**. The honest child paid **12,016 sats**. The attacker needed capital to make the offer and risked paying if its own child confirmed; it did not irreversibly spend that capital merely by entering the mempool.

A 2,000-sat honest replacement is rejected. This is an affordability counterexample, not a demonstration of a missed deadline. An attacker package may confirm the very ruling the honest party wants. The rational response may be to wait, depending on the deadline, package feerate, and competing spends. Do not implement automatic fee matching without evaluating that choice.

Therefore retract “whatever the attacker burns,” “nearly symmetric,” and any implication that +16 sats bounds the honest party's total risk. The increment is specific to the tested transaction size and configured policy, not a protocol constant. The original harness hardcodes `minRelay = 1` despite the report using Core's 0.1 sat/vB default; the audit reads the node's actual relay fee for that metadata.

TRUC restricts topology and improves replaceability; it does not promise affordable confirmation or an irreversible attacker expenditure. Its protection is also scoped to adopting nodes. See [BIP 431](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki), especially absolute-fee pinning and the scope of TRUC policy.

The empty-block result is useful but cannot justify “a pin only delays” as an economic safety guarantee: in a conditional trade, delay can let a conflicting refund/default payout win. That outcome still requires an explicit deadline test here.

### Cross-process setup is real progress, with a narrower recovery claim

Locally rebuilt templates and verification of received bare signatures are the right design. The tested named crashes, forged signature, and changed-template rejection are useful evidence.

Two additional tests expose missing lifecycle handling:

1. Complete A/B/R setup, then restart the completed A and R stores. Both exit with timeout code 3 rather than returning success. They republish artifacts, but terminal phases have no completion path in the main loop.
2. Put a truncated JSON message (`{`) in the relay before running A. Parsing throws and A exits 1. Signature filtering does not handle malformed input. Direct writes to visible relay filenames also permit readers to see partial files.

Further findings from source inspection, not exploit demonstrations:

- Signed envelopes contain `from`, `kind`, and `payload`, without an explicit contract identifier, protocol/network domain, or terms hash. `READY` has an empty payload. Transaction signatures bind templates, but readiness messages do not bind a specific setup. Fresh identities and a separate directory for each test hide cross-contract replay scenarios. Bind readiness to the complete local recovery bundle and immutable contract context; an authenticated claim still cannot prove a remote device actually persisted its data.
- Recovery commands require an external shared `terms.json`. The literal claim “store alone” is too strong: the store must include authenticated immutable terms and all reconstruction material. Test by deleting the relay and coordinator files, then recovering from a copied participant backup in a fresh directory.
- The appeal role P has a public key in the graph but no participant process or recovery store. Distributed recovery currently exercises the first-instance arbiter R, not end-to-end appeal execution by P.
- B treats an authenticated `FUNDED` message as completion without independently checking the claimed txid and chain confirmation. Funding announcement, mempool acceptance, and confirmed funding need distinct application states. Never release the external trade leg based solely on this message.
- The crash-loop funding assertion accepts either a UTXO (including mempool) or a mempool entry, records “on chain,” then mines. Assert confirmations after mining to support that label.
- File fsync plus rename and injected process exits do not demonstrate power-loss durability. Specify the storage durability contract, including directory-entry persistence where needed, and handle backup rollback/corruption explicitly. Processes run under one OS user and share coordinator-provided terms; this is process separation, not hostile host isolation.

## Next milestone: a recoverable contract lifecycle with an explicit fee budget

Do these in order; no FROST or real-money integration is needed to establish the first two.

1. **Harden local setup and backups.** Bind all messages to canonical contract context, validate bounded message schemas before crypto, ignore malformed/unknown/replayed input safely, publish atomically, make terminal-state restarts idempotent, and place authenticated terms in each backup. Add an independently stored P participant with a single ordinary key first. Require a fresh offline restore to reconstruct every authorized ruling, reversal, default collection and refund relevant to that role. Principal signatures must be complete and verified before funding is signed.
2. **Test deadline behavior and reorg recovery on regtest.** Give the honest side a fixed confirmed fee reserve and budget; exercise repeated adversarial bids, occupied blocks, conflicting refund/default spends at exact boundaries, and the choice to wait for an attacker-sponsored parent. Record offered fees separately from fees paid by confirmed transactions. Reorg funding and ruling blocks; check sponsor availability, descendant rebroadcast, confirmation-derived timers, and whether the intended payout actually confirms. There is no universal finite reserve that defeats arbitrary fee pressure: define an operating envelope and report failure outside it. A single regtest node can already test budget failures and invalidated blocks; heterogeneous networking is a separate milestone.
3. **Then substitute real Nostr transport and run across devices.** Repeat the same lifecycle tests with loss, duplication, reordering, censorship and stale replay. NIP-44 encryption does not supply the missing contract/state binding by itself. Only after the ordinary P role works should a BIP-340-compatible threshold implementation replace its signer interface.
4. **Extract a research-tested `contract-core` module into Chama.** Separate contract construction/validation, participant storage/state, chain monitoring and fee sponsorship from the Nostr transport. Preserve legacy funded-wallet recovery and keep backend guarantees explicit. Keep Fedimint for supported wallet/payment use; it does not inherit this Bitcoin transaction graph's guarantees automatically. Native conditional Cashu/Fedimint settlement remains a separate backend design.

The target is enforceable payout constraints plus an explicit availability/fee threat model. Honest real-world arbitration is still an assumption: a quorum can select one authorized but dishonest verdict. These tests do not remove that boundary.

## Reproduce

```sh
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-fee-audit.ts
BITCOIND=/path/to/bitcoind node_modules/.bin/tsx docs/protocol-research/harness/codex-distributed-audit.ts
```

The audit copies intentionally leave defects in `party.ts` intact so the counterexamples remain reproducible. The fee audit retains inherited historical labels except where it corrects the central burn claim; consult this review for the scope of those labels.
