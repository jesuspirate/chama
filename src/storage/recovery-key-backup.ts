// A receipt for a deliberate backup action, never a copy of the secret.
// Explicit public-key scope also works before login sets the storage scope.
const PREFIX = "chama_key_backup_v1:";
export const BACKUP_CHANGED = "chama-key-backup-changed";
export function recoveryKeyBackedUp(pubkey: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) return false;
  try { return localStorage.getItem(PREFIX + pubkey.toLowerCase()) === "1"; } catch { return false; }
}
export function markRecoveryKeyBackedUp(pubkey: string): void {
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) return;
  try { localStorage.setItem(PREFIX + pubkey.toLowerCase(), "1"); } catch { /* Backup itself still succeeded. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BACKUP_CHANGED));
}
