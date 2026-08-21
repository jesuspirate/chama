<p align="center">
  <img src="icon.png" alt="Chama Logo" width="21%">
</p>

# Chama on StartOS

Chama is a Nostr-native peer-to-peer marketplace with non-custodial escrow. There is no central Chama account server or custody layer: clients coordinate encrypted trade events over Nostr and interact directly with a selected Fedimint federation.

A trade can be held two ways. **Ecash** (the default) is instant, carries no miner fee, and settles inside the federation. **On-chain** holds the sats at a Bitcoin address built from three keys — both traders and their arbiter — with three spend paths: cooperative settlement, arbitration gated behind a consensus-enforced delay, and a timelocked refund to whoever funded it. On-chain is opt-in and available on larger trades, where a miner fee is small against the amount. Clients always recompute an escrow address from the trade's own terms and never trust one that arrived over the network.

> Everything not listed in this document should behave the same as upstream
> Chama. If a feature, setting, or behavior is not mentioned here, the upstream
> documentation is accurate and fully applicable — see the Documentation
> section of `instructions.md` for links.

[Chama](https://github.com/jesuspirate/chama) is a Nostr client with a built-in Fedimint ecash wallet. This package runs **three independent clients** from one service, each on its own address with its own identity, browser storage, and wallet — which is the whole point of it here, and the main thing that differs from installing Chama anywhere else.

This repository is a fork of the application's own; packaging changes land here.

- **Upstream repo:** <https://github.com/jesuspirate/chama>
- **Wrapper repo:** <https://github.com/Start9-Community/chama>

---

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Image and Container Runtime

One image, built here from this repository, running seven processes in one container.

| Property      | Value                               |
| ------------- | ----------------------------------- |
| Image         | Built from this repo's `Dockerfile` |
| Architectures | x86_64, aarch64                     |
| Command       | The package's own entrypoint script |

| Subcontainer | Purpose                                  |
| ------------ | ---------------------------------------- |
| `chama-sub`  | The only daemon — the one to `attach` to |

Inside it: **nginx**, serving three server blocks, and **three wallet bridge processes** on loopback, one per client, each with its own wallet directory.

**The entrypoint exits if any child dies**, deliberately, so StartOS restarts the whole service. A UI that is up while its wallet bridge is dead is the failure worth avoiding — it serves a page that looks healthy and fails every wallet call. The watchdog also treats an unreaped zombie as dead, because a bridge that aborts natively would otherwise still satisfy a naive liveness check.

## Volume and Data Layout

One volume, carved into one directory per client.

| Volume | Mount Point | Purpose                         |
| ------ | ----------- | ------------------------------- |
| `main` | `/data`     | One wallet directory per client |

| Path        | Holds                                    |
| ----------- | ---------------------------------------- |
| `client-1/` | The first client's Fedimint wallet state |
| `client-2/` | The second client's                      |
| `client-3/` | The third client's                       |

**The separation is the feature.** Each bridge is started with its own data directory, so the three wallets cannot see each other — and a backup captures all three together.

Nostr identities and application settings are **not** here: they live in each origin's browser storage, on the device the user browses from. See [Backups and Restore](#backups-and-restore), because this is the thing most likely to surprise someone.

## File Models

None. The package writes no configuration file, seeds nothing, and models nothing.

nginx's configuration and the entrypoint are baked into the image rather than generated, and everything else is either browser-side or inside a bridge's own wallet directory.

## Dependencies

None. The Fedimint federation a client joins is chosen by the user inside Chama and is remote; nothing on this server is required.

## Network Access and Interfaces

Three interfaces — one per client, and the separation is deliberate.

| Interface    | Id             | Type | Port | Description                   |
| ------------ | -------------- | ---- | ---- | ----------------------------- |
| Client One   | `client-one`   | ui   | 8080 | A self-contained Chama client |
| Client Two   | `client-two`   | ui   | 8081 | A self-contained Chama client |
| Client Three | `client-three` | ui   | 8082 | A self-contained Chama client |

Each is bound on its **own** MultiHost over HTTP and is not masked.

**Separate hosts are what make the clients independent.** A browser scopes identity, storage, and wallet state to an origin, so three clients sharing one address would share all three. Giving each its own host is what keeps them apart — it is not a convenience, it is the mechanism.

The three wallet bridges listen on loopback inside the container and are never exported; nginx proxies each client's bridge path to its own.

**One proxy timeout is set unusually long, on purpose.** The invoice-waiting path is a long poll held open until someone actually pays, so a read timeout there is a clock on the human rather than on the bridge. At nginx's default it hung up during an ordinary scan-the-QR pause and returned its own error page, which the client read as a _rejected payment_.

## Installation and First-Run Flow

There is no wizard, no credential, and no task. Start the service, open any of the three addresses, and Chama runs.

**A client holds no ecash until you join a federation from inside it**, and that is done per client — joining on Client One does nothing for Client Two. The Wallet Bridge Status action is how to see where each one stands.

The health check has a 30-second grace because seven processes have to come up before the service is genuinely usable.

## Actions

One action.

### Wallet Bridge Status

Reports each client's federation and relay-discovery state. Run it to see which clients have joined a federation, or when a client's wallet is misbehaving.

- **When to run it:** only while the service is running — it queries each bridge directly.
- **What it changes:** nothing. It is a read.
- **Cost:** immediate; each bridge is given a short timeout.
- **Repeat safety:** read-only.
- **Outputs:** per client, whether it has joined a federation and what its relay discovery is doing. A bridge that does not answer is reported as such rather than failing the action, so one broken client still lets you see the other two.

Relay discovery is reported as reachable, degraded, still probing, or not configured — and as unknown if a bridge reports something newer than the package understands.

## Tasks

None. This package raises no tasks, so the service is never held on a prompt and its ordinary controls are always available.

## Health Checks

One check, covering all six ports.

| Check     | Displayed as  | Method                                             | Grace Period |
| --------- | ------------- | -------------------------------------------------- | ------------ |
| `primary` | "Web Clients" | Every client's UI **and** bridge port is listening | 30s          |

**Both ports per client are required**, and that is the point: a client whose interface is up but whose bridge is not will serve its page and then fail every wallet call. The check names which client and which half is missing, so a failure message identifies the problem rather than just reporting "not ready".

It is a single check, so any one of the six ports being down marks the whole service unhealthy — which matches the entrypoint's behavior of restarting everything when any child dies.

## Backups and Restore

The `main` volume is copied wholesale — `sdk.Backups.ofVolumes('main')`. That is all three clients' wallet directories.

**What is _not_ in the backup is the part users assume is.** Nostr keys, contacts, and application settings live in the **browser's** storage for each origin, not on the server. A restore brings back the wallets and nothing else; a user who clears their browser data, or opens Chama from a different device, has a fresh client regardless of any backup taken here.

Because each interface is a separate origin, that browser state is also per client and per address — reaching the same client at a different address gives the browser a different origin and therefore a different identity.

## Limitations and Differences

1. **Exactly three clients**, fixed. The count is compiled into the package — the interfaces, the nginx configuration, and the entrypoint all derive from the same list.
2. **Nostr identity and settings are browser-side**, so they are outside StartOS backups entirely and do not follow a user between devices or addresses.
3. **Each client's identity is scoped to the address it is opened at.** Reaching a client over LAN and over Tor gives the browser two different origins and two different clients.
4. **Federations are joined per client**, inside the app; there is no package-level configuration for them.
5. **Any single failure restarts everything.** One dead bridge takes the whole service down by design, rather than leaving a client silently broken.
6. **No configuration surface at all** — no file models, no settings actions.

---

## Quick Reference for AI Consumers

```yaml
package_id: chama
image: built from ./Dockerfile
architectures:
  - x86_64
  - aarch64
subcontainers:
  - chama-sub # nginx plus three wallet-bridge processes
volumes:
  main: /data # client-1/, client-2/, client-3/
file_models: []
startos_managed_env_vars: []
dependencies: []
interfaces: # one host each, so the browser keeps them separate
  client-one: { type: ui, port: 8080 }
  client-two: { type: ui, port: 8081 }
  client-three: { type: ui, port: 8082 }
actions:
  - wallet-status
tasks: []
health_checks:
  - primary # displayed "Web Clients"; gates on all six internal ports
```
