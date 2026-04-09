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
  /** Amount breakdown */
  totalMsats: number;
  sellerReceivesMsats: number;
  arbiterFeeMsats: number;
  platformFeeMsats: number;
}

// ── Callback interface ────────────────────────────────────────────────────

export interface FedimintClientCallbacks {
  onBalanceUpdate?: (balance: number) => void;
  onFederationJoined?: (federationId: string) => void;
  onError?: (error: Error, context: string) => void;
}

// ══════════════════════════════════════════════════════════════════════════
// FEDIMINT CLIENT — High-level escrow-focused ecash operations
// ══════════════════════════════════════════════════════════════════════════

export class FedimintClient {
  private wallet: IFedimintWallet | null = null;
  private callbacks: FedimintClientCallbacks;
  private balanceUnsubscribe: (() => void) | null = null;
  private _federationId: string | null = null;

  /**
   * Factory function to create the actual wallet instance.
   * Injected to allow testing with mocks and to defer the heavy
   * WASM import until it's actually needed.
   *
   * Default (production): uses @fedimint/core + @fedimint/transport-web
   */
  private walletFactory: () => Promise<IFedimintWallet>;

  constructor(
    callbacks: FedimintClientCallbacks = {},
    walletFactory?: () => Promise<IFedimintWallet>
  ) {
    this.callbacks = callbacks;
    this.walletFactory = walletFactory || FedimintClient.defaultWalletFactory;
  }

  // ── Default factory — lazy-loads the WASM SDK ───────────────────────────

  private static async defaultWalletFactory(): Promise<IFedimintWallet> {
    // Dynamic import of the adapter keeps WASM out of the initial bundle.
    // The adapter maps @fedimint/core 0.1.x onto our IFedimintWallet shape.
    const { createRealWallet } = await import("./sdk-adapter.js");
    return createRealWallet();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize the WASM wallet. Call once at app startup.
   * If the user has previously joined a federation, it reopens automatically.
   */
  async init(): Promise<void> {
    try {
      this.wallet = await this.walletFactory();
      await this.wallet.open();

      // Subscribe to balance updates
      this.balanceUnsubscribe = this.wallet.balance.subscribeBalance((balance) => {
        this.callbacks.onBalanceUpdate?.(balance);
      });

      if (this.wallet.isOpen()) {
        this._federationId = await this.wallet.federation.getFederationId();
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

    if (wallet.isOpen()) {
      // Already joined — return current federation ID
      return this._federationId || await wallet.federation.getFederationId();
    }

    await wallet.joinFederation(inviteCode);
    this._federationId = await wallet.federation.getFederationId();
    this.callbacks.onFederationJoined?.(this._federationId);
    return this._federationId;
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
      platformFeeBps: number;
      arbiterFeeMsats: number;
    }
  ): Promise<EscrowLockBundle> {
    const wallet = this.requireWallet();

    // Calculate fee breakdown
    const platformFeeMsats = Math.floor((totalMsats * fees.platformFeeBps) / 10_000);
    const arbiterFeeMsats = fees.arbiterFeeMsats;
    const sellerReceivesMsats = totalMsats - platformFeeMsats - arbiterFeeMsats;

    if (sellerReceivesMsats <= 0) {
      throw new Error("Fees exceed total amount — seller would receive nothing");
    }

    // Step 1: Spend the full amount as ecash notes
    const oobNotes = await wallet.mint.spendNotes(totalMsats);

    // Step 2: Hash the notes for verification
    const notesHash = await hashNotes(oobNotes);

    // Step 3: Split into 2-of-3 Shamir shares
    const notesBytes = new TextEncoder().encode(oobNotes);
    const shares = await shamirSplit(notesBytes, 3, 2);

    return {
      notesHash,
      shares,
      totalMsats,
      sellerReceivesMsats,
      arbiterFeeMsats,
      platformFeeMsats,
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
  async claimEscrow(
    share1: SSSShare,
    share2: SSSShare,
    expectedNotesHash: string
  ): Promise<{ notesHash: string; amountMsats: number }> {
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

    // Step 4: Redeem into wallet
    await wallet.mint.redeemEcash(oobNotes);

    return {
      notesHash: actualHash,
      amountMsats: parsed.total_amount,
    };
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
 * Uses Web Crypto API (available in all modern browsers).
 */
async function hashNotes(oobNotes: string): Promise<string> {
  const data = new TextEncoder().encode(oobNotes);

  // Use Web Crypto API (browser-native, no dependencies)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Node.js fallback
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
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
