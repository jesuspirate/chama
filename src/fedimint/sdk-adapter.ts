// ══════════════════════════════════════════════════════════════════════════
// Chama — @fedimint/core SDK Adapter
// ══════════════════════════════════════════════════════════════════════════
//
// Adapts the real @fedimint/core 0.1.x FedimintWallet class to Chama's
// internal IFedimintWallet interface (defined in fedimint-client.ts).
//
// The high-level FedimintClient + EscrowFedimintBridge are written
// against IFedimintWallet. This adapter is what actually runs in the
// browser — it wraps a real WASM-backed FedimintWallet and maps its
// slightly different method shapes onto the shape our code expects.
//
// Notable API deltas handled here:
//   - mint.spendNotes returns { notes, operation_id }  → unwrap .notes
//   - mint.parseNotes returns number (msats)           → wrap as { total_amount }
//   - federation.getInviteCode returns string | null   → throw if null
//   - joinFederation returns boolean                   → unwrap
//   - subscribeBalance(onSuccess, onError) => CancelFn → one-arg wrapper
//
// No change to the FedimintClient public API. Swap the factory and go.

import type { IFedimintWallet } from "./fedimint-client.js";

// ── Minimal structural types for the real SDK ────────────────────────────
// We define these locally so that a consumer without @fedimint/core
// installed (e.g. running unit tests) can still typecheck the file.

interface RealBalanceService {
  getBalance(): Promise<number>;
  subscribeBalance(
    onSuccess?: (balanceMsats: number) => void,
    onError?: (err: string) => void
  ): () => void;
}

interface RealMintService {
  spendNotes(
    amountMsats: number
  ): Promise<{ notes: string; operation_id: string }>;
  redeemEcash(notes: string): Promise<string>;
  parseNotes(oobNotes: string): Promise<number>;
}

interface RealLightningService {
  createInvoice(
    amountMsats: number,
    description: string,
    expiryTime?: number
  ): Promise<{ invoice: string; operation_id: string }>;
  payInvoice(invoice: string): Promise<unknown>;
}

interface RealFederationService {
  getFederationId(): Promise<string>;
  getInviteCode(peer?: number): Promise<string | null>;
}

export interface RealFedimintWallet {
  balance: RealBalanceService;
  mint: RealMintService;
  lightning: RealLightningService;
  federation: RealFederationService;
  open(clientName?: string): Promise<boolean>;
  joinFederation(inviteCode: string, clientName?: string): Promise<boolean>;
  cleanup(): Promise<void>;
  isOpen(): boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// ADAPTER
// ══════════════════════════════════════════════════════════════════════════

export function adaptRealWallet(real: RealFedimintWallet): IFedimintWallet {
  return {
    async open() {
      await real.open();
    },

    isOpen() {
      return real.isOpen();
    },

    async joinFederation(inviteCode: string) {
      await real.joinFederation(inviteCode);
    },

    balance: {
      getBalance() {
        return real.balance.getBalance();
      },
      subscribeBalance(callback: (balance: number) => void) {
        return real.balance.subscribeBalance(callback);
      },
    },

    mint: {
      async spendNotes(amountMsats: number) {
        const result = await real.mint.spendNotes(amountMsats);
        return result.notes;
      },
      async redeemEcash(oobNotes: string) {
        await real.mint.redeemEcash(oobNotes);
      },
      async parseNotes(oobNotes: string) {
        const total = await real.mint.parseNotes(oobNotes);
        return { total_amount: total };
      },
    },

    lightning: {
      async createInvoice(amountMsats: number, description: string) {
        const result = await real.lightning.createInvoice(
          amountMsats,
          description
        );
        return {
          invoice: result.invoice,
          operationId: result.operation_id,
        };
      },
      async payInvoice(bolt11: string) {
        await real.lightning.payInvoice(bolt11);
        return { operationId: "" };
      },
    },

    federation: {
      getFederationId() {
        return real.federation.getFederationId();
      },
      async getInviteCode() {
        const code = await real.federation.getInviteCode();
        if (!code) {
          throw new Error(
            "Federation invite code unavailable — wallet may not be joined yet"
          );
        }
        return code;
      },
    },

    async cleanup() {
      await real.cleanup();
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// LOCAL WALLET RESET
//
// Wipes the Fedimint WASM wallet's IndexedDB so the next init() can install
// a fresh seed. This is the "get me out of the No modification allowed
// jail" escape hatch — safe to call whenever the user has no unspent ecash
// on this device (e.g. they haven't joined a federation yet, or they've
// already moved funds out).
//
// The database name `fedimint.db` is the one used by @fedimint/transport-web
// 0.1.x (grep `worker.js`). If a future SDK version changes this, update
// DB_NAME here.
// ══════════════════════════════════════════════════════════════════════════

/** IndexedDB database name used by @fedimint/transport-web */
const FEDIMINT_DB_NAME = "fedimint.db";

/**
 * Delete the local Fedimint wallet state (IndexedDB + any in-memory caches).
 *
 * This is destructive to *local* wallet state only. The Nostr-backed seed
 * stays intact on relays, so after a reset the next init() will reinstall
 * the same mnemonic and re-derive identical keys — any ecash that lives
 * inside an already-joined federation is recoverable by rejoining, and
 * any pending Lightning/mint operations that hadn't settled are lost.
 *
 * Returns once the database delete has resolved. Throws on blocked deletes
 * (e.g. another tab has the DB open) so the UI can surface the problem.
 */
export async function resetLocalFedimintWallet(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable in this environment");
  }

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(FEDIMINT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(
        new Error(
          `Failed to delete ${FEDIMINT_DB_NAME}: ${req.error?.message ?? "unknown"}`
        )
      );
    req.onblocked = () =>
      reject(
        new Error(
          `Reset blocked: another tab has the Fedimint wallet open. ` +
          `Close other Chama tabs and try again.`
        )
      );
  });

  console.info("[chama] Local Fedimint wallet IndexedDB deleted");
}

// ══════════════════════════════════════════════════════════════════════════
// FACTORY — Used by FedimintClient.defaultWalletFactory in production.
//
// Dynamically imports @fedimint/core and @fedimint/transport-web so that
// the heavy WASM bundle is only loaded when the user actually needs ecash
// operations. Unit tests can still run without the SDK installed.
// ══════════════════════════════════════════════════════════════════════════

export interface CreateRealWalletOptions {
  /**
   * Optional BIP-39 mnemonic (as a word array) to seed the wallet with.
   * If omitted, the director will generate a fresh mnemonic via
   * `generateMnemonic()`. Chama supplies this from the Nostr-backed
   * seed-manager so the wallet is deterministic across devices.
   */
  mnemonic?: string[];
}

export async function createRealWallet(
  opts: CreateRealWalletOptions = {}
): Promise<IFedimintWallet> {
  const { WalletDirector } = await import("@fedimint/core");
  const { WasmWorkerTransport } = await import("@fedimint/transport-web");

  const director = new WalletDirector(new WasmWorkerTransport());
  await director.initialize();

  // Install the seed BEFORE creating the wallet so the wallet's derived
  // keys come from our Nostr-backed mnemonic rather than a fresh random.
  //
  // The WASM wallet persists its seed in an IndexedDB database named
  // "fedimint.db". If a previous Chama session already wrote a seed
  // there, setMnemonic() will throw a "No modification allowed" error —
  // the Rust SDK refuses to overwrite an existing seed because doing so
  // would orphan any ecash associated with the old seed. We handle
  // three cases:
  //
  //   1. No existing seed  → install ours.
  //   2. Existing seed matches ours  → no-op, proceed.
  //   3. Existing seed differs  → throw an actionable error asking the
  //      user to reset their local wallet (which we also provide a
  //      one-click button for in the UI).
  const directorTyped = director as unknown as {
    setMnemonic(words: string[]): Promise<boolean>;
    getMnemonic(): Promise<string[]>;
    generateMnemonic(): Promise<string[]>;
  };

  if (opts.mnemonic && opts.mnemonic.length > 0) {
    let existing: string[] | null = null;
    try {
      existing = await directorTyped.getMnemonic();
    } catch {
      // getMnemonic throws when no seed is set yet — that's fine
      existing = null;
    }

    if (existing && existing.length > 0) {
      // Compare word-by-word. Arrays from the SDK are canonical lowercase.
      const sameLength = existing.length === opts.mnemonic.length;
      const allMatch = sameLength && existing.every(
        (w, i) => w.toLowerCase().trim() === opts.mnemonic![i].toLowerCase().trim()
      );

      if (!allMatch) {
        throw new Error(
          "Local Fedimint wallet has a different seed than your Nostr-backed " +
          "seed. Click 'Reset local wallet' in the Fedimint bar to clear the " +
          "stale local state and restore from Nostr. " +
          "(This is safe if you haven't yet joined a federation on this device.)"
        );
      }
      // Same seed already installed — nothing to do
      console.info("[chama] Fedimint seed already matches Nostr backup — reusing");
    } else {
      // No existing seed → install ours
      await directorTyped.setMnemonic(opts.mnemonic);
    }
  } else {
    // No seed supplied — let the director generate one, unless it already
    // has one persisted (testnet / CI path).
    try {
      const existing = await directorTyped.getMnemonic();
      if (!existing || existing.length === 0) {
        await directorTyped.generateMnemonic();
      }
    } catch {
      await directorTyped.generateMnemonic();
    }
  }

  const wallet = await director.createWallet();

  return adaptRealWallet(wallet as unknown as RealFedimintWallet);
}
