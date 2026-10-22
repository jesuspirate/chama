import type { EscrowState } from './types.js';

/** Readers must ship before this UTC boundary. Gate on signed CREATE time,
 * never local wall time or the creator's payload.createdAt. Older chains retain
 * their original law on every later replay, including funded recovery. */
export const MONEY_PATH_HARDENING_CREATE_AT = Date.parse('2026-11-01T00:00:00Z') / 1000;
export const LOCK_TIMESTAMP_SKEW_SECONDS = 5 * 60;
export function usesMoneyPathHardening(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= MONEY_PATH_HARDENING_CREATE_AT;
}

/** Second dated rule set (audit M2 and the refused-lock fixes). Same law as
 * above: gate on the signed CREATE time, so a chain keeps the rules it was
 * created under on every replay. Readers ship in 6.4.30, well before this. */
export const TRADE_RULES_DEC_2026_CREATE_AT = Date.parse('2026-12-01T00:00:00Z') / 1000;
export function usesDecemberTradeRules(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= TRADE_RULES_DEC_2026_CREATE_AT;
}
