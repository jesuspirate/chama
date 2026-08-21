export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting Chama': 0,
  'Web Clients': 1,
  'All three Chama clients are ready': 2,
  '${client} is not ready yet': 3,
  "${client}'s wallet bridge is not ready yet": 4,

  // interfaces.ts
  'Client One': 5,
  'Client Two': 6,
  'Client Three': 7,
  'A self-contained Chama client with its own identity, browser storage and Fedimint wallet': 8,

  // actions/walletStatus.ts
  'Wallet Bridge Status': 9,
  "Report the federation and relay discovery state of each client's Fedimint wallet bridge": 10,
  'A client holds ecash only once you have joined a federation from inside Chama.': 11,
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
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
