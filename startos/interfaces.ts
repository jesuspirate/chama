import { i18n } from './i18n'
import { sdk } from './sdk'
import { chamaPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  // Keep the original first-client host/interface IDs so an upgrade preserves
  // the existing StartOS address and its funded wallet data.
  const clientOneHost = sdk.MultiHost.of(effects, 'client-one-host')
  const clientOneOrigin = await clientOneHost.bindPort(chamaPort, { protocol: 'http' })

  return [
    await clientOneOrigin.export([
      sdk.createInterface(effects, {
        name: i18n('Chama'),
        id: 'client-one',
        description: i18n('Your personal authenticated Chama wallet'),
        type: 'ui',
        masked: false,
        schemeOverride: null,
        username: 'chama',
        path: '',
        query: {},
      }),
    ]),
  ]
})
