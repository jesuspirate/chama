<p align="center">
  <img src="icon.png" alt="Chama Logo" width="21%">
</p>

# Chama on StartOS

Chama is a self-hosted, Nostr-native peer-to-peer marketplace for local commerce. It has no central Chama account server and no custody layer: users publish and coordinate trades over Nostr, while the selected Fedimint federation or Bitcoin network performs settlement.

Trades can use instant Fedimint ecash escrow or opt-in on-chain Bitcoin escrow. Ecash is the default. On-chain trades use a Bitcoin address recomputed from the signed trade terms and offer cooperative, delayed-arbitration, and timelocked-refund spend paths.

This StartOS package serves the same Chama frontend as upstream through one interface and gives it one native Rust Fedimint wallet bridge. The package is infrastructure for one self-hosted Chama app, not a three-party trade simulator: buyers, sellers, and arbiters are independent Chama identities coordinating over Nostr.

- **Upstream repo:** <https://github.com/jesuspirate/chama>
- **StartOS package repo:** <https://github.com/Start9-Community/chama>
- **Website:** <https://getchama.app/>

## Runtime

The `chama-sub` subcontainer runs nginx, one `chama-fedimint-bridge`, and an entrypoint watchdog. nginx serves Chama on port 8080 and proxies `/bridge/` to the native wallet on loopback port 8787. The bridge is never exposed directly.

The entrypoint restarts the service if nginx or the bridge dies, including an unreaped zombie. nginx keeps the invoice proxy timeout at one hour because invoice settlement is a human-paced long poll; a short timeout can turn an ordinary scan delay into a misleading failure.

## Interface and upgrade stability

The package exports one unmasked UI interface named **Chama**.

| Interface ID | MultiHost ID | Port | Purpose |
| --- | --- | --- | --- |
| `client-one` | `client-one-host` | 8080 | The self-hosted Chama app |

Those legacy IDs and the port intentionally remain unchanged from the 6.0.x package. Keeping them stable preserves the primary browser origin and its origin-scoped identity, settings, and local trade cache during upgrade.

Version 6.0.x temporarily exposed Client One, Client Two, and Client Three as a co-located testing lab. Version 6.1 retires that topology. Only Client One becomes the ordinary Chama interface. The package does not delete `/data/client-2` or `/data/client-3`; they remain in the `main` volume and in backups as legacy wallet evidence, but no service or UI is launched for them. Anyone who deliberately stored funds in those experimental wallets should export them before upgrading.

## Data and backups

| Path | Contents |
| --- | --- |
| `/data/client-1` | Active native Fedimint wallet state |
| `/data/client-2` | Retained legacy Client Two wallet data, if present |
| `/data/client-3` | Retained legacy Client Three wallet data, if present |

StartOS backs up the entire `main` volume, so active and retained legacy wallet directories are included.

Nostr identity, contacts, settings, drafts, and browser-side trade cache remain scoped to the browser origin. They are not part of the server volume. Back up the identity phrase and any exported bearer notes separately; opening Chama through a different origin or clearing browser storage creates fresh browser state even when the server wallet still exists.

## Dependencies and configuration

The package has no StartOS service dependencies and no file models. Users choose a remote Fedimint federation inside Chama. There is no package-level federation configuration and no credential wizard.

## First run

1. Open **Chama** from the Interfaces tab.
2. Create or import your Chama identity.
3. Join a Fedimint federation inside Chama.
4. Store the identity phrase and any fund backup exports somewhere safe.

Until a federation is joined, the app can browse but its native wallet cannot receive or escrow ecash.
Nostr sign-in and the selected home community remain valid while wallet startup is unavailable; the Chama bar shows **Connecting** during startup and exposes **Reconnect** after a failure instead of returning the user to onboarding. Browser-wallet seed recovery also requires the configured Nostr relay read quorum before an empty result may be treated as a genuinely new wallet, so a slow or offline relay pool cannot trigger replacement-seed creation. A signature-verified copy of the still-NIP-44-encrypted seed event is cached per npub after the first successful relay read, allowing later logins on that device to decrypt locally while relay health refreshes in the background; no plaintext mnemonic is cached. A seed created during that authoritative first-launch read joins normally, including after a reload before its first successful join. Routine boot never starts forced Fedimint recovery: if a previously joined mnemonic reaches a fresh local database, Chama stays signed in and fails the wallet connection fast; an explicit **Reconnect** discards the recovery-disabled bootstrap client and creates the user-authorized recovery attempt.

Participant history remains in a hydration state until both the bounded saved-trade replay and the relay discovery/heal pass finish; saved histories are replayed with a three-request pool so large accounts do not serialize dozens of relay round trips. Attention badges and renewal surfaces stay hidden during that window. The lapsed Store reminder accepts only actual Store listings and additionally requires a live chain tip proving that the seller's current bond is still funded and before its lock height; cached or indeterminate bond state never resurrects an old storefront, and a legacy Exchange offer is never mislabeled as a Store.

## Action

### Wallet Bridge Status

A read-only action that reports whether the native wallet bridge answers, whether it has joined a federation, and whether federation relay discovery is reachable, degraded, still probing, or not configured. Run it while the service is running when balances or wallet operations appear unavailable.

## Health

The `primary` daemon is ready only when both port 8080 and bridge port 8787 are listening. A web page without its native wallet bridge is not considered healthy. The readiness grace period is 30 seconds.

## Limitations

1. StartOS backs up the native wallet volume, not browser-scoped identity and application state.
2. Browser state belongs to the exact interface origin used to open Chama.
3. The selected Fedimint federation is joined inside the app, not through StartOS configuration.
4. The retained Client Two/Three directories are backup evidence only after the 6.1 topology migration; they are not served.
5. The service deliberately restarts if either nginx or the wallet bridge exits.

## Quick reference

```yaml
package_id: chama
title: Chama
image: built from ./Dockerfile
architectures: [x86_64, aarch64]
subcontainers:
  - chama-sub # nginx + one native Fedimint bridge
volumes:
  main: /data
active_wallet: /data/client-1
interfaces:
  client-one: { name: Chama, type: ui, port: 8080 }
actions:
  - wallet-status
health_checks:
  - primary # UI 8080 + bridge 8787
dependencies: []
file_models: []
```
