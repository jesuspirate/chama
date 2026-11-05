import type { EscrowState } from './types.js';

/** Readers must ship before this UTC boundary. Gate on signed CREATE time,
 * never local wall time or the creator's payload.createdAt. Older chains retain
 * their original law on every later replay, including funded recovery. */
export const MONEY_PATH_HARDENING_CREATE_AT = Date.parse('2026-11-01T00:00:00Z') / 1000;
export const LOCK_TIMESTAMP_SKEW_SECONDS = 5 * 60;
export function usesMoneyPathHardening(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= MONEY_PATH_HARDENING_CREATE_AT;
}

/** Second dated rule set: audit M2 only (a stranger cannot carry a funded
 * trade past its deadline). Same law as above: gate on the signed CREATE time,
 * so a chain keeps the rules it was created under on every replay. Readers
 * ship in 6.4.30, well before this. The refused-lock rules (#43) are NOT part
 * of this set; they are gated separately below (same date, own constant). */
export const TRADE_RULES_DEC_2026_CREATE_AT = Date.parse('2026-12-01T00:00:00Z') / 1000;
export function usesDecemberTradeRules(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= TRADE_RULES_DEC_2026_CREATE_AT;
}

/** Third dated rule set, #43 refused-lock rules (roadmap/refused-lock-design.md):
 *  - a LOCK may carry only the funder's share (`withheldShares`), with the other
 *    two committed and sent later in a RELEASE;
 *  - the other principal ACCEPTs a LOCK by naming its id, after which their own
 *    CANCEL can never refuse it, whatever date that CANCEL carries;
 *  - the funder may WITHDRAW a withheld LOCK before RELEASE, and the trade
 *    returns to open.
 * Gate on the signed CREATE time, never the device clock. Readers and writers
 * both ship in 6.4.34 (Jet, Nov 5: date moved from Feb 1 2027 to Dec 1 2026).
 * Writers use the withheld shape only when the other principal's app has
 * shown 6.4.34 or later, so an older counterparty gets today's LOCK. */
export const WITHHELD_SHARES_CREATE_AT = Date.parse('2026-12-01T00:00:00Z') / 1000;
export function usesWithheldShares(state: Pick<EscrowState, 'createdAt'>): boolean {
  return state.createdAt >= WITHHELD_SHARES_CREATE_AT;
}
