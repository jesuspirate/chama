// ══════════════════════════════════════════════════════════════════════════
// Chama — Mock Fedimint Wallet (testnet dev-only)
// ══════════════════════════════════════════════════════════════════════════
//
// A fake IFedimintWallet that simulates ecash operations in-memory.
// Activated exclusively via the ?testnet=1 URL query flag (see
// `isTestnetMode()` below). Never advertised in the UI.
//
// Purpose:
//   - Exercise the full escrow flow (lock / vote / claim) without burning
//     real federation ecash.
//   - CI / local dev without the WASM bundle.
//
// Behaviour:
//   - Starts with 1,000,000 msats (1k sats) "free money"
//   - spendNotes just returns a deterministic fake OOB string and
//     subtracts from the mock balance
//   - redeemEcash parses the fake string and credits the balance back
//   - createInvoice returns a dummy bolt11-looking string
//
// Cryptographic guarantees: none. Do not use in production.

import type { IFedimintWallet } from "./fedimint-client.js";

const MOCK_FEDERATION_ID = "mock_fed_" + "0".repeat(56);
const MOCK_INVITE = "fed1mock" + "0".repeat(80);
const STARTING_BALANCE_MSATS = 1_000_000; // 1,000 sats

/**
 * Returns true when the app is running with the `?testnet=1` query flag.
 * Only works in a browser (checks `window.location.search`).
 */
export function isTestnetMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("testnet") === "1";
  } catch {
    return false;
  }
}

export function createMockWallet(): IFedimintWallet {
  let balanceMsats = STARTING_BALANCE_MSATS;
  let open = false;
  let joined = false;
  const subscribers = new Set<(balance: number) => void>();
  let noteCounter = 0;

  const notifyBalance = () => {
    for (const cb of subscribers) {
      try { cb(balanceMsats); } catch { /* swallow */ }
    }
  };

  return {
    async open() {
      open = true;
    },
    isOpen() {
      return open && joined;
    },
    recovery: {
      async hasPendingRecoveries() { return false; },
      async waitForAllRecoveries() {},
    },

    recovery: {
      async hasPendingRecoveries() { return false; },
      async waitForAllRecoveries() {},
    },

    async joinFederation(_inviteCode: string) {
      joined = true;
      // Give the user their welcome "sats" on first join
      notifyBalance();
    },

    balance: {
      async getBalance() {
        return balanceMsats;
      },
      subscribeBalance(callback: (balance: number) => void) {
        subscribers.add(callback);
        // Emit current balance immediately
        setTimeout(() => callback(balanceMsats), 0);
        return () => {
          subscribers.delete(callback);
        };
      },
    },

    mint: {
      async spendNotes(amountMsats: number) {
        if (amountMsats > balanceMsats) {
          throw new Error(
            `Mock wallet: insufficient balance (${balanceMsats} < ${amountMsats})`
          );
        }
        balanceMsats -= amountMsats;
        notifyBalance();
        noteCounter++;
        // Encode the amount in the fake notes so redeemEcash can parse it
        return `mock_notes_${noteCounter}_${amountMsats}`;
      },
      async redeemEcash(oobNotes: string) {
        const match = oobNotes.match(/^mock_notes_\d+_(\d+)$/);
        if (!match) {
          throw new Error("Mock wallet: invalid mock notes format");
        }
        const amount = parseInt(match[1], 10);
        balanceMsats += amount;
        notifyBalance();
      },
      async parseNotes(oobNotes: string) {
        const match = oobNotes.match(/^mock_notes_\d+_(\d+)$/);
        if (!match) {
          throw new Error("Mock wallet: invalid mock notes format");
        }
        return { total_amount: parseInt(match[1], 10) };
      },
    },

    lightning: {
      async createInvoice(amountMsats: number, description: string) {
        // Fake bolt11 — user can pretend-pay it and we'll credit the balance
        // after a short delay to simulate settlement.
        const opId = `mock_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setTimeout(() => {
          balanceMsats += amountMsats;
          notifyBalance();
        }, 2_000);
        return {
          invoice: `lnbcmock${amountMsats}n1p${description.replace(/\W/g, "").slice(0, 10)}${opId}`,
          operationId: opId,
        };
      },
      async payInvoice(_bolt11: string) {
        return { operationId: `mock_pay_${Date.now()}` };
      },
    },

    federation: {
      async getFederationId() {
        return MOCK_FEDERATION_ID;
      },
      async getInviteCode() {
        return MOCK_INVITE;
      },
    },

    async cleanup() {
      subscribers.clear();
      open = false;
      joined = false;
    },
  };
}
