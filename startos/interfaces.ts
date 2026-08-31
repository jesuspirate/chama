import { i18n } from './i18n'
import { sdk } from './sdk'
import { clients } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const receipts = []

  // Keep `client-one-host` stable from the former lab package so an upgrade
  // preserves the primary browser origin and its identity-scoped storage.
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
            'Your self-hosted Chama marketplace with a native Fedimint wallet',
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
