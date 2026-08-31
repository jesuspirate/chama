export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting Chama': 0,
  '${client} is not ready yet': 3,
  "${client}'s wallet bridge is not ready yet": 4,

  // interfaces.ts
  'Wallet Bridge Status': 9,
  'Not responding': 12,
  Federation: 13,
  Joined: 14,
  'Not joined yet': 15,
  'Relay discovery': 16,
  Reachable: 17,
  Degraded: 18,
  'Still probing': 19,
  'Not configured': 20,
  Unknown: 21,
  Chama: 22,
  'Web App': 23,
  'Chama is ready': 24,
  'Your self-hosted Chama marketplace with a native Fedimint wallet': 25,
  "Report the federation and relay discovery state of Chama's native Fedimint wallet": 26,
  'Chama holds ecash only once you have joined a federation inside the app.': 27,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
