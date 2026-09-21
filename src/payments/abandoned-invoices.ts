import { getLocalStorageUserScope, scopedStorageKey } from '../storage/user-scope.js';

export const ABANDONED_INVOICES_KEY = 'chama_abandoned_invoices_v1';
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
    throw new Error('Cannot safely identify the funding invoice before creation');
  }
  if (!scope || typeof localStorage === 'undefined') throw new Error('Cannot safely record the funding invoice on this device');
  const storage = localStorage;
  const key = scopedStorageKey(ABANDONED_INVOICES_KEY, scope);
  const read = (): RecordedFundingInvoice[] => {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(e => !e || typeof e.invoice !== 'string'
      || typeof e.escrowId !== 'string' || typeof e.federationId !== 'string'
      || typeof e.createdAt !== 'number' || typeof e.amountMsats !== 'number'
      || !['watching','abandoned','lock-observed'].includes(e.state))) {
      throw new Error('Funding invoice history is unreadable; keep this device data intact');
    }
    return parsed;
  };
  const write = (entries: RecordedFundingInvoice[]) => {
    const json = JSON.stringify(entries);
    storage.setItem(key, json);
    if (storage.getItem(key) !== json) throw new Error('Funding invoice history could not be saved');
  };
  // Refuse before invoice creation if storage is blocked/corrupt.
  write(read());
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
