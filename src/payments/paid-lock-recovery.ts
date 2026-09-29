import { getStrictScopedStorageItem, setStrictScopedStorageItem } from '../storage/user-scope.js';
import { paidLockRefusedCopy } from './seat-funding.js';
export const PAID_LOCK_RECOVERY_KEY = 'chama_paid_lock_recovery_v1';
export interface PaidLockRecovery {
  kind: 'lock-recovery'; escrowId: string; federationId: string;
  amountMsats: number; createdAt: number; message: string; seen?: boolean;
}
function readRecoveries(): PaidLockRecovery[] {
  const raw = getStrictScopedStorageItem(PAID_LOCK_RECOVERY_KEY);
  const rows: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(rows) || rows.some(row => !row || row.kind !== 'lock-recovery' || typeof row.escrowId !== 'string'
    || typeof row.federationId !== 'string' || !Number.isSafeInteger(row.amountMsats) || row.amountMsats <= 0
    || typeof row.message !== 'string' || !Number.isFinite(row.createdAt))) throw new Error('Wallet recovery history could not be read. No payment should be started.');
  return rows;
}
export function listPaidLockRecoveries(): PaidLockRecovery[] {
  try { return readRecoveries(); } catch { return []; }
}
export function assertPaidLockRecoveryWritable(): void {
  const json = JSON.stringify(readRecoveries());
  setStrictScopedStorageItem(PAID_LOCK_RECOVERY_KEY, json);
  if (getStrictScopedStorageItem(PAID_LOCK_RECOVERY_KEY) !== json) throw new Error('Wallet recovery history cannot be saved. No payment was started.');
}
export function recordPaidLockRecovery(escrowId: string, federationId: string, amountMsats: number, reason: string): string {
  const message = paidLockRefusedCopy(amountMsats, reason);
  const rows = readRecoveries().filter(row => row.escrowId !== escrowId || row.federationId !== federationId);
  rows.push({kind: 'lock-recovery', escrowId, federationId, amountMsats, createdAt: Date.now(), message});
  setStrictScopedStorageItem(PAID_LOCK_RECOVERY_KEY, JSON.stringify(rows));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('chama:paid-lock-recovery'));
  return message;
}
export function acknowledgePaidLockRecoveries(federationId: string, balanceMsats: number): void {
  const rows = readRecoveries();
  let changed = false;
  for (const row of rows) if (!row.seen && row.federationId === federationId && balanceMsats >= row.amountMsats) { row.seen = true; changed = true; }
  if (!changed) return;
  setStrictScopedStorageItem(PAID_LOCK_RECOVERY_KEY, JSON.stringify(rows));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chama:paid-lock-recovery"));
}
