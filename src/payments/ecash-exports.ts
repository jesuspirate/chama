// ══════════════════════════════════════════════════════════════════════════
// Chama — Ecash export stash (v2.4, #56 "withdraw as ecash")
// ══════════════════════════════════════════════════════════════════════════
//
// "Withdraw as ecash" spends the user's Chama balance into a Fedimint OOB note
// — a bearer string that IS the sats. The moment spendNotes returns, the funds
// have left the wallet balance and exist only as that string. If the UI showed
// it and the user closed/crashed before saving it, the sats would be orphaned.
//
// So we persist the string the instant it's generated (same discipline as the
// claim path's pending-redemption stash). The export survives a close/crash; a
// "pending ecash export" surface in Me lets the user retrieve it even after the
// balance reads 0, and clears it only when they confirm they've imported it
// elsewhere (Fedi / another Fedimint wallet on the same federation).
//
// Scoped to the active npub via user-scope, like the other crash-recovery
// queues — one user's pending export must not bleed into another's on a shared
// browser.

import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

/** localStorage key (versioned for future payload migrations). */
export const ECASH_EXPORT_KEY = "chama_ecash_export_v1";

export interface EcashExport {
  /** The Fedimint OOB ecash string (bearer token — this IS the sats). */
  notes: string;
  /** Amount the note represents, in msats. For the "pending export" UI. */
  amountMsats: number;
  /** Human label for the federation the note is bound to (e.g. "BLF").
   *  Display-only; the note itself embeds the federation's connection info. */
  federationLabel?: string;
  /** When the export was generated (Unix ms). */
  createdAt: number;
  /** Wallet exports are standalone; claim exports must also finish the
   *  matching escrow only after the user confirms the bearer note is safe. */
  source?: "wallet" | "claim";
  escrowId?: string;
}

/** Persist a freshly-generated export. Called immediately after spendNotes,
 *  BEFORE the string is shown, so a close/crash can never lose it. */
export function stashEcashExport(input: {
  notes: string;
  amountMsats: number;
  federationLabel?: string;
  source?: "wallet" | "claim";
  escrowId?: string;
}): void {
  try {
    const entry: EcashExport = {
      notes: input.notes,
      amountMsats: input.amountMsats,
      federationLabel: input.federationLabel,
      createdAt: Date.now(),
      source: input.source ?? "wallet",
      escrowId: input.escrowId,
    };
    setScopedStorageItem(ECASH_EXPORT_KEY, JSON.stringify(entry));
    console.info(
      `[chama] ecash-export stashed amountMsats=${input.amountMsats} ` +
      `notesLen=${input.notes.length}`,
    );
  } catch (e) {
    // Loud: failing to persist defeats the crash-safety this exists for.
    console.error("[chama] ecash-export: stash failed — note may be at risk:", e);
    throw e;
  }
}

/** Fail closed before any spend. Also prevents one pending bearer note from
 *  being overwritten by another. A same-claim record is a resumable success. */
export function assertEcashExportWritable(escrowId?: string): EcashExport | null {
  const existing = getEcashExport();
  if (existing) {
    if (escrowId && existing.source === "claim" && existing.escrowId === escrowId) {
      return existing;
    }
    throw new Error(
      "Finish the pending ecash export in Me before creating another one. No sats moved.",
    );
  }
  const probe = `chama-ecash-export-probe-${Date.now()}`;
  try {
    setScopedStorageItem(ECASH_EXPORT_KEY, probe);
    if (getScopedStorageItem(ECASH_EXPORT_KEY) !== probe) throw new Error("storage verification failed");
    removeScopedStorageItem(ECASH_EXPORT_KEY);
  } catch (e) {
    try { if (getScopedStorageItem(ECASH_EXPORT_KEY) === probe) removeScopedStorageItem(ECASH_EXPORT_KEY); } catch {}
    throw new Error(
      "Can't export ecash safely right now because this device can't persist the recovery copy. No sats moved.",
      { cause: e },
    );
  }
  return null;
}

/** The current pending export, or null. Drives the "pending ecash export"
 *  surface in Me and the modal's resume-from-stash branch. */
export function getEcashExport(): EcashExport | null {
  try {
    const raw = getScopedStorageItem(ECASH_EXPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.notes !== "string" ||
      typeof parsed.amountMsats !== "number"
    ) {
      return null;
    }
    return parsed as EcashExport;
  } catch {
    return null;
  }
}

/** Clear the pending export — ONLY after the user confirms they've imported
 *  the note elsewhere. The funds now live in the destination wallet. */
export function clearEcashExport(): void {
  try {
    removeScopedStorageItem(ECASH_EXPORT_KEY);
    console.info("[chama] ecash-export cleared (user confirmed import)");
  } catch (e) {
    console.warn("[chama] ecash-export: clear failed:", e);
    throw e;
  }
}
