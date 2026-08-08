import { i18n } from './i18n'
import { sdk } from './sdk'
import { chamaPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Chama'))

  const chamaSubcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'chama' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/data',
      readonly: false,
    }),
    'chama-sub',
  )

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: chamaSubcontainer,
    exec: { command: ['/usr/local/bin/chama-startos-entrypoint'] },
    ready: {
      display: i18n('Chama wallet'),
      gracePeriod: 30_000,
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, chamaPort, {
          successMessage: i18n('The Chama wallet is ready'),
          errorMessage: i18n('The Chama wallet is not ready'),
        }),
    },
    requires: [],
  })
})
