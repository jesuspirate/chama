import { getScopedStorageItem, setScopedStorageItem } from "../storage/user-scope.js";
import { recordNativeFundingDiagnostic } from "../notifications/native-push.js";
const KEY = "chama_funding_diagnostics_v1";
export function fundingDiagnostics(): Record<string, unknown>[] {
  try { const rows = JSON.parse(getScopedStorageItem(KEY) || "[]"); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}
export function recordFundingDiagnostic(diagnostic: Record<string, unknown>): void {
  try { setScopedStorageItem(KEY, JSON.stringify([...fundingDiagnostics().slice(-49), diagnostic])); }
  catch { /* Diagnostics cannot block funding state transitions. */ }
  void recordNativeFundingDiagnostic(diagnostic);
}
