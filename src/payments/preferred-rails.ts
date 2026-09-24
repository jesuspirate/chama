import { getScopedStorageItem, setScopedStorageItem } from '../storage/user-scope.js';
const KEY = 'chama_preferred_payment_rails_v1';
export function readPreferredRails(): string[] {
  try { const value = JSON.parse(getScopedStorageItem(KEY) ?? '[]'); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; } catch { return []; }
}
export function savePreferredRails(rails: string[]): void {
  try { setScopedStorageItem(KEY, JSON.stringify([...new Set(rails)])); } catch { /* device storage unavailable */ }
}
