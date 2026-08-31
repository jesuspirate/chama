# Chama

Chama is a self-hosted peer-to-peer marketplace for local commerce with Bitcoin rails. It coordinates offers and trades over Nostr without a central Chama account server or custodial middleman. Trades can settle with Fedimint ecash, Lightning, or opt-in on-chain Bitcoin.

## What you get on StartOS

One **Chama** web interface backed by one native Rust Fedimint wallet. Open it from the Interfaces tab and use it like the ordinary Chama app. Buyers, sellers, and community arbiters use their own Chama identities and coordinate over Nostr; they are not three clients bundled into one server.

## Upgrading from 6.0.x

The earlier StartOS package exposed three co-located clients for testing. Version 6.1 retires that model and keeps the former **Client One** as the single **Chama** interface. Its interface identity, browser origin, port, and `/data/client-1` wallet directory remain unchanged so the primary app and wallet survive the upgrade.

Client Two and Client Three are no longer launched or shown. Their `/data/client-2` and `/data/client-3` directories are not deleted and remain in StartOS backups, but this release does not provide an interface for spending from them. If you intentionally kept ecash in either experimental client, export it before upgrading.

## Getting set up

1. Open **Chama** from the Interfaces tab.
2. Create a new Chama identity or import your existing identity phrase.
3. Join your chosen Fedimint federation inside Chama.
4. Save the identity phrase and any exported ecash fund backups somewhere safe.

The native wallet cannot receive or escrow ecash until it has joined a federation.
If the wallet or Nostr relays are still starting, Chama keeps you signed in and preserves your selected home community. The Chama bar shows **Connecting** while startup is active and **Reconnect** if it fails. Chama will not create or replace a browser-wallet seed from an incomplete relay reading, and a genuinely new wallet will not waste time running recovery for a balance that cannot yet exist—even if you reload before its first join completes. After one successful seed lookup, returning logins on that device use a signature-verified encrypted event cache and refresh relay health in the background; Chama does not store the plaintext recovery phrase there. Chama also never starts forced recovery as routine boot work. If an older seed is found but its local wallet file is missing, you can still browse; tap **Reconnect** to discard the boot-only client and explicitly start the repair attempt.

On accounts with a long trade history, **Checking your complete trade history…** remains visible until Chama has replayed saved trades and completed its relay discovery/heal pass. Action badges and old listing reminders stay hidden until that reading is complete. Lapsed Store reminders apply only to actual Store listings and only return while a current on-chain bond is verifiably active; an expired, cached, or temporarily unverifiable bond does not bring an old store back, and an old Exchange offer is not shown as a Store.

## Backups

StartOS backs up the native wallet data stored on the server. Your Nostr identity, contacts, drafts, settings, and browser-side trade cache belong to the exact browser origin used to open Chama and are not included in the server backup.

Do not treat the identity phrase as an ecash balance backup. For funds, use Chama's ecash export and store the bearer note safely.

## Wallet Bridge Status

The read-only **Wallet Bridge Status** action reports whether the native wallet bridge responds, whether Chama has joined a federation, and whether federation relay discovery is reachable, degraded, still probing, or not configured. Run it when Chama loads but wallet balances or payments are unavailable.

## Security note

The browser session and native wallet can authorize real payments. Expose the interface only through addresses and devices you trust.

## Documentation

- [Chama website](https://getchama.app/)
- [Technical overview](https://github.com/jesuspirate/chama/blob/main/chama-technical-overview.pdf)
- [Relay operations](https://github.com/jesuspirate/chama/blob/main/docs/RELAY_OPERATIONS.md)
