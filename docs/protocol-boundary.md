# Protocol boundary

Step 0 recorded the intended wall; step 1 (below) cleared every crossing and
turned the check into a gate. This is not yet a completed file move. Runtime behaviour,
events, reducer rules and UI remain unchanged. The agreement / custody /
settlement distinction follows [the escrow draft](nip-draft-escrow.md) and
[the companion architecture](companion-apps-architecture.md).

## Entry files

<!-- protocol-core-entry: src/escrow-engine/types.ts -->
<!-- protocol-core-entry: src/escrow-engine/event-parser.ts -->
<!-- protocol-core-entry: src/escrow-engine/state-machine.ts -->
<!-- protocol-core-entry: src/protocol/core/index.ts -->

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

Step 0 fixed no crossing. Step 1, below, fixes all of them.

## Step 1 — the core reads no device

The core's import closure (roots above, now including `src/protocol/core/index.ts`)
has **0 crossings**, down from 66. `node scripts/check-protocol-boundary.mjs --strict`
is part of `npm test`: any new storage, network, UI, platform or clock read reachable
from the core fails the build. Without `--strict` the script still prints the report
and exits zero.

Each mixed module was split at the pure functions the core actually uses. The pure
part moved to `src/protocol/core/` and the original module re-exports it, so no
caller changed. Function bodies were moved byte for byte.

| Core module | Taken from | What stayed behind (app side) |
|---|---|---|
| `sim-tag.ts` — `SIM_TAG_NAME`, `SIM_TAG_VERSION`, `eventIsSim` | `sim/simMode.ts` | URL flag, session storage, sandbox build |
| `listing-image-ref.ts` — photo reference validation | `media/listing-image-upload.ts` | Upload over the network |
| `arbiter-pick.ts` — `pickArbiterFromPool`, `pickPreferredArbiter` | `arbiters/pool.ts` | Trusted-arbiter settings, roster, registry, federation invites |
| `bond-announcement.ts` — kind 38135 build, parse, select | `bond-multisig/bond-announcement.ts` | `verifyBondAnnouncement` (block explorer) |
| `commitment-record.ts` — `CommitmentRecord` type | `bond-multisig/commitment-store.ts` | Saving and loading records |
| `chain-data.ts` — `EsploraFetch`, `BondFunding` types | `bond-multisig/fund-watcher.ts` | Explorer URLs, settings and fetch |
| `clock.ts` — `nowSeconds`, `setProtocolClock` | the ten `Math.floor(Date.now() / 1000)` defaults in `types.ts`, `state-machine.ts` (`canVote`), `arbiter-substitution.ts`, `chama/circle.ts` and the announcement builder | — |

The clock is the one port the core reads directly, and `clock.ts` is the one file
allowed to touch `Date.now`. Every former default now calls `nowSeconds()`, which
returns the same value unless a host installs its own clock. Replay never reads it.

**Equivalence proof.** All 99 golden records replay with identical results and final
states, and the full test suite passes, before and after.

**Not done yet (later steps).** The reducer, parser and types still live under
`src/escrow-engine/`; `src/protocol/core/index.ts` is the entry new code should use,
and moving the files is a separate mechanical step. The closure still includes pure
helpers in `chama/` and `bond-multisig/`. `crypto.getRandomValues` and
`import.meta.env` were never counted by the rules, and neither is reachable from
the core any more (`storage/random-id.ts` and the pool configuration left the closure).

## Step 2 — public conformance vectors

`docs/conformance/` publishes the golden corpus as conformance vectors: 99 event
chains with their replay clock and the exact state or refusal each must produce.
`scripts/export-conformance-vectors.mjs` derives them from `tests/golden/replay.jsonl`
deterministically, and `npm test` fails if they are stale. The runner,
`src/protocol/conformance.tests.ts`, replays every vector through
`src/protocol/core/index.ts` with the clock set through `setProtocolClock` and
`Date.now` made to throw: all 99 match, so replay reads no device clock.

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
