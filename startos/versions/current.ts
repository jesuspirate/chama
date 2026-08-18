import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '6.0.1:0',
  releaseNotes: {
    en_US:
      'The headline fix in this release does not affect this package, and that is worth stating plainly: ecash escrows created in a web browser were being returned to their funder the moment they were created, because a 90-day auto-cancel deadline overflowed the browser\'s 32-bit timer and read as "immediately." Those trades published a lock and appeared funded while holding nothing. This package runs the Rust wallet on your own server, which never had that limit, so escrows here were held correctly throughout. The deadline is now 14 days and Chama refuses to spend notes at all if a deadline would exceed what a browser can represent — checked before any note is created. Also in this release: funding by Lightning now works from a browser, which matters here because that is how you reach each client — Chama had been demanding a vetting flag browser wallets are never given, so the control existed and quietly did nothing on every federation, and receiving now accepts the trust a federation publishes about its own gateways while still refusing a route nothing vouches for. Sats can no longer lock into a trade held on a different federation: the notes are read back after minting and compared against the trade\'s own federation, and on a mismatch they return to your wallet with no lock published. A revoked remote-node link now falls back to your own wallet instead of failing to start. Browse preferences are stored per identity, so a second npub on the same client starts from the defaults. Unchanged for this package: three co-located clients, each with its own native Fedimint bridge, no account server and no custody role.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
