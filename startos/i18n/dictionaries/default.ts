export const DEFAULT_LANG = 'en_US'

const dict = {
  'Starting Chama': 0,
  'Web clients': 1,
  'The Chama web clients are ready': 2,
  'The Chama web clients are not ready': 3,
  'Client One': 4,
  'Client Two': 5,
  'Client Three': 6,
  'An isolated Chama testing client': 7,
  'An authenticated, isolated Chama wallet client': 8,
} as const

export type LangDict = Record<(typeof dict)[keyof typeof dict], string>
export default dict
