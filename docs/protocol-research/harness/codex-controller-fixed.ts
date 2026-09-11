#!/usr/bin/env npx tsx
// Replays the deadline/fee scenarios THROUGH the observer and fee controller. REGTEST ONLY.
// Congestion follows Codex's deadline harness: -blockmaxweight=40000 with fee-ranked
// background traffic from a pre-split treasury. Assertions are on the FINAL AUTHORIZED
// PAYOUT and the BUDGET ACCOUNTING (offered vs paid), not on mempool acceptance.
//
// Run: BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/controller-scenarios.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startNode, mine, fundKey, keypair, btc, REGTEST, hex, hexToBytes, fundingTree, appealTree, newSpend, addToTree, addToKey, addP2A, finalize, txidOf, anchorChild, makeRecorder, ANCHOR_SATS, type Outpoint, type Roles } from "./lib.js";
import { observe, templateCutoff, type Graph, type Observation } from "./observer.js";
import { FeeController } from "./fee-policy.js";

const PORT = 20_399, MAXW = 40_000, ESCROW = 100_000n, W = 4;
const HERE = path.dirname(new URL(import.meta.url).pathname);

async function main() {
  const node = await startNode(PORT, [`-blockmaxweight=${MAXW}`, "-blockreservedweight=2000"]);
  const { rpc } = node; const rec = makeRecorder(rpc);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chama-controller-"));
  try {
    await mine(rpc, 110);
    const A = keypair(), B = keypair(), R = keypair(), P = keypair(), HONEST = keypair(), ATTACKER = keypair(), NOISE = keypair();
    const roles: Roles = { A: A.xonly, B: B.xonly, R: R.xonly, P: P.xonly };
    const mpi = await rpc<any>("getmempoolinfo", [], "");
    const minRelay = mpi.incrementalrelayfee * 1e8 / 1000;
    const ctl = new FeeController(path.join(tmp, "budgets.json"), path.join(tmp, "reservations.json"), HONEST, minRelay);

    // Treasury for background traffic (explicit block: the split would not fit the small template).
    const treasury = await fundKey(rpc, NOISE.xonly, 200_000_000n);
    const np = btc.p2tr(NOISE.xonly, undefined, REGTEST);
    const split = new btc.Transaction({ version: 2 });
    split.addInput({ txid: hexToBytes(treasury.txid), index: treasury.vout, witnessUtxo: { script: np.script, amount: treasury.amount }, tapInternalKey: NOISE.xonly });
    for (let i = 0; i < 1800; i++) split.addOutput({ script: np.script, amount: 100_000n });
    split.addOutput({ script: np.script, amount: treasury.amount - 180_000_000n - 2_000n }); split.signIdx(NOISE.priv, 0); split.finalize();
    await rpc("generateblock", [await rpc<string>("getnewaddress"), [hex(split.extract())]]);
    let noiseIdx = 0;
    const congest = async (n: number, feeSats = 20_000n) => {
      for (let i = 0; i < n; i++) {
        const tx = new btc.Transaction({ version: 2 });
        tx.addInput({ txid: hexToBytes(split.id), index: noiseIdx++, witnessUtxo: { script: np.script, amount: 100_000n }, tapInternalKey: NOISE.xonly });
        tx.addOutput({ script: np.script, amount: 100_000n - feeSats }); tx.signIdx(NOISE.priv, 0); tx.finalize();
        await rpc("sendrawtransaction", [hex(tx.extract())]);
      }
    };
    // Sponsors: several confirmed UTXOs for the honest controller, a big one for the attacker.
    const honestSponsors: Outpoint[] = []; for (let i = 0; i < 6; i++) honestSponsors.push(await fundKey(rpc, HONEST.xonly, 150_000n));
    const attackerSponsors: Outpoint[] = []; for (let i = 0; i < 8; i++) attackerSponsors.push(await fundKey(rpc, ATTACKER.xonly, 500_000n));
    let attackerSponsor = attackerSponsors[0];
    const freshAttacker = () => { attackerSponsor = attackerSponsors.shift()!; };
    const attackerPin = async (parentRaw: string, parentTxid: string, fee: bigint, pad = 825) => {
      // pad=825 → ~993 vB pin; pad=0 → ~153 vB "smart" rebid that can out-feerate a small honest child
      const raw = anchorChild(parentTxid, 1, attackerSponsor, ATTACKER, fee, { padBytes: pad });
      const r = await rpc<any>("submitpackage", [[parentRaw, raw]]).catch(async () => ({ package_msg: (await rpc<any[]>("testmempoolaccept", [[raw]]))[0].allowed ? await rpc("sendrawtransaction", [raw]) && "success" : "fail" }));
      return { txid: txidOf(raw), fee: Number(fee), ok: r.package_msg === "success" };
    };
    const competitorOn = async (parentTxid: string, ourTxid?: string) => {
      // Any mempool child spending the anchor that is not ours.
      const spends = await rpc<any>("gettxspendingprevout", [[{ txid: parentTxid, vout: 1 }]], "");
      const s = spends[0]?.spendingtxid as string | undefined;
      if (!s || s === ourTxid) return { fee: 0, feerate: 0 };
      const e = await rpc<any>("getmempoolentry", [s], "").catch(() => null);
      if (!e) return { fee: 0, feerate: 0 };
      const fee = Math.round(e.fees.base * 1e8);
      return { fee, feerate: Math.round(e.fees.ancestor * 1e8) / (e.vsize + (e.ancestorsize - e.vsize)) };
    };

    // One contract = one funding output with all templates pre-signed; helper builds them.
    async function contract(name: string, refundIn: number) {
      const funder = await fundKey(rpc, A.xonly, 300_000n);
      const tip = await rpc<number>("getblockcount");
      const refundHeight = tip + 1 + refundIn;                      // funding confirms at tip+1
      const F = fundingTree(roles, refundHeight), QA = appealTree(roles, "A", W), QB = appealTree(roles, "B", W);
      const fp = btc.p2tr(A.xonly, undefined, REGTEST);
      const fund = new btc.Transaction({ version: 2 });
      fund.addInput({ txid: hexToBytes(funder.txid), index: funder.vout, witnessUtxo: { script: fp.script, amount: funder.amount }, tapInternalKey: A.xonly });
      addToTree(fund, F, ESCROW); addToKey(fund, A.xonly, funder.amount - ESCROW - 2_000n);
      fund.signIdx(A.priv, 0); fund.finalize();
      const f0: Outpoint = { txid: fund.id, vout: 0, amount: ESCROW };
      const qAmt = ESCROW - ANCHOR_SATS, apAmt = qAmt - ANCHOR_SATS;
      const mk = (w: "A" | "B") => { const t = newSpend(F, "ruling", f0); addToTree(t, w === "A" ? QA : QB, qAmt); addP2A(t); t.signIdx(A.priv, 0); t.signIdx(B.priv, 0); t.signIdx(R.priv, 0); return { raw: finalize(t, F, "ruling"), txid: t.id }; };
      const rA = mk("A"), rB = mk("B");
      const ap = (w: "A" | "B") => { const Q = w === "A" ? QA : QB; const t = newSpend(Q, "appeal", { txid: (w === "A" ? rA : rB).txid, vout: 0, amount: qAmt }); addToKey(t, w === "A" ? B.xonly : A.xonly, apAmt); addP2A(t); t.signIdx(A.priv, 0); t.signIdx(B.priv, 0); t.signIdx(P.priv, 0); return { raw: finalize(t, Q, "appeal"), txid: t.id }; };
      const apA = ap("A"), apB = ap("B");
      await rpc("generateblock", [await rpc<string>("getnewaddress"), [hex(fund.extract())]]);   // explicit block: funding confirms now
      const g: Graph = { fundingTxid: fund.id, rulings: { A: rA.txid, B: rB.txid }, appeals: { A: apA.txid, B: apB.txid }, W, refundHeight };
      const refundTx = (fee: bigint) => { const t = newSpend(F, "refund", f0, { sequence: 0xfffffffe, lockTime: refundHeight }); addToKey(t, A.xonly, ESCROW - fee); t.signIdx(A.priv, 0); return finalize(t, F, "refund"); };
      const defaultTx = (w: "A" | "B", fee: bigint) => { const Q = w === "A" ? QA : QB; const t = newSpend(Q, "default", { txid: (w === "A" ? rA : rB).txid, vout: 0, amount: qAmt }, { sequence: W }); addToKey(t, w === "A" ? A.xonly : B.xonly, qAmt - fee); t.signIdx((w === "A" ? A : B).priv, 0); return finalize(t, Q, "default"); };
      return { name, g, rA, rB, apA, apB, refundTx, defaultTx };
    }

    /** One controller tick for a stage: observe → reconcile → decide → act. Returns the decision. */
    async function tick(c: Awaited<ReturnType<typeof contract>>, stage: "ruling" | "appeal", parent: { raw: string; txid: string }, cap: number, prev?: Observation) {
      const obs = await observe(rpc, c.g, prev);
      const b = ctl.load(c.name, cap);
      const st = b.stages[stage] ?? (b.stages[stage] = { stage, parentTxid: parent.txid, paid: 0, history: [] });
      const status = await ctl.reconcile(rpc, b, st);
      const parentConfirmed = stage === "ruling" ? obs.ruling.tx.state === "confirmed" : obs.appeal.tx.state === "confirmed";
      if (parentConfirmed) { st.history.push({ height: obs.tipHeight, action: "done", reason: "parent confirmed" }); ctl.save(b); return { obs, decision: { action: "done" as const, reason: "confirmed" }, st, b }; }
      const deadlineBlock = stage === "ruling" ? obs.eligible.refundBlock : (obs.eligible.defaultBlock ?? Infinity);
      const blocksLeft = deadlineBlock - (obs.tipHeight + 1);                     // candidate blocks before the competitor is eligible
      const comp = await competitorOn(parent.txid, st.ourChild?.txid);
      const cutoff = await templateCutoff(rpc, MAXW);
      const parentInMempool = (await rpc<string[]>("getrawmempool")).includes(parent.txid);
      const d = ctl.decide(b, st, { blocksLeft, competitorFee: comp.fee, competitorFeerate: comp.feerate, targetFeerate: cutoff + 0.5, parentVsize: 208, childVsize: 153, parentInMempool });
      let sponsor = st.ourChild?.sponsor ?? null;
      if ((d.action === "submit" || d.action === "bump") && !sponsor) sponsor = await ctl.reserveSponsor(rpc, c.name, honestSponsors);
      if ((d.action === "submit" || d.action === "bump") && !sponsor) { const w = { action: "wait" as const, reason: "no confirmed, unreserved sponsor input available" }; await ctl.act(rpc, b, st, w, parent.raw, honestSponsors[0], obs.tipHeight); return { obs, decision: w, st, b, status }; }
      const r = await ctl.act(rpc, b, st, d, parent.raw, sponsor!, obs.tipHeight);
      if (!r.ok) st.history.push({ height: obs.tipHeight, action: "broadcast-failed", reason: r.err ?? "" }), ctl.save(b);
      return { obs, decision: d, st, b, status };
    }
    const paidBy = async (sponsor: Outpoint) => !(await rpc<any>("gettxout", [sponsor.txid, sponsor.vout, false]));

    // ── C1: alternating replacement ladder under light congestion; honest cap 20,000 ──
    {
      freshAttacker(); const c = await contract("C1", 12);
      let pin = await attackerPin(c.rB.raw, c.rB.txid, 1_300n);
      let prev: Observation | undefined; let last: any; const ladder: string[] = [];
      for (let blk = 0; blk < 8; blk++) {
        await congest(90, 2_000n);                                  // ~18 sat/vB cutoff
        last = await tick(c, "ruling", c.rB, 20_000, prev); prev = last.obs; ladder.push(`${last.decision.action}${last.decision.fee ? ":" + last.decision.fee : ""}`);
        if (last.decision.action === "done") break;
        // Attacker rebids with a PADDED child: must exceed our feerate on ~993 vB, so a +1000 rebid is rejected.
        if (last.st.ourChild && pin.fee < 8_000) { const next = BigInt(Math.min(8_000, last.st.ourChild.fee + 1_000)); const p = await attackerPin(c.rB.raw, c.rB.txid, next); ladder.push(p.ok ? `atk:${next}` : `atk-rejected:${next}`); if (p.ok) pin = p; }
        await mine(rpc, 1);
      }
      const fin = await observe(rpc, c.g, prev);
      const b = ctl.load("C1", 20_000);
      rec.record("C1a", `padded attacker cannot climb the ladder: ${ladder.join(" → ")}`, "ACCEPT", fin.payout === "ruling-confirmed" && fin.ruling.winner === "B" && b.paidSats <= 20_000 && b.paidSats > 0 && b.offeredSats === 0, JSON.stringify({ payout: fin.payout, paid: b.paidSats, offered: b.offeredSats }), `honest paid ${b.paidSats}, attacker paid 0; replacement requires a higher FEERATE, and padding makes that expensive`);
    }
    {
      // Smart attacker: small (153 vB) rebids that CAN out-feerate our child, up to 8,000 sat. Honest cap 20,000.
      freshAttacker(); const c = await contract("C1b", 14);
      let pin = await attackerPin(c.rB.raw, c.rB.txid, 1_300n, 0);
      let prev: Observation | undefined; let last: any; const ladder: string[] = [];
      for (let blk = 0; blk < 10; blk++) {
        await congest(90, 2_000n);
        last = await tick(c, "ruling", c.rB, 20_000, prev); prev = last.obs; ladder.push(`${last.decision.action}${last.decision.fee ? ":" + last.decision.fee : ""}`);
        if (last.decision.action === "done") break;
        if (last.st.ourChild && pin.fee < 8_000) { const next = BigInt(Math.min(8_000, last.st.ourChild.fee + 1_000)); const p = await attackerPin(c.rB.raw, c.rB.txid, next, 0); ladder.push(p.ok ? `atk:${next}` : `atk-rejected:${next}`); if (p.ok) pin = p; }
        // A rebid that lands before the block is mined evicts our child; give the controller one more tick before mining.
        last = await tick(c, "ruling", c.rB, 20_000, prev); prev = last.obs; ladder.push(`${last.decision.action}${last.decision.fee ? ":" + last.decision.fee : ""}`);
        await mine(rpc, 1);
      }
      const fin = await observe(rpc, c.g, prev);
      const b = ctl.load("C1b", 20_000);
      const atkPaid = await paidBy(attackerSponsor);
      rec.record("C1b", `small-child attacker ladder: ${ladder.join(" → ")}`, "ACCEPT", fin.payout === "ruling-confirmed" && fin.ruling.winner === "B" && b.paidSats <= 20_000 && b.offeredSats === 0 && (b.paidSats > 0 || atkPaid), JSON.stringify({ payout: fin.payout, paid: b.paidSats, offered: b.offeredSats }), `honest paid ${b.paidSats}, attacker paid ${atkPaid ? "their rebid" : 0}: whoever's child confirms pays; the controller waits once the competitor clears the cutoff`);
    }

    // ── C2: insufficient budget under heavy congestion until the refund deadline ──
    {
      freshAttacker(); const c = await contract("C2", 4);
      await attackerPin(c.rB.raw, c.rB.txid, 12_000n);
      let prev: Observation | undefined; const log: string[] = [];
      for (let blk = 0; blk < 4; blk++) { await congest(90); const t = await tick(c, "ruling", c.rB, 2_000, prev); prev = t.obs; log.push(t.decision.action); await mine(rpc, 1); }
      const obs = await observe(rpc, c.g, prev);
      const refundOk = (await rpc<any[]>("testmempoolaccept", [[c.refundTx(50_000n)]]))[0].allowed;
      await rpc("sendrawtransaction", [c.refundTx(50_000n)]); await mine(rpc, 1);
      const fin = await observe(rpc, c.g, obs); const b = ctl.load("C2", 2_000);
      rec.record("C2", `cap 2000 vs 12000 pin, 4 congested blocks: decisions ${log.join(",")}; refund eligible and confirms`, "ACCEPT", log.includes("cannot-afford") && refundOk && !fin.funding.escrowUnspent && fin.payout !== "ruling-confirmed" && b.paidSats === 0 && b.offeredSats === 0, JSON.stringify({ payout: fin.payout, b }), "honest paid 0 (nothing confirmed); intended ruling lost to the scripted refund");
    }

    // ── C3: congestion clears before the deadline: controller waits, attacker's package confirms the ruling ──
    {
      freshAttacker(); const c = await contract("C3", 6);
      await attackerPin(c.rA.raw, c.rA.txid, 12_000n);
      let prev: Observation | undefined; const log: string[] = [];
      for (let blk = 0; blk < 5; blk++) { if (blk < 2) await congest(90); const t = await tick(c, "ruling", c.rA, 2_000, prev); prev = t.obs; log.push(t.decision.action); if (t.decision.action === "done") break; await mine(rpc, 1); }
      const fin = await observe(rpc, c.g, prev); const b = ctl.load("C3", 2_000);
      rec.record("C3", `congestion clears at block 3: decisions ${log.join(",")}`, "ACCEPT", fin.payout === "ruling-confirmed" && b.paidSats === 0, JSON.stringify({ payout: fin.payout, b }), `attacker paid ${(await paidBy(attackerSponsor)) ? "their offered fee" : "0"}; honest paid 0`);
    }

    // ── C4: ruling block reorged after our child confirmed: paid is reversed to offered, re-submitted, paid once ──
    {
      const c = await contract("C4", 12);
      let prev: Observation | undefined; let t = await tick(c, "ruling", c.rA, 20_000, prev); prev = t.obs; await mine(rpc, 1);
      t = await tick(c, "ruling", c.rA, 20_000, prev); prev = t.obs;
      const paidOnce = t.b.paidSats;
      const h = await rpc<number>("getblockcount"); await rpc("invalidateblock", [await rpc<string>("getblockhash", [h])]);
      const t2 = await tick(c, "ruling", c.rA, 20_000, prev); prev = t2.obs;   // sees reorg, reconciles
      await mine(rpc, 2);
      const t3 = await tick(c, "ruling", c.rA, 20_000, prev);
      rec.record("C4", `child confirmed (paid ${paidOnce}), block invalidated → observer reports reorg, controller re-submits, re-confirms; paid counted once`, "ACCEPT", paidOnce > 0 && !!t2.obs.reorgedSince && t3.decision.action === "done" && t3.b.paidSats === paidOnce && t3.b.offeredSats === 0 && t3.obs.ruling.tx.height !== undefined, JSON.stringify({ reorg: t2.obs.reorgedSince, b: t3.b, height: t3.obs.ruling.tx.height }));
    }

    // ── C5: two contracts, one fee reserve: reservations prevent a double-spend race ──
    {
      const only = honestSponsors.filter((s) => !fs.readFileSync(path.join(tmp, "reservations.json"), "utf8").includes(s.txid));
      // Shrink the pool to exactly one free sponsor for this test.
      const pool = honestSponsors.splice(0, honestSponsors.length, only[0]);
      const c1 = await contract("C5a", 12), c2 = await contract("C5b", 12);
      let p1: Observation | undefined, p2: Observation | undefined;
      const t1 = await tick(c1, "ruling", c1.rA, 20_000, p1); p1 = t1.obs;
      const t2 = await tick(c2, "ruling", c2.rB, 20_000, p2); p2 = t2.obs;
      await mine(rpc, 1);
      const u1 = await tick(c1, "ruling", c1.rA, 20_000, p1); p1 = u1.obs;
      // c1's child confirmed; its change output is a new confirmed sponsor for c2.
      if (u1.st.ourChild) honestSponsors.push({ txid: u1.st.ourChild.txid, vout: 0, amount: BigInt(u1.st.ourChild.sponsor.amount) + ANCHOR_SATS - BigInt(u1.st.ourChild.fee) });
      const u2 = await tick(c2, "ruling", c2.rB, 20_000, p2); p2 = u2.obs; await mine(rpc, 1);
      const v2 = await tick(c2, "ruling", c2.rB, 20_000, p2);
      rec.record("C5", `contract 2 waited (${t2.decision.reason.slice(0, 40)}…) while contract 1 held the only sponsor; then proceeded on the confirmed change`, "ACCEPT", t1.decision.action === "submit" && t2.decision.action === "wait" && u1.decision.action === "done" && u2.decision.action === "submit" && v2.decision.action === "done", JSON.stringify({ t2: t2.decision, u2: u2.decision, v2: v2.decision }).slice(0, 200));
      honestSponsors.push(...pool.slice(1));
    }

    // ── C6: appeal stage shares the cap: reversal confirms before default maturity when affordable, loses when not ──
    for (const [name, cap, expectReversal] of [["C6a", 20_000, true], ["C6b", 2_000, false]] as const) {
      freshAttacker(); const c = await contract(name, 30);
      await rpc("generateblock", [await rpc<string>("getnewaddress"), [c.rA.raw]]);            // ruling to A confirmed explicitly
      await attackerPin(c.apA.raw, c.apA.txid, 1_300n);                                         // reversal pending, pinned low
      let prev: Observation | undefined; const log: string[] = [];
      for (let blk = 0; blk < W + 1; blk++) { await congest(90, 2_000n); const t = await tick(c, "appeal", c.apA, cap, prev); prev = t.obs; log.push(t.decision.action + (t.decision.fee ? ":" + t.decision.fee : "")); if (t.decision.action === "done") break; await mine(rpc, 1); }
      let fin = await observe(rpc, c.g, prev);
      if (fin.appeal.tx.state !== "confirmed") { const d = c.defaultTx("A", 50_000n); const ok = (await rpc<any[]>("testmempoolaccept", [[d]]))[0].allowed; if (ok) { await rpc("sendrawtransaction", [d]); await mine(rpc, 1); } fin = await observe(rpc, c.g, fin); }
      const b = ctl.load(name, cap);
      const ok = expectReversal ? fin.payout === "appeal-confirmed" && b.paidSats > 0 && b.paidSats <= cap : fin.payout === "default-or-coop-spent-q" && b.paidSats === 0;
      rec.record(name, `appeal stage, cap ${cap}: ${log.join(" → ")} → ${fin.payout}`, "ACCEPT", ok, JSON.stringify({ payout: fin.payout, b }), expectReversal ? "reversal paid for within cap, before W" : "cap exhausted: give-up; default award wins at W");
    }

    rec.report("Observer + bounded fee controller under congestion — Bitcoin Core " + (await rpc<any>("getnetworkinfo", [], "")).subversion, path.join(HERE, "codex-controller-fixed-results.json"), { minRelaySatPerVb: minRelay, blockMaxWeight: MAXW, budgets: JSON.parse(fs.readFileSync(path.join(tmp, "budgets.json"), "utf8")) });
  } finally { await node.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exit(1); });
