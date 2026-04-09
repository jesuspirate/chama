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
// FACTORY — Used by FedimintClient.defaultWalletFactory in production.
//
// Dynamically imports @fedimint/core and @fedimint/transport-web so that
// the heavy WASM bundle is only loaded when the user actually needs ecash
// operations. Unit tests can still run without the SDK installed.
// ══════════════════════════════════════════════════════════════════════════

export async function createRealWallet(): Promise<IFedimintWallet> {
  const { WalletDirector } = await import("@fedimint/core");
  const { WasmWorkerTransport } = await import("@fedimint/transport-web");

  const director = new WalletDirector(new WasmWorkerTransport());
  await director.initialize();
  const wallet = await director.createWallet();

  return adaptRealWallet(wallet as unknown as RealFedimintWallet);
}
