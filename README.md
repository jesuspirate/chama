<p align="center">
  <img src="icon.png" alt="Chama Logo" width="21%">
</p>

# Chama

**Local money. Bitcoin rails.**

Chama is a Nostr-native peer-to-peer commerce client for exchanging value with people and communities directly. It combines local payment methods with Bitcoin settlement without a central Chama account server, a custodial marketplace operator, or a proprietary social graph.

People can exchange sats and fiat, pay community bills, run storefronts, and offer work. Listings, chat, reputation, and trade state travel over Nostr. Fedimint ecash is held only while a trade is in escrow and leaves through the chosen payout route after settlement; opt-in on-chain Bitcoin escrow is also available.

- **Website:** <https://getchama.app/>
- **Application source:** <https://github.com/jesuspirate/chama>
- **StartOS package:** <https://github.com/Start9-Community/chama-startos>

## What makes Chama different

- **No Chama account server.** Your Nostr identity is the account and relays carry the coordination layer.
- **Escrow without a Chama custodian.** A locked ecash trade uses three Shamir shares and a 2-of-3 vote outcome across buyer, seller, and community arbiter.
- **Local payment methods.** Communities can trade around the rails people already use while Bitcoin supplies settlement and finality.
- **Purpose-built commerce.** Exchange, Community Bill Pay, Stores, and Work share one verifiable trade protocol.
- **Portable clients.** Chama runs as a web/PWA client, desktop app, Android app, and self-hosted StartOS service.
- **No idle wallet product.** Chama is an escrow client, not a place to warehouse funds. Complete trades should be claimed or exported promptly.

## Trust and recovery model

Chama coordinates trades; it does not promise that a Nostr key recovers bearer ecash. Browser Fedimint wallets are device-local, and StartOS uses its own native wallet bridge and server volume. Preserve your Nostr secret key, but also move completed payouts and save any exported ecash notes independently.

Arbiters act only when the trading parties disagree or when an expired trade needs a protocol-defined healing vote. Community arbiter bonds are visible commitments, not custodial balances controlled by Chama.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the product boundaries and [chama-technical-overview.pdf](chama-technical-overview.pdf) for the protocol overview.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

The default development server is printed by Vite. To choose a port explicitly:

```sh
npm run dev -- --port 3001
```

## Verify a change

```sh
npm run typecheck
npm test
npm run build
```

`npm run predeploy` runs the repository hygiene check, typecheck, and full test suite together.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React UI, Nostr escrow protocol, wallet orchestration, and tests |
| `native/fedimint-bridge/` | Native Rust Fedimint bridge used by packaged clients |
| `src-tauri/` | Desktop shell and release configuration |
| `android/` | Capacitor Android application |
| `landing/` | Public website assets |
| `docs/` | Operational and protocol notes |
| `scripts/` | Release, deployment, audit, and build utilities |

## Releases and StartOS

This repository is the authoritative Chama **application**. It publishes signed `vX.Y.Z` tags for the web, desktop, Android, Zapstore, and downstream packagers.

StartOS packaging lives exclusively in [`Start9-Community/chama-startos`](https://github.com/Start9-Community/chama-startos). That repository pins this application as the `chama/` git submodule at a released `vX.Y.Z` tag and owns the `.s9pk`, StartOS metadata, migrations, and `vX.Y.Z_<revision>` package tags.

> **Do not update [`Start9-Community/chama`](https://github.com/Start9-Community/chama).** It is a retired application fork and is not a release or packaging source. Its ahead/behind status is irrelevant. Application fixes land here; StartOS updates move the submodule pin in `chama-startos`.

Application releases are cut from a clean, synchronized `main`:

```sh
npm run ship -- --patch
# or, for a backward-compatible feature/foundational release:
npm run ship -- --minor
```

For the complete release lane or a one-destination refresh—web, landing page, GitHub assets, GitHub Release page, Zapstore, or Zapstore listing metadata—see [Releasing Chama](docs/RELEASING.md). The remembered entry point is `npm run ship`; add `--only <target>` to guarantee unrelated channels are not touched.

## Security

Chama handles real signing keys, bearer ecash, Lightning invoices, and Bitcoin transactions. Treat changes to wallet storage, federation routing, encryption, escrow voting, payout recovery, and release automation as money-path changes: fail closed, preserve existing wallet files, and verify them with regression tests.

Security-sensitive dependencies are pinned or overridden in `package.json`; `npm run audit:deps` documents the repository's dependency policy.

## License

[MIT](LICENSE)
