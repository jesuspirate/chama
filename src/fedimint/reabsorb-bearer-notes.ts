// ══════════════════════════════════════════════════════════════════════════
// Chama — reissuance as the liveness probe
// ══════════════════════════════════════════════════════════════════════════
//
// When `verifyClaim` was deleted (2026-07-29, see escrow-bridge.ts
// "Pre-claim verification: REMOVED") the comment left behind named exactly
// what was missing:
//
//   "A real liveness probe needs the federation to be asked whether the notes
//    are spendable, and `parseNotes` is a local decode that never talks to
//    anyone."
//
// This is that probe. The one operation that asks the federation a question it
// cannot answer dishonestly — *are these notes spendable, right now?* — is
// reissuing them. The answer arrives as a state change rather than an opinion.
//
//   DO NOT VERIFY A NOTE. CONSUME IT.
//
// ── ⚠ WHAT THIS CANNOT DO ────────────────────────────────────────────────
//
// Reissue is a POINT-IN-TIME test THAT ALSO CONSUMES. It can never establish
// that a note will still be live later, because by the time it has answered,
// the note it asked about no longer exists. The rule is therefore always
// *recover or mark dead* — never *verify and keep showing*.
//
// Any future caller tempted to use this as a read-only check has
// misunderstood it. There is no read-only variant and there cannot be one:
// a probe that left the note spendable would be back to proving nothing.
//
// ── The five answers ──────────────────────────────────────────────────────
//
//   recovered  — the notes were live; they are now irreversibly in THIS wallet
//   consumed-uncredited
//              — the federation has definitively consumed this bearer string
//                (it can never be imported again) AND whether the credit
//                reached THIS wallet is unresolved. Two facts, both true, that
//                have to survive together.
//   dead       — the federation rejected the string as one it will never
//                honour (malformed / not a note). No money question follows,
//                because there was never money here.
//   unknown    — network / timeout / an unverifiable success. The caller MUST
//                leave its entry exactly as it was.
//   foreign    — the note belongs to another federation. Not dead: unreachable
//                from here.
//
// ── Why `dead` is narrow, and `consumed-uncredited` is not a synonym ──────
//
// The 2026-08-22 fixture probe (design/mockups/chama-probe-step1-result.md)
// showed one outcome answering two different questions. "Is this string still
// spendable?" and "did the sats reach this wallet?" have independent answers,
// and every already-spent / consumed-and-failed rejection answers the first
// definitively and the second not at all. Collapsing them either keeps
// offering a note proven un-importable, or archives an open money question as
// settled. So they get separate outcomes, and `dead` is reserved for the one
// case with no second question to keep open.
//
// ── Rules this module enforces so callers cannot forget them ─────────────
//
//  1. USER-INITIATED ONLY. Never a background poll, never on render.
//     Reissuing a LIVE note takes it back from whoever was about to claim it.
//     For a pending export that is precisely the intent (it is a cancel-send)
//     — but it has to be a deliberate tap, and labelled as one.
//  2. Only a definitive federation rejection may return `dead`. Everything
//     else is `unknown`. (`resumeMintReissueFromHistory` was tightened on
//     2026-08-20 so this classification can be trusted; this depends on it.)
//  3. THE BALANCE BRACKET IS INSIDE THIS FUNCTION, not in the callers. A
//     success that does not move the balance by the expected amount is not a
//     success — it is `unknown`. That exact undetected case is the
//     2026-08-19 fund-loss narrative.
//  4. The federation is pre-checked with parseNotes().federationId, so a
//     foreign note reports as foreign rather than as dead.
//  5. Double taps coalesce (see inFlightProbesByNotes below).

import type { ChamaOperationMeta } from "../payments/sats-trace.js";
import { buildChamaOperationMeta } from "../payments/sats-trace.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Which surface asked. Carried into the operation meta for forensics, and
 *  used only for logging — the probe behaves identically for all of them. */
export type ReabsorbContext =
  /** The teal PENDING ECASH EXPORT card: a note we minted and handed out. */
  | "pending-export"
  /** A pending-redemption stash entry automatic retry gave up on. */
  | "stranded-claim"
  /** §4a external ecash funding — reissue the pasted note instead of
   *  inspecting it. NOT wired here; named so the taxonomy is already right. */
  | "external-funding";

export type ReabsorbOutcome =
  | "recovered"
  | "consumed-uncredited"
  | "dead"
  | "unknown"
  | "foreign";

export type ReabsorbResult =
  | {
      outcome: "recovered";
      /** The balance delta actually observed, in msats. */
      recoveredMsats: number;
      expectedMsats: number;
      balanceBefore: number;
      balanceAfter: number;
      /** True when the reissue call THREW but the balance moved anyway — the
       *  op landed late. Recovered, but worth a distinct log line. */
      lateCredit: boolean;
    }
  | {
      outcome: "consumed-uncredited";
      /** The federation's own words, for the forensic record. */
      reason: string;
      balanceBefore: number;
      balanceAfter?: number;
    }
  | {
      outcome: "dead";
      /** The federation's own words, for the forensic record. */
      reason: string;
      balanceBefore: number;
      balanceAfter?: number;
    }
  | {
      outcome: "unknown";
      reason: string;
      balanceBefore?: number;
      balanceAfter?: number;
    }
  | {
      outcome: "foreign";
      noteFederationId: string;
      walletFederationId: string | null;
    };

/** The slice of FedimintClient this needs. Structural, so the native bridge
 *  adapter and the test fakes satisfy it without an import cycle. */
export interface ReabsorbWallet {
  parseNotes(oobNotes: string): Promise<{
    totalAmount: number;
    federationId?: string;
    federationInvite?: string;
  }>;
  getFederationId(): string | null;
  getBalance(): Promise<number>;
  redeemWithRetry(
    oobNotes: string,
    maxAttempts?: number,
    meta?: ChamaOperationMeta,
  ): Promise<void>;
}

export interface ReabsorbInput {
  oobNotes: string;
  /** The amount the ENTRY claims these notes are worth, in msats. The delta
   *  is compared against this — not against what the note decodes to — so a
   *  record that disagrees with its own note reports `unknown` rather than a
   *  false success. */
  expectedMsats: number;
  context: ReabsorbContext;
  /** Forensics only. */
  escrowId?: string;
}

// ── Coalescing ─────────────────────────────────────────────────────────────
//
// The SDK adapter already dedupes concurrent reissues of the same notes
// (`inFlightMintReissuesByNotes`), but that map lives INSIDE the mint mutex:
// two probes of the same note serialize on the lock, so the second one starts
// only after the first has finished and cleared the map. It would then be told
// "already spent" for a note the first probe had just successfully recovered,
// and report `dead` for money that is sitting in the balance.
//
// So the coalescing that makes double-taps safe has to be here, ABOVE the
// lock. Keyed by the exact bearer string — amount is never an identity.
const inFlightProbesByNotes = new Map<string, Promise<ReabsorbResult>>();

// ── Logging ────────────────────────────────────────────────────────────────

function probeLog(checkpoint: string, fields: Record<string, unknown>): void {
  const parts: string[] = [`[claim-trace] reabsorb-${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const val = typeof v === "string" && v.length > 96 ? `${v.slice(0, 92)}…` : String(v);
    parts.push(`${k}=${val}`);
  }
  console.info(parts.join(" "));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/** Walk a bounded `cause` chain. The proof of a consumed note frequently is
 *  not in the thrown error at all — the SDK adapter catches the federation's
 *  own already-spent error and rethrows a NEW error describing what it could
 *  not confirm, keeping the original only as `cause`. Reading the top-level
 *  message alone is how that proof stayed invisible until 2026-08-22. */
function errorChain(e: unknown, maxDepth = 4): unknown[] {
  const chain: unknown[] = [];
  let current = e;
  for (let i = 0; i < maxDepth && current != null; i++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** Does this error (message only — no code) say the federation has already
 *  taken these notes? Message-only on purpose: it is applied to raw SDK errors
 *  and to `cause` links, neither of which carries our structured codes. */
function saysAlreadyConsumed(e: unknown): boolean {
  const msg = errText(e).toLowerCase();
  return (
    msg.includes("already spent")
    || msg.includes("already redeemed")
    || msg.includes("already reissued")
    || msg.includes("already used")
    || msg.includes("double spend")
    || msg.includes("double-spend")
    || msg.includes("note already")
    || msg.includes("mint reissue operation failed after federation consumed")
  );
}

/**
 * Has the federation definitively consumed this bearer string, WITHOUT the
 * credit to this wallet being established?
 *
 * ── The three shapes, and why the cause chain is load-bearing ─────────────
 *
 *   ALREADY_SPENT_UNCONFIRMED — the federation said already-spent and the
 *     balance poll found no matching credit. Consumed; credit unproven.
 *   MINT_REISSUE_FAILED       — a reissue the federation consumed and failed.
 *     Consumed; credit unproven.
 *   MINT_REISSUE_UNKNOWN      — raised at exactly one site (sdk-adapter.ts),
 *     reachable ONLY when the federation's own error said already-reissued and
 *     no in-window local operation was found. Its own message ("no local
 *     reissue operation was found to confirm wallet credit") describes the
 *     second question only; the answer to the first is sitting in `cause`.
 *     We require that cause rather than trusting the code, so a future second
 *     raise site cannot smuggle in a note nobody rejected.
 *
 * All three carry the same pair of facts. They MUST NOT be treated as `dead`:
 * archiving them would close a money question that is genuinely open.
 */
function isConsumedCreditUnproven(e: unknown): boolean {
  const code = errCode(e);
  if (code === "ALREADY_SPENT_UNCONFIRMED" || code === "MINT_REISSUE_FAILED") return true;
  if (code === "MINT_REISSUE_UNKNOWN") {
    // Skip the head: its message is about the credit question, not the note.
    return errorChain(e).slice(1).some(saysAlreadyConsumed);
  }
  if (code === "MINT_REISSUE_PENDING" || code === "REDEEM_TIMEOUT") return false;
  return errorChain(e).some(saysAlreadyConsumed);
}

/**
 * Did the federation reject the string as one it will NEVER honour?
 *
 * This is the only `dead`: a thing that was never money, so no credit question
 * follows it. It is separate from `isConsumedCreditUnproven` precisely because
 * "this was never a note" and "this note is spent" have different consequences
 * for the user's money.
 */
function isNeverValidRejection(e: unknown): boolean {
  const msg = errText(e).toLowerCase();
  return (
    msg.includes("malformed")
    || msg.includes("invalid note format")
    || msg.includes("parse error")
  );
}

/** A throw that names the wrong federation rather than a spent or dead note. */
function isForeignFederationError(e: unknown): boolean {
  const msg = errText(e).toLowerCase();
  return msg.includes("invalid federation") || msg.includes("belongs to federation");
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Ask the federation whether these bearer notes are live, by taking them.
 *
 * Never throws: every path resolves to one of the four outcomes, because a
 * money surface that has to `try/catch` a probe ends up guessing again.
 *
 * The caller's job is only to act on the answer:
 *   recovered           → clear the entry (the sats are in the balance)
 *   consumed-uncredited → stop offering the note, KEEP the money question open
 *   dead                → mark the entry dead; stop offering the note
 *   unknown             → CHANGE NOTHING. Try again later.
 *   foreign             → tell the user which federation the note belongs to
 */
export async function reabsorbBearerNotes(
  wallet: ReabsorbWallet,
  input: ReabsorbInput,
): Promise<ReabsorbResult> {
  const { oobNotes } = input;
  if (!oobNotes) {
    return { outcome: "unknown", reason: "No bearer note to reabsorb." };
  }

  const existing = inFlightProbesByNotes.get(oobNotes);
  if (existing) {
    probeLog("coalesced", { context: input.context, notesLen: oobNotes.length });
    return existing;
  }

  const promise = runProbe(wallet, input);
  inFlightProbesByNotes.set(oobNotes, promise);
  try {
    return await promise;
  } finally {
    inFlightProbesByNotes.delete(oobNotes);
  }
}

async function runProbe(
  wallet: ReabsorbWallet,
  input: ReabsorbInput,
): Promise<ReabsorbResult> {
  const { oobNotes, expectedMsats, context, escrowId } = input;

  probeLog("in", {
    context,
    escrowId,
    expectedMsats,
    notesLen: oobNotes.length,
  });

  // ── 1. Local decode ─────────────────────────────────────────────────────
  // A decode failure is NOT a verdict. It looks identical whether the string
  // is malformed or the wallet simply isn't ready yet, so it reports unknown
  // and the entry survives untouched.
  let parsed: { totalAmount: number; federationId?: string } | null = null;
  try {
    parsed = await wallet.parseNotes(oobNotes);
  } catch (e) {
    probeLog("out", { context, escrowId, outcome: "unknown", at: "parse", error: errText(e) });
    return {
      outcome: "unknown",
      reason: `These notes couldn't be read on this device: ${errText(e)}`,
    };
  }

  // ── 2. Federation pre-check (rule 4) ────────────────────────────────────
  // Only decides anything when the note actually carries a federation id.
  // Compact exports (includeInvite: false) often don't — absence is not
  // evidence of a mismatch, so we proceed and let the federation answer.
  const walletFed = wallet.getFederationId();
  if (
    parsed.federationId
    && walletFed
    && parsed.federationId.toLowerCase() !== walletFed.toLowerCase()
  ) {
    probeLog("out", {
      context,
      escrowId,
      outcome: "foreign",
      noteFed: parsed.federationId.slice(0, 12),
      walletFed: walletFed.slice(0, 12),
    });
    return {
      outcome: "foreign",
      noteFederationId: parsed.federationId,
      walletFederationId: walletFed,
    };
  }

  // ── 3. Open the balance bracket (rule 3) ────────────────────────────────
  // If we cannot read the balance we cannot judge the result, so we do NOT
  // attempt the reissue at all. Refusing costs nothing (the note stays live);
  // attempting an unverifiable consume is the failure this brief exists for.
  let balanceBefore: number;
  try {
    balanceBefore = await wallet.getBalance();
  } catch (e) {
    probeLog("out", { context, escrowId, outcome: "unknown", at: "balance-before", error: errText(e) });
    return {
      outcome: "unknown",
      reason:
        "Couldn't read your balance, so this note wasn't touched — "
        + "there'd be no way to tell whether it landed. Try again in a moment.",
    };
  }

  // ── 4. Consume ──────────────────────────────────────────────────────────
  // maxAttempts = 1 on purpose. redeemWithRetry's internal backoff exists for
  // unattended boot drains; this is a human holding a button, so a transient
  // becomes `unknown` immediately (one bounded ~30s wait instead of ~90s of
  // silent retry) and they can tap again.
  const meta = buildChamaOperationMeta({
    flow: "reabsorb_bearer_notes",
    escrowId,
    amountMsats: expectedMsats,
    reason: context,
  });
  let thrown: unknown = null;
  try {
    await wallet.redeemWithRetry(oobNotes, 1, meta);
  } catch (e) {
    thrown = e;
  }

  // ── 5. Close the balance bracket ────────────────────────────────────────
  let balanceAfter: number | undefined;
  try {
    balanceAfter = await wallet.getBalance();
  } catch (e) {
    probeLog("balance-after-failed", { context, escrowId, error: errText(e) });
  }
  const delta = balanceAfter === undefined ? undefined : balanceAfter - balanceBefore;

  // ── 6. A clean resolve is judged by the bracket (rule 3) ────────────────
  //
  // EXACT, for the same reason step 8 is exact — and for one more. A clean
  // resolve is NOT always an independent second signal: on the already-spent
  // path, `confirmAlreadySpentCredit` (fedimint-client.ts) derives its verdict
  // from this very balance and then returns normally, so reading the balance
  // again here would be re-counting one signal as two. That function is now
  // exact as well; nothing downstream should be laxer than the check it rests
  // on, and this branch cannot tell a true reissue from a balance-confirmed
  // already-spent, so it takes the strict rule for both.
  if (thrown === null) {
    if (delta !== undefined && expectedMsats > 0 && delta === expectedMsats) {
      probeLog("out", {
        context, escrowId, outcome: "recovered",
        expectedMsats, balanceBefore, balanceAfter, delta, lateCredit: false,
      });
      return {
        outcome: "recovered",
        recoveredMsats: delta,
        expectedMsats,
        balanceBefore,
        balanceAfter: balanceAfter as number,
        lateCredit: false,
      };
    }
    // ⚠ THE 2026-08-19 CASE. The reissue reported success and the balance did
    // not move by the expected amount. That is not a success — it is the exact
    // shape that went undetected and turned into a fund-loss narrative. The
    // entry stays exactly as it was.
    probeLog("out", {
      context, escrowId, outcome: "unknown", at: "unverified-success",
      expectedMsats, balanceBefore, balanceAfter, delta,
    });
    return {
      outcome: "unknown",
      reason:
        `The reissue reported success but your balance didn't move by the expected amount `
        + `(expected ${Math.floor(expectedMsats / 1000)} sats, saw ${
          delta === undefined ? "no reading" : `${Math.floor(delta / 1000)} sats`
        }). Nothing has been marked — this note is being left exactly as it was.`,
      balanceBefore,
      balanceAfter,
    };
  }

  // ── 7. A throw is classified BEFORE the balance is consulted ────────────
  //
  // ⚠ THE ORDERING IS THE POINT. An earlier version tested `delta >=
  // expectedMsats` first and returned `recovered` from either branch, on the
  // reasoning that a concurrent Lightning receive "can only make a real
  // success look bigger, never invent one". That is false for a throw: the
  // mint mutex serializes mint traffic, but a Lightning receive settling
  // inside this window is under no such lock, and it would have turned a
  // federation REJECTION into "Recovered ₿100". A verdict always outranks the
  // balance.
  if (isForeignFederationError(thrown)) {
    probeLog("out", { context, escrowId, outcome: "foreign", at: "redeem", error: errText(thrown) });
    return {
      outcome: "foreign",
      noteFederationId: parsed.federationId ?? "unknown",
      walletFederationId: walletFed,
    };
  }

  if (isConsumedCreditUnproven(thrown)) {
    probeLog("out", {
      context, escrowId, outcome: "consumed-uncredited",
      expectedMsats, balanceBefore, balanceAfter, delta, error: errText(thrown),
    });
    return {
      outcome: "consumed-uncredited",
      reason: errText(thrown),
      balanceBefore,
      balanceAfter,
    };
  }

  if (isNeverValidRejection(thrown)) {
    probeLog("out", {
      context, escrowId, outcome: "dead",
      expectedMsats, balanceBefore, balanceAfter, delta, error: errText(thrown),
    });
    return {
      outcome: "dead",
      reason: errText(thrown),
      balanceBefore,
      balanceAfter,
    };
  }

  // ── 8. Non-definitive throw: the op may still have landed ───────────────
  //
  // This is the ONLY branch where a throw can end in `recovered`, and it
  // demands EXACT equality rather than `>=`. A timeout whose reissue lands a
  // moment later moves the balance by precisely the note's value; anything
  // else moved it by something we cannot attribute to this note, and an
  // unattributable credit is not evidence about this note.
  //
  // Keyed to the EVIDENCE, not to which surface called. A context allow-list
  // was considered and rejected: it would have missed the real shape, which is
  // "fund over Lightning → export → reabsorb" and therefore lands on the
  // pending-export card, not on a funding one. An exactness rule holds on
  // surfaces nobody has written yet.
  if (delta !== undefined && expectedMsats > 0 && delta === expectedMsats) {
    probeLog("out", {
      context, escrowId, outcome: "recovered",
      expectedMsats, balanceBefore, balanceAfter, delta, lateCredit: true,
    });
    return {
      outcome: "recovered",
      recoveredMsats: delta,
      expectedMsats,
      balanceBefore,
      balanceAfter: balanceAfter as number,
      lateCredit: true,
    };
  }

  if (delta !== undefined && delta !== 0) {
    probeLog("out", {
      context, escrowId, outcome: "unknown", at: "unattributable-delta",
      expectedMsats, balanceBefore, balanceAfter, delta, error: errText(thrown),
    });
    return {
      outcome: "unknown",
      reason:
        `The reissue didn't complete, and your balance moved by an amount that doesn't `
        + `match this note (expected ${Math.floor(expectedMsats / 1000)} sats, saw `
        + `${Math.floor(delta / 1000)}) — so that movement can't be credited to it. `
        + `Nothing has been marked.`,
      balanceBefore,
      balanceAfter,
    };
  }

  probeLog("out", {
    context,
    escrowId,
    outcome: "unknown",
    code: errCode(thrown) || undefined,
    balanceBefore,
    balanceAfter,
    error: errText(thrown),
  });
  return {
    outcome: "unknown",
    reason: errText(thrown),
    balanceBefore,
    balanceAfter,
  };
}
