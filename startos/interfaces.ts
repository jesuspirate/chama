import { i18n } from './i18n'
import { sdk } from './sdk'
import { clientOnePort, clientThreePort, clientTwoPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const clientOneHost = sdk.MultiHost.of(effects, 'client-one-host')
  const clientTwoHost = sdk.MultiHost.of(effects, 'client-two-host')
  const clientThreeHost = sdk.MultiHost.of(effects, 'client-three-host')

  const clientOneOrigin = await clientOneHost.bindPort(clientOnePort, { protocol: 'http' })
  const clientTwoOrigin = await clientTwoHost.bindPort(clientTwoPort, { protocol: 'http' })
  const clientThreeOrigin = await clientThreeHost.bindPort(clientThreePort, { protocol: 'http' })

  const makeClient = (id: string, name: 'Client One' | 'Client Two' | 'Client Three') =>
    sdk.createInterface(effects, {
      name: i18n(name),
      id,
      description: i18n('An authenticated, isolated Chama wallet client'),
      type: 'ui',
      masked: false,
      schemeOverride: null,
      username: 'chama',
      path: '',
      query: {},
    })

  return [
    await clientOneOrigin.export([makeClient('client-one', 'Client One')]),
    await clientTwoOrigin.export([makeClient('client-two', 'Client Two')]),
    await clientThreeOrigin.export([makeClient('client-three', 'Client Three')]),
  ]
})
