import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '6.0.0:0',
  releaseNotes: {
    en_US:
      'A trade can now be held two ways. Ecash stays the default: instant, no miner fee, settled inside your federation. On-chain is new — the sats wait at a Bitcoin address built from three keys, yours, your counterparty\'s, and your arbiter\'s, with three ways out: you and your counterparty settle it together, two of the three sign after a delay Bitcoin itself enforces, or whoever funded it recovers the coins outright once a timelock matures. Your client rebuilds that address from the trade\'s own terms every time it shows it, and never trusts an address that arrived over the network. On-chain is opt-in and aimed at larger trades, where a miner fee is small against the amount. Large trades can also move in slices now, each one gated on the previous actually landing. A long pass over claims: they route through the federation that holds the notes, interrupted reissues resume, credited claims stay reserved until the payout completes, and sats are recoverable across federations you have left. Browse works before the wallet finishes loading, so the market appears immediately instead of a spinner, and escrow amounts stay hidden until a trade has fully loaded rather than briefly showing a wrong number. Also adds a bitcoin/fiat converter, US federation choices, seller notifications for reservations on ecash trades, a configurable block explorer so you can point Chama at your own, and a dependency security gate in CI. Unchanged for this package: three co-located clients, each with its own native Fedimint bridge, no account server and no custody role.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
