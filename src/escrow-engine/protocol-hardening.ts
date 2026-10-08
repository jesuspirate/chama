import type { EscrowState } from './types.js';

/** Readers must ship before this UTC boundary. Gate on signed CREATE time,
 * never local wall time or the creator's payload.createdAt. Older chains retain
 * their original law on every later replay, including funded recovery. */
export const MONEY_PATH_HARDENING_CREATE_AT = Date.parse('2026-10-21T00:00:00Z') / 1000;
export const LOCK_TIMESTAMP_SKEW_SECONDS = 5 * 60;
export function usesMoneyPathHardening(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= MONEY_PATH_HARDENING_CREATE_AT;
}
