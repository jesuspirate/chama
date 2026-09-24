// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending Native-Lock Stash (SDK-wallet lock crash-safety, #37)
// ══════════════════════════════════════════════════════════════════════════
//
// Sibling of pending-fundings.ts (Fedi) and pending-redemptions.ts (claim),
// for the SDK-wallet lock path — the native Rust sidecar AND the browser
// WASM wallet, i.e. every non-Fedi real wallet. Those paths spend ecash out
// of the wallet (`spendNotes`) and publish the LOCK as a SECOND await:
//
//   1. User funds a CREATED trade (BOLT11 / NWC / on-chain / Try-LOCK-now).
//   2. `lockAndPublish` spends the trade amount → OOB bearer notes that
//      live only on the JS stack.
//   3. The notes are SSS-split and a LOCK is published.
//   4. A reload/crash between (2) and (3) strands the notes: the balance is
//      gone, the trade stays CREATED, and (pre-#37) NOTHING was persisted —
//      the RecoveryBanner then mis-fired and advised draining a live trade.
//
// This store persists the lock's lifecycle so boot can recover:
//
//   intent            → written BEFORE the spend (also covers the
//                       reload-DURING-spend window where the sidecar
//                       completes the spend but the response is lost:
//                       nothing recoverable client-side, but the balance
//                       story stays attributable + honest).
//   spent             → the OOB notes exist; upgraded SYNCHRONOUSLY the
//                       moment spendNotes returns.
//   publish-attempted → set immediately before the LOCK publish; from here
//                       on, an existing LOCK-with-our-notesHash must be
//                       positively ruled out before any re-absorb.
//   (cleared)         → ONLY on a confirmed LOCKED-with-our-notesHash, a
//                       confirmed re-absorb, or positively-dead notes.
//
// ── Recovery = RE-ABSORB ONLY, never re-publish ───────────────────────────
//
// Boot recovery reissues the stashed notes back into the own wallet
// (`redeemWithRetry` → native `/reissue-notes` / browser reissue). It NEVER
// re-publishes a LOCK: a rebuilt/replayed LOCK can permanently brick the
// trade chain (two distinct LOCK events fail replay for every client — the
// second's INVALID_STATE is not replay-benign) and a stale bundle whose
// notes the wallet's try_cancel auto-refund already reclaimed would hand
// the counterparty a hollow escrow. Re-absorb is the same self-reissue the
// auto-cancel performs: idempotent, signer-free, fee-free, mint-mutex
// covered. "Resume" is then a normal FOREGROUND lock from the restored
// balance (fresh spend, fresh horizon, protected by this same stash).
//
// ── Fail-closed rules (v0.1.76 / V8 lineage) ──────────────────────────────
//
// * The stash must be provably writable BEFORE the spend fires
//   (`assertNativeLockStashWritable`, the payout-journal V8 pattern) — a
//   silently-unsaved stash would re-open the exact window this closes.
// * An entry is cleared ONLY on a positively-confirmed outcome. Unknown
//   trade state (relay fetch failed / fed mismatch) ⇒ keep, do nothing.
// * A `publish-attempted` entry is NEVER re-absorbed from relay absence alone.
//   Relays may age out a valid LOCK that another device still retains; only
//   positive chain evidence may decide it.
//
// ── Storage ────────────────────────────────────────────────────────────────
//
// localStorage, user-scoped (same rationale as the sibling stashes):
// synchronous — the spent-upgrade happens with NO await between the spend
// resolving and the write. Deliberately NOT cleared by wallet resets: the
// entries reference bearer value the federation still honors.
//
// Kept STRICTLY separate from `chama_pending_fundings_v1` (Fedi): the
// recover actions differ (`redeemWithRetry` vs `receiveFediEcash`) and are
// both money-critical — a bug in one lane must never reach the other.

import {
  getStrictScopedStorageItem,
  removeStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";
import type { SelectedMenuItem } from "../escrow-engine/types.js";
import { EscrowStatus, type EscrowState } from "../escrow-engine/types.js";
import { compactSelectedMenuItems } from "../escrow-engine/selected-menu-items.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so the payload shape can migrate later. */
export const PENDING_NATIVE_LOCKS_KEY = "chama_pending_native_locks_v1";

/**
 * After this many failed re-absorb attempts we stop retrying automatically.
 * The entry stays in the stash with `lastError` set (bearer notes are never
 * dropped) and surfaces on the calm Me-tab card instead of retry-churning.
 */
export const MAX_NATIVE_LOCK_DRAIN_ATTEMPTS = 12;

/**
 * How long an `intent`-stage entry (nothing spent yet) stays relevant.
 * Intents exist for honest attribution ("you were funding trade X") and to
 * key the resume card; past this age the funding attempt is stale and the
 * normal recovery surfaces take back over. Spent/publish-attempted entries
 * NEVER expire — they reference real bearer value.
 */
export const NATIVE_LOCK_INTENT_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Hard bound on how long a notes-carrying entry may SUPPRESS the
 * drain-shaped recovery surfaces. Recovery can be kept pending
 * indefinitely by causes that never consume the retry budget (federation
 * mismatch, relays down at every boot) — the entry itself must survive
 * (bearer value), but past this age it moves to the calm stuck card and
 * stops hiding unrelated stranded balance. Review finding F1/F14/F17.
 */
export const NATIVE_LOCK_SUPPRESS_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum connected relays for a `publish-attempted` re-absorb decision.
 * Matches the relay-manager's adaptive-quorum floor: below this, a fetched
 * "no LOCK exists" is too weak to bet the counterparty's escrow on.
 */
export const NATIVE_LOCK_HEALTHY_RELAY_MIN = 2; // legacy export; absence no longer authorizes re-absorb

// ── Types ──────────────────────────────────────────────────────────────────

export type PendingNativeLockStage = "intent" | "spent" | "publish-attempted";

/** The lock options needed to re-run the SAME lock in the foreground.
 *  `selectedItems` is load-bearing (menu-listing locks throw without it);
 *  `savedHandleId` preserves the fiat-handle reveal. */
export interface PendingNativeLockOpts {
  savedHandleId?: string;
  selectedItems?: SelectedMenuItem[];
  /** Buyer seated when funding began. Preserved across a slow Lightning
   *  payment so expiry cannot erase the intended counterparty mid-lock. */
  buyerPubkey?: string;
}

export interface PendingNativeLock {
  /** Escrow ID this lock attempt belongs to (stash key). */
  escrowId: string;
  /** Lifecycle stage — see file header. */
  stage: PendingNativeLockStage;
  /** The OOB ecash spent for this lock. Present from stage `spent` on. */
  oobNotes?: string;
  /** Requested lock amount in msats (display + resume). */
  amountMsats: number;
  /** Federation the notes were minted on. Re-absorb and resume are only
   *  valid while joined to this fed. */
  federationId: string | null;
  /** Spend operation id, when the wallet surfaced one. Not used for
   *  recovery today; persisted for diagnostics and a future spend-state
   *  bridge endpoint. */
  operationId?: string;
  /** The try_cancel_after horizon the spend was submitted with (secs). */
  spendTimeoutSecs?: number;
  /** Lock options to reproduce the same lock on foreground resume. */
  lockOpts?: PendingNativeLockOpts;
  /** When the entry was first written (Unix ms). */
  createdAt: number;
  /** When the bearer-note spend completed and was synchronously stashed.
   *  Absent on legacy entries, which conservatively fall back to createdAt. */
  spentAt?: number;
  /** Re-absorb attempts (incremented only by recovery). */
  attempts: number;
  /** Last recovery error, if any. */
  lastError?: string;
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Stash = Record<string, PendingNativeLock>;

function compactLockOpts(opts: PendingNativeLockOpts | undefined): PendingNativeLockOpts | undefined {
  if (!opts) return undefined;
  return {
    ...opts,
    selectedItems: compactSelectedMenuItems(opts.selectedItems),
  };
}

function loadStash(): Stash {
  try {
    const raw = getStrictScopedStorageItem(PENDING_NATIVE_LOCKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const stash = parsed as Stash;
    let migrated = false;
    for (const entry of Object.values(stash)) {
      const before = entry.lockOpts?.selectedItems;
      if (!before) continue;
      const hadLegacyMedia = before.some(item =>
        Object.prototype.hasOwnProperty.call(item as object, "imageDataUrl")
      );
      if (hadLegacyMedia) {
        entry.lockOpts = compactLockOpts(entry.lockOpts);
        migrated = true;
      }
    }
    // Repair older pending retries immediately so a reload cannot restore
    // the oversized selection snapshot again.
    if (migrated) {
      setStrictScopedStorageItem(PENDING_NATIVE_LOCKS_KEY, JSON.stringify(stash));
    }
    return stash;
  } catch (e) {
    console.warn("[chama] pending-native-locks: loadStash failed:", e);
    return {};
  }
}

/** FAIL-CLOSED: a write failure here means the crash-safety guard did NOT
 *  persist — callers on the money path must not proceed past it. The
 *  pre-spend probe (`assertNativeLockStashWritable`) makes this loud
 *  BEFORE any sats move. */
function saveStash(stash: Stash): void {
  setStrictScopedStorageItem(PENDING_NATIVE_LOCKS_KEY, JSON.stringify(stash));
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API — stash lifecycle
// ══════════════════════════════════════════════════════════════════════════

/**
 * Probe that the stash can be PERSISTED right now (quota / private mode /
 * disabled storage — common on mobile WebViews). The bridge calls this
 * BEFORE spendNotes and refuses the lock when it throws, so a spend is
 * never fired without a working crash guard. Sentinel write+remove; never
 * disturbs the real stash. (payout-journal V8 pattern.)
 */
export function assertNativeLockStashWritable(): void {
  const probeKey = `${PENDING_NATIVE_LOCKS_KEY}_probe`;
  setStrictScopedStorageItem(probeKey, "1");
  try {
    removeStrictScopedStorageItem(probeKey);
  } catch {
    // Cleanup is best-effort; the write above is the load-bearing probe.
  }
}

/**
 * Record that a lock for this trade is about to spend (or that a funding
 * flow that will end in a lock has started). Create-or-refresh: an existing
 * intent's createdAt is refreshed (it's a NEW attempt for TTL purposes),
 * but an entry that already carries notes is left untouched — the caller
 * must settle it via recovery before starting a new attempt.
 */
export function stashNativeLockIntent(input: {
  escrowId: string;
  amountMsats: number;
  federationId: string | null;
  spendTimeoutSecs?: number;
  lockOpts?: PendingNativeLockOpts;
}): void {
  const stash = loadStash();
  const existing = stash[input.escrowId];
  if (existing && existing.stage !== "intent") {
    // Bearer notes live here — never downgrade/clobber. The bridge's
    // blocking gate should have settled this entry first; refusing keeps
    // the invariant even if a future caller forgets.
    console.warn(
      `[chama] pending-native-locks: refusing intent over ${existing.stage} entry for ${input.escrowId}`,
    );
    return;
  }
  stash[input.escrowId] = {
    escrowId: input.escrowId,
    stage: "intent",
    amountMsats: input.amountMsats,
    federationId: input.federationId,
    spendTimeoutSecs: input.spendTimeoutSecs,
    lockOpts: compactLockOpts(input.lockOpts),
    createdAt: Date.now(),
    attempts: 0,
  };
  saveStash(stash);
  console.info(
    `[fund-trace] native-lock-intent escrowId=${input.escrowId} amountMsats=${input.amountMsats}`,
  );
}

/**
 * The spend fired and returned notes — persist them SYNCHRONOUSLY (the
 * caller must not await anything between spendNotes resolving and this
 * call). Create-or-upgrade: works even if the intent write was lost (e.g.
 * a racing window dropped it). Refuses to overwrite DIFFERENT live notes —
 * by construction unreachable (the blocking gate settles prior entries),
 * so a hit here is a loud invariant break, not a normal path.
 */
export function upgradeNativeLockToSpent(input: {
  escrowId: string;
  oobNotes: string;
  amountMsats: number;
  federationId: string | null;
  operationId?: string;
  spendTimeoutSecs?: number;
  lockOpts?: PendingNativeLockOpts;
}): void {
  const stash = loadStash();
  const existing = stash[input.escrowId];
  if (existing?.oobNotes && existing.oobNotes !== input.oobNotes) {
    throw new Error(
      `pending-native-locks: entry for ${input.escrowId} already holds different ` +
        `live notes (stage=${existing.stage}) — refusing to overwrite bearer value.`,
    );
  }
  stash[input.escrowId] = {
    escrowId: input.escrowId,
    stage: "spent",
    oobNotes: input.oobNotes,
    amountMsats: input.amountMsats,
    federationId: input.federationId ?? existing?.federationId ?? null,
    operationId: input.operationId,
    spendTimeoutSecs: input.spendTimeoutSecs ?? existing?.spendTimeoutSecs,
    lockOpts: compactLockOpts(input.lockOpts ?? existing?.lockOpts),
    createdAt: existing?.createdAt ?? Date.now(),
    spentAt: existing?.spentAt ?? Date.now(),
    attempts: 0,
  };
  saveStash(stash);
  console.info(
    `[fund-trace] native-lock-spent escrowId=${input.escrowId} amountMsats=${input.amountMsats}`,
  );
}

/** About to publish the LOCK. From here on, recovery must positively rule
 *  out a committed LOCK-with-our-notesHash before re-absorbing. */
export function markNativeLockPublishAttempted(escrowId: string): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry || !entry.oobNotes) return;
  entry.stage = "publish-attempted";
  saveStash(stash);
}

/** Remove an entry. Called ONLY on a positively-confirmed outcome:
 *  LOCK committed with our notesHash, re-absorb confirmed, notes positively
 *  dead, or a stale intent aging out. */
export function clearPendingNativeLock(escrowId: string): void {
  const stash = loadStash();
  if (stash[escrowId]) {
    delete stash[escrowId];
    saveStash(stash);
    console.info(`[fund-trace] native-lock-clear escrowId=${escrowId}`);
  }
}

/** Clear an entry ONLY while it is still intent-stage (nothing spent).
 *  Used by the funding orchestrator's clean "expired" exit — the payment
 *  never arrived, so there is no balance story to attribute. Entries that
 *  carry notes are untouchable by this path. */
export function clearPendingNativeLockIfIntent(escrowId: string): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (entry && entry.stage === "intent") {
    delete stash[escrowId];
    saveStash(stash);
  }
}

export function getPendingNativeLock(escrowId: string): PendingNativeLock | null {
  return loadStash()[escrowId] ?? null;
}

/** Snapshot of all entries. For UI / drain / tests. */
export function listPendingNativeLocks(): PendingNativeLock[] {
  return Object.values(loadStash());
}

/** Test/advanced-settings helper. NOT called by wallet resets. */
export function clearAllPendingNativeLocks(): void {
  try {
    removeStrictScopedStorageItem(PENDING_NATIVE_LOCKS_KEY);
  } catch (e) {
    console.warn("[chama] pending-native-locks: clearAll failed:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PER-ESCROW FLOW MUTEX (review findings F7/F11/F15)
// ══════════════════════════════════════════════════════════════════════════
//
// Recovery must never act on an entry while a LIVE lock flow for the same
// trade is between its spend and its publish-confirm — a re-absorb there
// hands the counterparty a hollow escrow, and a stale-snapshot clear can
// delete the successor entry guarding an in-flight lock. Every actor
// (bridge.lockAndPublish, the pre-invoice settle, the boot drain) runs its
// whole per-trade critical section through this chain, so within one JS
// context they strictly serialize. Cross-TAB interleavings remain possible
// (localStorage is shared; the mint mutex serializes only the wallet ops)
// — the identity-guarded clears below are the belt-and-suspenders for
// those, and native shells are single-webview anyway.

const nativeLockFlowChains = new Map<string, Promise<unknown>>();

export function withNativeLockFlow<T>(
  escrowId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = nativeLockFlowChains.get(escrowId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  nativeLockFlowChains.set(escrowId, tail);
  void tail.then(() => {
    if (nativeLockFlowChains.get(escrowId) === tail) {
      nativeLockFlowChains.delete(escrowId);
    }
  });
  return run;
}

/** Delete the entry ONLY if it still holds exactly these notes — a
 *  cross-tab successor entry (fresh notes for a new attempt) must never be
 *  deleted on the strength of a stale snapshot. */
function clearPendingNativeLockMatching(escrowId: string, oobNotes: string): void {
  const stash = loadStash();
  const live = stash[escrowId];
  if (!live) return;
  if (live.oobNotes !== oobNotes) {
    console.warn(
      `[chama] pending-native-locks: skip clear for ${escrowId} — live entry holds different notes (successor attempt)`,
    );
    return;
  }
  delete stash[escrowId];
  saveStash(stash);
  console.info(`[fund-trace] native-lock-clear escrowId=${escrowId}`);
}

// ══════════════════════════════════════════════════════════════════════════
// RECOVERY — the fail-closed decision table (pure w.r.t. injected deps)
// ══════════════════════════════════════════════════════════════════════════

export interface NativeLockRecoveryDeps {
  /** Fresh relay fetch + replay for the trade. Bound to client.loadEscrow. */
  loadEscrow(escrowId: string): Promise<EscrowState | null>;
  /** Connected-relay count at decision time (healthy-read gate). */
  getConnectedRelayCount(): number;
  /** Reissue OUR OWN spent notes back into the wallet. Bound to
   *  fedimint.redeemWithRetry (mint-mutex + already-spent classification
   *  live there). */
  redeemNotes(oobNotes: string): Promise<void>;
  /** The wallet's CURRENT federation id (cached, no network). */
  currentFederationId(): string | null;
  /** SHA-256 hex of a notes string — the LOCK's notesHash function. */
  hashNotes(notes: string): Promise<string>;
  /** Leave a durable "your funding came back" breadcrumb after a successful
   *  re-absorb, so the honest calm banner can attribute the restored balance
   *  (instead of the generic "trade needs attention" alarm the cleared-entry
   *  used to fall through to). Bound to recordSatsTrace in useEscrow; omitted
   *  in tests. Recorded on BOTH the lockable and terminal paths — it's the
   *  fallback story if a downgraded-intent trade later expires. */
  recordReabsorbedResidue?(input: { escrowId: string; amountMsats: number }): void;
  now?(): number;
}

export type NativeLockRecoveryOutcome =
  /** A LOCK with our notesHash is committed — the trade owns the notes.
   *  Entry cleared; NOTHING was re-absorbed. */
  | "cleared-committed"
  /** Notes confirmed back in the wallet. Entry cleared. */
  | "reabsorbed"
  /** The federation reports the notes consumed and no LOCK of ours exists —
   *  our own try_cancel auto-refund (or an earlier re-absorb) already made
   *  the wallet whole. Entry cleared; nothing movable remains. */
  | "cleared-dead-notes"
  /** Stale intent aged out (nothing was ever spent). Entry cleared. */
  | "cleared-stale-intent"
  /** Could not positively resolve — entry kept for the next attempt.
   *  Unknown ⇒ refuse (v0.1.76). */
  | "kept";

export function shouldClearNativeLockAfterPublish(input: {
  committedNotesHash: string | null | undefined;
  expectedNotesHash: string;
  custodyDurability: "acknowledged" | "pending" | "expired-unacked" | undefined;
}): boolean {
  return input.committedNotesHash === input.expectedNotesHash
    && input.custodyDurability === "acknowledged";
}

const ALREADY_SPENT_SUBSTRINGS = [
  "already spent",
  "already redeemed",
  "already used",
  "double spend",
  "double-spend",
  "note already",
];

function isNotesDeadError(e: unknown): boolean {
  const code = typeof (e as any)?.code === "string" ? (e as any).code : "";
  if (code === "ALREADY_SPENT_UNCONFIRMED" || code === "MINT_REISSUE_UNKNOWN") {
    // For a CLAIM these codes mean "maybe front-run — needs attention". For a
    // FUNDING re-absorb they mean the opposite: the only parties who ever
    // held these notes are this wallet (and, had a LOCK committed, the
    // escrow — positively ruled out by the caller before redeeming). A
    // consumed note here is our own auto-refund/prior re-absorb having
    // landed: the wallet is whole, nothing movable remains.
    return true;
  }
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return ALREADY_SPENT_SUBSTRINGS.some((s) => msg.includes(s));
}

/**
 * Settle one entry. NEVER publishes anything; the only wallet mutation is
 * the self-reissue. See the decision table in the file header/brief.
 *
 * `ignoreAttemptCap`: user-initiated retries (Fund tap / Finish-lock) get
 * a fresh budget — the cap exists to stop BOOT-drain churn, not to lock a
 * trade out of recovery forever.
 */
export async function recoverPendingNativeLock(
  entry: PendingNativeLock,
  deps: NativeLockRecoveryDeps,
  opts: { ignoreAttemptCap?: boolean } = {},
): Promise<NativeLockRecoveryOutcome> {
  const now = deps.now?.() ?? Date.now();

  // ── Intent stage: nothing was spent — nothing to move. Age out only.
  //    Guarded delete: a concurrent flow may have upgraded the entry to
  //    `spent` since this snapshot was taken. ──
  if (entry.stage === "intent" || !entry.oobNotes) {
    if (now - entry.createdAt > NATIVE_LOCK_INTENT_TTL_MS) {
      const stash = loadStash();
      const live = stash[entry.escrowId];
      if (live && live.stage === "intent" && live.createdAt === entry.createdAt) {
        delete stash[entry.escrowId];
        saveStash(stash);
        return "cleared-stale-intent";
      }
      return "kept";
    }
    return "kept";
  }

  // ── Fed gate: the notes only exist on their minting federation. Not an
  //    attempt failure — the drain re-fires after every fed switch. ──
  const currentFed = deps.currentFederationId();
  if (!currentFed || (entry.federationId && currentFed !== entry.federationId)) {
    noteKept(entry.escrowId, `federation mismatch (notes on ${entry.federationId ?? "unknown"}, wallet on ${currentFed ?? "none"})`, { bumpAttempts: false });
    return "kept";
  }

  // ── Retry budget: exhausted entries surface calmly, stop auto-churning. ──
  if (!opts.ignoreAttemptCap && entry.attempts >= MAX_NATIVE_LOCK_DRAIN_ATTEMPTS) {
    return "kept";
  }

  // ── Trade state: the ONLY basis for the re-absorb decision. Sample the
  //    relay pool BEFORE the fetch as well as after (F16): the fetch's own
  //    quorum freezes at REQ dispatch, so a boot-race where one relay
  //    answered and more connected afterwards must not read as healthy. ──
  deps.getConnectedRelayCount(); // diagnostic capability retained; not proof of event absence
  let state: EscrowState | null = null;
  try {
    state = await deps.loadEscrow(entry.escrowId);
  } catch (e) {
    noteKept(entry.escrowId, `loadEscrow failed: ${errMsg(e)}`, { bumpAttempts: false });
    return "kept";
  }

  if (state) {
    const committedHash = state.lock?.notesHash ?? null;
    if (committedHash) {
      let ourHash: string;
      try {
        ourHash = await deps.hashNotes(entry.oobNotes);
      } catch (e) {
        noteKept(entry.escrowId, `hashNotes failed: ${errMsg(e)}`, { bumpAttempts: false });
        return "kept";
      }
      if (committedHash === ourHash) {
        if (state.lock?.custodyDurability === "pending"
          || state.lock?.custodyDurability === "expired-unacked") {
          noteKept(
            entry.escrowId,
            `LOCK is only locally applied (${state.lock.custodyDurability}); awaiting relay custody`,
            { bumpAttempts: false },
          );
          return "kept";
        }
        // Our crash-window publish actually landed: the escrow owns these
        // notes now. Re-absorbing would hollow our OWN live trade.
        clearPendingNativeLock(entry.escrowId);
        console.info(
          `[chama] native-lock recovery: LOCK committed with our notes for ${entry.escrowId} — cleared, nothing to recover.`,
        );
        return "cleared-committed";
      }
      // A DIFFERENT lock owns the chain — our notes are referenced nowhere.
      return reabsorb(entry, deps, state);
    }

    // No LOCK in the fetched chain (CREATED / CANCELLED / EXPIRED).
    if (entry.stage === "spent") {
      // The publish never even started — provably unpublished.
      return reabsorb(entry, deps, state);
    }
    // publish-attempted: "no LOCK in the fetch" is only trustworthy on a
    // healthy read — a degraded pool could hide a LOCK that one relay took.
    // Both samples (pre-fetch + now) must clear the bar.
    noteKept(entry.escrowId, "publish-attempted LOCK absent from relays; waiting for positive evidence", { bumpAttempts: false });
    return "kept";
  }

  // Unknown trade state ⇒ refuse to act.
  noteKept(entry.escrowId, "trade state unknown (loadEscrow returned null)", { bumpAttempts: false });
  return "kept";
}

async function reabsorb(
  entry: PendingNativeLock,
  deps: NativeLockRecoveryDeps,
  state: EscrowState,
): Promise<NativeLockRecoveryOutcome> {
  // Bump attempts BEFORE the try so attempts that crash mid-redeem count.
  // Identity-guarded: never mutate a successor entry (different notes).
  const stash = loadStash();
  const live = stash[entry.escrowId];
  if (live && live.oobNotes === entry.oobNotes) {
    live.attempts += 1;
    saveStash(stash);
  }
  try {
    await deps.redeemNotes(entry.oobNotes!);
    // The notes are back in the wallet. Two futures for that restored
    // balance, decided by whether the trade can still be locked:
    //   • lockable (CREATED, not past deadline) → downgrade to a fresh
    //     INTENT so the calm "Finish locking your trade" card persists;
    //     re-lock spends fresh from the balance we just restored.
    //   • terminal/expired → clear (nothing to re-lock).
    // EITHER WAY leave a durable funding breadcrumb so the balance reads as
    // "your funding came back" (honest calm banner), never the generic
    // "trade needs attention" alarm the cleared entry used to strand into.
    const now = deps.now?.() ?? Date.now();
    try {
      deps.recordReabsorbedResidue?.({ escrowId: entry.escrowId, amountMsats: entry.amountMsats });
    } catch { /* best-effort breadcrumb — never block recovery */ }
    if (tradeStillLockable(state, now)) {
      downgradeReabsorbedToIntent(entry, now);
      console.info(
        `[chama] native-lock recovery: re-absorbed ${entry.amountMsats / 1000} sats for ${entry.escrowId} ` +
          `— trade still lockable, downgraded to intent (Finish-lock resumes).`,
      );
    } else {
      clearPendingNativeLockMatching(entry.escrowId, entry.oobNotes!);
      console.info(
        `[chama] native-lock recovery: re-absorbed ${entry.amountMsats / 1000} sats for ${entry.escrowId} ` +
          `— trade terminal, cleared (funds returned to wallet).`,
      );
    }
    return "reabsorbed";
  } catch (e) {
    if (isNotesDeadError(e)) {
      // No LOCK of ours exists (checked above) and the mint reports the
      // notes consumed ⇒ our own auto-refund / prior re-absorb landed.
      clearPendingNativeLockMatching(entry.escrowId, entry.oobNotes!);
      console.warn(
        `[chama] native-lock recovery: notes for ${entry.escrowId} already consumed ` +
          `(auto-refund or earlier re-absorb) — wallet is whole, entry cleared.`,
      );
      return "cleared-dead-notes";
    }
    noteKept(entry.escrowId, errMsg(e), { bumpAttempts: false }); // attempts already bumped
    return "kept";
  }
}

/** A re-absorbed trade can still be finished only while it's CREATED and not
 *  past its deadline — mirrors the reducer's LOCK precondition. Once LOCKED
 *  (by anyone's notes), EXPIRED, or CANCELLED, re-locking is impossible and
 *  the restored balance is simply the user's returned funding. */
function tradeStillLockable(state: EscrowState, nowMs: number): boolean {
  if (state.status !== EscrowStatus.CREATED) return false;
  const nowSec = Math.floor(nowMs / 1000);
  const pastDeadline =
    typeof state.expiresAt === "number" && state.expiresAt > 0 && nowSec > state.expiresAt;
  return !pastDeadline;
}

/** Replace a re-absorbed `spent`/`publish-attempted` entry with a FRESH
 *  intent so the "Finish locking your trade" card keeps offering a re-lock
 *  from the restored balance. Drops oobNotes/operationId (the notes are back
 *  in the wallet, no longer stashed), resets attempts + createdAt so the
 *  resume card isn't treated as aged-out. Identity-guarded: never clobber a
 *  successor attempt that replaced this entry since the drain snapshot. */
function downgradeReabsorbedToIntent(entry: PendingNativeLock, nowMs: number): void {
  const stash = loadStash();
  const live = stash[entry.escrowId];
  if (!live || live.oobNotes !== entry.oobNotes) return;
  stash[entry.escrowId] = {
    escrowId: entry.escrowId,
    stage: "intent",
    amountMsats: entry.amountMsats,
    federationId: entry.federationId,
    spendTimeoutSecs: entry.spendTimeoutSecs,
    lockOpts: entry.lockOpts,
    attempts: 0,
    createdAt: nowMs,
  };
  saveStash(stash);
}

function noteKept(
  escrowId: string,
  reason: string,
  opts: { bumpAttempts: boolean },
): void {
  const stash = loadStash();
  const entry = stash[escrowId];
  if (!entry) return;
  if (opts.bumpAttempts) entry.attempts += 1;
  entry.lastError = reason.slice(0, 500);
  saveStash(stash);
  console.warn(`[chama] native-lock recovery kept ${escrowId}: ${reason}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}

// ══════════════════════════════════════════════════════════════════════════
// BOOT DRAIN
// ══════════════════════════════════════════════════════════════════════════

export interface NativeLockDrainSummary {
  attempted: number;
  reabsorbed: number;
  clearedCommitted: number;
  clearedDead: number;
  stillPending: number;
}

let drainChain: Promise<unknown> = Promise.resolve();

/**
 * Settle every entry. Drains CHAIN rather than coalesce: initFedimint
 * re-runs on every fed/community switch with freshly-bound deps, and a
 * switch-time drain must not be swallowed by a still-running earlier drain
 * whose deps point at the previous federation (review finding F18).
 * Fire-and-forget from useEscrow.initFedimint beside the sibling drains.
 * The caller gates on sim/testnet (this store is never written there).
 */
export function drainPendingNativeLocks(
  deps: NativeLockRecoveryDeps,
): Promise<NativeLockDrainSummary> {
  const run = drainChain.then(() => drainPendingNativeLocksInner(deps));
  drainChain = run.catch(() => {});
  return run;
}

async function drainPendingNativeLocksInner(
  deps: NativeLockRecoveryDeps,
): Promise<NativeLockDrainSummary> {
  const summary: NativeLockDrainSummary = {
    attempted: 0,
    reabsorbed: 0,
    clearedCommitted: 0,
    clearedDead: 0,
    stillPending: 0,
  };
  for (const snapshot of listPendingNativeLocks()) {
    try {
      // Per-trade critical section + fresh re-read: an inline settle or a
      // Finish-lock flow may have settled (or REPLACED) this entry while
      // the drain was working through earlier ones — never act on a stale
      // snapshot (review finding F15).
      const outcome = await withNativeLockFlow(snapshot.escrowId, async () => {
        const live = getPendingNativeLock(snapshot.escrowId);
        if (!live) return null;
        return recoverPendingNativeLock(live, deps);
      });
      if (outcome === null) continue;
      summary.attempted++;
      if (outcome === "reabsorbed") summary.reabsorbed++;
      else if (outcome === "cleared-committed") summary.clearedCommitted++;
      else if (outcome === "cleared-dead-notes") summary.clearedDead++;
      else if (outcome === "kept") summary.stillPending++;
    } catch (e) {
      // Defense-in-depth — recoverPendingNativeLock handles its own errors.
      summary.stillPending++;
      console.warn(`[chama] native-lock drain error for ${snapshot.escrowId}:`, e);
    }
  }
  if (summary.attempted > 0) {
    console.info("[chama] pending-native-lock drain:", summary);
  }
  return summary;
}

// ══════════════════════════════════════════════════════════════════════════
// UI SUMMARY (pure — testable without React)
// ══════════════════════════════════════════════════════════════════════════

export interface NativeLockUiSummary {
  /** Suppress the drain-shaped recovery surfaces (RecoveryBanner, ChamaBar
   *  stranded pill, MeScreen recover card, fed-switch drain CTA) while an
   *  actionable recovery/resume story exists. HARD-BOUNDED (review
   *  F1/F14/F17): stale intents, intents no current balance could satisfy,
   *  attempt-exhausted entries, entries older than
   *  NATIVE_LOCK_SUPPRESS_MAX_MS, and entries whose notes live on a
   *  DIFFERENT federation (they cannot explain THIS fed's balance) all
   *  stop suppressing. */
  suppressRecovery: boolean;
  /** The entry the "Finish locking your trade" card should point at
   *  (newest actionable), or null. */
  resume: PendingNativeLock | null;
  /** Entries recovery can't currently act on (attempt-exhausted, aged out,
   *  or minted on another federation) → the calm "couldn't finish
   *  automatically" Me-tab card. These do NOT suppress the recovery
   *  surfaces. */
  stuck: PendingNativeLock[];
}

export function summarizeNativeLocksForUi(
  entries: readonly PendingNativeLock[],
  nowMs: number,
  opts: {
    /** The wallet's CURRENT federation. When provided, entries minted on a
     *  different fed neither suppress nor resume — recovery for them waits
     *  on a fed switch, and hiding THIS fed's recovery surfaces for them
     *  would make unrelated stranded balance invisible. */
    currentFederationId?: string | null;
    /** Current wallet balance. When provided, an intent-stage entry only
     *  counts as actionable if the balance could actually satisfy its lock
     *  (the W1 signature: the funding payment landed). A cancelled or
     *  failed funding that never took money then tells no false story. */
    balanceMsats?: number;
  } = {},
): NativeLockUiSummary {
  const active: PendingNativeLock[] = [];
  const stuck: PendingNativeLock[] = [];
  for (const e of entries) {
    if (e.stage === "intent") {
      const fresh = nowMs - e.createdAt <= NATIVE_LOCK_INTENT_TTL_MS;
      const satisfiable =
        opts.balanceMsats === undefined || opts.balanceMsats >= e.amountMsats;
      if (fresh && satisfiable) active.push(e);
      // Stale/unsatisfiable intents are inert (no card, no suppression) —
      // the TTL cleanup retires them; nothing was ever spent.
      continue;
    }
    const fedMismatch =
      opts.currentFederationId != null &&
      e.federationId != null &&
      e.federationId !== opts.currentFederationId;
    if (
      e.attempts >= MAX_NATIVE_LOCK_DRAIN_ATTEMPTS ||
      nowMs - e.createdAt > NATIVE_LOCK_SUPPRESS_MAX_MS ||
      fedMismatch
    ) {
      stuck.push(e);
      continue;
    }
    active.push(e);
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  return {
    suppressRecovery: active.length > 0,
    resume: active[0] ?? null,
    stuck,
  };
}

/** Funding must never interpret unreadable ownership records as an empty wallet reservation. */
export function nativeLockEarmarks(federationId: string | null): (number | undefined)[] {
  try {
    const raw = getStrictScopedStorageItem(PENDING_NATIVE_LOCKS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [undefined];
    return Object.values(parsed).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [undefined];
      const lock = entry as Partial<PendingNativeLock>;
      if (lock.federationId && federationId && lock.federationId !== federationId) return [];
      return [lock.amountMsats];
    });
  } catch { return [undefined]; }
}
