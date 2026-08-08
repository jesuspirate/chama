export const DEFAULT_LANG = 'en_US'

const dict = {
  'Starting Chama': 0,
  'Chama wallet': 1,
  'The Chama wallet is ready': 2,
  'The Chama wallet is not ready': 3,
  Chama: 4,
  'Your personal authenticated Chama wallet': 5,
} as const

export type LangDict = Record<(typeof dict)[keyof typeof dict], string>
export default dict
