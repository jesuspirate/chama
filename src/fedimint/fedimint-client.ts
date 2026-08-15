// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Fedimint Client (Browser WASM)
// ══════════════════════════════════════════════════════════════════════════
//
// Wraps the @fedimint/core SDK to provide ecash operations for escrow:
//   - Join a federation
//   - Mint ecash notes (from Lightning or on-chain)
//   - Spend ecash notes (for locking in escrow)
//   - Redeem ecash notes (after SSS reconstruction)
//   - Parse and validate notes
//   - Balance management
//
// All operations run client-side via WebAssembly. No server.
// The Fedimint WASM client talks directly to federation guardians.
//
// Dependencies:
//   @fedimint/core          — Core wallet API
//   @fedimint/transport-web — WASM worker transport for browsers
//   shamir-secret-sharing   — 2-of-3 Shamir splitting
//
// NOTE: This module has runtime dependencies that must be installed:
//   npm install @fedimint/core @fedimint/transport-web shamir-secret-sharing

// ── Types (compatible with @fedimint/core) ────────────────────────────────

// v0.6.5: type-only import. The runtime adapter is loaded dynamically
// at init time (see initClient below); the type carries no runtime
// cost. Re-exported from this module so callers (useEscrow, the
// orchestrator) don't have to reach into sdk-adapter directly.
import type { LnReceiveStateKind } from "./sdk-adapter.js";
export type { LnReceiveStateKind };
import type { ChamaOperationMeta } from "../payments/sats-trace.js";
import { expectedFederationIdForInvite } from "./federation-config.js";
import { withMintLock } from "./mint-mutex.js";

/** V7 reconcile-by-escrow verdict. `none` is a POSITIVE "no matching payment
 *  exists" (the scan reached ops older than `sinceMs`); `unknown` means the
 *  scan failed / was unavailable / couldn't prove completeness — callers
 *  must refuse to re-pay on it. `operationId` rides along on
 *  settled/refunded/inflight so the caller can adopt it for re-attach. */
export type PayOutcomeByEscrowResult = {
  outcome: "settled" | "refunded" | "inflight" | "none" | "unknown";
  operationId?: string;
};

export interface OnchainInfo {
  network: string;
  finalityDelay: number;
  pegInFeeSats: number;
  pegOutFeeSats: number;
  minimumDepositSats: number;
}

export interface OnchainDepositAddress {
  operationId: string;
  address: string;
  tweakIdx?: unknown;
  finalityDelay: number;
}

export interface OnchainDepositSettled {
  status: string;
  operationId: string;
  amountSats?: number;
  outpoint?: string;
}

export interface OnchainWithdrawFees {
  amountSats: number;
  feesSats: number;
  totalSats: number;
}

export interface OnchainWithdrawResult {
  operationId: string;
  status: string;
  txid?: string;
  feesSats: number;
}

/**
 * Which Lightning gateway minted a receive invoice.
 *
 * A federation can announce several gateways, and the one chosen decides the
 * only route a payer may use. `provenPayable` is the load-bearing field: false
 * means the gateway answers its API but nothing has ever settled through it,
 * which is exactly the state that hands payers "no route" — worth telling the
 * user before they wait on a QR code.
 */
export interface InvoiceGatewayInfo {
  id: string;
  alias?: string;
  api?: string;
  provenPayable: boolean;
}

/**
 * Fedimint wallet instance — mirrors @fedimint/core FedimintWallet API.
 * We define our own interface to decouple from the SDK version and
 * enable testing with mocks.
 */
export interface IFedimintWallet {
  open(): Promise<void>;
  isOpen(): boolean;
  joinFederation(inviteCode: string): Promise<void>;
  /** Native sidecars can keep several federation databases and atomically
   *  select one without deleting the previously active database. Browser
   *  wallets implement the same behavior by reopening a federation-scoped
   *  OPFS file at the hook layer. */
  switchFederationPreserving?(inviteCode: string): Promise<void>;
  /** Optional sidecar hook for adapters that cannot recover an invite from
   *  the native client DB after an already-open wallet is re-associated with
   *  Chama's configured invite. */
  rememberInviteCode?(inviteCode: string): void;
  recovery: {
    hasPendingRecoveries(): Promise<boolean>;
    waitForAllRecoveries(): Promise<void>;
  };

  balance: {
    getBalance(): Promise<number>;
    subscribeBalance(callback: (balance: number) => void): () => void;
  };

  mint: {
    /** Spend notes from wallet — returns OOB ecash string */
    spendNotes(
      amountMsats: number,
      meta?: ChamaOperationMeta,
      includeInvite?: boolean,
    ): Promise<string>;
    /** #37 lock crash-safety: spend with an explicit try_cancel_after
     *  horizon and surface the spend operation id. Lock spends must
     *  outlive any trade + dispute (the client-side auto-cancel would
     *  otherwise hollow out a long-running escrow); default spends keep
     *  the SDK's short horizons. Optional — wallets that omit it fall
     *  back to `spendNotes` (default horizon, no operation id). */
    spendNotesDetailed?(
      amountMsats: number,
      opts: { tryCancelAfterSecs?: number; includeInvite?: boolean },
      meta?: ChamaOperationMeta,
    ): Promise<{ notes: string; operationId?: string }>;
    /** Redeem OOB ecash notes into wallet */
    redeemEcash(oobNotes: string, meta?: ChamaOperationMeta): Promise<string | void>;
    /** Parse OOB notes to inspect amount without redeeming. Native adapters
     *  also expose the note's own federation route; browser SDKs may omit it. */
    parseNotes(oobNotes: string): Promise<{
      total_amount: number;
      federation_id?: string;
      federation_invite?: string;
    }>;
  };

  lightning: {
    /** Create a Lightning invoice to receive sats into the federation.
     *  v0.6.5: `onReceiveState` is fired on every state transition of
     *  the underlying SDK receive operation (created → funded →
     *  awaiting_funds → claimed). The orchestrator uses this to
     *  advance modal UI on `funded` without waiting for the 5s
     *  balance poll to notice. */
    createInvoice(
      amountMsats: number,
      description: string,
      onReceiveState?: (kind: LnReceiveStateKind) => void,
      meta?: ChamaOperationMeta,
    ): Promise<{ invoice: string; operationId: string; gateway?: InvoiceGatewayInfo }>;
    /** Pay a Lightning invoice from federation balance */
    payInvoice(bolt11: string, meta?: ChamaOperationMeta): Promise<{ operationId: string }>;
    /** 3.5.1 double-pay guard: re-attach to a previously-submitted payout
     *  and report its terminal outcome without paying again. Optional —
     *  mock/native wallets may omit it. */
    awaitPayOutcome?(operationId: string): Promise<"settled" | "refunded" | "unknown">;
    /** V7 reconcile-by-escrow: resolve the outgoing payment(s) stamped with
     *  this escrow's `chama_escrow_id` in the fedimint operation log —
     *  durable in the client DB, so it survives restarts that lost the
     *  operationId. Optional — mock wallets may omit it (⇒ "unknown"). */
    payOutcomeByEscrow?(escrowId: string, sinceMs?: number): Promise<PayOutcomeByEscrowResult>;
  };

  /** Optional native wallet-module on-chain peg-in/peg-out support.
   * Browser WASM adapters may omit this until the SDK path is validated. */
  onchain?: {
    getInfo(): Promise<OnchainInfo>;
    createDepositAddress(meta?: ChamaOperationMeta): Promise<OnchainDepositAddress>;
    awaitDeposit(operationId: string): Promise<OnchainDepositSettled>;
    getWithdrawFees(address: string, amountSats: number): Promise<OnchainWithdrawFees>;
    withdraw(
      address: string,
      amountSats: number,
      options?: { wait?: boolean; meta?: ChamaOperationMeta },
    ): Promise<OnchainWithdrawResult>;
  };

  federation: {
    getFederationId(): Promise<string>;
    getInviteCode(): Promise<string>;
  };

  cleanup(): Promise<void>;
}

// ── SSS Share structure ───────────────────────────────────────────────────

export interface SSSShare {
  /** Index: 0, 1, or 2 */
  index: number;
  /** Raw share bytes as base64 */
  data: string;
}

export interface EscrowLockBundle {
  /** SHA-256 hash of the original ecash notes (for verification) */
  notesHash: string;
  /** The 3 SSS shares */
  shares: SSSShare[];
  /** Amount breakdown (v0.1.71: 2-way split, no platformFeeMsats) */
  totalMsats: number;
  sellerReceivesMsats: number;
  arbiterFeeMsats: number;
}

/**
 * #37: try_cancel_after horizon for LOCK spends, in seconds (90 days).
 *
 * fedimint OOB spends carry a CLIENT-SIDE auto-cancel: after this window
 * the spender's own client refunds the notes to itself. The SDK defaults
 * (browser 1 day, native bridge 7 days) are SHORTER than a disputed
 * trade's life — past them a healthy-looking LOCKED escrow silently
 * hollows out and the winner's claim fails as already-spent. Lock spends
 * therefore pass this explicit long horizon; crash recovery no longer
 * leans on the auto-cancel (the pending-native-locks stash re-absorbs
 * within minutes of the next boot instead).
 */
export const LOCK_SPEND_TRY_CANCEL_SECS = 90 * 24 * 60 * 60;
/** User-facing bearer exports stay claimable for two weeks, then the mint
 *  client can reabsorb an unclaimed note. This bounds even the tiny
 *  spend-return→stash crash window without hollowing out a live export. */
export const ECASH_EXPORT_TRY_CANCEL_SECS = 14 * 24 * 60 * 60;


// [$$] money instrumentation v0.1.71b
// ══════════════════════════════════════════════════════════════════════════
// Money-flow instrumentation helpers.
//
// Activation: in the browser console, run:
//   localStorage.setItem("chama_debug_money", "1")
// To deactivate:
//   localStorage.removeItem("chama_debug_money")
//
// All instrumentation lines start with "[$$]" so you can filter the
// console with that one keyword to see *only* money flow across all
// checkpoints. Federation ID is included on every line so you can
// detect mid-flow federation drift (the v0.1.71 incident root cause
// hypothesis).
// ══════════════════════════════════════════════════════════════════════════

function mlogEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("chama_debug_money") !== null;
  } catch {
    return false;
  }
}

function mlog(checkpoint: string, fields: Record<string, unknown>): void {
  if (!mlogEnabled()) return;
  // Stable shape: [$$] CHECKPOINT key=value key=value ...
  const parts: string[] = [`[$$] ${checkpoint}`];
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

function claimTrace(checkpoint: string, fields: Record<string, unknown>): void {
  if (!mlogEnabled()) return;
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

function normalizeKnownFederationId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function assertJoinedFederationMatchesInvite(
  inviteCode: string,
  federationId: string | null | undefined,
): void {
  const expected = expectedFederationIdForInvite(inviteCode);
  if (!expected) return;

  const actual = normalizeKnownFederationId(federationId);
  if (actual === expected) return;

  const err: Error & {
    code?: string;
    expected?: string;
    got?: string | null;
    invitePrefix?: string;
  } = new Error(
    `Requested federation invite resolves to ${expected}, but the wallet opened ` +
      `${actual || "an unknown federation"}. Refusing to record a mismatched route.`
  );
  err.code = "FED_JOIN_MISMATCH";
  err.expected = expected;
  err.got = actual || null;
  err.invitePrefix = inviteCode.slice(0, 24);
  throw err;
}

// ── Callback interface ────────────────────────────────────────────────────

export interface FedimintClientCallbacks {
  onBalanceUpdate?: (balance: number) => void;
  onFederationJoined?: (federationId: string) => void;
  onError?: (error: Error, context: string) => void;
}

// ── Init / factory options ────────────────────────────────────────────────

export interface FedimintWalletFactoryOptions {
  /** BIP-39 mnemonic words, if a deterministic seed should be installed */
  mnemonic?: string[];
  /** Stable browser-storage scope. Real wallets use this to isolate OPFS
   *  files per Nostr identity so one profile can test multiple npubs without
   *  tripping seed-mismatch safety. */
  storageScope?: string | null;
  /** v0.4.2 sim mode: hex pubkey of the active signer. Sim-wallet keys
   *  its persistent state by this so multiple identities in one browser
   *  don't share a sim balance. Ignored by the real wallet factory. */
  simNpub?: string | null;
}

export interface FedimintInitOptions {
  /** BIP-39 mnemonic words, if a deterministic seed should be installed */
  mnemonic?: string[];
  /** Stable browser-storage scope. See FedimintWalletFactoryOptions. */
  storageScope?: string | null;
  /** v0.4.2 sim mode: hex pubkey of the active signer. See
   *  FedimintWalletFactoryOptions.simNpub. */
  simNpub?: string | null;
}

// ══════════════════════════════════════════════════════════════════════════
// FEDIMINT CLIENT — High-level escrow-focused ecash operations
// ══════════════════════════════════════════════════════════════════════════

export class FedimintClient {
  private wallet: IFedimintWallet | null = null;
  private callbacks: FedimintClientCallbacks;
  private balanceUnsubscribe: (() => void) | null = null;
  private _federationId: string | null = null;
  /** v0.1.69: cache the invite we actually joined with, to detect switch attempts */
  private _joinedInvite: string | null = null;
  /** C5 (v3.4.0): how long the "already spent" path polls for a
   *  confirmed balance credit before declaring the redeem unresolved.
   *  Public so tests can shrink it; production default is generous
   *  because a reissue that landed moments ago may still be settling. */
  alreadySpentConfirmTimeoutMs = 10_000;

  /**
   * Factory function to create the actual wallet instance.
   * Injected to allow testing with mocks and to defer the heavy
   * WASM import until it's actually needed.
   *
   * Default (production): uses @fedimint/core + @fedimint/transport-web
   */
  private walletFactory: (opts: FedimintWalletFactoryOptions) => Promise<IFedimintWallet>;

  constructor(
    callbacks: FedimintClientCallbacks = {},
    walletFactory?: (opts: FedimintWalletFactoryOptions) => Promise<IFedimintWallet>
  ) {
    this.callbacks = callbacks;
    this.walletFactory = walletFactory || FedimintClient.defaultWalletFactory;
  }

  // ── Default factory — lazy-loads the WASM SDK ───────────────────────────

  private static async defaultWalletFactory(
    opts: FedimintWalletFactoryOptions
  ): Promise<IFedimintWallet> {
    // v0.4.2: ?sim=1 → swap in the product-facing sim wallet (0 starting
    // sats, npub-keyed persistence, realistic latency). Takes priority
    // over testnet=1 if both happen to be set.
    const { isSimModeOn } = await import("../sim/simMode.js");
    if (isSimModeOn()) {
      const { createSimWallet } = await import("../sim/sim-wallet.js");
      console.info("[chama] ⚠ sim=1 — using sim Fedimint wallet (no real money)");
      return createSimWallet({ npub: opts.simNpub ?? null });
    }

    // ?testnet=1 → in-memory mock for unit-test scaffolding. Distinct
    // from sim mode (1k starting sats, not persisted). Dev/CI only.
    const { isTestnetMode, createMockWallet } = await import("./mock-wallet.js");
    if (isTestnetMode()) {
      console.info("[chama] ⚠ testnet=1 — using mock Fedimint wallet");
      return createMockWallet();
    }

    // ?nativeFedimint=1, Capacitor, or Tauri → route wallet calls to the local
    // Rust sidecar. Browser builds remain opt-in; native shells package and
    // start the sidecar automatically.
    const { isNativeBridgeModeOn, createNativeBridgeWallet, getNativeBridgeUrl } =
      await import("./native-bridge-adapter.js");
    if (isNativeBridgeModeOn()) {
      const bridgeUrl = getNativeBridgeUrl();
      console.info(`[chama] nativeFedimint=1 — using native Fedimint bridge at ${bridgeUrl}`);
      return createNativeBridgeWallet(bridgeUrl);
    }

    // Dynamic import of the adapter keeps WASM out of the initial bundle.
    // The adapter maps @fedimint/core 0.1.x onto our IFedimintWallet shape.
    const { createRealWallet } = await import("./sdk-adapter.js");
    return createRealWallet({
      mnemonic: opts.mnemonic,
      storageScope: opts.storageScope,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize the WASM wallet. Call once at app startup.
   *
   * @param opts.mnemonic Optional BIP-39 mnemonic to seed the wallet. If
   *                      supplied, the wallet is deterministic and
   *                      recoverable on any device with the same seed.
   *                      Chama's useEscrow hook fetches this from the
   *                      Nostr-backed seed-manager.
   */
  async init(opts: FedimintInitOptions = {}): Promise<void> {
    try {
      this.wallet = await this.walletFactory({
        mnemonic: opts.mnemonic,
        storageScope: opts.storageScope,
        simNpub: opts.simNpub,
      });

      // Try to open an existing client in the DB. On a fresh OPFS file
      // (e.g. after filename rotation or a first-ever launch) there is
      // no client yet and the SDK/native bridge throws a first-run
      // "client/database is not initialized" variant — that's not a
      // real error, it just means we haven't joined a federation on
      // this DB yet. We'll open it implicitly when joinFederation() runs.
      try {
        await this.wallet.open();
      } catch (openErr) {
        const msg = typeof openErr === "string" ? openErr : (openErr as Error)?.message || "";
        if (/client is not initialized|client database not initialized|database not initialized|not initialized for this database|no such client|client secret is not present|run join first/i.test(msg)) {
          console.info(
            "[chama] No existing Fedimint client in this DB — will be created on join"
          );
        } else {
          throw openErr;
        }
      }

      // Only subscribe to balance updates if we successfully opened an
      // existing client. On a fresh DB the subscription would target a
      // non-existent client; we'll subscribe inside joinFederation()
      // instead, after the client is bootstrapped.
      if (this.wallet.isOpen()) {
        // [$$] BAL-TICK on every balance push from the SDK
        this.balanceUnsubscribe = this.wallet.balance.subscribeBalance((balance) => {
          mlog("BAL-TICK", {
            fed: this._federationId,
            balance,
            source: "init-subscribe",
          });
          this.callbacks.onBalanceUpdate?.(balance);
        });
        this._federationId = await this.wallet.federation.getFederationId();
        try {
          const initBal = await this.wallet.balance.getBalance();
          mlog("FED-INIT", {
            fed: this._federationId,
            balance: initBal,
            source: "existing-opfs",
          });
        } catch {}

        // Check for pending recovery on init (e.g. after auto-reset).
        // v0.1.75 recovery instrumentation: source="init" tells us this
        // fired from the existing-OPFS path, not from a fresh join.
        await this.runRecoveryIfNeeded(this.wallet, "init");
      }
    } catch (e) {
      this.callbacks.onError?.(
        e instanceof Error ? e : new Error(String(e)),
        "init"
      );
      throw e;
    }
  }

  /** Clean up WASM resources */
  async cleanup(): Promise<void> {
    if (this.balanceUnsubscribe) {
      this.balanceUnsubscribe();
      this.balanceUnsubscribe = null;
    }
    if (this.wallet) {
      const wallet = this.wallet;
      this.wallet = null;
      try {
        await wallet.cleanup();
      } finally {
        this._federationId = null;
        this._joinedInvite = null;
      }
      return;
    }
    this._federationId = null;
    this._joinedInvite = null;
  }

  private requireWallet(): IFedimintWallet {
    if (!this.wallet) throw new Error("FedimintClient not initialized — call init() first");
    return this.wallet;
  }

  private requireOnchainWallet(): NonNullable<IFedimintWallet["onchain"]> {
    const wallet = this.requireWallet();
    if (!wallet.onchain) {
      throw new Error(
        "On-chain Fedimint wallet support is not available in this wallet adapter. " +
        "Start Chama with nativeFedimint=1 and the Rust bridge.",
      );
    }
    return wallet.onchain;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FEDERATION MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Join a Fedimint federation using an invite code.
   * This is a one-time operation per federation.
   */
  async joinFederation(inviteCode: string): Promise<string> {
    const wallet = this.requireWallet();

    // v3.4.x sim mode: the sim wallet models a single synthetic federation
    // (SIM_FEDERATION_ID) that is intentionally invite-agnostic — it never
    // equals the real fed id that expectedFederationIdForInvite() derives
    // from a community invite. The real-mode switch guard and the
    // assertJoinedFederationMatchesInvite() check below would therefore
    // throw FED_JOIN_MISMATCH for every real community invite, aborting
    // init so fedimint.joined never flips true (ChamaBar stuck on
    // "Reconnect"). Sim has no real bearer ecash to orphan, so we take a
    // self-contained join path that records the invite, wires the balance
    // stream, and skips the real-fed identity guards. Real mode is below.
    const { isSimModeOn } = await import("../sim/simMode.js");
    if (isSimModeOn()) {
      if (!wallet.isOpen()) {
        await wallet.joinFederation(inviteCode);
      }
      this._federationId = await wallet.federation.getFederationId();
      this._joinedInvite = inviteCode.trim();
      wallet.rememberInviteCode?.(this._joinedInvite);
      if (!this.balanceUnsubscribe) {
        this.balanceUnsubscribe = wallet.balance.subscribeBalance((balance) => {
          this.callbacks.onBalanceUpdate?.(balance);
        });
      }
      this.callbacks.onFederationJoined?.(this._federationId);
      return this._federationId;
    }

    // v0.1.69 / v0.1.70: Gate federation switching (with re-open fix).
    // ─────────────────────────────────────────────────────────────────
    // Ecash is federation-bound. Until Chama supports proper per-
    // federation isolation (separate OPFS files or the SDK's native
    // multi-federation client), switching federations on an already-
    // open wallet would orphan ecash notes bound to the previous
    // federation. The v0.1.69 guard blocks explicit switches cleanly,
    // but it also broke the re-open-after-reload case, where the
    // wallet is already open from a previous session and the user
    // (or code) tries to re-join the SAME federation — _joinedInvite
    // is null at that point because we haven't called joinFederation
    // this session, so the equality check fell through to the throw.
    //
    // v0.1.70: distinguish three sub-cases of isOpen():
    //   (a) same session, same invite  → no-op
    //   (b) re-open after reload       → trust the re-open, record
    //                                    the invite, return current
    //                                    federation ID
    //   (c) same session, different    → throw (legitimate switch
    //       invite                       attempt, still blocked)
    //
    // Residual risk in (b): if an invite for a different federation
    // is passed while the OPFS holds federation X, we'd record it
    // but the wallet stays on X. This matches pre-v0.1.68 behavior
    // (silent no-op in this case) and doesn't introduce new risk
    // relative to what shipped for months before. Closing this gap
    // requires an SDK helper to peek an invite's federation ID
    // without joining — revisit when multi-federation work starts.
    if (wallet.isOpen()) {
      const currentId =
        this._federationId || (await wallet.federation.getFederationId());
      assertJoinedFederationMatchesInvite(inviteCode, currentId);

      // (b) Re-open case: wallet is open from a previous session but
      // we haven't called joinFederation yet this session. Record the
      // invite and return the existing federation ID. This is the
      // common happy-path-after-reload flow; the user simply re-joined
      // the same federation their OPFS already holds.
      if (this._joinedInvite === null) {
        this._joinedInvite = inviteCode.trim();
        wallet.rememberInviteCode?.(this._joinedInvite);
        return currentId;
      }

      // (a) Same-session idempotent re-join. Trim-compare to be
      // defensive about whitespace that sometimes sneaks in from
      // clipboard paste.
      if (this._joinedInvite.trim() === inviteCode.trim()) {
        wallet.rememberInviteCode?.(this._joinedInvite);
        return currentId;
      }

      // (c) Same session, different invite → switch attempt. Refuse.
      throw new Error(
        "Federation switching is not yet supported. " +
        "Your wallet is currently joined to another federation, and " +
        "switching would orphan any ecash bound to it. " +
        "Multi-federation support is planned for a future release."
      );
    }

    await wallet.joinFederation(inviteCode);
    this._federationId = await wallet.federation.getFederationId();
    assertJoinedFederationMatchesInvite(inviteCode, this._federationId);
    this._joinedInvite = inviteCode.trim();

    // Now that the client exists in the DB, wire up the balance stream
    // (if init() skipped it because the DB was empty).
    if (!this.balanceUnsubscribe) {
      this.balanceUnsubscribe = wallet.balance.subscribeBalance((balance) => {
        // [$$] BAL-TICK on every balance push from the SDK
        mlog("BAL-TICK", {
          fed: this._federationId,
          balance,
          source: "join-subscribe",
        });
        this.callbacks.onBalanceUpdate?.(balance);
      });
    }
    try {
      const joinBal = await wallet.balance.getBalance();
      mlog("FED-JOIN", {
        fed: this._federationId,
        balance: joinBal,
        invitePrefix: inviteCode.slice(0, 24),
      });
    } catch {}

    // Check for pending recovery (happens when rejoining with same seed
    // after OPFS reset — the federation can reconstruct ecash notes).
    //
    // v0.1.75 recovery instrumentation: this used to be an inline block
    // that duplicated the helper logic. Now it just delegates, with a
    // source="join" tag so we can distinguish it from the init path in
    // the [$$] mlog stream. This is the call site we expect to fire
    // when a user has joined BLF after wiping OPFS — the funds-recovery
    // moment we've been chasing.
    await this.runRecoveryIfNeeded(wallet, "join");

    this.callbacks.onFederationJoined?.(this._federationId);
    return this._federationId;
  }

  /** Select another already-isolated federation database without resetting it.
   * Only the arbiter flow calls this, and only native adapters expose the hook. */
  async switchFederationPreserving(inviteCode: string): Promise<string> {
    const wallet = this.requireWallet();
    if (!wallet.switchFederationPreserving) {
      throw new Error("This Fedimint adapter does not support an in-place preserved switch");
    }
    if (this.balanceUnsubscribe) {
      this.balanceUnsubscribe();
      this.balanceUnsubscribe = null;
    }
    await wallet.switchFederationPreserving(inviteCode);
    this._federationId = await wallet.federation.getFederationId();
    assertJoinedFederationMatchesInvite(inviteCode, this._federationId);
    this._joinedInvite = inviteCode.trim();
    wallet.rememberInviteCode?.(this._joinedInvite);
    this.balanceUnsubscribe = wallet.balance.subscribeBalance((balance) => {
      this.callbacks.onBalanceUpdate?.(balance);
    });
    this.callbacks.onFederationJoined?.(this._federationId);
    return this._federationId;
  }

  /**
   * Run ecash recovery if the federation has pending recoveries for this seed.
   *
   * v0.1.75 recovery instrumentation: takes a `source` param so the [$$]
   * mlog distinguishes init-path from join-path checks. This is critical
   * for diagnosing the post-OPFS-reset fund recovery flow, because we
   * need to know which call site fired and what hasPendingRecoveries()
   * returned.
   *
   * @param wallet The Fedimint wallet to recover into
   * @param source Where the call came from: "init" (existing OPFS at
   *               startup) or "join" (after joinFederation completes)
   */
  private async runRecoveryIfNeeded(
    wallet: IFedimintWallet,
    source: "init" | "join",
  ): Promise<void> {
    let balanceBefore: number | undefined;
    try {
      balanceBefore = await wallet.balance.getBalance();
    } catch {
      // pre-recovery balance may not be readable on a freshly-joined
      // empty client — that's fine, we just won't have a delta.
    }

    mlog("RECOVERY-CHECK", {
      source,
      fed: this._federationId,
      balanceBefore,
    });

    const checkStart = Date.now();
    let hasPending = false;
    try {
      hasPending = await wallet.recovery.hasPendingRecoveries();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mlog("RECOVERY-ERROR", { source, phase: "hasPending", error: msg });
      console.warn("[chama] Recovery check failed (non-fatal):", e);
      return;
    }
    const checkDurationMs = Date.now() - checkStart;
    mlog("RECOVERY-RESULT", {
      source,
      hasPending,
      durationMs: checkDurationMs,
    });

    if (!hasPending) return;

    // Pending recoveries exist — wait for them and report the delta.
    console.info(
      `[chama] Recovery in progress (source=${source}) — restoring ecash notes from federation...`,
    );
    mlog("RECOVERY-WAIT-START", { source, fed: this._federationId });
    // Signal UI that recovery is running (used by join-path to show spinner)
    if (source === "join") this.callbacks.onBalanceUpdate?.(-1);
    const waitStart = Date.now();
    try {
      await wallet.recovery.waitForAllRecoveries();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mlog("RECOVERY-ERROR", { source, phase: "waitForAll", error: msg });
      console.warn("[chama] waitForAllRecoveries threw (non-fatal):", e);
      // Fall through to the balance refresh anyway — partial recovery
      // may have landed.
    }
    const waitDurationMs = Date.now() - waitStart;

    let balanceAfter: number | undefined;
    try {
      balanceAfter = await wallet.balance.getBalance();
      this.callbacks.onBalanceUpdate?.(balanceAfter);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mlog("RECOVERY-ERROR", { source, phase: "balanceAfter", error: msg });
    }

    const delta = (balanceBefore !== undefined && balanceAfter !== undefined)
      ? balanceAfter - balanceBefore
      : undefined;
    mlog("RECOVERY-WAIT-END", {
      source,
      durationMs: waitDurationMs,
      balanceBefore,
      balanceAfter,
      delta,
    });
    console.info(
      `[chama] Recovery complete (source=${source}) — ecash notes restored ` +
      `(balance: ${balanceBefore ?? "?"} → ${balanceAfter ?? "?"})`,
    );
  }

  /** Get the current federation ID (null if not joined) */
  getFederationId(): string | null {
    return this._federationId;
  }

  /** Check if the wallet object exists in this JS client. */
  isInitialized(): boolean {
    return this.wallet !== null;
  }

  /** Check if the wallet is connected to a federation */
  isJoined(): boolean {
    try {
      return this.wallet?.isOpen() ?? false;
    } catch {
      return false;
    }
  }

  /** Get the federation invite code (for sharing) */
  async getInviteCode(): Promise<string> {
    return this.requireWallet().federation.getInviteCode();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BALANCE
  // ══════════════════════════════════════════════════════════════════════════

  /** Get current ecash balance in msats */
  async getBalance(): Promise<number> {
    const balance = await this.requireWallet().balance.getBalance();
    mlog("BAL-GET", {
      fed: this._federationId,
      balance,
    });
    return balance;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ECASH OPERATIONS — Core of the escrow flow
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mint ecash notes for a specific amount.
   * Returns the OOB (out-of-band) ecash string.
   *
   * This is what gets split into SSS shares for escrow.
   */
  async spendNotes(
    amountMsats: number,
    meta?: ChamaOperationMeta,
    includeInvite = false,
  ): Promise<string> {
    const wallet = this.requireWallet();
    // INVARIANT(mint-mutex): every spend/redeem on the shared OPFS
    // wallet serializes on the cross-tab mint lock (C12). The wrapped
    // fn calls the raw wallet directly — never another locked method.
    return withMintLock("spend-notes", () => wallet.mint.spendNotes(amountMsats, meta, includeInvite));
  }

  /**
   * Redeem ecash notes into the wallet balance.
   * Used by the escrow winner after reconstructing from SSS shares.
   */
  async redeemEcash(oobNotes: string, meta?: ChamaOperationMeta): Promise<void> {
    const wallet = this.requireWallet();
    // INVARIANT(mint-mutex): see spendNotes.
    await withMintLock("redeem-ecash", () => wallet.mint.redeemEcash(oobNotes, meta));
  }

  /**
   * Parse ecash notes to inspect the amount without redeeming.
   * Useful for verification before claiming.
   */
  async parseNotes(oobNotes: string): Promise<{
    totalAmount: number;
    federationId?: string;
    federationInvite?: string;
  }> {
    const wallet = this.requireWallet();
    const parsed = await wallet.mint.parseNotes(oobNotes);
    return {
      totalAmount: parsed.total_amount,
      federationId: parsed.federation_id,
      federationInvite: parsed.federation_invite,
    };
  }

  // v0.4.4 federation reachability ───────────────────────────────────────
  /**
   * Probe the wallet's current federation for reachability WITHOUT
   * requiring any balance. Returns the cached federation ID on success;
   * throws if the federation cannot be queried.
   *
   * Why balance-free: per v0.1.76 Option B ("no sats stranded ever"),
   * wallets sit at 0 between trades. The old probeFederation() spent
   * 1 sat as ecash to extract a federation-identifying prefix; with
   * zero balance that path was guaranteed to throw "Insufficient
   * balance" and falsely surface the federation as unreachable. This
   * variant uses a balance-independent wallet roundtrip so the boot
   * probe survives the steady-state-zero invariant.
   *
   * isOpen() alone is too cheap (pure local state); getBalance()
   * actually exercises the wallet's federation-bound DB read path and
   * surfaces a federation-side fault as a thrown error.
   *
   * Used by:
   *   - useEscrow.initFedimint        — cold-boot reachability gate
   *   - useEscrow.createFundingInvoice — pre-receive health check
   *   - useEscrow.probeFederation     — explicit re-probe (Try Again)
   *   - escrow-bridge.lockAndPublish  — fed-ID gate before LOCK
   *   - escrow-bridge.claimAndRedeem  — fed-ID gate before redeem
   *
   * Throws if the wallet isn't joined or if the wallet/federation
   * rejects the read (likely a connectivity issue).
   */
  async probeReachable(): Promise<{ fed: string | null }> {
    const wallet = this.requireWallet();

    // v0.4.2 sim mode: sim wallet has exactly one synthetic federation
    // and always agrees with itself. Short-circuit with the cached
    // fed ID — no roundtrip needed.
    const { isSimModeOn } = await import("../sim/simMode.js");
    if (isSimModeOn()) {
      mlog("FED-PROBE-REACHABLE", {
        fed: this._federationId,
        result: "sim-bypass",
      });
      return { fed: this._federationId };
    }

    // v1.2.2 claim-hang fix: bound the balance read so a stuck WASM
    // state machine surfaces as a probe failure instead of returning
    // ok and then hanging downstream in `reissueExternalNotes`. The
    // probe is supposed to be the bridge's "is this federation
    // actually responding" gate before we touch the mint module.
    // Without a timeout, getBalance can return cached local state
    // even when the federation is mid-stall — we'd report ok and the
    // subsequent claim would silently hang for the user. 10 s is more
    // than enough for a healthy local DB read; anything slower than
    // that is a real problem.
    const PROBE_BALANCE_TIMEOUT_MS = 10_000;
    let balance: number | undefined;
    try {
      balance = await Promise.race<number>([
        wallet.balance.getBalance(),
        new Promise<number>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new Error(
                  `wallet.balance.getBalance() did not resolve within ${PROBE_BALANCE_TIMEOUT_MS / 1000}s`,
                ),
              ),
            PROBE_BALANCE_TIMEOUT_MS,
          );
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch (e) {
      mlog("FED-PROBE-REACHABLE", {
        fed: this._federationId,
        result: "balance-read-failed",
        errMsg: (e instanceof Error ? e.message : String(e)).slice(0, 120),
      });
      throw new Error(
        "Federation probe failed (couldn't query wallet state). " +
        "Your wallet may be disconnected or the federation may be unreachable. " +
        "Try again in a moment."
      );
    }

    mlog("FED-PROBE-REACHABLE", {
      fed: this._federationId,
      balance,
      result: "ok",
    });

    return { fed: this._federationId };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIGHTNING — Funding the wallet
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a Lightning invoice to fund the wallet.
   * The user pays this invoice from any Lightning wallet.
   */
  async createInvoice(
    amountMsats: number,
    description: string,
    onReceiveState?: (kind: LnReceiveStateKind) => void,
    meta?: ChamaOperationMeta,
    // Reported rather than returned so every existing caller keeps taking a
    // plain BOLT11 string back.
    onGateway?: (gateway: InvoiceGatewayInfo) => void,
  ): Promise<string> {
    const wallet = this.requireWallet();
    const result = await wallet.lightning.createInvoice(
      amountMsats,
      description,
      onReceiveState,
      meta,
    );
    if (result.gateway) onGateway?.(result.gateway);
    return result.invoice;
  }

  /**
   * Pay a Lightning invoice from the federation balance.
   * Used for outbound payments.
   */
  async payInvoice(bolt11: string, meta?: ChamaOperationMeta): Promise<string | undefined> {
    const wallet = this.requireWallet();
    let balanceBefore: number | undefined;
    try { balanceBefore = await wallet.balance.getBalance(); } catch {}
    mlog("PAY-IN", {
      fed: this._federationId,
      invoicePrefix: bolt11.slice(0, 24),
      invoiceLen: bolt11.length,
      balanceBefore,
    });
    try {
      // 3.5.1: surface the durable operationId so the claim orchestrator can
      // journal the payout and re-attach to it instead of ever re-paying.
      const res = await wallet.lightning.payInvoice(bolt11, meta);
      let balanceAfter: number | undefined;
      try { balanceAfter = await wallet.balance.getBalance(); } catch {}
      mlog("PAY-OUT", {
        fed: this._federationId,
        result: "success",
        balanceBefore,
        balanceAfter,
        balanceDelta: balanceBefore !== undefined && balanceAfter !== undefined
          ? balanceAfter - balanceBefore
          : undefined,
      });
      return res?.operationId;
    } catch (e: any) {
      let balanceAfter: number | undefined;
      try { balanceAfter = await wallet.balance.getBalance(); } catch {}
      mlog("PAY-OUT", {
        fed: this._federationId,
        result: "error",
        balanceBefore,
        balanceAfter,
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      throw e;
    }
  }

  /** 3.5.1 double-pay guard: re-attach to a previously-submitted payout and
   *  report its terminal outcome. Returns "unknown" when the wallet adapter
   *  cannot watch (mock/native) — the caller then keeps the submitted record
   *  and refuses to re-pay. */
  async awaitPayOutcome(
    operationId: string,
  ): Promise<"settled" | "refunded" | "unknown"> {
    const wallet = this.requireWallet();
    if (!wallet.lightning.awaitPayOutcome) return "unknown";
    return wallet.lightning.awaitPayOutcome(operationId);
  }

  /** V7 reconcile-by-escrow: scan the operation log for outgoing payments
   *  stamped with this escrow id. "unknown" when the wallet adapter can't
   *  scan — callers refuse to re-pay and retry the reconcile later. */
  async payOutcomeByEscrow(
    escrowId: string,
    sinceMs?: number,
  ): Promise<PayOutcomeByEscrowResult> {
    const wallet = this.requireWallet();
    if (!wallet.lightning.payOutcomeByEscrow) return { outcome: "unknown" };
    return wallet.lightning.payOutcomeByEscrow(escrowId, sinceMs);
  }

  async getOnchainInfo(): Promise<OnchainInfo> {
    return this.requireOnchainWallet().getInfo();
  }

  async createOnchainDepositAddress(
    meta?: ChamaOperationMeta,
  ): Promise<OnchainDepositAddress> {
    return this.requireOnchainWallet().createDepositAddress(meta);
  }

  async awaitOnchainDeposit(operationId: string): Promise<OnchainDepositSettled> {
    return this.requireOnchainWallet().awaitDeposit(operationId);
  }

  async getOnchainWithdrawFees(
    address: string,
    amountSats: number,
  ): Promise<OnchainWithdrawFees> {
    return this.requireOnchainWallet().getWithdrawFees(address, amountSats);
  }

  async withdrawOnchain(
    address: string,
    amountSats: number,
    options?: { wait?: boolean; meta?: ChamaOperationMeta },
  ): Promise<OnchainWithdrawResult> {
    return this.requireOnchainWallet().withdraw(address, amountSats, options);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SSS ESCROW OPERATIONS — The money part of non-custodial escrow
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Lock ecash into 2-of-3 SSS escrow.
   *
   * This is THE critical operation:
   *   1. Spend ecash notes from wallet (full trade amount)
   *   2. Split the notes into 3 Shamir shares (threshold 2)
   *   3. Hash the original notes for later verification
   *   4. Return the lock bundle (shares + hash + fee breakdown)
   *
   * The caller (EscrowClient) then NIP-44 encrypts each share
   * to its intended recipient and publishes the LOCK event.
   *
   * After this call, the ecash is OUT of the wallet. It exists
   * only as 3 shares. Any 2 can reconstruct the original.
   */
  async createEscrowLock(
    totalMsats: number,
    fees: {
      arbiterFeeMsats: number;
    },
    meta?: ChamaOperationMeta,
  ): Promise<EscrowLockBundle> {
    const wallet = this.requireWallet();

    // Current browser/Fedi milestone: do not deduct ambient/dispute
    // policy fees from the reconstructed ecash token.
    // ─────────────────────────────────────────────────────────────────
    // The locker spends the full trade amount as one bearer ecash payload.
    // Splitting arbiter/platform proceeds requires a dedicated multi-party
    // payout path; subtracting here would make Fedi/ecash claims settle for
    // less than the user actually receives and recreate the old claim-modal
    // mismatch.
    //
    // Parked code below — if protocol-level fee splitting returns, restore
    // this only alongside the LockPayload field and actual payout fan-out.
    //
    // const platformFeeMsats = Math.floor((totalMsats * fees.platformFeeBps) / 10_000);
    // const sellerReceivesMsats = totalMsats - platformFeeMsats - fees.arbiterFeeMsats;
    //
    // 2-way split:
    const arbiterFeeMsats = fees.arbiterFeeMsats;
    const sellerReceivesMsats = totalMsats - arbiterFeeMsats;

    if (sellerReceivesMsats <= 0) {
      throw new Error("Arbiter fee exceeds total amount — seller would receive nothing");
    }
    void wallet; // presence check above; the composed calls re-require it

    // #37: composed from the two crash-safety-aware halves so every lock
    // spend gets the long try_cancel horizon. The BRIDGE calls the halves
    // directly (it stashes the notes between them); this composition stays
    // for tests/back-compat callers.
    const { oobNotes } = await this.spendNotesForLock(totalMsats, meta);
    return this.buildEscrowLockBundle(oobNotes, totalMsats, fees);
  }

  /**
   * #37 lock crash-safety, half 1: spend the lock amount and SURFACE the
   * raw OOB notes (+ operation id when the wallet provides one) so the
   * caller can persist them BEFORE the LOCK publish. Uses the 90-day
   * try_cancel horizon (LOCK_SPEND_TRY_CANCEL_SECS) — the SDK defaults are
   * shorter than a disputed trade's life and would hollow out the escrow.
   */
  async spendNotesForLock(
    totalMsats: number,
    meta?: ChamaOperationMeta,
    /** #37: invoked SYNCHRONOUSLY the moment the wallet's spend resolves —
     *  before any diagnostics await — so the caller can persist the bearer
     *  notes with a zero-await gap. A reload during the money-debug reads
     *  below must find the notes already stashed. */
    onSpent?: (oobNotes: string, operationId?: string) => void,
  ): Promise<{ oobNotes: string; operationId?: string }> {
    const wallet = this.requireWallet();
    // INVARIANT(mint-mutex): the Fund spend serializes on the cross-tab
    // mint lock (C12) — a boot-drain redeem or a second tab's spend
    // cannot overlap this spendNotes on the shared OPFS wallet. The
    // locked section calls the raw wallet only (no nesting).
    return withMintLock("fund-spend", async () => {
      // [$$] LOCK-IN — entering the spend. Diagnostics reads are gated on
      // mlogEnabled(): they are extra awaits in the window where the notes
      // exist only in memory, so they must not run for every user (F12).
      const debugMoney = mlogEnabled();
      let _lockBalBefore: number | undefined;
      if (debugMoney) {
        try { _lockBalBefore = await wallet.balance.getBalance(); } catch {}
        mlog("LOCK-IN", {
          fed: this._federationId,
          totalMsats,
          balanceBefore: _lockBalBefore,
        });
      }

      // Step 1: Spend the full amount as ecash notes. Prefer the detailed
      // spend (explicit long horizon + operation id); wallets that omit it
      // fall back to the plain spend (SDK-default horizon, no id).
      let oobNotes: string;
      let operationId: string | undefined;
      if (wallet.mint.spendNotesDetailed) {
        const detailed = await wallet.mint.spendNotesDetailed(
          totalMsats,
          { tryCancelAfterSecs: LOCK_SPEND_TRY_CANCEL_SECS },
          meta,
        );
        oobNotes = detailed.notes;
        operationId = detailed.operationId;
      } else {
        oobNotes = await wallet.mint.spendNotes(totalMsats, meta);
      }

      // Crash guard FIRST — synchronous, before any further await.
      onSpent?.(oobNotes, operationId);

      if (debugMoney) {
        // [$$] LOCK-SPEND — what spendNotes actually returned
        let _spentParsed: number | undefined;
        try {
          const _p = await wallet.mint.parseNotes(oobNotes);
          _spentParsed = _p.total_amount;
        } catch {}
        let _lockBalAfter: number | undefined;
        try { _lockBalAfter = await wallet.balance.getBalance(); } catch {}
        mlog("LOCK-SPEND", {
          fed: this._federationId,
          requestedMsats: totalMsats,
          oobNotesLen: oobNotes.length,
          operationId,
          parsedTotalMsats: _spentParsed,
          delta: _spentParsed !== undefined ? _spentParsed - totalMsats : undefined,
          balanceAfter: _lockBalAfter,
          balanceDelta: (_lockBalBefore !== undefined && _lockBalAfter !== undefined)
            ? _lockBalAfter - _lockBalBefore
            : undefined,
        });
      }

      return { oobNotes, operationId };
    });
  }

  /**
   * Generic OOB spend with an explicit try_cancel horizon (task #53 E1:
   * arbiter-premium notes ride this with a 14-day horizon so an absent
   * arbiter auto-refunds the payer). Serializes on the cross-tab mint
   * lock like every other mint op; wallets without the detailed spend
   * fall back to the plain spend (SDK-default horizon, no id).
   */
  async spendNotesWithHorizon(
    totalMsats: number,
    tryCancelAfterSecs: number,
    meta?: ChamaOperationMeta,
    includeInvite = false,
  ): Promise<{ oobNotes: string; operationId?: string }> {
    const wallet = this.requireWallet();
    return withMintLock("premium-spend", async () => {
      if (wallet.mint.spendNotesDetailed) {
        const detailed = await wallet.mint.spendNotesDetailed(
          totalMsats,
          { tryCancelAfterSecs, includeInvite },
          meta,
        );
        return { oobNotes: detailed.notes, operationId: detailed.operationId };
      }
      const oobNotes = await wallet.mint.spendNotes(totalMsats, meta, includeInvite);
      return { oobNotes };
    });
  }

  /**
   * #37 lock crash-safety, half 2: hash + SSS-split already-spent notes
   * into the lock bundle. Pure w.r.t. the wallet (no spend, no mint lock).
   * Unlike `createEscrowLockFromNotes` (the Fedi path) this does NOT
   * require the parsed note total to equal `totalMsats` exactly — the
   * browser SDK's spend can legitimately overpay by denomination, and the
   * bundle's fee fields intentionally carry the REQUESTED amounts, byte-
   * matching the pre-#37 behavior.
   */
  async buildEscrowLockBundle(
    oobNotes: string,
    totalMsats: number,
    fees: {
      arbiterFeeMsats: number;
    },
  ): Promise<EscrowLockBundle> {
    const arbiterFeeMsats = fees.arbiterFeeMsats;
    const sellerReceivesMsats = totalMsats - arbiterFeeMsats;
    if (sellerReceivesMsats <= 0) {
      throw new Error("Arbiter fee exceeds total amount — seller would receive nothing");
    }

    // Step 2: Hash the notes for verification
    const notesHash = await hashNotes(oobNotes);

    // Step 3: Split into 2-of-3 Shamir shares
    const notesBytes = new TextEncoder().encode(oobNotes);
    const shares = await shamirSplit(notesBytes, 3, 2);

    // [$$] LOCK-OUT — final breakdown leaving the bridge
    mlog("LOCK-OUT", {
      fed: this._federationId,
      notesHashPrefix: notesHash.slice(0, 16),
      sellerReceivesMsats,
      arbiterFeeMsats,
      totalMsats,
    });

    return {
      notesHash,
      shares,
      totalMsats,
      sellerReceivesMsats,
      arbiterFeeMsats,
    };
  }

  /**
   * Lock already-generated OOB ecash notes into 2-of-3 SSS escrow.
   *
   * Used by Fedi Mini-App flows where the Fedi host wallet generates
   * ecash directly via `window.fediInternal.generateEcash`. This avoids
   * the browser SDK Lightning receive path entirely, while keeping the
   * same hash + Shamir escrow format as the normal `spendNotes` path.
   */
  async createEscrowLockFromNotes(
    oobNotes: string,
    totalMsats: number,
    fees: {
      arbiterFeeMsats: number;
    },
    _meta?: ChamaOperationMeta,
  ): Promise<EscrowLockBundle> {
    const wallet = this.requireWallet();

    const arbiterFeeMsats = fees.arbiterFeeMsats;
    const sellerReceivesMsats = totalMsats - arbiterFeeMsats;

    if (sellerReceivesMsats <= 0) {
      throw new Error("Arbiter fee exceeds total amount — seller would receive nothing");
    }

    const parsed = await wallet.mint.parseNotes(oobNotes);
    if (parsed.total_amount !== totalMsats) {
      throw new Error(
        `Fedi wallet generated ${parsed.total_amount} msats, ` +
        `but this trade requires ${totalMsats} msats. No LOCK was published.`,
      );
    }
    // A Fedi-generated note can come from a different federation than the
    // trade room currently represents. Amount-only validation accepted that
    // shape and produced an escrow nobody in this room could redeem (the
    // 202-sat BLF note locked into a GBF trade). The bearer note is the money:
    // when its route is knowable, require an exact match before LOCK publish.
    if (
      parsed.federation_id
      && this._federationId
      && parsed.federation_id.toLowerCase() !== this._federationId.toLowerCase()
    ) {
      throw new Error(
        `This ecash belongs to federation ${parsed.federation_id.slice(0, 8)}…, ` +
        `but this trade is using ${this._federationId.slice(0, 8)}…. ` +
        "Choose the matching Chama in Fedi and generate the ecash again. No LOCK was published.",
      );
    }

    mlog("LOCK-EXTERNAL-IN", {
      fed: this._federationId,
      totalMsats,
      arbiterFeeMsats,
      sellerReceivesMsats,
      oobNotesLen: oobNotes.length,
      parsedTotalMsats: parsed.total_amount,
    });

    const notesHash = await hashNotes(oobNotes);
    const notesBytes = new TextEncoder().encode(oobNotes);
    const shares = await shamirSplit(notesBytes, 3, 2);

    mlog("LOCK-EXTERNAL-OUT", {
      fed: this._federationId,
      notesHashPrefix: notesHash.slice(0, 16),
      sellerReceivesMsats,
      arbiterFeeMsats,
      totalMsats,
    });

    return {
      notesHash,
      shares,
      totalMsats,
      sellerReceivesMsats,
      arbiterFeeMsats,
    };
  }

  /**
   * Reconstruct ecash from 2 SSS shares and redeem into wallet.
   *
   * This is what the winner calls after the escrow resolves:
   *   1. Collect their own share + one other matching voter's share
   *   2. Reconstruct the original ecash notes via Shamir combine
   *   3. Verify the hash matches the original LOCK event
   *   4. Redeem the ecash into their wallet
   *
   * Returns the verified notes hash for the CLAIM event.
   */
  /**
   * Reconstruct ecash from 2 SSS shares and verify the hash. Does NOT redeem.
   *
   * This is the *provable* half of the claim: given a matching hash, the
   * winner has demonstrated they can reconstruct the locked notes. The
   * CLAIM Nostr event can be published on the strength of this result
   * alone — federation redemption can follow asynchronously.
   *
   * Returns the verified notes hash (for the CLAIM event's
   * notesHashVerification field), the raw OOB notes (for redemption),
   * and the parsed amount (for display).
   */
  async reconstructAndVerify(
    share1: SSSShare,
    share2: SSSShare,
    expectedNotesHash: string
  ): Promise<{
    notesHash: string;
    oobNotes: string;
    amountMsats: number;
    federationId?: string;
    federationInvite?: string;
  }> {
    const wallet = this.requireWallet();

    // Step 1: Reconstruct from 2 shares
    const oobNotes = await shamirCombine(share1, share2);

    // Step 2: Verify hash
    const actualHash = await hashNotes(oobNotes);
    if (actualHash !== expectedNotesHash) {
      throw new Error(
        `Notes hash mismatch: expected ${expectedNotesHash.slice(0, 16)}…, ` +
        `got ${actualHash.slice(0, 16)}…. Shares may be corrupted.`
      );
    }

    // Step 3: Parse to verify amount
    const parsed = await wallet.mint.parseNotes(oobNotes);

    // [$$] CLAIM-RECON — reconstruction succeeded; report parsed amount
    mlog("CLAIM-RECON", {
      fed: this._federationId,
      expectedHashPrefix: expectedNotesHash.slice(0, 16),
      actualHashPrefix: actualHash.slice(0, 16),
      hashMatch: actualHash === expectedNotesHash,
      parsedTotalMsats: parsed.total_amount,
      oobNotesLen: oobNotes.length,
    });
    claimTrace("reconstruct-ok", {
      fed: this._federationId,
      hashPrefix: actualHash.slice(0, 16),
      parsedTotalMsats: parsed.total_amount,
    });

    return {
      notesHash: actualHash,
      oobNotes,
      amountMsats: parsed.total_amount,
      federationId: parsed.federation_id,
      federationInvite: parsed.federation_invite,
    };
  }

  /**
   * Redeem OOB ecash notes into the wallet with defensive retry.
   *
   * redeemEcash is NOT strictly idempotent — Fedimint rejects a second
   * submission of the same notes with a double-spend error. The real SDK
   * adapter handles "already reissued" by finding and watching the local
   * reissue operation. This generic fallback only treats older double-spend
   * wordings as already accepted.
   *
   * IMPORTANT: the error strings below are educated guesses based on
   * Fedimint's generic semantics. @fedimint/core does not document its
   * error taxonomy, so we match on substrings. If in production we
   * observe unknown error strings, expand this list. Worst case today:
   * an unknown transient bubbles up and the hook's balance watchdog
   * (v0.1.62) covers it — the user still gets correct UI feedback.
   *
   * @param oobNotes The OOB ecash string from reconstructAndVerify
   * @param maxAttempts Total attempts including the first. Default 3.
   */
  async redeemWithRetry(
    oobNotes: string,
    maxAttempts = 3,
    meta?: ChamaOperationMeta,
  ): Promise<void> {
    const wallet = this.requireWallet();
    // INVARIANT(mint-mutex): claim and boot-drain redeems serialize on
    // the cross-tab mint lock (C12), so a drain in one tab can't race a
    // Fund spend in another on the shared OPFS wallet. The locked body
    // calls the raw wallet only (no nesting).
    return withMintLock("claim-redeem", () =>
      this.redeemWithRetryLocked(wallet, oobNotes, maxAttempts, meta)
    );
  }

  /** Body of redeemWithRetry, run while holding the mint lock. */
  private async redeemWithRetryLocked(
    wallet: IFedimintWallet,
    oobNotes: string,
    maxAttempts: number,
    meta?: ChamaOperationMeta,
  ): Promise<void> {
    // [$$] REDEEM-IN — entering redeem with intended amount
    let _redeemAmount: number | undefined;
    try {
      const _p = await wallet.mint.parseNotes(oobNotes);
      _redeemAmount = _p.total_amount;
    } catch {}
    let _redeemBalBefore: number | undefined;
    try { _redeemBalBefore = await wallet.balance.getBalance(); } catch {}
    mlog("REDEEM-IN", {
      fed: this._federationId,
      amountMsats: _redeemAmount,
      oobNotesLen: oobNotes.length,
      balanceBefore: _redeemBalBefore,
    });
    claimTrace("redeem-in", {
      fed: this._federationId,
      amountMsats: _redeemAmount,
      balanceBefore: _redeemBalBefore,
    });

    let lastErr: unknown;
    // v3.5.1 claim-hang: bound each redeemEcash so a cross-fed / unreachable
    // redeem can't stall the in-progress claim forever. On timeout we throw
    // (handled in the catch below) so withMintLock releases and the
    // orchestrator can surface a retryable terminal — a held lock would
    // otherwise deadlock the user's "switch fed and retry".
    const REDEEM_ATTEMPT_TIMEOUT_MS = 30_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const operationId = await Promise.race([
          wallet.mint.redeemEcash(oobNotes, meta),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => {
              const err: Error & { code?: string } = new Error(
                `redeemEcash did not resolve within ${REDEEM_ATTEMPT_TIMEOUT_MS / 1000}s ` +
                  `(federation unreachable or wrong route). Your claim is published — your ` +
                  `sats are safe and the redeem will be retried.`,
              );
              err.code = "REDEEM_TIMEOUT";
              reject(err);
            }, REDEEM_ATTEMPT_TIMEOUT_MS);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
        // [$$] REDEEM-TRY — success path
        let _redeemBalAfter: number | undefined;
        try { _redeemBalAfter = await wallet.balance.getBalance(); } catch {}
        mlog("REDEEM-TRY", {
          fed: this._federationId,
          attempt,
          result: "success",
          operationId,
          balanceAfter: _redeemBalAfter,
        });
        claimTrace("redeem-try", {
          fed: this._federationId,
          attempt,
          result: "success",
          operationId,
          balanceAfter: _redeemBalAfter,
        });
        // [$$] REDEEM-OUT — final delta check
        mlog("REDEEM-OUT", {
          fed: this._federationId,
          expectedMsats: _redeemAmount,
          balanceBefore: _redeemBalBefore,
          balanceAfter: _redeemBalAfter,
          balanceDelta: (_redeemBalBefore !== undefined && _redeemBalAfter !== undefined)
            ? _redeemBalAfter - _redeemBalBefore
            : undefined,
          deltaMatchesExpected: (_redeemAmount !== undefined && _redeemBalBefore !== undefined && _redeemBalAfter !== undefined)
            ? (_redeemBalAfter - _redeemBalBefore) === _redeemAmount
            : undefined,
        });
        claimTrace("redeem-out", {
          fed: this._federationId,
          expectedMsats: _redeemAmount,
          balanceBefore: _redeemBalBefore,
          balanceAfter: _redeemBalAfter,
          balanceDelta: (_redeemBalBefore !== undefined && _redeemBalAfter !== undefined)
            ? _redeemBalAfter - _redeemBalBefore
            : undefined,
        });
        return;
      } catch (e) {
        lastErr = e;
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        const code = typeof (e as any)?.code === "string" ? (e as any).code : "";

        // v3.5.1 claim-hang: a redeem that overran REDEEM_ATTEMPT_TIMEOUT_MS
        // means the federation is unreachable or on the wrong route (e.g. a
        // cross-fed claim whose CREATE carried no `fed` tag, so the pre-redeem
        // fed-ID gate at escrow-bridge.ts couldn't catch it). Re-throw at once
        // so the mint lock releases and the orchestrator surfaces the
        // retryable claim-pending terminal; the op may still land in the
        // background, where boot-drain + the cover check reconcile it.
        // Retrying in-loop would only stack more stalled SDK calls.
        if (code === "REDEEM_TIMEOUT") {
          mlog("REDEEM-TRY", { fed: this._federationId, attempt, result: "timeout" });
          claimTrace("redeem-try", { fed: this._federationId, attempt, result: "timeout" });
          throw e;
        }

        // Already-accepted variants — the federation has consumed the
        // notes. That alone is NOT success: it proves SOMEONE redeemed
        // them, not that it was this wallet (C5 — the front-run hole:
        // if another party redeemed first, "already spent" here used to
        // clear the stash while the winner's wallet stayed empty).
        if (
          msg.includes("already spent") ||
          msg.includes("already redeemed") ||
          msg.includes("already used") ||
          msg.includes("double spend") ||
          msg.includes("double-spend") ||
          msg.includes("note already")
        ) {
          // INVARIANT(already-spent-verified): "already spent" is only
          // success once a credit to THIS wallet is confirmed via
          // balance delta. The real SDK adapter never lands here for a
          // self-credit — it resumes from local op history and returns
          // cleanly — so an unconfirmed delta is a strong front-run
          // signal. Unconfirmed ⇒ surface as needs-attention, never
          // silent success, never silent loss.
          const credit = await this.confirmAlreadySpentCredit(
            wallet,
            _redeemAmount,
            _redeemBalBefore,
          );
          if (!credit.confirmed) {
            mlog("REDEEM-TRY", {
              fed: this._federationId,
              attempt,
              result: "already-spent-unconfirmed",
              expectedMsats: _redeemAmount,
              balanceBefore: _redeemBalBefore,
              balanceAfter: credit.balanceAfter,
              errMsg: msg.slice(0, 80),
            });
            claimTrace("redeem-try", {
              fed: this._federationId,
              attempt,
              result: "already-spent-unconfirmed",
              errMsg: msg.slice(0, 80),
            });
            mlog("REDEEM-OUT", {
              fed: this._federationId,
              expectedMsats: _redeemAmount,
              balanceBefore: _redeemBalBefore,
              balanceAfter: credit.balanceAfter,
              note: "already-spent-no-confirmed-credit",
            });
            const unconfirmed: Error & { code?: string; cause?: unknown } = new Error(
              "The federation reports these escrow notes were redeemed, but no matching " +
              "credit to this wallet could be confirmed. Don't assume the sats arrived — " +
              "the notes stay stashed and this claim needs attention."
            );
            unconfirmed.code = "ALREADY_SPENT_UNCONFIRMED";
            unconfirmed.cause = e;
            throw unconfirmed;
          }
          console.debug(
            `[chama] redeem attempt ${attempt}: notes already accepted by federation, wallet credit confirmed (+${_redeemAmount} msats)`
          );
          // [$$] REDEEM-TRY — already-spent treated as success
          mlog("REDEEM-TRY", {
            fed: this._federationId,
            attempt,
            result: "already-accepted",
            errMsg: msg.slice(0, 80),
          });
          claimTrace("redeem-try", {
            fed: this._federationId,
            attempt,
            result: "already-accepted",
            errMsg: msg.slice(0, 80),
          });
          // [$$] REDEEM-OUT — exit on already-accepted
          let _bAft: number | undefined;
          try { _bAft = await wallet.balance.getBalance(); } catch {}
          mlog("REDEEM-OUT", {
            fed: this._federationId,
            expectedMsats: _redeemAmount,
            balanceBefore: _redeemBalBefore,
            balanceAfter: _bAft,
            note: "already-accepted-path",
          });
          claimTrace("redeem-out", {
            fed: this._federationId,
            expectedMsats: _redeemAmount,
            balanceBefore: _redeemBalBefore,
            balanceAfter: _bAft,
            note: "already-accepted-path",
          });
          return;
        }

        // Hard failures — surface immediately, don't retry.
        if (
          code === "MINT_REISSUE_FAILED" ||
          code === "MINT_REISSUE_UNKNOWN" ||
          msg.includes("malformed") ||
          msg.includes("invalid federation") ||
          msg.includes("not joined") ||
          msg.includes("parse error") ||
          msg.includes("invalid note format") ||
          msg.includes("mint reissue operation failed") ||
          msg.includes("mint notes were consumed")
        ) {
          // [$$] REDEEM-TRY — hard failure
          mlog("REDEEM-TRY", {
            fed: this._federationId,
            attempt,
            result: "hard-fail",
            errMsg: msg.slice(0, 120),
          });
          claimTrace("redeem-try", {
            fed: this._federationId,
            attempt,
            result: "hard-fail",
            errMsg: msg.slice(0, 120),
          });
          // [$$] REDEEM-OUT — exit on hard fail (no balance change expected)
          mlog("REDEEM-OUT", {
            fed: this._federationId,
            expectedMsats: _redeemAmount,
            balanceBefore: _redeemBalBefore,
            note: "hard-fail-no-credit",
          });
          throw e;
        }

        // Transient — back off and retry.
        // [$$] REDEEM-TRY — transient
        mlog("REDEEM-TRY", {
          fed: this._federationId,
          attempt,
          result: "transient",
          errMsg: msg.slice(0, 120),
          willRetry: attempt < maxAttempts,
        });
        claimTrace("redeem-try", {
          fed: this._federationId,
          attempt,
          result: "transient",
          errMsg: msg.slice(0, 120),
          willRetry: attempt < maxAttempts,
        });
        // Backoff schedule: ~500ms, ~1500ms, ~3500ms with jitter.
        if (attempt < maxAttempts) {
          const delay = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
          console.warn(
            `[chama] redeem attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms:`,
            msg
          );
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // [$$] REDEEM-OUT — exhausted retries, final fail
    mlog("REDEEM-OUT", {
      fed: this._federationId,
      expectedMsats: _redeemAmount,
      balanceBefore: _redeemBalBefore,
      note: "all-retries-failed",
    });
    claimTrace("redeem-out", {
      fed: this._federationId,
      expectedMsats: _redeemAmount,
      balanceBefore: _redeemBalBefore,
      note: "all-retries-failed",
    });
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`redeemEcash failed after ${maxAttempts} attempts`);
  }

  /**
   * C5 (v3.4.0): confirm that an "already spent" redeem actually
   * credited THIS wallet, by polling for a balance delta of at least
   * the parsed note amount relative to the balance captured at
   * redeemWithRetry entry.
   *
   * Under the mint mutex (C12) no other mint op moves this wallet's
   * balance concurrently, so `delta >= expected` is a sound credit
   * signal for mint traffic. Lightning receives are NOT under the mint
   * lock, so one accepted residual risk remains: an unrelated LN
   * receive of >= the claim amount landing inside this poll window
   * would false-confirm a front-run — success is reported and the
   * stash entry is cleared with no alarm. That window is bounded by
   * alreadySpentConfirmTimeoutMs (default 10s) from a baseline taken
   * at redeem entry, and the real SDK adapter never reaches this
   * branch for a self-credit (it resumes from local op history), so
   * the coincidence-of-amount-and-timing is judged acceptably rare.
   * Do NOT widen this window without revisiting that trade-off.
   *
   * Returns confirmed=false when the entry balance or the parsed
   * amount was unreadable — "can't confirm" must surface, not pass.
   */
  private async confirmAlreadySpentCredit(
    wallet: IFedimintWallet,
    expectedMsats: number | undefined,
    balanceBefore: number | undefined,
  ): Promise<{ confirmed: boolean; balanceAfter?: number }> {
    if (expectedMsats === undefined || balanceBefore === undefined) {
      return { confirmed: false };
    }
    const timeoutMs = Math.max(0, this.alreadySpentConfirmTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const pollMs = Math.min(1_500, Math.max(25, Math.floor(timeoutMs / 5)));
    let balanceAfter: number | undefined;
    for (;;) {
      try {
        balanceAfter = await wallet.balance.getBalance();
        if (balanceAfter - balanceBefore >= expectedMsats) {
          return { confirmed: true, balanceAfter };
        }
      } catch {
        // Balance unreadable right now — keep polling until deadline;
        // an unreadable balance can never confirm a credit.
      }
      if (Date.now() >= deadline) return { confirmed: false, balanceAfter };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * @deprecated Prefer reconstructAndVerify + redeemWithRetry so callers
   * can publish the CLAIM Nostr event between the two phases. Kept as a
   * thin delegator for any callers that haven't been updated.
   */
  async claimEscrow(
    share1: SSSShare,
    share2: SSSShare,
    expectedNotesHash: string
  ): Promise<{ notesHash: string; amountMsats: number }> {
    const { notesHash, oobNotes, amountMsats } = await this.reconstructAndVerify(
      share1, share2, expectedNotesHash
    );
    await this.redeemWithRetry(oobNotes);
    return { notesHash, amountMsats };
  }

}

// ══════════════════════════════════════════════════════════════════════════
// CRYPTO HELPERS — Hashing and Shamir operations
// ══════════════════════════════════════════════════════════════════════════

/**
 * SHA-256 hash of ecash notes string.
 *
 * v0.1.66.34: uses Web Crypto API (crypto.subtle), which is available
 * in every environment this app runs in: modern browsers, Node 19+
 * (global crypto.subtle), and WebView in Capacitor. The previous
 * `await import("crypto")` Node fallback was getting externalized
 * by Vite into the browser bundle as a no-op, so if the top check
 * ever missed, hashNotes would silently return garbage. Now throws
 * explicitly — unreachable in practice, but fails loud if wrong.
 */
export async function hashNotes(oobNotes: string): Promise<string> {
  const data = new TextEncoder().encode(oobNotes);

  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "Web Crypto API (crypto.subtle) is required for hashNotes but is unavailable in this environment",
    );
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Split bytes into N shares with threshold T using Shamir Secret Sharing.
 *
 * Uses the `shamir-secret-sharing` npm package (same one used in
 * Chama production — tested and proven).
 */
async function shamirSplit(secret: Uint8Array, n: number, t: number): Promise<SSSShare[]> {
  // Dynamic import to keep the dependency lazy
  const { split } = await import("shamir-secret-sharing");

  const rawShares = await split(secret, n, t);

  return rawShares.map((shareBytes: Uint8Array, index: number) => ({
    index,
    data: uint8ToBase64(shareBytes),
  }));
}

/**
 * Combine 2 SSS shares to reconstruct the original secret.
 * Returns the reconstructed ecash notes string.
 */
async function shamirCombine(share1: SSSShare, share2: SSSShare): Promise<string> {
  const { combine } = await import("shamir-secret-sharing");

  const bytes1 = base64ToUint8(share1.data);
  const bytes2 = base64ToUint8(share2.data);

  const reconstructed = await combine([bytes1, bytes2]);
  return new TextDecoder().decode(reconstructed);
}

// ── Base64 helpers ────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "undefined") {
    // Browser
    const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join("");
    return btoa(binary);
  }
  // Node.js
  return Buffer.from(bytes).toString("base64");
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof atob !== "undefined") {
    // Browser
    const binary = atob(b64);
    return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
  }
  // Node.js
  return new Uint8Array(Buffer.from(b64, "base64"));
}
