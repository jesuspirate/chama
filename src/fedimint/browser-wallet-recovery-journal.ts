export type BrowserWalletRecoveryStage =
  | "requested"
  | "rotating"
  | "recovering"
  | "completed"
  | "inconclusive";

export interface BrowserWalletRecoveryJournal {
  version: 1;
  stage: BrowserWalletRecoveryStage;
  operationId: string;
  federationId: string;
  trigger: "operation-proof" | "explicit-diagnostic" | "mint-reissue-failed";
  requestedAt: number;
  updatedAt: number;
  oldFilename?: string;
  newFilename?: string;
  hadPendingRecovery?: boolean;
  balanceBeforeMsats?: number;
  balanceAfterMsats?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Normal wallet startup must not poll or wait on the SDK recovery service.
 * A browser repair is resumable only while its durable journal says that an
 * explicitly-started attempt is still in flight. Completed and inconclusive
 * attempts are evidence receipts, not permission to repeat work on every boot.
 *
 * A fresh join remains eligible for the check because the wallet adapter may
 * have invoked the SDK's `forceRecover` option for a restored mnemonic even
 * when no incident journal exists.
 */
export function shouldCheckBrowserWalletRecovery(
  source: "init" | "join",
  journal: BrowserWalletRecoveryJournal | null,
): boolean {
  if (source === "join") return true;
  return journal?.stage === "requested" ||
    journal?.stage === "rotating" ||
    journal?.stage === "recovering";
}

const JOURNAL_PREFIX = "chama_fedimint_recovery_journal_v1:";

function key(storageScope?: string | null): string {
  return `${JOURNAL_PREFIX}${storageScope || "legacy"}`;
}

export function readBrowserWalletRecoveryJournal(
  storageScope?: string | null,
): BrowserWalletRecoveryJournal | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(storageScope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrowserWalletRecoveryJournal>;
    if (
      parsed.version !== 1 ||
      typeof parsed.stage !== "string" ||
      typeof parsed.operationId !== "string" ||
      typeof parsed.federationId !== "string" ||
      typeof parsed.requestedAt !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) return null;
    return parsed as BrowserWalletRecoveryJournal;
  } catch {
    return null;
  }
}

export function writeBrowserWalletRecoveryJournal(
  storageScope: string | null | undefined,
  journal: BrowserWalletRecoveryJournal,
): boolean {
  try {
    globalThis.localStorage?.setItem(key(storageScope), JSON.stringify(journal));
    return globalThis.localStorage?.getItem(key(storageScope)) !== null;
  } catch {
    return false;
  }
}

export function updateBrowserWalletRecoveryJournal(
  storageScope: string | null | undefined,
  patch: Partial<BrowserWalletRecoveryJournal>,
): BrowserWalletRecoveryJournal | null {
  const current = readBrowserWalletRecoveryJournal(storageScope);
  if (!current) return null;
  const next: BrowserWalletRecoveryJournal = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
  };
  return writeBrowserWalletRecoveryJournal(storageScope, next) ? next : null;
}
