// Bounded fee controller for one contract stage. RESEARCH, REGTEST.
//
// Invariants it enforces (and persists so a restart cannot overspend):
//  • a hard per-contract cap shared across both stages (ruling, appeal)
//  • offered ≠ paid: exposure is counted at offer time, expenditure only when a
//    child CONFIRMS; an evicted child's fee is released back to the budget
//  • sponsor inputs must be confirmed and are reserved per contract in a shared
//    reservation file, so two contracts never race for one input
//  • decisions are explicit: wait / bump / give-up, each with a reason
import * as fs from "node:fs";
import { anchorChild, hex, type Keypair, type Outpoint, type Rpc } from "./lib.js";

export interface StageState { stage: "ruling" | "appeal"; parentTxid: string; ourChild?: { txid: string; fee: number; raw: string; sponsor: Outpoint }; paid: number; history: { height: number; action: string; fee?: number; reason: string }[] }
export interface ContractBudget { contract: string; capSats: number; paidSats: number; offeredSats: number; stages: Record<string, StageState> }
export interface Decision { action: "wait" | "bump" | "give-up" | "cannot-afford" | "done" | "submit"; fee?: number; reason: string }

export class FeeController {
  constructor(private file: string, private reservationsFile: string, public sponsorKey: Keypair, public minRelaySatPerVb: number) {}
  load(contract: string, cap: number): ContractBudget {
    const all = this.loadAll();
    return all[contract] ?? (all[contract] = { contract, capSats: cap, paidSats: 0, offeredSats: 0, stages: {} }, this.saveAll(all), all[contract]);
  }
  private loadAll(): Record<string, ContractBudget> { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {}; }
  private saveAll(all: Record<string, ContractBudget>) { const tmp = this.file + ".tmp"; const fd = fs.openSync(tmp, "w"); fs.writeSync(fd, JSON.stringify(all, (_, v) => typeof v === "bigint" ? v.toString() : v, 1)); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, this.file); }
  save(b: ContractBudget) { const all = this.loadAll(); all[b.contract] = b; this.saveAll(all); }

  // ── sponsor reservations shared across contracts ──
  private reservations(): Record<string, string> { return fs.existsSync(this.reservationsFile) ? JSON.parse(fs.readFileSync(this.reservationsFile, "utf8")) : {}; }
  private saveReservations(r: Record<string, string>) { fs.writeFileSync(this.reservationsFile, JSON.stringify(r, null, 1)); }
  /** Pick a CONFIRMED, unreserved sponsor UTXO of ours, and reserve it for this contract. */
  async reserveSponsor(rpc: Rpc, contract: string, candidates: Outpoint[]): Promise<Outpoint | null> {
    const res = this.reservations();
    for (const c of candidates) {
      const key = `${c.txid}:${c.vout}`;
      if (res[key] && res[key] !== contract) continue;
      const o = await rpc<any>("gettxout", [c.txid, c.vout, false]).catch(() => null);   // confirmed only
      if (!o || o.confirmations < 1) continue;
      res[key] = contract; this.saveReservations(res); return c;
    }
    return null;
  }
  release(contract: string) { const res = this.reservations(); for (const k of Object.keys(res)) if (res[k] === contract) delete res[k]; this.saveReservations(res); }

  /** Decide for one stage. `competitorFee` is the fee of a foreign child currently on the anchor (0 if none). */
  decide(b: ContractBudget, st: StageState, input: { blocksLeft: number; competitorFee: number; competitorFeerate: number; targetFeerate: number; parentVsize: number; childVsize: number; parentInMempool: boolean }): Decision {
    const remaining = b.capSats - b.paidSats - (b.offeredSats - (st.ourChild?.fee ?? 0));   // our own outstanding offer is replaceable
    const needForRate = Math.ceil(input.targetFeerate * (input.parentVsize + input.childVsize)) + 1;
    const needForEviction = input.competitorFee > 0 ? input.competitorFee + Math.ceil(this.minRelaySatPerVb * input.childVsize) + 1 : 0;
    const need = Math.max(needForRate, needForEviction, Math.ceil(this.minRelaySatPerVb * (input.parentVsize + input.childVsize)) + 1);
    if (input.blocksLeft <= 0) return { action: "give-up", reason: "deadline reached: a competing spend is now eligible; the ruling may still confirm but we stop paying" };
    if (input.competitorFee > 0 && input.competitorFeerate >= input.targetFeerate) return { action: "wait", reason: `competitor's package already clears the cutoff (${input.competitorFeerate.toFixed(1)} ≥ ${input.targetFeerate.toFixed(1)} sat/vB): let them pay` };
    if (st.ourChild && st.ourChild.fee >= need) return { action: "wait", reason: `our child (${st.ourChild.fee} sat) already meets need (${need})` };
    if (need > remaining) return { action: "cannot-afford", reason: `need ${need} sat > remaining budget ${remaining} sat (cap ${b.capSats}, paid ${b.paidSats}, offered ${b.offeredSats})` };
    return { action: st.ourChild ? "bump" : "submit", fee: need, reason: `need ${need} sat (rate ${needForRate}, eviction ${needForEviction}); remaining ${remaining}` };
  }

  /** Build, persist as offered, then broadcast. Persist-before-broadcast so a restart never double-offers. */
  async act(rpc: Rpc, b: ContractBudget, st: StageState, d: Decision, parentRaw: string, sponsor: Outpoint, height: number): Promise<{ ok: boolean; err?: string }> {
    if (d.action !== "submit" && d.action !== "bump") { st.history.push({ height, action: d.action, reason: d.reason }); this.save(b); return { ok: true }; }
    sponsor = { ...sponsor, amount: BigInt(sponsor.amount) };
    const raw = anchorChild(st.parentTxid, 1, sponsor, this.sponsorKey, BigInt(d.fee!));
    const txid = (await rpc<any>("decoderawtransaction", [raw], "")).txid as string;
    b.offeredSats += d.fee! - (st.ourChild?.fee ?? 0);
    st.ourChild = { txid, fee: d.fee!, raw, sponsor };
    st.history.push({ height, action: d.action, fee: d.fee, reason: d.reason }); this.save(b);
    try {
      if (d.action === "submit") { const r = await rpc<any>("submitpackage", [[parentRaw, raw]], ""); if (r.package_msg !== "success") return { ok: false, err: JSON.stringify(r).slice(0, 200) }; }
      else await rpc("sendrawtransaction", [raw], "");
      return { ok: true };
    } catch (e) { return { ok: false, err: (e as Error).message }; }
  }

  /** Settle accounting from the chain: confirmed child → paid; evicted/absent child → offer released. */
  async reconcile(rpc: Rpc, b: ContractBudget, st: StageState): Promise<"confirmed" | "pending" | "evicted"> {
    if (!st.ourChild) return "pending";
    const o = await rpc<any>("gettxout", [st.ourChild.txid, 0, false]).catch(() => null);
    if (o && o.confirmations >= 1) { if (st.paid === 0) { st.paid = st.ourChild.fee; b.paidSats += st.ourChild.fee; b.offeredSats -= st.ourChild.fee; this.save(b); } return "confirmed"; }
    const mem = new Set(await rpc<string[]>("getrawmempool", [], ""));
    if (mem.has(st.ourChild.txid)) return "pending";
    if (st.paid) { st.paid = 0; b.paidSats -= st.ourChild.fee; b.offeredSats += st.ourChild.fee; this.save(b); return "evicted"; }   // reorged out: paid → offered again
    b.offeredSats -= st.ourChild.fee; st.history.push({ height: -1, action: "evicted", fee: st.ourChild.fee, reason: "child no longer in mempool; offer released" });
    st.ourChild = undefined; this.save(b); return "evicted";
  }
}
