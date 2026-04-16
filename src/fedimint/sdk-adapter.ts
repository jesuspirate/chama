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

    recovery: {
      async hasPendingRecoveries(): Promise<boolean> {
        try {
          return await real.recovery.hasPendingRecoveries();
        } catch { return false; }
      },
      async waitForAllRecoveries(): Promise<void> {
        try {
          await real.recovery.waitForAllRecoveries();
        } catch (e) {
          console.warn("[chama] waitForAllRecoveries error:", e);
        }
      },
    },

    recovery: {
      async hasPendingRecoveries(): Promise<boolean> {
        try {
          return await real.recovery.hasPendingRecoveries();
        } catch { return false; }
      },
      async waitForAllRecoveries(): Promise<void> {
        try {
          await real.recovery.waitForAllRecoveries();
        } catch (e) {
          console.warn("[chama] waitForAllRecoveries error:", e);
        }
      },
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

  // 2. OPFS entry removal + filename rotation so the next init() uses a
  //    guaranteed-fresh OPFS file, sidestepping any orphaned sync handle.
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

  // Best-effort delete of the currently-configured file AND the legacy
  // default name. Failures on a locked file are non-fatal because we're
  // about to rotate anyway.
  const namesToDelete = new Set<string>([getStoredFilename(), FEDIMINT_OPFS_FILE]);
  for (const name of namesToDelete) {
    try {
      // @ts-ignore — options arg lacks TS lib coverage on some releases
      await root.removeEntry(name, { recursive: true });
      console.info(`[chama] OPFS '${name}' removed`);
    } catch (e: any) {
      if (e?.name === "NotFoundError") continue;
      console.warn(
        `[chama] couldn't remove OPFS '${name}' (${e?.name}) — rotating filename instead`
      );
    }
  }

  // 3. Rotate to a fresh filename. Even if the old file couldn't be
  //    deleted, the next init() will use a brand-new name and skip
  //    whatever stale handle was orphaned.
  const newName = rotateFilename();
  console.info(`[chama] Next init will use OPFS file: ${newName}`);
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

// ── OPFS filename rotation ───────────────────────────────────────────────
//
// Firefox (and sometimes Chrome after crashes) can leak OPFS sync access
// handles across page reloads. When that happens, the worker's attempt to
// createSyncAccessHandle() on the default "fedimint.db" file throws
// NoModificationAllowedError, and there's no API to release the orphaned
// handle — it'll clear itself "eventually" but not during this session.
//
// Fix: rotate the OPFS filename. We store the chosen filename in
// localStorage so the next page load reuses the same file (preserving
// the WASM wallet's local state). If init fails, we generate a new
// random filename and retry — losing no user data, because the
// Nostr-backed mnemonic is what actually owns the funds; the OPFS file
// is just a local cache.

const FILENAME_STORAGE_KEY = "chama_fedimint_opfs_file_v1";
const DEFAULT_FILENAME = "fedimint.db";

function getStoredFilename(): string {
  try {
    return localStorage.getItem(FILENAME_STORAGE_KEY) || DEFAULT_FILENAME;
  } catch {
    return DEFAULT_FILENAME;
  }
}

function rotateFilename(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const name = `chama-fedimint-${suffix}.db`;
  try {
    localStorage.setItem(FILENAME_STORAGE_KEY, name);
  } catch {}
  return name;
}

/**
 * Check if an error is the OPFS "file is locked" error.
 *
 * The @fedimint/transport-web worker posts errors as a STRING in
 * `response.error` (not an Error object), so we have to sniff both
 * shapes: DOMException-like objects AND plain string messages.
 */
function isOpfsLockError(e: unknown): boolean {
  if (!e) return false;

  // Plain string (this is how the worker actually rejects)
  if (typeof e === "string") {
    return /no modification allowed|invalidstate/i.test(e);
  }

  // Error / DOMException
  const err = e as { name?: string; message?: string; toString?: () => string };
  if (err.name === "NoModificationAllowedError") return true;
  if (err.name === "InvalidStateError") return true;

  const msg = err.message || (typeof err.toString === "function" ? err.toString() : "");
  return /no modification allowed|invalidstate/i.test(msg);
}

export async function createRealWallet(
  opts: CreateRealWalletOptions = {}
): Promise<IFedimintWallet> {
  const { WalletDirector } = await import("@fedimint/core");
  const { WasmWorkerTransport } = await import("@fedimint/transport-web");

  // Terminate any worker left over from a previous init in this session.
  // Handles HMR, double-init, and retry-after-failed-join. (This does NOT
  // help the cross-reload leak case — that's what filename rotation is for.)
  terminateCurrentWorker();

  // Try the stored filename first. If the worker can't open it (stale
  // sync handle from a previous page load that didn't release), rotate
  // to a fresh name and retry once.
  let filename = getStoredFilename();
  let director: any;
  let transport: any;

  const attemptInit = async (fname: string) => {
    const t = new WasmWorkerTransport();
    registerTransport(t as unknown as AnyTransport);
    const d = new WalletDirector(t, /* lazy */ true);
    // _client is protected; cast through unknown to reach initialize()
    const tc = (d as unknown as {
      _client: { initialize(testFilename?: string): Promise<boolean> };
    })._client;
    await tc.initialize(fname);
    return { d, t };
  };

  try {
    ({ d: director, t: transport } = await attemptInit(filename));
    console.info(`[chama] Fedimint OPFS file: ${filename}`);
  } catch (e) {
    console.warn(
      `[chama] init failed on '${filename}' —`,
      e,
      "isOpfsLockError:",
      isOpfsLockError(e)
    );
    if (isOpfsLockError(e)) {
      console.warn(`[chama] OPFS '${filename}' is locked (stale sync handle). Rotating.`);
      terminateCurrentWorker();
      // Give the browser a tick to finalize the failed worker's teardown
      // before spinning up a new one. Some Firefox builds need this.
      await new Promise((r) => setTimeout(r, 50));
      filename = rotateFilename();
      try {
        ({ d: director, t: transport } = await attemptInit(filename));
        console.info(`[chama] Fedimint OPFS file (rotated): ${filename}`);
      } catch (e2) {
        console.error(`[chama] retry with rotated filename '${filename}' also failed:`, e2);
        throw e2;
      }
    } else {
      throw e;
    }
  }
  void transport; // retained reference via registerTransport

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
        // Local seed differs from Nostr backup.
        // The Nostr-backed seed is the source of truth — it's what was used
        // to lock ecash in escrows. The local OPFS seed is just a cache that
        // can go stale (filename rotation, browser clear, different device).
        // Force-overwrite local with the Nostr seed so the user can claim.
        console.warn(
          "[chama] Seed mismatch — local OPFS has a different seed than Nostr.",
          "Overwriting local seed with Nostr-backed seed (source of truth)."
        );
        try {
          await directorTyped.setMnemonic(opts.mnemonic!);
          console.info("[chama] Local seed overwritten with Nostr-backed seed");
        } catch (setErr: any) {
          // setMnemonic doesn't allow overwrite. Auto-reset OPFS and retry.
          console.warn("[chama] setMnemonic rejected overwrite — auto-resetting OPFS:", setErr?.message);
          
          // Terminate the current worker so OPFS handle is released
          terminateCurrentWorker();
          
          // Delete the OPFS file and rotate to a fresh filename
          try {
            const root = await navigator.storage.getDirectory();
            const oldName = getStoredFilename();
            try { await (root as any).removeEntry(oldName, { recursive: true }); } catch {}
            try { await (root as any).removeEntry("fedimint.db", { recursive: true }); } catch {}
          } catch {}
          const freshName = rotateFilename();
          console.info("[chama] OPFS reset complete, retrying with fresh file:", freshName);
          
          // Retry: create a brand new director + transport with the fresh OPFS file
          const { WalletDirector: WD2 } = await import("@fedimint/core");
          const { WasmWorkerTransport: WT2 } = await import("@fedimint/transport-web");
          const t2 = new WT2();
          registerTransport(t2 as unknown as AnyTransport);
          const d2 = new WD2(t2, true);
          const tc2 = (d2 as unknown as {
            _client: { initialize(testFilename?: string): Promise<boolean> };
          })._client;
          await tc2.initialize(freshName);
          
          // Fresh DB — no existing seed, install the Nostr-backed one
          const dt2 = d2 as unknown as {
            setMnemonic(words: string[]): Promise<boolean>;
            getMnemonic(): Promise<string[]>;
          };
          await dt2.setMnemonic(opts.mnemonic!);
          console.info("[chama] Nostr-backed seed installed in fresh OPFS file");
          
          // Replace the director reference for the rest of the factory
          director = d2;
        }
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
