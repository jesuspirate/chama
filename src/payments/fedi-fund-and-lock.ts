// ══════════════════════════════════════════════════════════════════════════
// Chama — Atomic Fedi fund-and-lock orchestrator (fund-loss guard)
// ══════════════════════════════════════════════════════════════════════════
//
// The Fedi Mini-App funding path is NOT the BOLT11 path in fund-and-lock.ts.
// In a Fedi webview the host wallet mints ecash directly via
// `window.fediInternal.generateEcash`, so there is no invoice to poll — we
// spend ecash out of Fedi and lock those out-of-band bearer notes into 2-of-3
// SSS escrow. The catch: the spend and the lock are two steps, and between
// them the sats live ONLY in a JS variable. Native (createEscrowLock) is
// immune because it spends + SSS-splits atomically inside the SDK; the Fedi
// path is not, so it dropped sats on abort / lock-throw / crash.
//
// This orchestrator makes the Fedi path atomic the way the v0.1.68 CLAIM path
// is: it STASHES the spent notes to crash-durable storage before the lock,
// and RE-ABSORBS them back into Fedi on any exit that isn't a confirmed LOCK.
// Ecash is committed only once the LOCK publishes with our notesHash; every
// other outcome — abort, amount mismatch, publish failure, racing tab, reload,
// crash — refunds, so the user is always whole.
//
// Pure and dependency-injected (no React, no Fedimint imports) so the whole
// flow is testable in isolation — mirrors runFundAndLock. The hook binds the
// dependencies to the live wallet; the AtomicFundingModal renders the phases.

import type { FundAndLockPhase, FundAndLockTerminal } from "./fund-and-lock.js";
import type { SelectedMenuItem } from "../escrow-engine/types.js";

// ── Dependencies (bound to the live wallet in useEscrow) ───────────────────

export interface RunFediFundAndLockDeps {
  /** Pre-spend state gate — bridge.preflightLock. Throws if the trade is not
   *  in a lockable state. Runs BEFORE any ecash leaves Fedi. */
  preflight: (escrowId: string) => Promise<void>;
  /** Spend ecash out of Fedi → OOB bearer notes — generateFediEcash. Throws on
   *  insufficient funds BEFORE any spend (Fedi mints nothing it can't back). */
  generateEcash: (
    amountMsats: number,
    memo?: string,
  ) => Promise<{ notes: string }>;
  /** Re-absorb OOB notes back into Fedi — receiveFediEcash, bound WITHOUT an
   *  expectedMsats so repeated boot-drain attempts stay idempotent. */
  receiveEcash: (notes: string) => Promise<unknown>;
  /** Persist spent notes to crash-durable storage — stashPendingFunding.
   *  Synchronous (localStorage); no await that could itself be interrupted. */
  stashFunding: (input: {
    escrowId: string;
    oobNotes: string;
    amountMsats: number;
  }) => void;
  /** Remove the stash entry — clearPendingFunding. Called only on a confirmed
   *  outcome (LOCK committed with our notes, or re-absorb confirmed). */
  clearFunding: (escrowId: string) => void;
  /** Hash OOB notes exactly as the LOCK does (SHA-256 hex) — hashNotes. Used to
   *  confirm the published LOCK committed OUR notes, not a racing tab's. */
  hashNotes: (notes: string) => Promise<string>;
  /** Lock OOB notes into 2-of-3 SSS escrow + publish LOCK. Returns the notesHash
   *  the resulting state committed to (null if no LOCK applied — e.g. a stale-
   *  suppression resolve on a terminal trade). Throws on amount mismatch or
   *  publish failure. */
  lockAndPublish: (
    escrowId: string,
    notes: string,
    opts: { savedHandleId?: string; selectedItems?: SelectedMenuItem[] },
  ) => Promise<{ lockedNotesHash: string | null }>;
}

export interface RunFediFundAndLockOpts extends RunFediFundAndLockDeps {
  /** Trade ID being funded. */
  escrowId: string;
  /** Trade amount in msats. */
  amountMsats: number;
  /** Memo embedded in the generated ecash. */
  description: string;
  /** Optional handle to reveal in the LOCK payload. */
  savedHandleId?: string;
  /** Optional menu basket snapshot to attach to LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** Phase callback — granular UI updates. */
  onPhase: (phase: FundAndLockPhase) => void;
  /** Caller-controlled abort (modal Cancel, unmount). */
  signal?: AbortSignal;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function errMessage(e: unknown, fallback: string): string {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).trim();
  return msg || fallback;
}

/** Item 1 (realized as copy, not a gate — there is no Fedi host-wallet balance
 *  API to pre-read): map an insufficient-funds-shaped generate failure to a
 *  clear message. generateEcash throws BEFORE any spend, so this is a clean
 *  no-loss exit. */
function fediGenerateErrorCopy(e: unknown): string {
  const msg = errMessage(e, "");
  if (/insufficient|not enough|exceeds|too large/i.test(msg)) {
    return "Not enough in your Fedi wallet for this trade. Top up your Fedi balance and try again.";
  }
  return `Fedi ecash funding failed: ${msg || "Fedi wallet did not return ecash."}`;
}

/** Shared recovery for every post-spend lock failure: re-absorb, then report
 *  lock-failed with copy that tells the truth about where the sats are. */
async function recoverFailedLock(
  reabsorb: () => Promise<boolean>,
  originalError: string,
  emit: (p: FundAndLockPhase) => void,
): Promise<FundAndLockTerminal> {
  const recovered = await reabsorb();
  originalError = originalError.replace(/Local apply failed:[\s\S]*/, "This trade could no longer be locked.");
  const err = recovered
    ? `${originalError} Your sats were returned to your Fedi wallet.`
    : `${originalError} Your sats are saved — Chama will return them to your Fedi wallet next time you open it.`;
  emit({ kind: "lock-failed", error: err });
  return { kind: "lock-failed", error: err };
}

// ── runFediFundAndLock ─────────────────────────────────────────────────────

/** Compose preflight → generate → stash → lock → confirm/refund into one
 *  atomic flow. Resolves with the terminal phase; never rejects (callers
 *  branch on the returned kind, like runFundAndLock). */
export async function runFediFundAndLock(
  opts: RunFediFundAndLockOpts,
): Promise<FundAndLockTerminal> {
  const emit = (p: FundAndLockPhase) => opts.onPhase(p);
  const { escrowId, amountMsats, description, signal } = opts;

  emit({ kind: "requesting-fedi-ecash" });

  // Pre-spend state gate. A throw here is BEFORE any ecash leaves Fedi — clean
  // exit, nothing to recover.
  try {
    await opts.preflight(escrowId);
  } catch (e) {
    const err = errMessage(e, "This trade can no longer be funded.");
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

  if (signal?.aborted) {
    emit({ kind: "aborted" });
    return { kind: "aborted" };
  }

  // Spend ecash OUT of Fedi. A throw is still pre-spend (Fedi mints nothing it
  // can't back), so also a clean exit.
  let notes: string;
  try {
    ({ notes } = await opts.generateEcash(amountMsats, description));
  } catch (e) {
    const err = fediGenerateErrorCopy(e);
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

  // The sats have now LEFT Fedi and live only in `notes`. Persist them
  // synchronously BEFORE the abort-check + lock can drop them.
  opts.stashFunding({ escrowId, oobNotes: notes, amountMsats });

  // The notesHash the LOCK must commit to for the spend to count as committed.
  const expectedNotesHash = await opts.hashNotes(notes);

  // Re-absorb the spent notes back into Fedi. true ⇒ Fedi confirmed receipt and
  // the stash was cleared; false ⇒ stash kept for the boot drain.
  const reabsorb = async (): Promise<boolean> => {
    try {
      await opts.receiveEcash(notes);
      opts.clearFunding(escrowId);
      return true;
    } catch {
      return false;
    }
  };

  // Caller aborted after the spend → refund and report aborted (EXIT A).
  if (signal?.aborted) {
    await reabsorb();
    emit({ kind: "aborted" });
    return { kind: "aborted" };
  }

  emit({ kind: "fedi-ecash-created" });
  emit({ kind: "locking" });

  // Lock the notes + publish LOCK. A throw (amount mismatch — "No LOCK was
  // published" — or publish failure) means no LOCK exists → refund (EXIT B).
  let lockedNotesHash: string | null;
  try {
    ({ lockedNotesHash } = await opts.lockAndPublish(escrowId, notes, {
      savedHandleId: opts.savedHandleId,
      selectedItems: opts.selectedItems,
    }));
  } catch (e) {
    return await recoverFailedLock(reabsorb, errMessage(e, "LOCK failed."), emit);
  }

  // Positive confirmation: commit ONLY on a genuine LOCKED-with-our-notesHash.
  // Anything else — a stale-suppression resolve on a terminal/cancelled trade,
  // or a LOCK that committed DIFFERENT notes (a racing tab locked first) —
  // means our notes are still live, so refund them. Unknown ⇒ don't assume
  // committed. This closes the silent hole where the lock action swallows
  // "Cannot LOCK"/"TERMINAL" and resolves without throwing.
  if (lockedNotesHash !== null && lockedNotesHash === expectedNotesHash) {
    opts.clearFunding(escrowId);
    emit({ kind: "locked" });
    return { kind: "locked" };
  }

  return await recoverFailedLock(
    reabsorb,
    "This trade was no longer lockable.",
    emit,
  );
}
