import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '6.0.1:0',
  releaseNotes: {
    en_US:
      'Three fixes on top of 6.0.0, and one of them matters most on this package: funding a trade by Lightning now works from a browser, which is how every client in this lab is reached. Chama had been refusing to create an invoice unless it could prove a gateway was vetted through a signal browser wallets are never given, so the control existed and quietly did nothing on every federation. Receiving now accepts the same trust the paying side always accepted — the gateways a federation publishes as its own, or ones Chama has verified for that federation — and still refuses a route nothing vouches for. Second, sats can no longer lock into a trade held on a different federation: the notes are read back after they are minted and compared against the federation the trade is actually held on, and if they disagree the sats return to your wallet with no lock published. Third, Browse preferences are stored per identity, so a second npub on the same client starts from the defaults instead of inheriting another account\'s view. Unchanged for this package: three co-located clients, each with its own native Fedimint bridge, no account server and no custody role.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
