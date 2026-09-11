// Chain observer for the fixed-payout ruling graph. RESEARCH, REGTEST.
//
// A pure derivation from RPC observations to contract status. It never assumes:
// "unknown/spent" is reported as such and left for the caller to investigate.
// Every timer is recomputed from the ACTIVE chain on every observation, so a
// reorg that moves a confirmation height moves the deadline with it.
import type { Rpc } from "./lib.js";

export interface Graph {
  fundingTxid: string;                       // escrow output is vout 0
  rulings: { A: string; B: string };          // R_A, R_B txids (Q_w is vout 0, anchor vout 1)
  appeals: { A: string; B: string };          // AP_A spends Q_A, AP_B spends Q_B
  W: number;                                 // CSV blocks on Q_w
  refundHeight: number;                      // CLTV height in the refund leaf
}
export type TxState = "unseen" | "mempool" | "confirmed";
export interface TxObs { state: TxState; height?: number; confirmations: number }
export interface Observation {
  tipHeight: number; tipHash: string;
  funding: TxObs & { escrowUnspent: boolean };
  ruling: { winner: "A" | "B" | null; tx: TxObs; qUnspent: boolean | null };
  appeal: { tx: TxObs };
  /** First CANDIDATE block height in which each competing spend is consensus-eligible, from the active chain. */
  eligible: { refundBlock: number; defaultBlock: number | null };
  /** Best-effort classification of what happened to the money. */
  payout: "pending" | "escrow-unspent" | "ruling-confirmed" | "default-or-coop-spent-q" | "appeal-confirmed" | "refund-or-coop-spent-escrow" | "unknown";
  reorgedSince?: { field: string; before: unknown; after: unknown }[];
}

async function txObs(rpc: Rpc, txid: string, vout: number, tip: number, mempool: Set<string>): Promise<TxObs & { unspent: boolean }> {
  const conf = await rpc<any>("gettxout", [txid, vout, false]).catch(() => null);      // confirmed & unspent
  if (conf) return { state: "confirmed", confirmations: conf.confirmations, height: tip - conf.confirmations + 1, unspent: true };
  if (mempool.has(txid)) return { state: "mempool", confirmations: 0, unspent: true };
  // Confirmed-but-spent is indistinguishable from unseen without txindex; the caller cross-checks spenders.
  return { state: "unseen", confirmations: 0, unspent: false };
}

export async function observe(rpc: Rpc, g: Graph, prev?: Observation): Promise<Observation> {
  const tipHeight = await rpc<number>("getblockcount", [], "");
  const tipHash = await rpc<string>("getbestblockhash", [], "");
  const mempool = new Set(await rpc<string[]>("getrawmempool", [], ""));
  const f = await txObs(rpc, g.fundingTxid, 0, tipHeight, mempool);
  const rA = await txObs(rpc, g.rulings.A, 0, tipHeight, mempool);
  const rB = await txObs(rpc, g.rulings.B, 0, tipHeight, mempool);
  // A ruling whose Q output is spent still "happened": detect through its anchor (vout 1) or its appeal child.
  const anchorA = await txObs(rpc, g.rulings.A, 1, tipHeight, mempool);
  const anchorB = await txObs(rpc, g.rulings.B, 1, tipHeight, mempool);
  const apA = await txObs(rpc, g.appeals.A, 0, tipHeight, mempool);
  const apB = await txObs(rpc, g.appeals.B, 0, tipHeight, mempool);
  const pick = (w: "A" | "B") => {
    const q = w === "A" ? rA : rB, anchor = w === "A" ? anchorA : anchorB, ap = w === "A" ? apA : apB;
    if (q.state !== "unseen") return { winner: w, tx: q, qUnspent: true, ap };
    if (anchor.state === "confirmed" || ap.state !== "unseen") {
      // Ruling confirmed (anchor still unspent, or appeal exists) but Q was spent.
      const h = anchor.state === "confirmed" ? anchor.height : ap.height;
      return { winner: w, tx: { state: "confirmed" as TxState, confirmations: anchor.state === "confirmed" ? anchor.confirmations : ap.confirmations, height: h }, qUnspent: false, ap };
    }
    return null;
  };
  const r = pick("A") ?? pick("B");
  const funding: Observation["funding"] = { ...f, escrowUnspent: f.unspent };
  const fundingHappened = f.state !== "unseen" || !!r;
  const ruling: Observation["ruling"] = r ? { winner: r.winner, tx: r.tx, qUnspent: r.qUnspent } : { winner: null, tx: { state: "unseen", confirmations: 0 }, qUnspent: null };
  const appeal = { tx: r ? r.ap : { state: "unseen" as TxState, confirmations: 0 } };
  const defaultBlock = r && r.tx.state === "confirmed" ? r.tx.height! + g.W : null;   // BIP68: eligible in block h+W
  let payout: Observation["payout"] = "pending";
  if (appeal.tx.state === "confirmed") payout = "appeal-confirmed";
  else if (r && r.tx.state === "confirmed" && !r.qUnspent) payout = "default-or-coop-spent-q";
  else if (r && r.tx.state === "confirmed") payout = "ruling-confirmed";
  else if (f.state === "confirmed") payout = "escrow-unspent";
  else if (!fundingHappened && prev && prev.funding.state === "confirmed") payout = "unknown";                 // reorged away or unknown: investigate
  else if (fundingHappened === false && prev && prev.payout !== "pending") payout = "refund-or-coop-spent-escrow";
  else if (f.state === "unseen" && !r && prev && prev.funding.state !== "unseen") payout = "refund-or-coop-spent-escrow";
  const obs: Observation = { tipHeight, tipHash, funding, ruling, appeal, eligible: { refundBlock: g.refundHeight + 1, defaultBlock }, payout };
  if (prev) {
    const diffs: NonNullable<Observation["reorgedSince"]> = [];
    if (prev.funding.state === "confirmed" && f.state !== "confirmed") diffs.push({ field: "funding.height", before: prev.funding.height, after: f.height });
    if (prev.ruling.tx.state === "confirmed" && (ruling.tx.state !== "confirmed" || ruling.tx.height !== prev.ruling.tx.height)) diffs.push({ field: "ruling.height", before: prev.ruling.tx.height, after: ruling.tx.height });
    if (diffs.length) obs.reorgedSince = diffs;
  }
  return obs;
}

/** Feerate (sat/vB) of the cheapest transaction the local miner would include right now; 0 if the template has room. */
export async function templateCutoff(rpc: Rpc, maxWeight: number): Promise<number> {
  const t = await rpc<any>("getblocktemplate", [{ rules: ["segwit"] }], "");
  const txs = t.transactions as { fee: number; weight: number }[];
  const used = txs.reduce((s, x) => s + x.weight, 0);
  if (used < maxWeight * 0.9) return 0;
  return Math.min(...txs.map((x) => x.fee / (x.weight / 4)));
}
