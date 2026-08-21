import { i18n } from './i18n'
import { sdk } from './sdk'
import { clients } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const receipts = []

  // A separate host per client, so each lands on its own origin and the
  // browser keeps their identities, storage and wallets apart.
  for (const { id, name, uiPort } of clients) {
    const origin = await sdk.MultiHost.of(effects, `${id}-host`).bindPort(
      uiPort,
      { protocol: 'http' },
    )
    receipts.push(
      await origin.export([
        sdk.createInterface(effects, {
          name: i18n(name),
          id,
          description: i18n(
            'A self-contained Chama client with its own identity, browser storage and Fedimint wallet',
          ),
          type: 'ui',
          masked: false,
          schemeOverride: null,
          username: null,
          path: '',
          query: {},
        }),
      ]),
    )
  }

  return receipts
})
