// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending Funding Stash (Fedi funding fund-loss guard)
// ══════════════════════════════════════════════════════════════════════════
//
// Sibling of pending-redemptions.ts, for the OPPOSITE direction of bearer
// notes on the Fedi (browser `generateEcash`) funding path:
//
//   1. User taps Fund on a CREATED trade.
//   2. `generateFediEcash` spends ecash OUT of the Fedi host wallet →
//      out-of-band bearer notes that live only on the JS stack.
//   3. The notes are locked into 2-of-3 SSS escrow + a LOCK is published.
//   4. App aborts / throws / closes (crash, refresh, background kill)
//      between (2) and (3) confirming.
//
// In that window the sats have already left Fedi but no LOCK exists — the
// bearer token is orphaned. (#37 correction: the SDK-wallet lock paths —
// native sidecar + browser WASM — were NEVER immune; their spend→publish
// window is guarded by the SIBLING store src/fedimint/pending-native-locks.ts.
// This store stays Fedi-ONLY.) The Fedi path spends first and locks second,
// so it needs the same crash-safety the CLAIM path got in v0.1.68 — only
// mirrored. The CLAIM stash REDEEMS its notes into the wallet; this stash
// RE-ABSORBS its notes back into Fedi via `receiveFediEcash`. The recover
// actions differ and all are money-critical, so the stores are kept
// strictly separate: a bug in one lane's recovery can never reach another.
//
// ── When an entry is written / cleared ────────────────────────────────────
//
// Written:  synchronously (localStorage) immediately AFTER generateFediEcash
//           returns and BEFORE the abort-check + lock. See
//           src/payments/fedi-fund-and-lock.ts.
// Cleared:  only on a positively-confirmed outcome — either the LOCK
//           published with our notesHash (committed), or `receiveFediEcash`
//           confirmed the notes are back in Fedi (refunded). Never cleared
//           on an unknown outcome — unknown ⇒ keep the bearer token.
//
// ── Storage strategy ──────────────────────────────────────────────────────
//
// localStorage, user-scoped, same rationale as pending-redemptions.ts:
// synchronous (no await in the critical fund path), durable across
// crashes/refreshes, well under quota for realistic queue sizes.
//
// ── Reset semantics ───────────────────────────────────────────────────────
//
// Like the redemption stash, this is deliberately NOT cleared by
// resetLocalFedimintWallet(). Ecash is a bearer token — a wallet reset must
// never discard notes the federation will still honor.

import {
  getStrictScopedStorageItem,
  removeStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";
import { hasFediInternalReceiveEcash, receiveFediEcash } from "./fedi-internal.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so we can migrate the payload shape later. */
export const PENDING_FUNDINGS_KEY = "chama_pending_fundings_v1";

/**
 * After this many failed re-absorb attempts we stop retrying automatically.
 * The entry stays in the stash with `lastError` set so the bearer notes are
 * never dropped and remain visible for manual recovery.
 */
export const MAX_FUNDING_DRAIN_ATTEMPTS = 12;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PendingFunding {
  /** Escrow ID this funding belongs to (stash key) */
  escrowId: string;
  /** The OOB ecash notes spent out of Fedi, awaiting LOCK or re-absorb */
  oobNotes: string;
  /** Amount these notes represent, in msats */
  amountMsats: number;
  /** When the entry was first stashed (Unix ms) */
  createdAt: number;
  /** Number of re-absorb attempts (incremented only by drain) */
  attempts: number;
  /** Last re-absorb error, if any. Presence = re-absorb has failed at least once. */
  lastError?: string;
}

export interface FundingDrainSummary {
  attempted: number;
  /** Notes confirmed back in Fedi this drain (entry cleared). */
  reabsorbed: number;
  /** Entries left in the stash for the next drain. */
  stillPending: number;
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Stash = Record<string, PendingFunding>;

/** Parse the stored stash. THROWS when a value exists but is not a stash: it
 *  may hold the only copy of spent bearer notes, so it must never be read as
 *  empty by a writer and then overwritten. */
function loadStashStrict(): Stash {
  const raw = getStrictScopedStorageItem(PENDING_FUNDINGS_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pending-funding stash is unreadable");
  }
  return parsed as Stash;
}

/** Read-only view for listing and draining. A corrupt stash reads as empty
 *  here and stays untouched on disk. */
function loadStash(): Stash {
  try {
    return loadStashStrict();
  } catch (e) {
    console.warn("[chama] pending-fundings: loadStash failed:", e);
    return {};
  }
}

/** Throws on failure. Swallowing a failed write here would leave spent notes
 *  with no durable copy while the funding flow carries on as if they had one. */
function saveStash(stash: Stash): void {
  setStrictScopedStorageItem(PENDING_FUNDINGS_KEY, JSON.stringify(stash));
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Pre-spend probe. Throws if the stash cannot be read or written right now, so
 * the Fedi funding flow refuses BEFORE any ecash leaves Fedi rather than
 * discovering the problem with the notes already spent.
 */
export function assertPendingFundingWritable(): void {
  loadStashStrict();
  const probeKey = `${PENDING_FUNDINGS_KEY}_probe`;
  setStrictScopedStorageItem(probeKey, "1");
  try {
    removeStrictScopedStorageItem(probeKey);
  } catch {
    // Cleanup is best-effort; the write above is the load-bearing probe.
  }
}

/**
 * Stash spent OOB funding notes to localStorage. Called by the Fedi
 * fund orchestrator AFTER generateFediEcash returns and BEFORE the
 * abort-check + lock.
 *
 * Idempotent: re-stashing the same escrowId updates the notes but
 * preserves createdAt and attempts.
 */
export function stashPendingFunding(input: {
  escrowId: string;
  oobNotes: string;
  amountMsats: number;
}): void {
  const stash = loadStashStrict();
  const existing = stash[input.escrowId];
  stash[input.escrowId] = {
    escrowId: input.escrowId,
    oobNotes: input.oobNotes,
    amountMsats: input.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: existing?.attempts ?? 0,
    lastError: existing?.lastError,
  };
  saveStash(stash);
  console.info(
    `[fund-trace] pending-funding-stash escrowId=${input.escrowId} ` +
      `amountMsats=${input.amountMsats}`,
  );
}

/**
 * Remove an entry from the stash. Called only after a positively-confirmed
 * outcome: the LOCK published with our notesHash, or `receiveFediEcash`
 * confirmed the notes are back in Fedi.
 */
export function clearPendingFunding(escrowId: string): void {
  try {
    const stash = loadStashStrict();
    if (stash[escrowId]) {
      delete stash[escrowId];
      saveStash(stash);
      console.info(`[fund-trace] pending-funding-clear escrowId=${escrowId}`);
    }
  } catch (e) {
    // Clearing follows a confirmed outcome; a failure leaves the entry in
    // place, which never loses notes.
    console.error("[chama] pending-funding: clear failed (entry kept):", e);
  }
}

/** Snapshot of all current entries. For UI / debug / tests. */
export function listPendingFundings(): PendingFunding[] {
  return Object.values(loadStash());
}

/**
 * Re-absorb every stashed funding entry back into the Fedi wallet via
 * `receiveFediEcash`. Fire-and-forget from useEscrow.initFedimint, mirroring
 * the claim-side drainPendingRedemptions.
 *
 * Recovers the launch-blocker fund-loss: a fund flow that spent ecash out of
 * Fedi but died before the LOCK published leaves notes here; this puts them
 * back so the user is whole.
 *
 * ── Conservative clearing ─────────────────────────────────────────────────
 * An entry is cleared ONLY on a confirmed `receiveFediEcash` resolve. ANY
 * error — including a Fedi "already spent" on a note that actually landed in
 * an earlier session — leaves the entry in place (bounded by
 * MAX_FUNDING_DRAIN_ATTEMPTS). We would rather keep a benign already-home
 * entry around than risk a single false-clear of live bearer notes. The
 * narrow crash-between-receive-and-clear window therefore leaves a harmless
 * stale entry after the retry budget, never a loss.
 *
 * ── Wrong context is expected, not a crash ────────────────────────────────
 * If Fedi's `receiveEcash` isn't available (not a Fedi Mini-App runtime),
 * this no-ops — funding stashes are only ever created on the Fedi path, so a
 * non-Fedi boot simply leaves them for the next Fedi session.
 */
export async function drainPendingFundings(): Promise<FundingDrainSummary> {
  const summary: FundingDrainSummary = {
    attempted: 0,
    reabsorbed: 0,
    stillPending: 0,
  };

  if (!hasFediInternalReceiveEcash()) {
    // Not a Fedi runtime — nothing here can be re-absorbed. Leave entries
    // untouched for the next Fedi boot.
    const pending = Object.keys(loadStash()).length;
    summary.stillPending = pending;
    return summary;
  }

  const entries = Object.values(loadStash());

  for (const entry of entries) {
    // Out of retry budget — leave it visible in the stash, stop auto-retrying.
    if (entry.attempts >= MAX_FUNDING_DRAIN_ATTEMPTS) {
      summary.stillPending++;
      continue;
    }

    summary.attempted++;

    // Bump attempts BEFORE the try so attempts that crash the browser are
    // counted too, not just clean returns.
    entry.attempts += 1;
    try {
      saveStash({ ...loadStashStrict(), [entry.escrowId]: entry });
    } catch (e) {
      // Can't count this attempt durably. Leave the entry for a later boot
      // rather than retrying without a bounded budget.
      summary.stillPending++;
      console.warn(`[chama] pending funding for ${entry.escrowId}: attempt not recorded, skipped:`, e);
      continue;
    }

    try {
      // No expectedMsats: re-absorbing the exact notes we generated is exact,
      // and passing it risks a receive-then-throw-on-mismatch that would
      // double-attempt an already-consumed note on the next boot.
      await receiveFediEcash(entry.oobNotes);
      clearPendingFunding(entry.escrowId);
      summary.reabsorbed++;
      console.info(
        `[chama] re-absorbed pending funding for ${entry.escrowId} ` +
          `(${entry.amountMsats / 1000} sats)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        const stash = loadStashStrict();
        const cur = stash[entry.escrowId];
        if (cur) {
          cur.lastError = msg.slice(0, 500);
          saveStash(stash);
        }
      } catch (writeErr) {
        console.warn("[chama] pending-funding: lastError not recorded:", writeErr);
      }
      summary.stillPending++;
      console.warn(
        `[chama] pending funding for ${entry.escrowId} still pending after ` +
          `attempt ${entry.attempts}: ${msg}`,
      );
    }
  }

  if (summary.attempted > 0) {
    console.info("[chama] pending-funding drain:", summary);
  }

  return summary;
}

// ── Debug helper (not called in production paths) ──────────────────────────

/**
 * Clear the entire stash. Useful for tests and for a future advanced-settings
 * action. NOT called from resetLocalFedimintWallet — see file header.
 */
export function clearAllPendingFundings(): void {
  try {
    removeStrictScopedStorageItem(PENDING_FUNDINGS_KEY);
  } catch (e) {
    console.warn("[chama] pending-fundings: clearAll failed:", e);
  }
}
