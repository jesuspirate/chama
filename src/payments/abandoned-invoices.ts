import { getLocalStorageUserScope, scopedStorageKey } from '../storage/user-scope.js';

export const ABANDONED_INVOICES_KEY = 'chama_abandoned_invoices_v1';
export type FundingStorageKey = 'fund.storageUnavailable' | 'fund.historyUnreadable' | 'fund.historyUnwritable' | 'fund.contextUnavailable';
export class FundingStorageError extends Error {
  constructor(public readonly key: FundingStorageKey, public readonly beforeInvoice: boolean) {
    super(key);
    this.name = 'FundingStorageError';
  }
}

/** Only the factory's preflight can assert that no invoice was issued. */
export function fundingStorageFailure(error: unknown) {
  if (!(error instanceof FundingStorageError)) return null;
  return error.beforeInvoice
    ? { kind: 'funding-not-started' as const, reason: error.key }
    : { kind: 'lock-failed' as const, error: error.key, errorKey: error.key };
}
export interface RecordedFundingInvoice {
  invoice: string;
  operationId?: string;
  escrowId: string;
  federationId: string;
  amountMsats: number;
  createdAt: number;
  state: 'watching' | 'abandoned' | 'lock-observed';
}
export interface FundingInvoiceJournal {
  record(invoice: string, operationId?: string): void;
  stop(locked: boolean): void;
}

/** Capture both identity and storage before any asynchronous wallet work.
 * A watching record on a later boot is an interrupted watcher, even if the OS
 * killed the page without delivering an abort event. No TTL, cap, or deletion:
 * a future reconciliation API must prove paid-and-swept or expired-unpaid. */
export function createFundingInvoiceJournal(input: {
  escrowId: string; amountMsats: number; federationId: string;
}): FundingInvoiceJournal {
  const scope = getLocalStorageUserScope();
  if (!input.federationId || !input.escrowId || !Number.isSafeInteger(input.amountMsats) || input.amountMsats <= 0) {
    throw new FundingStorageError('fund.contextUnavailable', true);
  }
  if (!scope) throw new FundingStorageError('fund.contextUnavailable', true);
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
    if (!storage) throw new Error();
  } catch { throw new FundingStorageError('fund.storageUnavailable', true); }
  let beforeInvoice = true;
  const fail = (key: FundingStorageKey): never => { throw new FundingStorageError(key, beforeInvoice); };
  const storageFailure = (error: unknown, fallback: FundingStorageKey): never =>
    fail((error as { name?: string })?.name === 'SecurityError' ? 'fund.storageUnavailable' : fallback);
  const key = scopedStorageKey(ABANDONED_INVOICES_KEY, scope);
  const read = (): RecordedFundingInvoice[] => {
    let raw: string | null;
    try { raw = storage.getItem(key); }
    catch (error) { return storageFailure(error, 'fund.historyUnreadable'); }
    if (raw === null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return fail('fund.historyUnreadable'); }
    if (!Array.isArray(parsed) || parsed.some(e => !e || typeof e.invoice !== 'string'
      || typeof e.escrowId !== 'string' || typeof e.federationId !== 'string'
      || typeof e.createdAt !== 'number' || typeof e.amountMsats !== 'number'
      || !['watching','abandoned','lock-observed'].includes(e.state))) {
      return fail('fund.historyUnreadable');
    }
    return parsed;
  };
  const write = (entries: RecordedFundingInvoice[]) => {
    const json = JSON.stringify(entries);
    try {
      storage.setItem(key, json);
      if (storage.getItem(key) !== json) fail('fund.historyUnwritable');
    } catch (error) {
      if (error instanceof FundingStorageError) throw error;
      storageFailure(error, 'fund.historyUnwritable');
    }
  };
  // Refuse before invoice creation if storage is blocked/corrupt.
  write(read());
  beforeInvoice = false;
  const recorded = new Set<string>();
  let stopped: boolean | undefined;
  return {
    record(invoice, operationId) {
      const entries = read();
      if (!entries.some(e => e.invoice === invoice && e.federationId === input.federationId)) {
        entries.push({...input, invoice, operationId, createdAt:Date.now(), state:stopped === undefined ? 'watching' : stopped ? 'lock-observed' : 'abandoned'});
      }
      write(entries);
      recorded.add(invoice);
    },
    stop(locked) {
      stopped = locked;
      const entries = read();
      for (const entry of entries) if (recorded.has(entry.invoice) && entry.federationId === input.federationId) entry.state = locked ? 'lock-observed' : 'abandoned';
      write(entries);
    },
  };
}
