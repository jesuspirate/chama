import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { clients } from '../utils'

// The bridge reports one of "probing" | "reachable" | "degraded" | "skipped"
// under `discovery.status`; anything else means a bridge newer than this
// package knows about.
const DISCOVERY = {
  reachable: 'Reachable',
  degraded: 'Degraded',
  probing: 'Still probing',
  skipped: 'Not configured',
} as const

async function readHealth(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return null
    return (await res.json()) as {
      joined?: boolean
      discovery?: { status?: string }
    }
  } catch {
    return null
  }
}

export const walletStatus = sdk.Action.withoutInput(
  'wallet-status',

  async ({ effects }) => ({
    name: i18n('Wallet Bridge Status'),
    description: i18n(
      "Report the federation and relay discovery state of each client's Fedimint wallet bridge",
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => ({
    version: '1' as const,
    title: i18n('Wallet Bridge Status'),
    message: i18n(
      'A client holds ecash only once you have joined a federation from inside Chama.',
    ),
    result: {
      type: 'group' as const,
      value: await Promise.all(
        clients.map(async ({ name, bridgePort }) => {
          const health = await readHealth(bridgePort)
          if (!health)
            return {
              type: 'single' as const,
              name: i18n(name),
              description: null,
              value: i18n('Not responding'),
              masked: false,
              copyable: false,
              qr: false,
            }
          const status = health.discovery?.status ?? ''
          return {
            type: 'group' as const,
            name: i18n(name),
            description: null,
            value: [
              {
                type: 'single' as const,
                name: i18n('Federation'),
                description: null,
                value: health.joined ? i18n('Joined') : i18n('Not joined yet'),
                masked: false,
                copyable: false,
                qr: false,
              },
              {
                type: 'single' as const,
                name: i18n('Relay discovery'),
                description: null,
                value: i18n(
                  status in DISCOVERY
                    ? DISCOVERY[status as keyof typeof DISCOVERY]
                    : 'Unknown',
                ),
                masked: false,
                copyable: false,
                qr: false,
              },
            ],
          }
        }),
      ),
    },
  }),
)
