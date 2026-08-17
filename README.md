# Chama

[![CI](https://github.com/jesuspirate/chama/actions/workflows/ci.yml/badge.svg)](https://github.com/jesuspirate/chama/actions/workflows/ci.yml)

Chama is a Nostr-native peer-to-peer marketplace with non-custodial escrow. There is no central Chama account server or custody layer: clients coordinate encrypted trade events over Nostr and interact directly with a selected Fedimint federation.

A trade can be held two ways. **Ecash** (the default) is instant, carries no miner fee, and settles inside the federation. **On-chain** holds the sats at a Bitcoin address built from three keys — both traders and their arbiter — with three spend paths: cooperative settlement, arbitration gated behind a consensus-enforced delay, and a timelocked refund to whoever funded it. On-chain is opt-in and available on larger trades, where a miner fee is small against the amount. Clients always recompute an escrow address from the trade's own terms and never trust one that arrived over the network.

## Run locally

Requirements: Node.js 22+, npm, and a NIP-07 signer extension such as Alby or nos2x.

```bash
npm install
npm run dev
```

The development server runs at `http://localhost:3000`.

### StartOS package (lab — 3 clients)

This package is a **local lab**: three co-located Chama UIs (ports 8080–8082), each with its own native Fedimint bridge under `/data/client-*`. It is **not** the friend-wallet / remote-bridge host.

Requirements: Docker, `start-cli`, `jq`, Node 22+, and a packaging workspace (this repo’s `.startos` link). The npm `@start9labs/start-sdk@1.5.3` pin may not ship `s9pk.mk`; the Makefile falls back to `$HOME/start9-workspace/.../s9pk.mk` or accepts:

```bash
make START_SDK_MK=/path/to/start-sdk/s9pk.mk x86   # or: make arm
npm run startos:check   # package TypeScript only
make install            # sideload on a StartOS box matching the arch
make publish            # personal registry
```

Package icon must be `icon.svg` or `icon.png` ≤ 40 KiB (StartOS marketplace limit).

Before opening a pull request:

```bash
npm run predeploy
npm run build
```

`predeploy` checks repository hygiene, TypeScript, and the escrow-engine test suite.

## Architecture

| Area | Responsibility |
| --- | --- |
| `src/escrow-engine/` | Deterministic escrow state machine, event validation, encrypted Nostr coordination, relay discovery, and replay |
| `src/fedimint/` | Federation selection, ecash operations, recovery, and browser/native bridge adapters |
| `src/bond-multisig/` | On-chain single-key CLTV commitment bonds and chain verification |
| `src/arbiters/` | Arbiter rosters, bonded-arbiter selection, exposure, premiums, and earnings |
| `src/ui/` | React application and platform-neutral product UI |
| `native/fedimint-bridge/` | Rust Fedimint client used by native platforms |
| `android/` | Capacitor Android application project and native bridge packaging |
| `src-tauri/` | Tauri desktop shell and sidecar configuration |
| `public/` | Production web assets copied into web, Android, and desktop builds |

The core trade chain uses Nostr kinds `38100`–`38113` (with retired kinds reserved). Governance, roster, and chain-verifiable bond announcements use separate kinds. Sensitive trade content and ecash material are encrypted for participants.

### Platform builds

```bash
npm run android:sync   # build web assets and sync the Android project
npm run tauri:build    # build the desktop application
```

Android builds require the Android SDK/NDK; see [docs/ANDROID_BUILD.md](./docs/ANDROID_BUILD.md). Desktop builds require Rust and the platform dependencies expected by Tauri. The native bridge build scripts under `scripts/` are invoked by these platform builds.

## Repository boundaries

This repository contains product source, tests, platform projects, public assets, and reproducible build/release automation. Draft designs, generated media, migration records, private infrastructure notes, agent memory, and social-content logs do not belong here. Keep temporary work under the ignored `outputs/` or `tmp/` directories.

The Zapstore screenshots are retained because they are referenced by `zapstore.yaml` and are part of the public Android store listing. GitHub workflows are retained because they run CI and build desktop release artifacts.

For a visual technical introduction, see [chama-technical-overview.pdf](./chama-technical-overview.pdf). Relay operators can consult [docs/RELAY_OPERATIONS.md](./docs/RELAY_OPERATIONS.md).

## License

[MIT](./LICENSE)
