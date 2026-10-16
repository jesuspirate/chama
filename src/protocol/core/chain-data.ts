// ══════════════════════════════════════════════════════════════════════════
// Protocol core — the chain-data port
// ══════════════════════════════════════════════════════════════════════════
//
// The core reads the chain only through an injected fetcher. Which explorer
// to call, and how, is an app concern (src/bond-multisig/fund-watcher.ts and
// esplora-config.ts).

import type { BondUtxo } from "../../bond-multisig/multisig.js";

/** An injected Esplora GET that returns parsed JSON for a path like
 *  `/address/{addr}/utxo` or `/tx/{txid}`. In the app this wraps `fetch`; in tests
 *  it's a fake. */
export type EsploraFetch = (path: string) => Promise<any>;

export interface BondFunding {
  utxo: BondUtxo;
  /** Block the deposit confirmed in, when Esplora reported it. This is the
   *  tenure clock: unforgeable, and instantly checkable by anyone. */
  blockHeight?: number;
  /** The ACTUAL on-chain output script at (txid, vout), read off the funding tx —
   *  recompute-don't-trust reaches the deposit. */
  fundingScript: Uint8Array;
}
