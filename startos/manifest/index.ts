import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'chama',
  title: 'Chama',
  license: 'MIT',
  packageRepo: 'https://github.com/Start9-Community/chama',
  upstreamRepo: 'https://github.com/jesuspirate/chama',
  marketingUrl: 'https://chama.community/',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    chama: {
      source: { dockerBuild: {} },
      arch: ['x86_64', 'aarch64'],
    },
  },
  dependencies: {},
})
