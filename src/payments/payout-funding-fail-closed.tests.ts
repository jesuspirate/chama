// M4 + M5 (money-path review, Oct 2026): payout and funding records fail
// closed. An uncoded payout error keeps the pre-send intent; the double-pay
// guard covers every payout kind; an unreadable journal or stash is never read
// as empty by a writer; a Fedi funding never spends without a durable copy.
import assert from "node:assert/strict";
import { runClaimAndPayout, type RunClaimAndPayoutOpts } from "./claim-and-payout.js";
import { runFediFundAndLock, type RunFediFundAndLockOpts } from "./fedi-fund-and-lock.js";
import { LN_PAY_REFUNDED, LN_PAY_SUBMIT_FAILED, codedPayError } from "./ln-pay-codes.js";
import {
  PAYOUT_JOURNAL_KEY,
  assertPayoutJournalReadable,
  assertPayoutJournalWritable,
  clearPayoutRecord,
  getPayoutRecord,
  markPayoutSettled,
  recordPayoutIntent,
  recordPayoutSubmitted,
} from "./payout-journal.js";
import {
  PENDING_FUNDINGS_KEY,
  assertPendingFundingWritable,
  clearPendingFunding,
  listPendingFundings,
  stashPendingFunding,
} from "../fedimint/pending-fundings.js";
import { scopedStorageKey, setLocalStorageUserScope } from "../storage/user-scope.js";

const values = new Map<string, string>();
let failWrites = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      values.set(k, v);
    },
    removeItem: (k: string) => { values.delete(k); },
  },
});
setLocalStorageUserScope("alice");

type Status = "intent" | "submitted" | "settled";
type Outcome = "settled" | "refunded" | "inflight" | "none" | "unknown";

/** In-memory journal + wallet. Balance is 0 until the claim redeems. */
function harness(over: Partial<RunClaimAndPayoutOpts> & {
  record?: Status;
  reconcile?: Outcome;
  payError?: unknown;
} = {}) {
  let record: { status: Status; createdAt: number } | null =
    over.record ? { status: over.record, createdAt: 1 } : null;
  let balance = 0;
  const calls = { claim: 0, pay: 0, onchain: 0, exportEcash: 0, reconcile: 0, complete: 0 };
  const opts: RunClaimAndPayoutOpts = {
    escrowId: "esc_m4",
    bolt11: "lnbc100n1pfakeclaimpayout",
    expectedDeltaMsats: 100_000,
    saveAfter: false,
    getBalance: async () => balance,
    claimAndRedeem: async () => { calls.claim++; balance = 100_000; return undefined as never; },
    payInvoice: async () => {
      calls.pay++;
      if (over.payError) throw over.payError;
      return "op_ok";
    },
    payOnchain: async () => { calls.onchain++; },
    prepareEcashExport: () => null,
    claimAndExportEcash: async () => { calls.exportEcash++; return { notes: "note", amountMsats: 100_000 }; },
    completeClaim: async () => { calls.complete++; },
    getPayoutRecord: () => record,
    recordPayoutIntent: () => { record = { status: "intent", createdAt: 2 }; },
    recordPayoutSubmitted: () => { record = { status: "submitted", createdAt: record?.createdAt ?? 2 }; },
    markPayoutSettled: () => { record = { status: "settled", createdAt: record?.createdAt ?? 2 }; },
    clearPayoutRecord: () => { record = null; },
    payOutcomeByEscrow: async () => { calls.reconcile++; return { outcome: over.reconcile ?? "unknown" }; },
    addOrTouchLightningHandle: () => {},
    onPhase: () => {},
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1_000); })(),
    confirmTimeoutMs: 30_000,
    pollIntervalMs: 1_000,
    ...over,
  };
  return { opts, calls, record: () => record };
}

// ── M4: an uncoded payout error keeps the intent ───────────────────────────
{
  const h = harness({ payError: new Error("internal pay unexpected_error") });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "payout-failed");
  assert.equal(h.calls.pay, 1);
  assert.equal(h.record()?.status, "intent",
    "an uncoded failure says nothing about whether the payment left, so the intent stays");
}
for (const code of [LN_PAY_REFUNDED, LN_PAY_SUBMIT_FAILED]) {
  const h = harness({ payError: codedPayError("no payment", code) });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "payout-failed");
  assert.equal(h.record(), null, `${code} is a definite failure and clears the record`);
}
{
  // Retry after the uncoded failure: the operation log shows the first payment
  // settled. Nothing is paid again; the trade completes.
  const h = harness({ record: "intent", reconcile: "settled" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "done");
  assert.equal(h.calls.pay, 0, "a settled first payment is never paid twice");
  assert.equal(h.calls.claim, 0);
  assert.equal(h.record()?.status, "settled");
}
{
  // Retry where the log proves no payment was ever dispatched: pay fresh once.
  const h = harness({ record: "intent", reconcile: "none" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "done");
  assert.equal(h.calls.pay, 1);
}
{
  // Log unavailable: refuse for now, keep the record, send nothing.
  const h = harness({ record: "intent", reconcile: "unknown" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "payout-confirming");
  assert.equal(h.calls.pay + h.calls.claim, 0);
  assert.equal(h.record()?.status, "intent");
}

// ── M4: switching payout kind does not bypass the guard ────────────────────
{
  const h = harness({ record: "intent", reconcile: "inflight", payoutKind: "onchain", bolt11: "onchain-payout" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "payout-confirming",
    "an unresolved Lightning payout blocks an on-chain payout for the same trade");
  assert.equal(h.calls.onchain + h.calls.claim, 0);
}
{
  const h = harness({ record: "settled", payoutKind: "ecash", bolt11: "ecash-export" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "done", "a settled Lightning payout ends an ecash retry as done");
  assert.equal(h.calls.exportEcash, 0, "no bearer note is exported after a settled payout");
}
{
  // A pending ecash export still resumes ahead of the guard: it already holds sats.
  const h = harness({ record: "settled", payoutKind: "ecash", bolt11: "ecash-export",
    prepareEcashExport: () => ({ notes: "resumed", amountMsats: 100_000 }) });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind === "ecash-ready" && out.notes, "resumed");
}
{
  const h = harness({ record: "intent", reconcile: "none", payoutKind: "onchain", bolt11: "onchain-payout" });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "done");
  assert.equal(h.calls.onchain, 1, "proof of no payment lets the on-chain payout go once");
  assert.equal(h.record(), null);
}
{
  const h = harness({ assertPayoutJournalReadable: () => { throw new Error("corrupt"); } });
  const out = await runClaimAndPayout(h.opts);
  assert.equal(out.kind, "payout-failed");
  assert.equal(h.calls.claim + h.calls.pay, 0, "an unreadable journal refuses before anything is claimed or sent");
}

// ── M5: the real payout journal never overwrites an unreadable value ───────
{
  const key = scopedStorageKey(PAYOUT_JOURNAL_KEY);
  values.set(key, "{not json");
  assert.throws(() => assertPayoutJournalReadable());
  assert.throws(() => assertPayoutJournalWritable(), "the pre-send probe refuses a corrupt journal");
  assert.throws(() => recordPayoutIntent({ escrowId: "e1" }));
  assert.throws(() => recordPayoutSubmitted({ escrowId: "e1", operationId: "op" }));
  assert.throws(() => markPayoutSettled("e1"));
  clearPayoutRecord("e1");
  assert.equal(values.get(key), "{not json", "the corrupt value is preserved for inspection");
  assert.equal(getPayoutRecord("e1"), null, "display reads stay quiet");
  values.set(key, "[]");
  assert.throws(() => assertPayoutJournalReadable(), "an array is not a journal");
  values.delete(key);
  recordPayoutIntent({ escrowId: "e1" });
  assert.equal(getPayoutRecord("e1")?.status, "intent");
  values.delete(key);
}

// ── M5: the real funding stash fails closed ────────────────────────────────
{
  const key = scopedStorageKey(PENDING_FUNDINGS_KEY);
  values.set(key, "{not json");
  assert.throws(() => assertPendingFundingWritable());
  assert.throws(() => stashPendingFunding({ escrowId: "f1", oobNotes: "n", amountMsats: 1 }));
  clearPendingFunding("f1");
  assert.equal(values.get(key), "{not json", "a corrupt stash may hold spent notes; it is never overwritten");
  assert.deepEqual(listPendingFundings(), []);
  values.delete(key);

  failWrites = true;
  assert.throws(() => assertPendingFundingWritable(), "a full device fails the pre-spend probe");
  assert.throws(() => stashPendingFunding({ escrowId: "f1", oobNotes: "n", amountMsats: 1 }),
    "a failed stash write is reported, not swallowed");
  failWrites = false;

  assertPendingFundingWritable();
  stashPendingFunding({ escrowId: "f1", oobNotes: "n", amountMsats: 1 });
  assert.equal(listPendingFundings()[0]?.oobNotes, "n");
  clearPendingFunding("f1");
  assert.deepEqual(listPendingFundings(), []);
}

// ── M5: Fedi funding never spends without a durable copy ───────────────────
function fedi(over: Partial<RunFediFundAndLockOpts> = {}) {
  const calls = { generate: 0, receive: 0, lock: 0, stash: 0, clear: 0 };
  const opts: RunFediFundAndLockOpts = {
    escrowId: "esc_m5",
    amountMsats: 100_000,
    description: "test",
    onPhase: () => {},
    preflight: async () => {},
    assertStashWritable: () => {},
    generateEcash: async () => { calls.generate++; return { notes: "fedi-notes" }; },
    receiveEcash: async () => { calls.receive++; },
    stashFunding: () => { calls.stash++; },
    clearFunding: () => { calls.clear++; },
    hashNotes: async (n) => `h:${n}`,
    lockAndPublish: async () => { calls.lock++; return { lockedNotesHash: "h:fedi-notes" }; },
    ...over,
  };
  return { opts, calls };
}
{
  const f = fedi({ assertStashWritable: () => { throw new Error("quota"); } });
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "lock-failed");
  assert.match(out.kind === "lock-failed" ? out.error : "", /No sats moved/);
  assert.equal(f.calls.generate, 0, "an unwritable stash refuses before any ecash leaves Fedi");
}
{
  const f = fedi({ stashFunding: () => { throw new Error("quota"); } });
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "lock-failed");
  assert.match(out.kind === "lock-failed" ? out.error : "", /returned your sats/);
  assert.equal(f.calls.receive, 1, "spent notes without a durable copy go straight back to Fedi");
  assert.equal(f.calls.lock, 0, "and no LOCK is published");
}
{
  // Fedi refuses them back too: the notes are not dropped, the lock goes ahead
  // and the LOCK's own refund path is the recovery.
  const f = fedi({
    stashFunding: () => { throw new Error("quota"); },
    receiveEcash: async () => { throw new Error("fedi busy"); },
  });
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "locked");
  assert.equal(f.calls.lock, 1);
}
{
  const f = fedi({
    stashFunding: () => { throw new Error("quota"); },
    receiveEcash: async () => { throw new Error("fedi busy"); },
    lockAndPublish: async () => { throw new Error("relay down"); },
  });
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "lock-failed");
  const error = out.kind === "lock-failed" ? out.error : "";
  assert.doesNotMatch(error, /next time you open it/, "never promise a return that has no saved copy");
  assert.match(error, /could not return your sats/);
}
{
  const abort = new AbortController();
  const f = fedi({
    stashFunding: () => { throw new Error("quota"); },
    receiveEcash: async () => { throw new Error("fedi busy"); },
    generateEcash: async () => { abort.abort(); return { notes: "fedi-notes" }; },
    signal: abort.signal,
  });
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "lock-failed", "an abort with no copy and no return says so");
  assert.equal(f.calls.lock ?? 0, 0, "and does not lock against the user's cancel");
}
{
  const f = fedi();
  const out = await runFediFundAndLock(f.opts);
  assert.equal(out.kind, "locked");
  assert.equal(f.calls.stash, 1);
  assert.equal(f.calls.clear, 1);
}

console.log("PASS M4/M5: payout intent kept on uncoded errors, guard covers every payout kind, journal and funding stash fail closed");
