# Protocol boundary — step 0

This records the intended wall, not a completed extraction. Runtime behaviour,
events, reducer rules and UI remain unchanged. The agreement / custody /
settlement distinction follows [the escrow draft](nip-draft-escrow.md) and
[the companion architecture](companion-apps-architecture.md).

## Entry files

<!-- protocol-core-entry: src/escrow-engine/types.ts -->
<!-- protocol-core-entry: src/escrow-engine/event-parser.ts -->
<!-- protocol-core-entry: src/escrow-engine/state-machine.ts -->

These markers are the checker's roots. Its import closure includes type imports,
re-exports and literal dynamic imports. External packages are opaque dependencies;
this check does not traverse node_modules. Full reachable files are scanned,
including unused exports in a mixed module. A crossing is evidence to inspect,
not proof that replay executes that capability.

## Core and ports

The core parses verified signed events and already-decrypted participant payloads,
computes agreement state, and builds unsigned protocol events. Signing, decrypting,
delivery, persistence and moving sats belong to adapters. Signature and transaction
verification can remain pure computations supplied with explicit evidence.

The actual closure and its corrections to the proposed list are recorded below.

## Replaceable ports (future interfaces, not introduced in step 0)

| Port | Responsibility | Current implementation / seam |
|---|---|---|
| Transport | Fetch, subscribe, publish signed events and receipts | `src/escrow-engine/relay-manager.ts`; orchestration in `escrow-client.ts` |
| Signer | Public key, signing, participant encryption/decryption; never inferred wallet backup | `Signer` in `src/escrow-engine/escrow-client.ts`; `signers.ts`, `nip46-signer.ts` |
| Storage | Identity-scoped events, durable publishes and custody recovery; explicit failure | `src/escrow-engine/escrow-event-cache.ts`, `durable-money-publish.ts`, `src/storage/user-scope.ts`; native wallet stores remain separate |
| Clock | Explicit observation time, distinct from signed event time and chain height | Existing `nowSec` arguments; remaining `Date.now` defaults; app timers in `src/hooks/useEscrow.ts` |
| Custody | Fund, lock, redeem/refund; report holder, instrument, amount, deadline and recovery evidence | `src/fedimint/escrow-bridge.ts`, `fedimint-client.ts`, SDK/native adapters; Taproot orchestration in `src/hooks/useEscrow.ts`, pure transaction helpers under `src/bond-multisig` |
| Notifier | Wake an app without deciding money state | `src/notifications/wake-index.ts`, native/web wake adapters and `scripts/vps-webpush-watcher/watcher.mjs` |
| Chain data | Fetch heights, blocks, UTXOs and confirmations; supply evidence to pure verification | `src/bond-multisig/fund-watcher.ts` (`esploraFetcher`), `esplora-config.ts`; observer orchestration in `src/escrow-engine/onchain-attention.ts` |

Custody must say who holds the sats and until when. Fedimint bearer notes and a
Taproot output have different holders, spending authorities and recovery clocks.
A Nostr identity alone is not an ecash backup. The port must not erase a funded
wallet or treat a timeout as evidence of zero funds.

Everything outside the eventual pure closure is adapter or app orchestration:
UI, hooks, bridge, wallet SDK, payments, notifications, storage and network I/O.
A reachable mixed file must later split its pure exports from its adapters;
being in today's import closure does not make its I/O part of the future core.

## Baseline and replay proof

`node scripts/check-protocol-boundary.mjs` is report-only and always exits zero,
even if inspection fails (an error is printed). It does not enter predeploy.
The committed baseline lists each rule/file/line and the whole import closure.
The checker uses TypeScript syntax trees so prose/comments are not capabilities.
It is a conservative source check, not whole-program capability analysis: aliases,
computed imports or properties can escape it and require review.

Golden capture preserves full raw event objects in input order, exact parsed inputs,
creator options, observed `nowSec`, final state and the complete success/error result. `parsedEvents` stores raw-parser output where key-free parsing succeeds; `replayOverrides` preserves fixture-only context or deliberate parsed-field overrides separately. Replay uses those overrides without claiming they came from the raw event.
Existing replay tests include synthetic signatures and modeled decrypted content;
those are explicitly classified and are not claimed to authenticate a chain.
Parsed inputs are necessary because some tests deliberately override parsed fields
without changing raw content. The raw events are never rewritten or re-signed.
Golden replay tests the reducer boundary and also checks parser equality for every raw event that parses with its own content and no decryption keys or context. It does not claim coverage of encrypted/decryption or transport paths.

## Verified closure and corrections

The three roots reach **39 repository files** at main `8036bd2c`. The full-file
closure is in `docs/evidence/protocol-boundary-baseline.txt`.

| Group | Reachable files (relative to `src/`) |
|---|---|
| Agreement / pure escrow helpers | `escrow-engine/{types,event-parser,state-machine,trade-identity,recipients,holder-shares,arbiter-substitution,onchain-funding-terms,onchain-settlement-choice,onchain-settlement-transport,onchain-stalled,tranche,tranche-plan,slice-policy,client-tag,experimental-escrow-features}.ts` |
| Circle law and data | `chama/{policy,circle,rotation,types}.ts` |
| Arbiter selection and its evidence dependencies | `arbiters/{pool,exposure,roster,bonds}.ts` |
| Bitcoin transaction / verification dependencies | `bond-multisig/{onchain-escrow,onchain-escrow-funding,onchain-escrow-settle,multisig,commitment-bond,bond-announcement}.ts` |
| Mixed modules reached transitively | `bond-multisig/{commitment-store,esplora-config,fund-watcher}.ts`, `communities/registry.ts`, `media/listing-image-upload.ts`, `sim/simMode.ts`, `storage/{user-scope,random-id}.ts`, `fedimint/federation-invites.ts` |

Corrections to the proposed core list:

- Add `slice-policy`, `client-tag` and `experimental-escrow-features`, and the
  circle / rotation dependencies reached from `chama/policy`.
- `arbiters/pool` pulls in roster, exposure, bonds, registry and federation
  constants; it is not wholly pure. Only explicit-evidence selection functions
  belong on the core side. Registry/storage/network lookup does not.
- Reducer Bitcoin verification reaches the named transaction helpers, not every
  `bond-multisig/*` file. It also reaches mixed watcher, config and store modules
  through their imports; those need eventual separation, not blanket inclusion.
- `eventIsSim` and listing-image reference validation are pure exports, while
  their modules contain browser/storage and upload functionality respectively.
  These are mixed files, not core upload/session services.
- The graph walks type-only imports too. That captures source coupling without
  claiming those imports execute in a runtime bundle.

## Known crossings

The report has **66 distinct rule/file/line crossings**: 42 localStorage,
2 window property accesses, 3 fetch calls, 17 Date.now defaults, and 2 imports
into the app/adapter path families. Other requested rules have count zero.

- Pool / roster / bond evidence, community registry and scoped stores read local
  storage. Defaults and persisted authority must eventually be supplied explicitly.
- `simMode` mixes signed-event tag classification with browser URL/session setup.
- Image reference parsing shares a file with the upload fetch adapter.
- Bitcoin verification's reachable mixed files also contain explorer fetches,
  funding watchers, wallet stores and default clocks.
- `canVote` uses wall-clock defaults when callers do not pass observation time.
- The two adapter-path imports are pool and registry imports of federation invite
  constants. They are source-boundary crossings, not wallet operations during replay.

The requested rules do not cover every host dependency. `storage/random-id.ts`
uses `crypto.getRandomValues`, and pool configuration reads `import.meta.env`.
These reachable capabilities also belong outside a pure agreement computation;
nonce/configuration inputs must be explicit in later extraction. They are not
silently counted as Math.random or browser-property matches by this baseline.

No crossing is fixed here. The baseline remains report-only until extraction
steps have their own review and equivalence proof.

## Regeneration contract

`npm run golden:capture` runs the seven existing suites with test-only fixed
fixture time (2026-10-09T12:00:00Z) and reproducible fixture entropy. It appends
one record per intercepted replay call, including replays executed by imported
fixture suites. Ordinary `npm test` never writes the corpus or freezes its clock.
Timers and performance clocks remain real during capture; wallet deadlines, payment last-used timestamps and the existing test wait helper use advancing elapsed time on the fixed calendar; tests' own explicit
clock overrides still apply. The capture helper pins and restores the observed
clock for each synchronous replay without changing the reducer.

`npm test` replays the committed records with recorded parsed input, order,
creator options and time; sorted object keys and sorted Set/Map arrays allow
exact comparisons, including refusal codes and messages. Signature status is
recorded separately. Fixture secret keys are not stored; only public keys,
signatures, payloads and test/model data are in the corpus. Capture audits for
nsec strings and private-key/seed field names.

Regenerate twice and compare byte-for-byte before accepting a new baseline.
A difference is a review signal: explain it in the PR rather than automatically
accepting it. Updating the baseline is never part of an ordinary test run.

Current corpus after capture coverage review: **56 records, 4,003,703 bytes**;
45 successful replays and 11 refusals. The main engine suite contributes 34,
two-truths 5, partial-relay 3, onchain-safety 1, chama-gate 2,
rejected-lock-recovery 7 (5 imported fixture replays and 2 direct calls), and
brief-6418 4. The dynamic mode-mismatch import is wrapped but only checks that
its function exists, so it contributes no invocation.

There are 20 valid-signature and 240 synthetic/modeled raw-event occurrences.
**31 key-free raw parser outputs** deep-equal stored parsed events. Fixture cycle
context is kept separately as a replay override; it is not reconstructed from
raw content. The original 54 records retain identical raw events, actual replay
inputs, clocks, options, signature classifications and results; the additional
2 records close a capture gap, not a protocol behaviour change. Two complete
captures compare byte-for-byte equal. No signing secret, nsec or wallet seed
is exported; fixture signatures and public/model evidence remain distinguished.
