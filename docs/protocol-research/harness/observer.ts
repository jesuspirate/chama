// Chain observer for the fixed-payout ruling graph. RESEARCH, REGTEST.
//
// A pure derivation from RPC observations to contract status. It never assumes:
// "unknown/spent" is reported as such and left for the caller to investigate.
// Every timer is recomputed from the ACTIVE chain on every observation, so a
// reorg that moves a confirmation height moves the deadline with it.
import { activeChain } from "./active-chain.js";
import type { Rpc } from "./lib.js";

export interface Graph {
  fundingTxid: string;                       // escrow output is vout 0
  rulings: { A: string; B: string };          // R_A, R_B txids (Q_w is vout 0, anchor vout 1)
  appeals: { A: string; B: string };          // AP_A spends Q_A, AP_B spends Q_B
  W: number;                                 // CSV blocks on Q_w
  refundHeight: number;                      // CLTV height in the refund leaf
}
export type TxState = "unseen" | "mempool" | "confirmed";
export interface TxObs { state: TxState; height?: number; blockHash?: string; confirmations: number }
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

export async function observe(rpc: Rpc, g: Graph, prev?: Observation): Promise<Observation> {
  const chain = await activeChain(rpc);
  const tx = (id: string): TxObs => {
    const found = chain.txs.get(id);
    return found ? { state: "confirmed", height: found.height, blockHash: found.blockHash, confirmations: chain.tipHeight - found.height + 1 }
      : { state: chain.mempool.has(id) ? "mempool" : "unseen", confirmations: 0 };
  };
  const f = tx(g.fundingTxid), a = tx(g.rulings.A), b = tx(g.rulings.B);
  // Confirmed alternatives take priority; never derive a parent's height from a child.
  const winner = a.state === "confirmed" ? "A" : b.state === "confirmed" ? "B" : a.state === "mempool" ? "A" : b.state === "mempool" ? "B" : null;
  const rulingTx = winner === "A" ? a : winner === "B" ? b : { state: "unseen" as TxState, confirmations: 0 };
  const escrowSpent = chain.spends.has(`${g.fundingTxid}:0`);
  const qSpent = winner ? chain.spends.has(`${g.rulings[winner]}:0`) : false;
  const appealTx = winner ? tx(g.appeals[winner]) : { state: "unseen" as TxState, confirmations: 0 };
  let payout: Observation["payout"] = "pending";
  if (appealTx.state === "confirmed") payout = "appeal-confirmed";
  else if (rulingTx.state === "confirmed") payout = qSpent ? "default-or-coop-spent-q" : "ruling-confirmed";
  else if (f.state === "confirmed") payout = escrowSpent ? "refund-or-coop-spent-escrow" : "escrow-unspent";
  else if (f.state === "unseen") payout = "unknown";
  const obs: Observation = {
    tipHeight: chain.tipHeight, tipHash: chain.tipHash,
    funding: { ...f, escrowUnspent: f.state !== "unseen" && !escrowSpent },
    ruling: { winner, tx: rulingTx, qUnspent: winner ? !qSpent : null }, appeal: { tx: appealTx },
    eligible: { refundBlock: g.refundHeight + 1, defaultBlock: rulingTx.state === "confirmed" ? rulingTx.height! + g.W : null }, payout,
  };
  if (prev) {
    const diffs: NonNullable<Observation["reorgedSince"]> = [];
    for (const [field, before, after] of [["funding", prev.funding, obs.funding], ["ruling", prev.ruling.tx, rulingTx], ["appeal", prev.appeal.tx, appealTx]] as const) {
      if (before.state === "confirmed" && (after.state !== "confirmed" || before.height !== after.height || before.blockHash !== after.blockHash)) diffs.push({ field: `${field}.height`, before: before.height, after: after.height });
    }
    if (diffs.length) obs.reorgedSince = diffs;
  }
  return obs;
}

/** Feerate (sat/vB) of the cheapest transaction the local miner would include right now; 0 if the template has room. */
export async function templateCutoff(rpc: Rpc, maxWeight: number): Promise<number> {
  const t = await rpc<any>("getblocktemplate", [{ rules: ["segwit"] }], "");
  const txs = t.transactions as { fee: number; weight: number; depends?: number[] }[];
  const used = txs.reduce((s, x) => s + x.weight, 0);
  if (used < maxWeight * 0.9) return 0;
  // Zero-fee parents must be counted together with their fee-paying children.
  // Connected-component averages are still only a local template heuristic.
  const roots = txs.map((_,i)=>i);
  const root = (i:number):number => roots[i] === i ? i : (roots[i] = root(roots[i]));
  txs.forEach((x,i)=>(x.depends??[]).forEach(d=>{ if(d<1||d>txs.length)throw new Error("invalid template dependency");roots[root(i)]=root(d-1); }));
  const groups = new Map<number,{fee:number;weight:number}>();
  txs.forEach((x,i)=>{ const r=root(i),g=groups.get(r)??{fee:0,weight:0};g.fee+=x.fee;g.weight+=x.weight;groups.set(r,g); });
  return groups.size ? Math.min(...[...groups.values()].map(g=>g.fee/(g.weight/4))) : 0;
}
