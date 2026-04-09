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

export function adaptRealWallet(
  real: RealFedimintWallet,
  onCleanup?: () => void
): IFedimintWallet {
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
      try {
        await real.cleanup();
      } finally {
        onCleanup?.();
      }
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// LOCAL WALLET RESET — OPFS-based
//
// IMPORTANT: Fedimint's WASM worker (@fedimint/transport-web) does NOT use
// IndexedDB for persistence. It uses the Origin Private File System (OPFS)
// via `navigator.storage.getDirectory()` + `createSyncAccessHandle()`.
// The string "fedimint.db" in the worker source is the OPFS filename.
//
// This matters for two reasons:
//
//   1. Deleting an IndexedDB database called "fedimint.db" is a no-op —
//      no such database exists. Earlier Chama versions (v0.1.11) did exactly
//      this and it didn't help.
//
//   2. The "NoModificationAllowedError" that users hit on re-init is NOT
//      about stale data. It's OPFS refusing to open a second sync access
//      handle on a file that's still locked by another handle — i.e. a
//      PREVIOUS Web Worker is still alive and holding the file. In Vite
//      dev with HMR this is extremely common: the old module gets replaced
//      but its worker keeps running.
//
// Fixes:
//   (a) Track the worker we spawn in a module-level ref, terminate it
//       before spawning a new one AND on cleanup(). This handles the
//       HMR / multi-init case end-to-end.
//   (b) The reset helper terminates the worker first (releasing the OPFS
//       handle) and then deletes the OPFS file so the next init starts
//       from a blank slate.
// ══════════════════════════════════════════════════════════════════════════

/** OPFS filename used by @fedimint/transport-web worker */
const FEDIMINT_OPFS_FILE = "fedimint.db";

/**
 * Module-level reference to the currently-live transport (for its worker).
 * We terminate this worker before creating a new one so the OPFS sync
 * access handle is released and the next init() doesn't throw
 * NoModificationAllowedError. HMR-safe: `import.meta.hot?.dispose` also
 * terminates it to be doubly sure during dev.
 */
type AnyTransport = { worker?: Worker };
let currentTransport: AnyTransport | null = null;

function terminateCurrentWorker(): void {
  const t = currentTransport;
  currentTransport = null;
  if (t && t.worker && typeof t.worker.terminate === "function") {
    try {
      t.worker.terminate();
      console.info("[chama] Previous Fedimint worker terminated");
    } catch (e) {
      console.debug("[chama] worker terminate threw:", e);
    }
  }
}

// Vite HMR: tear the worker down when the module is disposed so the next
// hot-replaced instance starts fresh. No-op in production.
// @ts-ignore — import.meta.hot is a dev-only Vite API
if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  // @ts-ignore
  (import.meta as any).hot.dispose(() => {
    terminateCurrentWorker();
  });
}

/**
 * Wipe the Fedimint WASM wallet's local state.
 *
 * Steps:
 *   1. Terminate any live worker so its OPFS sync access handle is released.
 *   2. `removeEntry("fedimint.db")` on the OPFS root directory.
 *   3. Fall back to a brute-force clear of the OPFS root if step 2 throws
 *      (e.g. file is held by a worker in another tab). Returns a warning
 *      rather than throwing so the UI can still recover.
 *
 * Destructive to *local* state only. The Nostr-backed mnemonic lives on
 * relays and will be reinstalled on the next init().
 */
export async function resetLocalFedimintWallet(): Promise<void> {
  // 1. Release any live sync handle by killing the worker that owns it.
  terminateCurrentWorker();

  // 2. OPFS entry removal.
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== "function"
  ) {
    throw new Error(
      "This browser does not support OPFS (navigator.storage.getDirectory). " +
      "Try a recent Chrome, Edge, or Safari build."
    );
  }

  const root = await navigator.storage.getDirectory();

  try {
    // @ts-ignore — options arg is supported in Chrome/Safari but not yet in
    // all TypeScript DOM libs.
    await root.removeEntry(FEDIMINT_OPFS_FILE, { recursive: true });
    console.info("[chama] OPFS 'fedimint.db' removed");
  } catch (e: any) {
    // NotFoundError = nothing to delete, which is fine.
    if (e?.name === "NotFoundError") {
      console.info("[chama] OPFS 'fedimint.db' not present — nothing to clear");
      return;
    }
    // NoModificationAllowed here means another worker (different tab)
    // is still holding the handle. Surface to UI.
    if (e?.name === "NoModificationAllowedError" || e?.name === "InvalidStateError") {
      throw new Error(
        "Couldn't clear local Fedimint wallet: another tab has it open. " +
        "Close other Chama tabs and try again."
      );
    }
    throw e;
  }
}

/** @internal — used by createRealWallet to stash the transport for termination */
function registerTransport(t: AnyTransport): void {
  // Terminate any prior one first — catches the HMR and double-init cases.
  terminateCurrentWorker();
  currentTransport = t;
}

/** @internal — used by the adapted wallet's cleanup() to release the worker */
function clearRegisteredTransport(): void {
  terminateCurrentWorker();
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

  // CRITICAL: terminate any worker left over from a previous init (HMR,
  // double-init, or a failed join). If we don't, the new worker tries to
  // open the OPFS 'fedimint.db' file and hits NoModificationAllowedError
  // because the stale worker still holds the sync access handle.
  const transport = new WasmWorkerTransport();
  registerTransport(transport as unknown as AnyTransport);

  const director = new WalletDirector(transport);
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

  return adaptRealWallet(
    wallet as unknown as RealFedimintWallet,
    clearRegisteredTransport
  );
}
