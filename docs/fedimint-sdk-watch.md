# Fedimint Android SDK watch

Checked 2026-10-02. This is a migration assessment; nothing in the v6.5 plan changes.

- Maven coordinates: `org.fedimint:sdk`. [Central metadata](https://repo.maven.apache.org/maven2/org/fedimint/sdk/maven-metadata.xml) currently lists only `0.1.0-beta.1`; `0.1.0` is not published there yet.
- Repository: [fedimint/fedimint-sdk](https://github.com/fedimint/fedimint-sdk), specifically its [Android SDK](https://github.com/fedimint/fedimint-sdk/blob/7a2843316db2253452a8f9741a08d2002d505425/android/README.md). Assessment pinned to `7a2843316db2253452a8f9741a08d2002d505425`.
- Eventual dependency: `implementation("org.fedimint:sdk:0.1.0")`, **after publication and verification**. A non-beta 0.1.0 is the evaluation trigger, not a guarantee of API compatibility: upstream reserves breaking changes for minor bumps before 1.0.

## What does our bridge do beyond fedimint-client, and could the Fedimint part be swapped for org.fedimint:sdk in-process once it hits 0.1.0 stable?

**Yes in principle on Android, but it is not a dependency-only swap.** Our Rust bridge already embeds `fedimint-client` 0.11.1 directly. Android launches that executable as a separate process and the WebView talks to its localhost HTTP API. The SDK instead packages Rust plus generated Kotlin/UniFFI bindings in an AAR, exposing federation handles, balances, ecash, Lightning, on-chain operations and observable operation states. A Capacitor plugin could translate those calls into our existing `IFedimintWallet` contract.

Chama's additional work must survive that translation:

- Gateway reachability deadlines, selection and persisted settlement-based health; Iroh configuration and discovery diagnostics.
- Payout outcomes that distinguish settled, confirmed refunded and uncertain/inflight; reconciliation by operation ID and Chama escrow metadata after a crash, without sending again.
- Reattachment to deterministic ecash reissue operations, on-chain policy/progress translation, and federation switching that preserves each wallet's storage.
- The HTTP contract, optional remote bearer authentication, and native process supervision. An Android plugin could replace local HTTP and supervision; desktop and remote bridge users still need their existing transport.

The largest risk is **existing funded wallet state**. Chama uses per-wallet `client.db` directories and stored mnemonic entropy; the SDK uses a `db` root with its own seed/registry records and federation namespaces. Shared RocksDB ancestry does not prove compatibility. Opening the SDK beside old data could create a different wallet. Never reset or silently replace the old wallet to make migration succeed. Seed restoration alone is not proof that bearer notes and pending operations survive.

**Sizing judgment: v6.6 can contain an isolated fresh-wallet prototype; treat production migration as a v7 candidate today.** Reconsider for v6.6 only after a stable-artifact spike proves gateway controls, escrow metadata/history access, interrupted-payment and reissue recovery, and funded-state migration with rollback. The SDK currently requires Android API 28 while Chama supports 24, so device coverage also needs a decision. Measure startup, RSS and restart behavior on the Pixel; moving Rust into the app process does not itself promise less memory use or eliminate native crashes.

Local evidence: [bridge implementation](../native/fedimint-bridge/src/main.rs), [Android host](../android/app/src/main/java/app/chama/market/MainActivity.java), [wallet adapter](../src/fedimint/native-bridge-adapter.ts), [minimum Android version](../android/variables.gradle). Upstream storage evidence: [SDK database layout](https://github.com/fedimint/fedimint-sdk/blob/7a2843316db2253452a8f9741a08d2002d505425/rust/fedimint-sdk/src/db.rs).
