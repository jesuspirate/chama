# Chama

## Documentation

- [Chama technical overview](https://github.com/jesuspirate/chama/blob/main/chama-technical-overview.pdf) — how the escrow state machine, the Nostr event kinds, and Fedimint settlement fit together.
- [Relay operations](https://github.com/jesuspirate/chama/blob/main/docs/RELAY_OPERATIONS.md) — for anyone running a Nostr relay that carries Chama traffic.

## What you get on StartOS

Three separate Chama clients — **Client One**, **Client Two**, and **Client
Three** — each with its own address. They are fully independent: a Nostr
identity, browser storage, and a Fedimint ecash wallet per client, with nothing
shared between them. Use one for yourself, or use several to hold separate
trading identities, or to play buyer, seller, and arbiter through a trade
end to end.

The Fedimint wallet of each client is the one part that lives on your server
rather than in your browser, so it is what StartOS backs up.

## Getting set up

Do this once per client you intend to use:

1. Open the client from the **Interfaces** tab and let the page load.
2. Choose or import a Nostr identity when Chama asks for one. This is the
   identity your counterparties will see, so use a different one in each client
   if you want the clients to be unrelated.
3. Join a Fedimint federation with an invite code. Until you do, the client can
   browse but cannot hold ecash or fund an escrow.
4. Save whatever recovery material Chama shows you, somewhere off this server.

## Using Chama

### Web interfaces

Each client opens on the Chama marketplace: browse offers, publish your own,
negotiate, and settle. Bookmark the address of the client you use — the identity
and history you built up belong to that address, and opening a different client
gets you a different, empty one.

### Actions

**Wallet Bridge Status** reports, for each client, whether its wallet is
answering, whether it has joined a federation yet, and whether Chama can reach
the relay-discovery service it uses to find federation nodes. Run it when a
client will not load its balance or a payment seems stuck.

## Limitations

- **A Chama client has no login.** Anyone who can open one of these addresses
  can spend that client's ecash. Enable only the addresses you trust, and treat
  each one like a password.
- **Backups cover the wallets, not your history.** Your identity, trades, and
  drafts live in the browser you opened the client with. Clearing site data,
  switching browsers, or using a private window gives you a fresh empty client
  and can lose access to the old one — export your recovery material instead of
  relying on the backup.
