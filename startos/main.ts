import { i18n } from './i18n'
import { sdk } from './sdk'
import { clients } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Chama'))

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: sdk.SubContainer.of(
      effects,
      { imageId: 'chama' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'chama-sub',
    ),
    exec: { command: ['/usr/local/bin/chama-startos-entrypoint'] },
    ready: {
      display: i18n('Web Clients'),
      gracePeriod: 30_000,
      fn: async () => {
        for (const { name, uiPort, bridgePort } of clients) {
          const client = i18n(name)
          // A client whose UI is up but whose wallet bridge is not serves the
          // page and then 502s every /bridge/ call, so both ports gate ready.
          for (const [port, errorMessage] of [
            [uiPort, i18n('${client} is not ready yet', { client })],
            [
              bridgePort,
              i18n("${client}'s wallet bridge is not ready yet", { client }),
            ],
          ] as const) {
            const result = await sdk.healthCheck.checkPortListening(
              effects,
              port,
              {
                successMessage: i18n('All three Chama clients are ready'),
                errorMessage,
              },
            )
            if (result.result !== 'success') return result
          }
        }
        return {
          result: 'success' as const,
          message: i18n('All three Chama clients are ready'),
        }
      },
    },
    requires: [],
  })
})
