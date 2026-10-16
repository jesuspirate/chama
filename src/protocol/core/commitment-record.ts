// ══════════════════════════════════════════════════════════════════════════
// Protocol core — the shape of a commitment-bond record
// ══════════════════════════════════════════════════════════════════════════
//
// Type only. Saving and loading records is an app concern and lives in
// src/bond-multisig/commitment-store.ts.

import type { CommitmentBond, CommitmentReclaimDestination } from "../../bond-multisig/commitment-bond.js";
import type { BondUtxo } from "../../bond-multisig/multisig.js";

export type CommitmentPhase = "created" | "locked" | "reclaimed";

/** The full local record for one commitment bond. `bond` is the recomputable
 *  descriptor; the rest is lifecycle. The owner PRIVATE key is never stored — it's
 *  re-derived from the seed at reclaim time. */
export interface CommitmentRecord {
  bondId: string;
  bond: CommitmentBond;
  amountSats: bigint;
  phase: CommitmentPhase;
  /** BIP86 address index this bond's key was derived at (m/86'/coin'/0'/0/index) —
   *  persisted so reclaim re-derives the RIGHT private key. Each bond gets its own,
   *  so no two bonds ever share an address. Absent ⇒ 0 (legacy single-key bonds). */
  keyIndex?: number;
  /** All UTXOs at the address once funded (phase >= locked) — the reclaim sweeps them. */
  utxos?: BondUtxo[];
  /** Set once reclaimed. */
  reclaimTxid?: string;
  /** The user's selected reclaim destination and the actual transaction output. */
  reclaimDestination?: CommitmentReclaimDestination;
  /** Set when the reclaimed return output is sent into Chama/Fedimint. */
  creditTxid?: string;
  creditOperationId?: string;
  /** Set once the Fedimint on-chain deposit (peg-in) has confirmed and the ecash
   *  landed in the spendable Chama balance — the "credit landed" signal the UI shows. */
  creditConfirmedAt?: number;
  /** v5.4 direct rollover journal. The replacement record remains `created`
   * until its output reaches the normal bond confirmation policy. */
  renewedFromBondId?: string;
  renewalToBondId?: string;
  renewalTxid?: string;
  renewalRawTx?: string;
  renewalFeeSats?: bigint;
  renewalBroadcastAt?: number;
  createdAt: number;
}
