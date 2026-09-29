import { decodeBolt11Payment } from "./bolt11.js";
import { preLockDeadline, type EscrowState } from '../escrow-engine/types.js';

export const FUNDING_LOCK_MARGIN_SECONDS = 60;
export const MIN_ONCHAIN_HOLD_SECONDS = 10 * 60;
export function fundingSeatDeadline(state: EscrowState): number | undefined {
  return preLockDeadline(state)?.at;
}
export function fundingInvoiceSeconds(deadline: number | undefined, now = Date.now(), gatewayDefault = 900): number {
  const seconds = deadline === undefined ? gatewayDefault
    : Math.min(gatewayDefault, Math.floor(deadline - now / 1000) - FUNDING_LOCK_MARGIN_SECONDS);
  if (seconds <= 0) throw new Error("The buyer's seat is too close to lapsing. Wait for them to rejoin before paying.");
  return seconds;
}
export function assertOnchainFundingWindow(state: EscrowState, now = Date.now()): void {
  const deadline = fundingSeatDeadline(state);
  if (deadline !== undefined && deadline - now / 1000 < MIN_ONCHAIN_HOLD_SECONDS) {
    throw new Error("The seat has under 10 minutes left. Wait for the buyer to rejoin before preparing an on-chain deposit.");
  }
}
export function paidLockRefusedCopy(amountMsats: number, reason: string): string {
  return `Your ${Math.floor(amountMsats / 1000).toLocaleString('en-US')} sats are in your Chama wallet, not in escrow. ${reason} Post it again to try once more.`;
}
export const SEAT_LAPSED_COPY = "The buyer's seat lapsed before you paid. Nothing was taken.";

/** Check the wire invoice, not just the requested gateway lifetime. */
export function assertFundingInvoiceWithinSeat(invoice: string, deadline: number, now = Date.now()): void {
  const decoded = decodeBolt11Payment(invoice);
  if (!decoded || decoded.expiresAt > deadline - FUNDING_LOCK_MARGIN_SECONDS || decoded.expiresAt * 1000 <= now) {
    throw new Error("This invoice cannot be paid within the buyer's seat window. Chama did not show it. Wait for the buyer to rejoin.");
  }
}
