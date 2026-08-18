// ══════════════════════════════════════════════════════════════════════════
// Chama — Escrow ↔ Fedimint Bridge
// ══════════════════════════════════════════════════════════════════════════
//
// Glues the EscrowClient (trade protocol on Nostr) to the FedimintClient
// (ecash operations via WASM). Provides the full escrow flow in two
// high-level methods:
//
//   lockAndPublish()  — Spend ecash, SSS split, encrypt shares, publish LOCK
//   claimAndRedeem()  — Decrypt shares, SSS combine, verify, redeem, publish CLAIM
//
// This is the integration layer the UI calls for the money-critical steps.

import { type EscrowClient, type Signer } from "../escrow-engine/escrow-client.js";
import {
  hashNotes,
  LOCK_SPEND_TRY_CANCEL_SECS,
  ECASH_EXPORT_TRY_CANCEL_SECS,
  type EscrowLockBundle,
  type FedimintClient,
  type PayOutcomeByEscrowResult,
  type SSSShare,
} from "./fedimint-client.js";
import { stashPendingRedemption, clearPendingRedemption, markUnresolvedCredit } from "./pending-redemptions.js";
import {
  assertNativeLockStashWritable,
  clearPendingNativeLock,
  getPendingNativeLock,
  markNativeLockPublishAttempted,
  recoverPendingNativeLock,
  stashNativeLockIntent,
  upgradeNativeLockToSpent,
  withNativeLockFlow,
  type NativeLockRecoveryDeps,
  type NativeLockRecoveryOutcome,
} from "./pending-native-locks.js";
import { isTestnetMode } from "./mock-wallet.js";
import {
  type EscrowState,
  type SelectedMenuItem,
  type LockShareEntry,
  type VotePayload,
  EscrowEventKind,
  EscrowStatus,
  Role,
  Outcome,
  getEffectiveParticipantAt,
  selectedMenuItemsTotalMsats,
} from "../escrow-engine/types.js";
import { getWinner, payoutRecipientFor } from "../escrow-engine/state-machine.js";
import {
  HOLDER_ONLY_SHARE_POLICY,
  holderRoleForShareIndex,
  shareIndexForRole,
  collectClaimEnvelopeCandidates,
} from "../escrow-engine/holder-shares.js";
import { arbiterShareRecipientsFor } from "../escrow-engine/arbiter-substitution.js";
import { getSavedHandle } from "../payments/saved-handles.js";
import { pickArbiterFromPool, pickPreferredArbiter } from "../arbiters/pool.js";
import { verifyBondedStamp } from "../arbiters/bonded-stamp.js";
import { isSimModeOn } from "../sim/simMode.js";
import { buildChamaOperationMeta, recordSatsTrace, type ChamaOperationMeta } from "../payments/sats-trace.js";
import { receiveFediEcash } from "./fedi-internal.js";
import { effectiveCreateFederationId } from "./federation-config.js";

function claimTraceEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("chama_debug_money") !== null;
  } catch {
    return false;
  }
}

function claimTrace(checkpoint: string, fields: Record<string, unknown>): void {
  if (!claimTraceEnabled()) return;
  const parts: string[] = [`[claim-trace] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

interface LockOptions {
  /** PR 3: ID of a saved handle in the seller's localStorage. The
   *  bridge resolves it to cleartext at lock time and includes both
   *  the cleartext + audit ID in the (encrypted) LockPayload so the
   *  buyer and arbiter can read where to send fiat. Optional —
   *  marketplace digital trades and raw escrows don't need it. */
  savedHandleId?: string;
  /** Menu basket snapshot. Required when locking a menu listing. */
  selectedItems?: SelectedMenuItem[];
  /** Buyer identity snapshotted before an external funding payment begins.
   *  May outlive that buyer's JOIN grace, but never a replacement buyer. */
  buyerPubkey?: string;
  /** v2.3: committed substitution grace ceiling (seconds). The hook resolves
   *  this from the consensus-safe power-user override; absent ⇒ the legacy 4h
   *  default. Rides into the signed LOCK so backup eligibility replays
   *  identically everywhere. */
  substitutionGraceSeconds?: number;
  /** §0.3: the caller's chain-verified bonded set for this community, when it
   *  has one cheaply to hand (the 12h pool cache is a synchronous read — do NOT
   *  add a blocking network fetch to the lock path for this). Absent ⇒ the
   *  creator's unverified `bondedArbiters` stamp is IGNORED and seating falls
   *  back to the legacy deterministic pick. */
  verifiedBondedArbiters?: readonly string[] | null;
}

function amountMsatsForLock(state: EscrowState, selectedItems?: SelectedMenuItem[]): number {
  if (!state.items || state.items.length === 0) return state.amountMsats;
  const total = selectedMenuItemsTotalMsats(selectedItems);
  if (!selectedItems || selectedItems.length === 0 || total <= 0) {
    throw new Error("Select at least one menu item before locking this trade.");
  }
  return total;
}

/** Resolve the buyer for LOCK across a slow external payment. Normally the
 * active hold wins. A buyer pinned before funding may survive hold expiry, but
 * only while the latest known buyer is still that same key; a replacement is
 * a hard stop so funds can never lock against an unseen counterparty. */
export function resolveLockBuyerPubkey(
  state: EscrowState,
  nowSec: number,
  pinnedBuyerPubkey?: string,
): string | null {
  const effectiveBuyer = getEffectiveParticipantAt(state, Role.BUYER, nowSec, { includeLockGrace: true });
  const lastKnownBuyer = state.joinHolds?.[Role.BUYER]?.pubkey ?? state.participants[Role.BUYER] ?? null;
  if (pinnedBuyerPubkey && lastKnownBuyer && lastKnownBuyer !== pinnedBuyerPubkey) {
    throw new Error(
      "Cannot lock — a different buyer replaced the buyer who began this funding attempt. " +
      "Your sats stay in your Chama balance; review the new buyer before locking."
    );
  }
  return effectiveBuyer ?? (
    pinnedBuyerPubkey && lastKnownBuyer === pinnedBuyerPubkey ? pinnedBuyerPubkey : null
  );
}

// ══════════════════════════════════════════════════════════════════════════
// BRIDGE
// ══════════════════════════════════════════════════════════════════════════

export class EscrowFedimintBridge {
  private escrow: EscrowClient;
  private fedimint: FedimintClient;
  private signer: Signer;

  constructor(escrow: EscrowClient, fedimint: FedimintClient, signer: Signer) {
    this.escrow = escrow;
    this.fedimint = fedimint;
    this.signer = signer;
  }

  private async prepareLockContext(escrowId: string, opts: LockOptions = {}): Promise<{
    state: EscrowState;
    buyerPubkey: string;
    sellerPk: string;
    arbiterPubkey: string;
    /** The federation this trade's CREATE committed to, or null for legacy
     *  chains that stamped none. Returned rather than recomputed by the caller
     *  so the pre-spend probe and the post-spend note check can never disagree
     *  about what "the right federation" means. */
    expectedFed: string | null;
  }> {
    const state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    // #37 hardening: refuse pre-spend AND pre-publish when the trade is no
    // longer CREATED. The reducer only accepts LOCK from CREATED, but until
    // now nothing checked status before the spend fired and the LOCK event
    // hit relays — and a second distinct LOCK on a chain is a permanent
    // replay-poison. "Cannot LOCK" keeps the hook's benign-stale swallow.
    if (state.status !== EscrowStatus.CREATED) {
      throw new Error(
        `Cannot LOCK in state ${state.status} — this trade is no longer lockable. ` +
        `(No sats were spent.)`
      );
    }

    // ⭐ Tier 2.1: never ecash-lock a trade created as on-chain escrow.
    // The reducer rejects the mismatched LOCK anyway (ESCROW_MODE_MISMATCH), but
    // that rejection happens AFTER this bridge would already have spent the
    // locker's ecash — a refusal that costs the user their sats is not a
    // refusal. Fail here, before any spend.
    if ((state.escrowMode ?? "ecash") === "onchain") {
      throw new Error(
        "This trade uses on-chain escrow — fund the escrow address instead. " +
        "(No sats were spent.)"
      );
    }

    // Parent/child tranche protocol: this runs before invoice/address creation
    // and before createEscrowLock spends notes. It proves this is the single
    // active verified child; the parent manifest and later children fail shut.
    const trancheGate = (this.escrow as EscrowClient & {
      assertTrancheFundingAllowed?: (candidate: EscrowState) => Promise<void>;
    }).assertTrancheFundingAllowed;
    if (trancheGate) await trancheGate.call(this.escrow, state);

    const createEvent = state.eventChain.find(
      (e: any) => e.kind === 38100 || e.payload?.type === "escrow:create"
    );
    const expectedFed = effectiveCreateFederationId(createEvent?.payload as any);

    // #35: sim mode uses a fake federation (SIM_FEDERATION_ID) that never equals
    // a trade's real stamped fed. This fed-match gate is a real-money defense, so
    // it must not fire in sim — else the lock (and thus a full sim trade) can
    // never complete. No sats are real in sim, so nothing to protect.
    if (expectedFed && !isSimModeOn()) {
      let probe: { fed: string | null };
      try {
        probe = await this.fedimint.probeReachable();
      } catch (probeErr) {
        const err: any = new Error(
          "Couldn't verify your federation. Your wallet may be disconnected. " +
            "Try again in a moment. (No sats were spent.)"
        );
        err.code = "FED_PROBE_FAILED";
        err.cause = probeErr;
        throw err;
      }

      if (probe.fed !== expectedFed) {
        const err: any = new Error(
          `This trade requires federation ${expectedFed}. ` +
            `Your wallet is on ${probe.fed}. ` +
            `Sign out and rejoin with the correct federation invite. ` +
            `(No sats were spent.)`
        );
        err.code = "FED_MISMATCH";
        err.expected = expectedFed;
        err.got = probe.fed;
        throw err;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const buyerPubkey = resolveLockBuyerPubkey(state, nowSec, opts.buyerPubkey);
    if (!buyerPubkey) {
      throw new Error(
        "Cannot lock — no buyer pubkey known. The buyer must publish a JOIN " +
        "ACK (or the locker's payment-detection path must supply the buyer " +
        "pubkey) before LOCK can fire."
      );
    }
    const sellerPk = getEffectiveParticipantAt(state, Role.SELLER, nowSec, { includeLockGrace: true });
    if (!sellerPk) {
      throw new Error("Cannot lock — no seller pubkey known for this trade.");
    }
    const arbiterPubkey = getEffectiveParticipantAt(state, Role.ARBITER, nowSec, { includeLockGrace: true })
      // 2B prefer-bonded: seat the bonded-preferred arbiter when none has JOINed.
      // The reducer JOIN gate + C1 classifier both accept this pick AND the legacy
      // one, so a mixed-version counterparty never reads it as off-assignment.
      // (Orthogonal to #37's spend/publish/stash — pure arbiter selection.)
      // §0.3: the stamp is creator-written. A CREATE naming exactly one
      // "bonded" key short-circuits the deterministic pick, so an attacker's
      // stamp gets their confederate seated BY THE HONEST COUNTERPARTY'S OWN
      // CLIENT. Only honour it against a chain-verified set; with none
      // available we fall back to the legacy deterministic pick, which the
      // reducer's JOIN gate and the C1 classifier both accept — so this is
      // safe for mixed-version chains and never strands a lock.
      ?? pickPreferredArbiter(
        state.communityArbiters,
        verifyBondedStamp(state.bondedArbiters, opts.verifiedBondedArbiters).effective,
        state.id,
        [buyerPubkey, sellerPk],
      );
    if (!arbiterPubkey) {
      throw new Error(
        "Cannot lock — no arbiter available. The trade has no JOINed arbiter " +
        "and the communityArbiters pool has no eligible backup after excluding " +
        "the buyer and seller."
      );
    }
    if (arbiterPubkey === buyerPubkey || arbiterPubkey === sellerPk) {
      throw new Error(
        "Cannot lock — buyer, seller, and arbiter must be three different keys. " +
        "(No sats were spent.)"
      );
    }

    return { state, buyerPubkey, sellerPk, arbiterPubkey, expectedFed: expectedFed ?? null };
  }

  private async publishLockBundle(
    escrowId: string,
    state: EscrowState,
    lockBundle: EscrowLockBundle,
    participants: {
      buyerPubkey: string;
      sellerPk: string;
      arbiterPubkey: string;
    },
    opts: LockOptions = {},
  ): Promise<EscrowState> {
    const { buyerPubkey, sellerPk, arbiterPubkey } = participants;
    const allPks = [buyerPubkey, sellerPk, arbiterPubkey];

    const shares: { shareIndex: number; encryptedFor: Record<string, string> }[] = [];

    // Holder-only-v1: encrypt each share to ONLY its assigned holder. allPks is
    // [buyer, seller, arbiter] — exactly the shareIndex→holder convention
    // (0=buyer, 1=seller, 2=arbiter) — so share i goes to holder i and no single
    // party holds two. Reconstruction needs the agreeing voter's VOTE-carried
    // share (see appendVoteShareEnvelope / claimAndRedeem). We stop emitting
    // dual-encrypted shares entirely; old locks still claim via the legacy path
    // (keyed on the absent sharePolicy). See docs/DESIGN-holder-only-shares.md.
    //
    // Arbiter substitution (DESIGN-arbiter-substitution.md): the ARBITER share
    // (index 2) alone is encrypted to the escrow's deterministic priority
    // order — the assigned arbiter + up to 2 backups — so a pool backup can
    // carry the deciding share if the assigned arbiter goes absent. Each pool
    // member still holds only this ONE slot, so nobody can reconstruct alone;
    // buyer/seller shares remain strictly single-holder.
    // ⚠ SHARE recipients, not the vote-priority order — see
    // arbiterShareRecipientsFor. With a 3-member pool the old call handed a
    // decryptable share to EVERY arbiter in the system on every trade, so a
    // principal colluding with any one of them could redeem without a seat.
    // Vote eligibility (reducer-gated) is deliberately unchanged.
    const arbiterRecipients = arbiterShareRecipientsFor({
      escrowId,
      pool: state.communityArbiters ?? [],
      buyerPubkey,
      sellerPubkey: sellerPk,
      assignedArbiter: arbiterPubkey,
    });
    for (let i = 0; i < lockBundle.shares.length; i++) {
      const share = lockBundle.shares[i];
      const recipients = i === 2 && arbiterRecipients.length > 0
        ? arbiterRecipients
        : allPks[i] ? [allPks[i]] : [];
      if (recipients.length === 0) continue;
      const encryptedFor: Record<string, string> = {};
      for (const pk of recipients) {
        encryptedFor[pk] = await this.encryptShare(share, pk);
      }
      shares.push({ shareIndex: i, encryptedFor });
    }

    let handleId: string | undefined;
    let handle: string | undefined;
    let rail: string | undefined;
    let handleNetworks: string[] | undefined;
    if (opts.savedHandleId) {
      const saved = getSavedHandle(opts.savedHandleId);
      if (saved) {
        handleId = saved.id;
        handle = saved.handle;
        rail = saved.rail;
        if (saved.networks && saved.networks.length > 0) {
          handleNetworks = saved.networks;
        }
      } else {
        console.warn(
          `[chama] lockAndPublish: savedHandleId ${opts.savedHandleId} ` +
          `not found in local storage — proceeding without handle reveal`
        );
      }
    }

    return this.escrow.lockEscrow(escrowId, {
      notesHash: lockBundle.notesHash,
      shares,
      sharePolicy: HOLDER_ONLY_SHARE_POLICY,
      arbiterPoolShare: arbiterRecipients.length > 0,
      ...(typeof opts.substitutionGraceSeconds === "number"
        ? { substitutionGraceSeconds: opts.substitutionGraceSeconds }
        : {}),
      sellerReceivesMsats: lockBundle.sellerReceivesMsats,
      arbiterFeeMsats: lockBundle.arbiterFeeMsats,
      buyerPubkey,
      arbiterPubkey,
      selectedItems: opts.selectedItems,
      handleId,
      handle,
      rail,
      handleNetworks,
    });
  }

  // ── Lock: Spend ecash → SSS split → encrypt shares → publish LOCK ──────

  /** #37: sim/testnet run the plain flow — their fake notes must never
   *  enter the real recovery stash, and there is nothing to recover. */
  private nativeLockGuardOn(): boolean {
    return !isSimModeOn() && !isTestnetMode();
  }

  /**
   * #37: the fail-closed recovery dependency set, bound to the live client
   * + wallet. Shared by the inline pre-lock settle below and the boot
   * drain (useEscrow passes this to drainPendingNativeLocks).
   */
  nativeLockRecoveryDeps(): NativeLockRecoveryDeps {
    return {
      loadEscrow: (id) => this.escrow.loadEscrow(id),
      getConnectedRelayCount: () => this.escrow.getConnectedRelayCount(),
      redeemNotes: (notes) => this.fedimint.redeemWithRetry(notes),
      currentFederationId: () => this.fedimint.getFederationId(),
      hashNotes,
      // Re-absorb story-loss fix: leave a durable "your funding came back"
      // breadcrumb so the restored balance reads as a calm funds-returned
      // recovery, not the generic "trade needs attention" alarm. Merges with
      // any existing funding trace for this escrow (fund-and-lock's
      // lock-failed-after-funding), just updating the reason.
      recordReabsorbedResidue: ({ escrowId, amountMsats }) =>
        recordSatsTrace({
          source: "funding",
          escrowId,
          amountMsats,
          reason: "lock-reabsorbed",
        }),
    };
  }

  /**
   * #37: settle any notes-carrying stash entry for this trade. Returns
   * "none" when no such entry exists. Called (a) by the funding
   * orchestrator BEFORE it creates an invoice — an unsettled prior attempt
   * must never invite a SECOND payment — and (b) by lockAndPublish as
   * defense-in-depth before any new spend. User-initiated, so the boot
   * drain's attempt cap does not apply by default.
   *
   * Serialized on the per-escrow flow mutex so it can never act while a
   * live lock flow for the same trade is between spend and publish-confirm
   * (re-absorbing there would hollow the escrow — review F7/F11).
   */
  async settlePendingNativeLock(
    escrowId: string,
    opts: { ignoreAttemptCap?: boolean } = { ignoreAttemptCap: true },
  ): Promise<NativeLockRecoveryOutcome | "none"> {
    return withNativeLockFlow(escrowId, () =>
      this.settlePendingNativeLockInner(escrowId, opts),
    );
  }

  /** Unlocked body — callable only while the caller HOLDS the flow mutex
   *  (lockAndPublish's inner flow) or via the locked wrapper above. */
  private async settlePendingNativeLockInner(
    escrowId: string,
    opts: { ignoreAttemptCap?: boolean },
  ): Promise<NativeLockRecoveryOutcome | "none"> {
    if (!this.nativeLockGuardOn()) return "none";
    const prior = getPendingNativeLock(escrowId);
    if (!prior || prior.stage === "intent") return "none";
    return recoverPendingNativeLock(prior, this.nativeLockRecoveryDeps(), opts);
  }

  /**
   * Full lock flow (crash-safe since #37):
   *   0. v0.1.72: Probe-and-verify locker's federation matches CREATE's;
   *      #37: refuse when the trade is no longer CREATED.
   *   1. Settle any prior attempt's stash entry (re-absorb / idempotent
   *      resume / honest refuse) — its bearer notes must never be clobbered.
   *   2. Persist an INTENT record, fail-closed on unwritable storage.
   *   3. Spend ecash (browser-safe 14-day try_cancel horizon) → stash the notes
   *      SYNCHRONOUSLY before anything else can await, throw, or reload.
   *   4. Split into 2-of-3 SSS shares, NIP-44 encrypt, publish the LOCK.
   *   5. Clear the stash ONLY on a confirmed LOCKED-with-our-notesHash.
   *
   * After this, the money is in escrow — no one can move it alone. On any
   * crash or failure in between, the stash entry drives fail-closed
   * recovery (pending-native-locks.ts) instead of stranding the sats.
   */
  async lockAndPublish(escrowId: string, opts: LockOptions = {}): Promise<EscrowState> {
    // Whole flow under the per-escrow mutex: recovery (settle/drain) can
    // never interleave with the spend→publish→confirm window of a LIVE
    // lock for the same trade (review F7/F11/F15).
    return withNativeLockFlow(escrowId, () => this.lockAndPublishInner(escrowId, opts));
  }

  private async lockAndPublishInner(escrowId: string, opts: LockOptions = {}): Promise<EscrowState> {
    const context = await this.prepareLockContext(escrowId, opts);
    const amountMsats = amountMsatsForLock(context.state, opts.selectedItems);
    const meta = buildChamaOperationMeta({
      flow: "lock_spend",
      escrowId,
      amountMsats,
    });
    const guardOn = this.nativeLockGuardOn();
    const lockOpts = {
      savedHandleId: opts.savedHandleId,
      selectedItems: opts.selectedItems,
      buyerPubkey: opts.buyerPubkey,
    };

    if (guardOn) {
      // A prior attempt's entry holds bearer notes — settle it before any
      // new spend can exist for the same trade. (Inner variant: we already
      // hold the flow mutex.)
      const outcome = await this.settlePendingNativeLockInner(escrowId, { ignoreAttemptCap: true });
      if (outcome !== "none") {
        if (outcome === "cleared-committed") {
          // The crash-window publish actually landed: the trade is already
          // locked with the prior notes. Idempotent resume — never spend
          // again, never publish a second LOCK.
          const settled = this.escrow.getState(escrowId);
          if (settled) return settled;
          throw new Error(
            "Cannot LOCK — this trade already locked with your previous funding. " +
            "Reopen it to continue."
          );
        }
        if (outcome === "kept") {
          throw new Error(
            "Chama is still recovering your previous funding attempt for this trade. " +
            "Your sats are safe — recovery retries automatically. Try again in a " +
            "moment. (No new sats were spent.)"
          );
        }
        // reabsorbed / cleared-dead-notes ⇒ the wallet is whole again —
        // proceed with a fresh lock.
      }

      // FAIL-CLOSED (V8 pattern): if the crash guard can't persist, refuse
      // the lock BEFORE any sats move.
      assertNativeLockStashWritable();
      stashNativeLockIntent({
        escrowId,
        amountMsats,
        federationId: this.fedimint.getFederationId(),
        spendTimeoutSecs: LOCK_SPEND_TRY_CANCEL_SECS,
        lockOpts,
      });
    }

    // The sats exist ONLY as the returned notes the instant the wallet
    // call resolves — the onSpent callback persists them SYNCHRONOUSLY
    // inside spendNotesForLock, before its own diagnostics awaits can
    // widen the unstashed window (review F12).
    const spend = await this.fedimint.spendNotesForLock(
      amountMsats,
      meta,
      guardOn
        ? (oobNotes, operationId) => upgradeNativeLockToSpent({
            escrowId,
            oobNotes,
            amountMsats,
            federationId: this.fedimint.getFederationId(),
            operationId,
            spendTimeoutSecs: LOCK_SPEND_TRY_CANCEL_SECS,
            lockOpts,
          })
        : undefined,
    );

    // ⭐⭐ VERIFY THE INSTRUMENT, NOT THE PROBE.
    //
    // A pre-spend probe already asked the wallet which federation it is on and
    // refused on mismatch (see prepareLockContext). In the field that guard did
    // not fire and BLF notes were locked into a GBF trade anyway — most likely a
    // probe→spend race, since the bridge can switch its active client between
    // the two. Rather than chase a race no test can prove gone, check the thing
    // that actually matters: the notes we are about to commit. `parseNotes` is a
    // LOCAL decode that talks to nobody, so this cannot fail for network
    // reasons, and a wrong-federation note is unambiguous evidence — however the
    // probe was bypassed.
    //
    // Chama-generated lock notes now always embed the federation invite, and
    // the browser adapter uses WalletDirector's federation-aware parser. That
    // lets this fail CLOSED on an absent/unreadable ID: a lock we cannot bind
    // to CREATE's federation is returned to the wallet, never published.
    //
    // Gated on `guardOn` — the same condition that wrote the #37 stash — so the
    // re-absorb path below is guaranteed to have an entry to recover. Without
    // that pairing a refusal here would strand the spend it just refused.
    if (guardOn && context.expectedFed) {
      let mintedFed: string | undefined;
      let parseFailure: unknown;
      try {
        mintedFed = (await this.fedimint.parseNotes(spend.oobNotes)).federationId;
      } catch (parseErr) {
        parseFailure = parseErr;
      }
      if (!mintedFed || mintedFed !== context.expectedFed) {
        // Re-absorb through the #37 machinery and publish NO LOCK. The notes go
        // back to the wallet; the trade stays CREATED and fundable.
        let recovered = false;
        try {
          const outcome = await this.settlePendingNativeLockInner(escrowId, { ignoreAttemptCap: true });
          recovered = outcome !== "none";
        } catch (recoverErr) {
          console.warn(
            "[chama] lock: cross-federation refusal could not re-absorb inline; " +
            "the boot drain owns recovery.",
            recoverErr,
          );
        }
        const instrumentProblem = mintedFed
          ? `These sats are from federation ${mintedFed}, but this trade is held on ${context.expectedFed}.`
          : `Chama could not verify that these sats belong to federation ${context.expectedFed}.`;
        const err: any = new Error(
          `${instrumentProblem} Chama did not lock them — ` +
          (recovered
            ? "they are back in your wallet."
            : "they are saved and will return to your wallet automatically.") +
          " Switch to the trade's federation and try again.",
        );
        err.code = mintedFed ? "FED_MISMATCH_NOTES" : "FED_UNVERIFIED_NOTES";
        err.expected = context.expectedFed;
        err.got = mintedFed ?? null;
        err.cause = parseFailure;
        throw err;
      }
    }

    const lockBundle = await this.fedimint.buildEscrowLockBundle(
      spend.oobNotes,
      amountMsats,
      { arbiterFeeMsats: context.state.fees.arbiterMsats },
    );

    if (guardOn) markNativeLockPublishAttempted(escrowId);
    // On a publish throw the entry stays `publish-attempted` and we rethrow:
    // deliberately NO inline re-absorb here — right after a failed publish,
    // a relay that timed out may still have taken the LOCK frame, so the
    // "no LOCK exists" read is not yet trustworthy. The next Fund tap or
    // the next boot drain settles it once relay state is readable.
    const resultState = await this.publishLockBundle(
      escrowId, context.state, lockBundle, context, opts,
    );

    if (guardOn) {
      if (resultState?.lock?.notesHash === lockBundle.notesHash) {
        // Positive confirmation — the LOCK committed OUR notes.
        clearPendingNativeLock(escrowId);
      } else {
        // Stale-suppression resolve or a competing lock committed different
        // notes: ours are NOT in escrow. Keep the entry; recovery re-absorbs
        // when provably safe.
        console.warn(
          `[chama] lockAndPublish: LOCK did not commit our notes for ${escrowId} ` +
          `— stash entry kept for recovery`
        );
      }
    }
    return resultState;
  }

  async preflightLock(escrowId: string): Promise<{ buyerPubkey: string }> {
    const { buyerPubkey } = await this.prepareLockContext(escrowId);
    return { buyerPubkey };
  }

  async lockAndPublishWithEcash(escrowId: string, oobNotes: string, opts: LockOptions = {}): Promise<EscrowState> {
    return withNativeLockFlow(escrowId, () =>
      this.lockAndPublishWithEcashInner(escrowId, oobNotes, opts),
    );
  }

  private async lockAndPublishWithEcashInner(escrowId: string, oobNotes: string, opts: LockOptions = {}): Promise<EscrowState> {
    const context = await this.prepareLockContext(escrowId, opts);
    const amountMsats = amountMsatsForLock(context.state, opts.selectedItems);
    const guardOn = this.nativeLockGuardOn();
    const lockOpts = {
      savedHandleId: opts.savedHandleId,
      selectedItems: opts.selectedItems,
      buyerPubkey: opts.buyerPubkey,
    };

    if (guardOn) {
      const outcome = await this.settlePendingNativeLockInner(escrowId, { ignoreAttemptCap: true });
      if (outcome === "cleared-committed") {
        const settled = this.escrow.getState(escrowId);
        if (settled) return settled;
        throw new Error("This trade already locked with your previous ecash funding. Reopen it to continue.");
      }
      if (outcome === "kept") {
        throw new Error("Chama is still recovering your previous ecash funding. Your notes are safely stashed; try again shortly.");
      }
    }

    // External/Fedi notes were minted outside Chama's active client. Refuse
    // unless the bearer instrument itself carries the full federation route
    // committed by CREATE. The caller still owns the note and its fund-loss
    // guard will re-absorb it when this throws.
    if (context.expectedFed && !isSimModeOn()) {
      let parsedFed: string | undefined;
      try {
        parsedFed = (await this.fedimint.parseNotes(oobNotes)).federationId;
      } catch {
        // The fail-closed error below is the user-facing boundary.
      }
      if (!parsedFed || parsedFed !== context.expectedFed) {
        const err: any = new Error(
          parsedFed
            ? `This ecash belongs to federation ${parsedFed}, but this trade is held on ${context.expectedFed}. No LOCK was published.`
            : `Chama could not verify which federation minted this ecash. No LOCK was published.`,
        );
        err.code = parsedFed ? "FED_MISMATCH_NOTES" : "FED_UNVERIFIED_NOTES";
        err.expected = context.expectedFed;
        err.got = parsedFed ?? null;
        throw err;
      }
    }

    // Parse and validate federation + exact amount BEFORE taking custody in
    // Chama's recovery stash. An invalid paste remains solely in Fedi.
    const lockBundle = await this.fedimint.createEscrowLockFromNotes(
      oobNotes,
      amountMsats,
      {
        arbiterFeeMsats: context.state.fees.arbiterMsats,
      },
      buildChamaOperationMeta({
        flow: "lock_external_ecash",
        escrowId,
        amountMsats,
      }),
    );

    if (guardOn) {
      assertNativeLockStashWritable();
      stashNativeLockIntent({
        escrowId,
        amountMsats,
        federationId: this.fedimint.getFederationId(),
        spendTimeoutSecs: LOCK_SPEND_TRY_CANCEL_SECS,
        lockOpts,
      });
      upgradeNativeLockToSpent({
        escrowId,
        oobNotes,
        amountMsats,
        federationId: this.fedimint.getFederationId(),
        spendTimeoutSecs: LOCK_SPEND_TRY_CANCEL_SECS,
        lockOpts,
      });
      markNativeLockPublishAttempted(escrowId);
    }

    const resultState = await this.publishLockBundle(
      escrowId, context.state, lockBundle, context, opts,
    );
    if (guardOn && resultState?.lock?.notesHash === lockBundle.notesHash) {
      clearPendingNativeLock(escrowId);
    }
    return resultState;
  }

  // ── Claim: Decrypt shares → SSS combine → verify → redeem → publish CLAIM

  /**
   * Full claim flow (winner only):
   *   1. Identify which 2 shares the winner can access
   *      (their own share + the share of a voter who agreed with them)
   *   2. Decrypt both shares
   *   3. Reconstruct the original ecash via SSS combine
   *   4. Verify the hash matches the LOCK event
   *   5. Redeem the ecash into their Fedimint wallet
   *   6. Publish the CLAIM event to Nostr relays
   *
   * After this, the money is in the winner's wallet.
   */
  /** ⚠ ECASH CLAIMS ONLY. An on-chain escrow has no shares to reconstruct and
   *  no notes to redeem — its settlement is a co-signed PSBT (S4/S5). Entering
   *  this path with an on-chain lock would fail deep inside share decryption
   *  with a confusing error, and any "retry" would be meaningless. Refuse at the
   *  door with something true instead. */
  private assertEcashSettlement(state: EscrowState): void {
    if ((state.escrowMode ?? "ecash") === "onchain" || state.lock.onchain) {
      throw new Error(
        "This escrow is held on-chain — settle it by co-signing the payout transaction, not by claiming ecash."
      );
    }
  }

  async claimAndRedeem(
    escrowId: string,
    opts: {
      clearPendingOnRedeem?: boolean;
      redeemWith?: "browser-sdk" | "fedi-internal";
    } = {},
  ): Promise<EscrowState> {
    let state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);
    this.assertEcashSettlement(state);

    // Details opens immediately and refreshes the relay chain in the
    // background. On a cold/legacy trade the APPROVED/CLAIMED tail can already
    // be present in memory while the earlier LOCK body (hash + encrypted
    // shares) is still missing. A fast Claim tap used to race that refresh and
    // fail permanently with "No lock data" even though a full relay replay a
    // moment later could recover it. Make the money path self-sufficient: when
    // either required LOCK component is absent, synchronously fetch + replay
    // the authoritative union once before deciding the trade is incomplete.
    // loadEscrow has its own bounded completeness retries and partial-downgrade
    // guard, so this cannot replace a newer state with a shorter relay view.
    if (!state.lock.notesHash || !state.lock.shares || state.lock.shares.size < 1) {
      try {
        const rehydrated = await this.escrow.loadEscrow(escrowId);
        state = rehydrated ?? this.escrow.getState(escrowId) ?? state;
      } catch (error) {
        // Preserve the deterministic hard-failure below. Letting a relay-fetch
        // exception escape would make the claim coordinator misclassify this
        // as an in-flight redeem and start a pointless balance watchdog even
        // though reconstruction never began.
        console.debug(
          `[chama] claim rehydrate failed for ${escrowId}:`,
          error instanceof Error ? error.message : error,
        );
        state = this.escrow.getState(escrowId) ?? state;
      }
    }

    const myPubkey = await this.signer.getPublicKey();
    const winner = getWinner(state);
    claimTrace("bridge-in", {
      escrowId,
      status: state.status,
      outcome: state.resolvedOutcome,
      myPubkey: myPubkey.slice(0, 8),
      winnerRole: winner?.role,
      winnerPubkey: winner?.pubkey?.slice(0, 8),
    });
    if (!winner || winner.pubkey !== myPubkey) {
      throw new Error("You are not the winner of this escrow");
    }

    if (!state.lock.notesHash) {
      throw new Error("No lock data available — escrow may not be fully loaded");
    }

    if (!state.lock.shares || state.lock.shares.size < 1) {
      throw new Error("No shares available — state may be incomplete");
    }

    // NIP-44 decrypt needs the sender's pubkey. LOCK shares were encrypted by
    // the locker (the LOCK event signer).
    const lockEvent = state.eventChain.find((e: any) => e.kind === 38102 || e.payload?.type === "escrow:lock");
    const lockerPubkey = lockEvent?.raw?.pubkey || lockEvent?.pubkey || myPubkey;

    let decryptedMyShare: SSSShare;
    // C15 (v3.4.0): every decryptable partner share, in chain order —
    // not just the first. One poisoned / old-client / uncooperative
    // envelope must not strand the winner when another agreeing voter's
    // envelope reconstructs fine. Trying several is idempotent: each
    // try is a local SSS combine + hash check; nothing touches the
    // federation until exactly one reconstruction has succeeded.
    const partnerCandidates: Array<{ share: SSSShare; voterPubkey: string }> = [];
    const candidateDecryptErrors: string[] = [];

    if (state.lock.sharePolicy === HOLDER_ONLY_SHARE_POLICY) {
      // Holder-only: the winner reconstructs from their OWN LOCK share (the
      // locker encrypted it to them at their holder index) PLUS one agreeing
      // voter's VOTE-carried share (a voter re-encrypted their own share to the
      // winner when voting this outcome). Two distinct shares, mixed senders —
      // the cryptographic 2-of-3. See docs/DESIGN-holder-only-shares.md.
      const ownShareIndex = shareIndexForRole(winner.role);
      const ownEntry = state.lock.shares.get(String(ownShareIndex));
      if (!ownEntry?.encryptedFor?.[myPubkey]) {
        throw new Error("Can't find your share of this trade. Make sure you're on Chama v2.x.x or higher and let it finish syncing — if the other side is on an older version, everyone needs to update for the trade to complete.");
      }
      // LOCK share: locker is the sender.
      decryptedMyShare = await this.decryptShareDual(ownEntry, myPubkey, lockerPubkey);

      // VOTE share: scan for agreeing voters' shares routed to me — but each
      // must be a DISTINCT share from my own. The winner usually also voted, and
      // their own vote re-encrypts their own share (same index) back to
      // themselves; using it would feed SSS two copies of one share ("shares
      // must contain unique values"). Skip any envelope at my own shareIndex so
      // we take a different holder's agreeing share.
      //
      // INVARIANT(claim-tries-all-envelopes): collect EVERY matching
      // envelope (C15) — a per-envelope decrypt failure is recorded and
      // skipped, not fatal, because a later envelope may still unlock
      // the claim. Selection rules live in collectClaimEnvelopeCandidates
      // (pure, pinned by invariant_claim__tries_all_envelopes).
      for (const candidate of collectClaimEnvelopeCandidates(state.eventChain, {
        resolvedOutcome: state.resolvedOutcome,
        myPubkey,
        ownShareIndex,
      })) {
        try {
          // VOTE share: the VOTER is the sender (not the locker).
          partnerCandidates.push({
            share: await this.decryptShare(candidate.ciphertext, candidate.voterPubkey),
            voterPubkey: candidate.voterPubkey,
          });
        } catch (decErr) {
          candidateDecryptErrors.push(
            decErr instanceof Error ? decErr.message : String(decErr)
          );
        }
      }
      claimTrace("bridge-envelopes", {
        escrowId,
        candidates: partnerCandidates.length,
        decryptFailures: candidateDecryptErrors.length,
      });
      if (partnerCandidates.length === 0) {
        // Some envelopes existed but none could be decrypted — that's a
        // different (and more actionable) failure than "nobody agreed".
        if (candidateDecryptErrors.length > 0) {
          throw new Error(
            `Found ${candidateDecryptErrors.length} release key${candidateDecryptErrors.length === 1 ? "" : "s"} for this claim, but none could be unlocked ` +
            `(${candidateDecryptErrors[candidateDecryptErrors.length - 1]}). ` +
            "Ask a voter who agreed with the outcome to update Chama and vote again, then retry."
          );
        }
        // Tell apart "no one has agreed yet" from a VERSION MISMATCH: a voter on
        // a pre-2.0 build votes WITHOUT a holder-only shareEnvelope, so their
        // agreement carries no release key and the winner can never assemble the
        // second share. The fix is an upgrade — say so plainly instead of leaving
        // a cryptic share error (the original field-test confusion).
        const agreedButNoKey = state.eventChain.some((ve: any) =>
          ve.kind === EscrowEventKind.VOTE &&
          (ve.payload as VotePayload | undefined)?.outcome === state.resolvedOutcome &&
          ((ve.raw?.pubkey || ve.pubkey) !== myPubkey) &&
          !(ve.payload as VotePayload | undefined)?.shareEnvelope
        );
        if (agreedButNoKey) {
          throw new Error("Can't release yet — someone who agreed is on an older Chama that can't carry the release key. Ask them to update to Chama v2.x.x or higher and vote again, then you can claim.");
        }
        throw new Error("Waiting on a second agreeing vote — someone other than you must vote your way before you can claim.");
      }
    } else {
      // Legacy dual-encryption: every share is locker-encrypted to all three,
      // so any two reconstruct.
      const shareEntries = [...state.lock.shares.values()];
      if (shareEntries.length < 2) {
        throw new Error("Not enough shares: got " + shareEntries.length + ", need 2");
      }
      decryptedMyShare = await this.decryptShareDual(shareEntries[0], myPubkey, lockerPubkey);
      partnerCandidates.push({
        share: await this.decryptShareDual(shareEntries[1], myPubkey, lockerPubkey),
        voterPubkey: lockerPubkey,
      });
    }

    // v0.1.63: Publish CLAIM before redeem
    // ──────────────────────────────────────
    // The chain-correctness move. Reconstructing the notes + matching the
    // hash is already cryptographic proof that the winner has the ecash.
    // Publish CLAIM on the strength of that proof so the Nostr event chain
    // reflects reality *now*, even if the federation redeem is slow.
    //
    // Order is:
    //   1. reconstruct + verify (deterministic, local, fast)
    //   2. publish CLAIM       (chain is now correct)
    //   3. redeemWithRetry     (settle the wallet)
    //
    // If step 3 hard-fails, we throw a marked error so the hook can
    // route to the "watching" UI state instead of red-toasting.

    // C15 (v3.4.0): try EVERY candidate envelope before giving up. Each
    // attempt is local (Shamir combine + hash check + parse) — no
    // federation mutation — so trying several cannot double-spend. The
    // first candidate whose reconstruction matches the LOCK hash wins;
    // a corrupted or hostile envelope just falls through to the next.
    let reconstructed: {
      notesHash: string;
      oobNotes: string;
      federationId?: string;
      federationInvite?: string;
    } | null = null;
    const reconstructErrors: string[] = [];
    for (const candidate of partnerCandidates) {
      try {
        const result = await this.fedimint.reconstructAndVerify(
          decryptedMyShare,
          candidate.share,
          state.lock.notesHash
        );
        reconstructed = {
          notesHash: result.notesHash,
          oobNotes: result.oobNotes,
          federationId: result.federationId,
          federationInvite: result.federationInvite,
        };
        break;
      } catch (reconErr) {
        reconstructErrors.push(
          reconErr instanceof Error ? reconErr.message : String(reconErr)
        );
        claimTrace("bridge-reconstruct-candidate-failed", {
          escrowId,
          voter: candidate.voterPubkey.slice(0, 8),
          errMsg: (reconErr instanceof Error ? reconErr.message : String(reconErr)).slice(0, 120),
        });
      }
    }
    if (!reconstructed) {
      throw new Error(
        `Couldn't rebuild your sats from any release key (${partnerCandidates.length} tried). ` +
        `Last error: ${reconstructErrors[reconstructErrors.length - 1] ?? "none"}. ` +
        "Your sats are still locked and safe. Ask a voter who agreed with the outcome to update Chama and vote again, then retry."
      );
    }
    const { notesHash, oobNotes } = reconstructed;
    claimTrace("bridge-reconstructed", {
      escrowId,
      notesHashPrefix: notesHash.slice(0, 16),
      oobNotesLen: oobNotes.length,
      candidatesTried: reconstructErrors.length + 1,
      candidatesAvailable: partnerCandidates.length,
    });

    // v0.4.4 federation gates (fed-ID equality) ──────────────────────────
    // Probe reachability of the redeemer's wallet, and verify it sits on
    // the same federation the trade was created on. If not, the redeem
    // would either silently partial-credit (the v0.1.71 incident root
    // cause) or hard-fail with a confusing error from the SDK. Catch it
    // here with a clear actionable error instead.
    //
    // The CREATE event's `fed` tag is the source of truth for which
    // federation the lock lives on. We compare it to the wallet's own
    // fed ID. Legacy trades without payload.fed (expectedFed === null) skip
    // this gate and fall through to the redeem itself. v3.5.1: that redeem
    // is now bounded by REDEEM_ATTEMPT_TIMEOUT_MS, so a cross-fed claim the
    // gate couldn't catch surfaces a retryable claim-pending terminal
    // instead of hanging the in-progress spinner forever.
    const claimCreateEvent = state.eventChain.find(
      (e: any) => e.kind === 38100 || e.payload?.type === "escrow:create"
    );
    // The bearer note is the settlement's final route authority. CREATE is a
    // compatibility fallback only for adapters that cannot inspect the note.
    // This both detects cross-fed Fedi locks honestly and lets an already-
    // stranded trade recover after the wallet switches to the note's real fed.
    const expectedFed = reconstructed.federationId
      ?? effectiveCreateFederationId(claimCreateEvent?.payload as any);

    let redeemProbe: { fed: string | null };
    try {
      redeemProbe = await this.fedimint.probeReachable();
      claimTrace("bridge-probe", {
        escrowId,
        expectedFed: expectedFed ?? "none",
        actualFed: redeemProbe.fed,
      });
    } catch (probeErr) {
      // v0.3.1 Phase 1: honest copy. This throw fires BEFORE
      // stashPendingRedemption (below, ~line 341) AND before the CLAIM
      // publish at this.escrow.claim() — nothing has been stashed,
      // nothing has been published, no chain advance. The previous
      // "Notes stashed for retry" copy was technically false at this
      // point in the flow (Pillar 2.7 violation surfaced in v0.3.0
      // production smoke). The other claim-side throw at the
      // post-redeem catch (below, claimPublished:true) keeps its
      // existing copy because notes ARE stashed by that point.
      const err: any = new Error(
        "Couldn't verify your federation before claiming. " +
          "(No sats were spent — retry when your Chama is reachable.)"
      );
      err.code = "FED_PROBE_FAILED";
      err.cause = probeErr;
      throw err;
    }

    // Native Chama wallets keep each federation in an isolated database. A
    // prior trade can therefore leave the sidecar pointing at Afribit/GBF
    // while the verified bearer note belongs to BLF. When the note itself
    // carries its invite, select that preserved database automatically. This
    // never wipes the current federation and happens before CLAIM publish or
    // redeem, so a failed switch leaves the bearer note untouched and stashed.
    if (
      expectedFed
      && !isSimModeOn()
      && redeemProbe.fed !== expectedFed
      && reconstructed.federationInvite
    ) {
      try {
        await this.fedimint.switchFederationPreserving(
          reconstructed.federationInvite,
        );
        redeemProbe = await this.fedimint.probeReachable();
        claimTrace("bridge-route-switched", {
          escrowId,
          expectedFed,
          actualFed: redeemProbe.fed,
        });
      } catch (switchError) {
        claimTrace("bridge-route-switch-failed", {
          escrowId,
          expectedFed,
          actualFed: redeemProbe.fed,
          reason: switchError instanceof Error
            ? switchError.message
            : String(switchError),
        });
      }
    }

    if (expectedFed && !isSimModeOn() && redeemProbe.fed !== expectedFed) {
      const err: any = new Error(
        `This trade's sats were minted on federation ${expectedFed}. ` +
          `Your wallet is on ${redeemProbe.fed}. ` +
          `Switch to the note's federation, then retry. ` +
          `No claim was published — your sats are safe and waiting.`
      );
      err.code = "FED_MISMATCH";
      err.expected = expectedFed;
      err.got = redeemProbe.fed;
      err.invite = reconstructed.federationInvite;
      // Don't publish CLAIM yet — refusing redeem before claim publish
      // means the trade chain doesn't advance prematurely. The user
      // switches feds and retries; CLAIM will publish on the next try.
      throw err;
    }

    const existingClaim = state.eventChain.find((e: any) => {
      const payload = e.payload;
      return (e.kind === EscrowEventKind.CLAIM || payload?.type === "escrow:claim") &&
        payload?.claimerRole === winner.role &&
        payload?.notesHashVerification === notesHash;
    });
    claimTrace("bridge-claim-event", {
      escrowId,
      existingClaim: Boolean(existingClaim),
      notesHashPrefix: notesHash.slice(0, 16),
    });
    const stateAfterClaim = existingClaim
      ? state
      : await this.escrow.claim(escrowId, notesHash);

    // v0.1.68: Stash oobNotes to localStorage BEFORE attempting redeem.
    // ───────────────────────────────────────────────────────────────────
    // At this point:
    //   - The chain has advanced: CLAIM is published, trade is settling.
    //   - The reconstructed oobNotes bearer token exists only on this
    //     JS stack frame.
    //   - If the app closes before redeemWithRetry resolves, the token
    //     is lost and the sats are orphaned (see sm_moadjfkb_9ue9pd5p
    //     incident, v0.1.67 and earlier).
    //
    // Persisting here, then clearing after a successful redeem, makes
    // the claim path crash-safe. A boot-time drainPendingRedemptions()
    // call in useEscrow.initFedimint retries any entries that survive
    // the browser/app dying mid-redeem.
    //
    // Note: stashPendingRedemption is synchronous (localStorage), so
    // there's no new await that could itself be interrupted.
    stashPendingRedemption({
      escrowId,
      oobNotes,
      notesHash,
      amountMsats: state.amountMsats,
    });
    claimTrace("bridge-stashed", {
      escrowId,
      amountMsats: state.amountMsats,
      notesHashPrefix: notesHash.slice(0, 16),
    });

    try {
      if (opts.redeemWith === "fedi-internal") {
        const receivedMsats = await receiveFediEcash(oobNotes, state.amountMsats);
        claimTrace("bridge-fedi-receive-ok", {
          escrowId,
          expectedMsats: state.amountMsats,
          receivedMsats: receivedMsats ?? "unknown",
        });
      } else {
        await this.fedimint.redeemWithRetry(
          oobNotes,
          3,
          buildChamaOperationMeta({
            flow: "claim_reissue",
            escrowId,
            amountMsats: state.amountMsats,
            notesHashPrefix: notesHash.slice(0, 16),
          }),
        );
      }
      claimTrace("bridge-redeem-ok", {
        escrowId,
        redeemWith: opts.redeemWith ?? "browser-sdk",
        clearPendingOnRedeem: opts.clearPendingOnRedeem !== false,
      });
      // Redeem confirmed (or already-spent, which redeemWithRetry treats
      // as success). Federation has the notes, stash is no longer needed.
      if (opts.clearPendingOnRedeem !== false) {
        clearPendingRedemption(escrowId);
      }
    } catch (redeemErr) {
      const redeemCode = (redeemErr as any)?.code;
      claimTrace("bridge-redeem-error", {
        escrowId,
        code: redeemCode,
        errMsg: (redeemErr instanceof Error ? redeemErr.message : String(redeemErr)).slice(0, 120),
      });
      // C5 (v3.4.0): "already spent, credit unconfirmed" — retrying is
      // pointless (the notes are consumed), so mark the stash entry now
      // rather than burning boot-drain attempts before the C13 surface
      // lights up. The entry (with the bearer notes) stays exportable.
      if (redeemCode === "ALREADY_SPENT_UNCONFIRMED") {
        markUnresolvedCredit(
          escrowId,
          redeemErr instanceof Error ? redeemErr.message : String(redeemErr)
        );
      }
      // Stash stays. The boot-drain on next initFedimint() will retry.
      // UI error surface is unchanged from v0.1.67.
      const wrapped = new Error(
        "Claim published to relays, but ecash redeem failed: " +
          (redeemErr instanceof Error ? redeemErr.message : String(redeemErr))
      );
      (wrapped as any).claimPublished = true;
      if (
        opts.redeemWith === "fedi-internal" ||
        redeemCode === "MINT_REISSUE_FAILED" ||
        redeemCode === "MINT_REISSUE_UNKNOWN" ||
        // C5: balance growth from THIS redeem is impossible (notes
        // consumed); let the orchestrator skip the growth poll and
        // judge by the absolute-balance cover check, exactly like the
        // terminal mint-reissue codes.
        redeemCode === "ALREADY_SPENT_UNCONFIRMED"
      ) {
        (wrapped as any).settlementFailed = true;
        (wrapped as any).code = opts.redeemWith === "fedi-internal"
          ? "FEDI_RECEIVE_FAILED"
          : redeemCode;
      }
      (wrapped as any).cause = redeemErr;
      throw wrapped;
    }

    return stateAfterClaim;
  }

  async claimAndReceiveFedi(
    escrowId: string,
    opts: { clearPendingOnRedeem?: boolean } = {},
  ): Promise<EscrowState> {
    return this.claimAndRedeem(escrowId, {
      ...opts,
      redeemWith: "fedi-internal",
    });
  }

  // ── Pre-claim verification: REMOVED (2026-07-29) ────────────────────────
  //
  // ⚰️ `verifyClaim` lived here for a long time with ZERO callers, described as
  // "optional but recommended". It was neither: it could not do the job its
  // name implied, and nobody could call it to find out.
  //
  // What it actually did was reconstruct the shares and check them against the
  // LOCK's `notesHash`. That hash is SHA-256 over the note STRING, so it stays
  // valid forever — including after the notes have been spent. It therefore
  // could not detect the one thing a pre-claim check exists to detect: whether
  // the escrow still holds money. A funder who reissued their own notes
  // (lock-custody.ts) would have sailed through it.
  //
  // Deleted rather than wired, because wiring it would have shipped a
  // reassuring green check that proves nothing — worse than no check at all,
  // since a counterparty would ship goods against it. A real liveness probe
  // needs the federation to be asked whether the notes are spendable, and
  // `parseNotes` is a local decode that never talks to anyone. Until that
  // exists, detection comes from tranching (escrow-engine/tranche.ts), where a
  // slice's claim either credits or does not.

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Decrypt a share using the dual-encryption format.
   * Looks up own pubkey in encryptedFor map and NIP-44-decrypts with
   * the locker's pubkey as the sender.
   */
  private async decryptShareDual(
    share: LockShareEntry,
    myPubkey: string,
    lockerPubkey: string,
  ): Promise<SSSShare> {
    const ciphertext = share.encryptedFor[myPubkey];
    if (!ciphertext) {
      throw new Error(
        `No encrypted share found for pubkey ${myPubkey.slice(0, 8)}...`
      );
    }
    return this.decryptShare(ciphertext, lockerPubkey);
  }

  /** Encrypt an SSS share to a recipient pubkey */
  private async encryptShare(share: SSSShare, recipientPubkey: string): Promise<string> {
    // SSS shares MUST be NIP-44 encrypted to each recipient.
    // This is the real security boundary — unencrypted shares on relays
    // would let anyone reconstruct the ecash.
    const json = JSON.stringify(share);
    return await this.signer.nip44Encrypt(json, recipientPubkey);
  }

  /** Decrypt an SSS share from a sender */
  private async decryptShare(encryptedShare: string, senderPubkey: string): Promise<SSSShare> {
    // In dev/plaintext mode, shares are not encrypted — try parsing directly first
    let decrypted: string;
    try {
      const parsed = JSON.parse(encryptedShare);
      if (parsed && (parsed.index !== undefined || parsed.data !== undefined)) {
        // Already plaintext JSON — no decryption needed
        decrypted = encryptedShare;
      } else {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      }
    } catch {
      // Not valid JSON — must be encrypted, decrypt it
      try {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      } catch (decryptErr) {
        // If decrypt also fails, the share might be a simulated plaintext string
        // (from simulatedLock which uses "sim_share_0_..." format)
        console.warn("[chama] Share decrypt failed, using as-is:", encryptedShare.slice(0, 30));
        decrypted = encryptedShare;
      }
    }
    // Try parsing as JSON (real SSS shares are JSON objects)
    try {
      return JSON.parse(decrypted) as SSSShare;
    } catch {
      // Not JSON — simulated or raw share string
      // Wrap it as a minimal SSSShare-like object so downstream code can handle it
      console.warn("[chama] Share is not JSON, wrapping as raw:", decrypted.slice(0, 30));
      return { index: 0, data: decrypted } as unknown as SSSShare;
    }
  }


  // ── Wallet passthrough: used by Fund Wallet modal ──────────────────────
  // These delegate to FedimintClient and are exposed on the bridge so the
  // UI can route ALL money operations through a single object. Keeps the
  // hook layer consistent (always calls bridge.*) and makes it easy to
  // add logging/metrics around wallet ops in one place.

  async payInvoice(bolt11: string, meta?: ChamaOperationMeta): Promise<string | undefined> {
    // Returns the durable LN-pay operationId so the claim orchestrator can
    // journal the payout (double-pay guard). Errors thrown here carry a
    // `code` (LN_PAY_INFLIGHT / LN_PAY_REFUNDED / LN_PAY_SUBMIT_FAILED) and
    // an `operationId` for re-attach — see sdk-adapter.ts.
    return await this.fedimint.payInvoice(bolt11, meta);
  }

  /** 3.5.1 double-pay guard: re-attach to a previously-submitted payout and
   *  report its terminal outcome without paying again. */
  async awaitPayoutOutcome(
    operationId: string,
  ): Promise<"settled" | "refunded" | "unknown"> {
    return await this.fedimint.awaitPayOutcome(operationId);
  }

  /** V7 reconcile-by-escrow: resolve the payment(s) ever dispatched for this
   *  escrow via the operation log's chama_escrow_id stamp — survives a crash
   *  that lost the operationId. "unknown" ⇒ refuse re-pay for now. */
  async payOutcomeByEscrow(
    escrowId: string,
    sinceMs?: number,
  ): Promise<PayOutcomeByEscrowResult> {
    return await this.fedimint.payOutcomeByEscrow(escrowId, sinceMs);
  }

  async spendNotes(
    amountMsats: number,
    meta?: ChamaOperationMeta,
    includeInvite = false,
  ): Promise<string> {
    // FedimintClient exposes spendNotes via its wallet; route through there.
    return await this.fedimint.spendNotes(amountMsats, meta, includeInvite);
  }

  /** User-facing export: long auto-refund horizon + invite-bearing note for
   *  Fedi portability. Detailed spend returns straight into the caller's
   *  synchronous stash write (no intervening await). */
  async spendNotesForExport(
    amountMsats: number,
    meta?: ChamaOperationMeta,
  ): Promise<string> {
    const spent = await this.fedimint.spendNotesWithHorizon(
      amountMsats,
      ECASH_EXPORT_TRY_CANCEL_SECS,
      meta,
      true,
    );
    return spent.oobNotes;
  }

  async redeemEcash(oobNotes: string, meta?: ChamaOperationMeta): Promise<void> {
    await this.fedimint.redeemEcash(oobNotes, meta);
  }

  async getOnchainWithdrawFees(address: string, amountSats: number) {
    return await this.fedimint.getOnchainWithdrawFees(address, amountSats);
  }

  async withdrawOnchain(address: string, amountSats: number, meta?: ChamaOperationMeta) {
    return await this.fedimint.withdrawOnchain(address, amountSats, {
      wait: true,
      meta,
    });
  }
}
