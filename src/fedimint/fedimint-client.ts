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

/**
 * Fedimint wallet instance — mirrors @fedimint/core FedimintWallet API.
 * We define our own interface to decouple from the SDK version and
 * enable testing with mocks.
 */
export interface IFedimintWallet {
  open(): Promise<void>;
  isOpen(): boolean;
  joinFederation(inviteCode: string): Promise<void>;
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
    spendNotes(amountMsats: number): Promise<string>;
    /** Redeem OOB ecash notes into wallet */
    redeemEcash(oobNotes: string): Promise<void>;
    /** Parse OOB notes to inspect amount without redeeming */
    parseNotes(oobNotes: string): Promise<{ total_amount: number }>;
  };

  lightning: {
    /** Create a Lightning invoice to receive sats into the federation */
    createInvoice(amountMsats: number, description: string): Promise<{ invoice: string; operationId: string }>;
    /** Pay a Lightning invoice from federation balance */
    payInvoice(bolt11: string): Promise<{ operationId: string }>;
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
}

export interface FedimintInitOptions {
  /** BIP-39 mnemonic words, if a deterministic seed should be installed */
  mnemonic?: string[];
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
    // ?testnet=1 → swap in the in-memory mock wallet. Dev/CI only.
    const { isTestnetMode, createMockWallet } = await import("./mock-wallet.js");
    if (isTestnetMode()) {
      console.info("[chama] ⚠ testnet=1 — using mock Fedimint wallet");
      return createMockWallet();
    }

    // Dynamic import of the adapter keeps WASM out of the initial bundle.
    // The adapter maps @fedimint/core 0.1.x onto our IFedimintWallet shape.
    const { createRealWallet } = await import("./sdk-adapter.js");
    return createRealWallet({ mnemonic: opts.mnemonic });
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
      this.wallet = await this.walletFactory({ mnemonic: opts.mnemonic });

      // Try to open an existing client in the DB. On a fresh OPFS file
      // (e.g. after filename rotation or a first-ever launch) there is
      // no client yet and the SDK throws "client is not initialized for
      // this database" — that's not a real error, it just means we
      // haven't joined a federation on this DB yet. We'll open it
      // implicitly when joinFederation() runs.
      try {
        await this.wallet.open();
      } catch (openErr) {
        const msg = typeof openErr === "string" ? openErr : (openErr as Error)?.message || "";
        if (/client is not initialized|not initialized for this database|no such client/i.test(msg)) {
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
      await this.wallet.cleanup();
      this.wallet = null;
    }
  }

  private requireWallet(): IFedimintWallet {
    if (!this.wallet) throw new Error("FedimintClient not initialized — call init() first");
    return this.wallet;
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

      // (b) Re-open case: wallet is open from a previous session but
      // we haven't called joinFederation yet this session. Record the
      // invite and return the existing federation ID. This is the
      // common happy-path-after-reload flow; the user simply re-joined
      // the same federation their OPFS already holds.
      if (this._joinedInvite === null) {
        this._joinedInvite = inviteCode.trim();
        return currentId;
      }

      // (a) Same-session idempotent re-join. Trim-compare to be
      // defensive about whitespace that sometimes sneaks in from
      // clipboard paste.
      if (this._joinedInvite.trim() === inviteCode.trim()) {
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

  /** Check if the wallet is connected to a federation */
  isJoined(): boolean {
    return this.wallet?.isOpen() ?? false;
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
    return this.requireWallet().balance.getBalance();
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
  async spendNotes(amountMsats: number): Promise<string> {
    const wallet = this.requireWallet();
    return wallet.mint.spendNotes(amountMsats);
  }

  /**
   * Redeem ecash notes into the wallet balance.
   * Used by the escrow winner after reconstructing from SSS shares.
   */
  async redeemEcash(oobNotes: string): Promise<void> {
    const wallet = this.requireWallet();
    await wallet.mint.redeemEcash(oobNotes);
  }

  /**
   * Parse ecash notes to inspect the amount without redeeming.
   * Useful for verification before claiming.
   */
  async parseNotes(oobNotes: string): Promise<{ totalAmount: number }> {
    const wallet = this.requireWallet();
    const parsed = await wallet.mint.parseNotes(oobNotes);
    return { totalAmount: parsed.total_amount };
  }

  // v0.1.72 federation gates ─────────────────────────────────────────────
  /**
   * Probe the wallet's current federation by spending 1 sat as ecash,
   * extracting the federation-identifying prefix from the OOB notes
   * string, and immediately redeeming the probe back. Net zero
   * movement, ~1-second round trip, invisible to the user.
   *
   * The first ~10 chars of any OOB ecash notes string is a stable
   * federation identifier — the VPS federated-escrow project mapped
   * known prefixes:
   *   AwEEiItw7A — Bitcoin Life Federation
   *   AwEEG8tk5g — Global Bitcoin Federation
   *   AwEE_yhqbg — Afribit Kibera
   *
   * Used by:
   *   - escrow-client.createEscrow  — captures locker's fed at create
   *   - escrow-client.joinEscrow    — refuses to join wrong federation
   *   - escrow-bridge.lockAndPublish — verifies notes match the create
   *   - escrow-bridge.claimAndRedeem — verifies redeemer is on the
   *                                    federation that minted the notes
   *
   * Throws if the wallet isn't joined or if the federation rejects
   * the probe (likely a connectivity issue).
   */
  async probeFederation(): Promise<{ prefix: string; fed: string | null }> {
    const wallet = this.requireWallet();
    const PROBE_MSATS = 1000; // 1 sat — smallest meaningful probe

    let probeNotes: string;
    try {
      probeNotes = await wallet.mint.spendNotes(PROBE_MSATS);
    } catch (e) {
      mlog("FED-PROBE", {
        fed: this._federationId,
        result: "spend-failed",
        errMsg: (e instanceof Error ? e.message : String(e)).slice(0, 120),
      });
      throw new Error(
        "Federation probe failed (couldn't generate ecash). " +
        "Your wallet may be disconnected or the federation may be unreachable. " +
        "Try again in a moment."
      );
    }

    if (!probeNotes || probeNotes.length < 10) {
      // Try to refund what we got (best-effort) before throwing
      try { await wallet.mint.redeemEcash(probeNotes); } catch {}
      mlog("FED-PROBE", {
        fed: this._federationId,
        result: "short-notes",
        oobNotesLen: probeNotes?.length ?? 0,
      });
      throw new Error("Federation probe returned malformed notes — try again.");
    }

    const prefix = probeNotes.slice(0, 10);

    // Refund the probe immediately. Net zero movement.
    try {
      await wallet.mint.redeemEcash(probeNotes);
    } catch (refundErr) {
      // The probe sat may take a moment to come back via the balance
      // subscriber, but the prefix we captured is still correct. Log
      // and continue — we don't want to fail the whole flow over a
      // 1-sat refund hiccup.
      console.warn(
        "[chama] FED-PROBE: 1-sat probe refund failed (will arrive via balance subscriber):",
        refundErr instanceof Error ? refundErr.message : refundErr
      );
    }

    mlog("FED-PROBE", {
      fed: this._federationId,
      prefix,
      result: "ok",
    });

    return { prefix, fed: this._federationId };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIGHTNING — Funding the wallet
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a Lightning invoice to fund the wallet.
   * The user pays this invoice from any Lightning wallet.
   */
  async createInvoice(amountMsats: number, description: string): Promise<string> {
    const wallet = this.requireWallet();
    const result = await wallet.lightning.createInvoice(amountMsats, description);
    return result.invoice;
  }

  /**
   * Pay a Lightning invoice from the federation balance.
   * Used for outbound payments.
   */
  async payInvoice(bolt11: string): Promise<void> {
    const wallet = this.requireWallet();
    await wallet.lightning.payInvoice(bolt11);
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
    }
  ): Promise<EscrowLockBundle> {
    const wallet = this.requireWallet();

    // v0.1.71: platform fee no longer deducted from lock.
    // ─────────────────────────────────────────────────────────────────
    // The locker spends only what's owed to participants (seller +
    // arbiter). The 0.5% platform fee is collected separately via
    // Lightning at trade completion (see fee-collector.ts in v0.1.72+).
    //
    // Parked code below — uncomment if LN-only fee collection ever needs
    // to be reverted to protocol-level enforcement. The state machine's
    // legacy sum check accepts either shape, so a future re-enable just
    // means restoring this code, the LockPayload field, and the share-3
    // encryption path in escrow-bridge.ts.
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

    // [$$] LOCK-IN — entering the spend
    let _lockBalBefore: number | undefined;
    try { _lockBalBefore = await wallet.balance.getBalance(); } catch {}
    mlog("LOCK-IN", {
      fed: this._federationId,
      totalMsats,
      arbiterFeeMsats,
      sellerReceivesMsats,
      balanceBefore: _lockBalBefore,
    });

    // Step 1: Spend the full amount as ecash notes
    const oobNotes = await wallet.mint.spendNotes(totalMsats);

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
      parsedTotalMsats: _spentParsed,
      delta: _spentParsed !== undefined ? _spentParsed - totalMsats : undefined,
      balanceAfter: _lockBalAfter,
      balanceDelta: (_lockBalBefore !== undefined && _lockBalAfter !== undefined)
        ? _lockBalAfter - _lockBalBefore
        : undefined,
    });

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
  ): Promise<{ notesHash: string; oobNotes: string; amountMsats: number }> {
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

    return {
      notesHash: actualHash,
      oobNotes,
      amountMsats: parsed.total_amount,
    };
  }

  /**
   * Redeem OOB ecash notes into the wallet with defensive retry.
   *
   * redeemEcash is NOT strictly idempotent — Fedimint rejects a second
   * submission of the same notes with a double-spend error. We treat
   * that rejection as *success*: the federation accepted the notes on
   * a prior attempt, and the balance stream will catch up.
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
  async redeemWithRetry(oobNotes: string, maxAttempts = 3): Promise<void> {
    const wallet = this.requireWallet();

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

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await wallet.mint.redeemEcash(oobNotes);
        // [$$] REDEEM-TRY — success path
        let _redeemBalAfter: number | undefined;
        try { _redeemBalAfter = await wallet.balance.getBalance(); } catch {}
        mlog("REDEEM-TRY", {
          fed: this._federationId,
          attempt,
          result: "success",
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
        return;
      } catch (e) {
        lastErr = e;
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();

        // Already-accepted variants — federation has the notes, balance
        // will reflect shortly. Treat as success.
        if (
          msg.includes("already spent") ||
          msg.includes("already redeemed") ||
          msg.includes("already used") ||
          msg.includes("double spend") ||
          msg.includes("double-spend") ||
          msg.includes("note already")
        ) {
          console.debug(
            `[chama] redeem attempt ${attempt}: notes already accepted by federation, treating as success`
          );
          // [$$] REDEEM-TRY — already-spent treated as success
          mlog("REDEEM-TRY", {
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
          return;
        }

        // Hard failures — surface immediately, don't retry.
        if (
          msg.includes("malformed") ||
          msg.includes("invalid federation") ||
          msg.includes("not joined") ||
          msg.includes("parse error") ||
          msg.includes("invalid note format")
        ) {
          // [$$] REDEEM-TRY — hard failure
          mlog("REDEEM-TRY", {
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
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`redeemEcash failed after ${maxAttempts} attempts`);
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

  /**
   * Verify that 2 shares can reconstruct notes matching a hash,
   * WITHOUT redeeming them. Used for pre-claim verification.
   */
  async verifyShares(
    share1: SSSShare,
    share2: SSSShare,
    expectedNotesHash: string
  ): Promise<{ valid: boolean; amountMsats?: number; error?: string }> {
    try {
      const oobNotes = await shamirCombine(share1, share2);
      const actualHash = await hashNotes(oobNotes);

      if (actualHash !== expectedNotesHash) {
        return { valid: false, error: "Hash mismatch — shares may be corrupted" };
      }

      const wallet = this.requireWallet();
      const parsed = await wallet.mint.parseNotes(oobNotes);
      return { valid: true, amountMsats: parsed.total_amount };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
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
async function hashNotes(oobNotes: string): Promise<string> {
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
