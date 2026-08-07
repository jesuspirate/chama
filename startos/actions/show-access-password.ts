import { sdk } from '../sdk'

export const showAccessPassword = sdk.Action.withoutInput(
  'show-access-password',
  {
    name: 'Show Chama login',
    description: 'Reveal the credentials required to open all three real-funds Chama wallet clients.',
    warning: 'Anyone with this password can access the wallet clients. Keep it private.',
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  },
  async ({ effects }) => {
    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/data',
      readonly: true,
    })
    const { stdout } = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'chama' },
      mounts,
      'read-chama-access-password',
      (container) => container.execFail([
        'sh',
        '-c',
        'test -s /data/security/access-password && cat /data/security/access-password',
      ]),
    )
    const password = String(stdout).trim()
    if (!/^[0-9a-f]{48}$/.test(password)) {
      throw new Error('Chama has not generated valid login credentials yet. Start the service, then retry.')
    }
    return {
      version: '1' as const,
      title: 'Chama wallet login',
      message: 'Use username `chama` and the password below for Client One, Client Two, and Client Three.',
      result: {
        type: 'single' as const,
        value: password,
        copyable: true,
        qr: false,
        masked: true,
      },
    }
  },
)
