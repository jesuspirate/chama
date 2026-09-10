#!/usr/bin/env npx tsx
// Hostile fee handling for the fixed-payout ruling graph. REGTEST ONLY.
//
// The only anyone-can-spend output in a pre-signed ruling is its P2A anchor. This
// matrix asks: what can an attacker do with that anchor, what does it cost them,
// and what does it cost the honest side to win? Every row is decided by Bitcoin
// Core 31.1 mempool policy (TRUC / BIP 431, RBF, P2A) on a private regtest node.
//
// Run: BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/pinning-matrix.ts
import * as path from "node:path";
import { startNode, mine, fundKey, keypair, fundingTree, appealTree, newSpend, addToTree, addP2A, finalize, txidOf, anchorChild, makeRecorder, ANCHOR_SATS, btc, hex, hexToBytes, REGTEST, type Roles } from "./lib.js";

const PORT = 18_799;
const ESCROW = 100_000n;
const W = 20;

async function main() {
  const node = await startNode(PORT);
  const { rpc } = node;
  const rec = makeRecorder(rpc);
  try {
    await mine(rpc, 110);
    const A = keypair(), B = keypair(), R = keypair(), P = keypair();
    const roles: Roles = { A: A.xonly, B: B.xonly, R: R.xonly, P: P.xonly };
    const HONEST = keypair(), ATTACKER = keypair();
    const funder = await fundKey(rpc, A.xonly, 2_000_000n);
    const honestSponsors = [] as Awaited<ReturnType<typeof fundKey>>[];
    const attackerSponsors = [] as Awaited<ReturnType<typeof fundKey>>[];
    for (let i = 0; i < 6; i++) { honestSponsors.push(await fundKey(rpc, HONEST.xonly, 200_000n)); attackerSponsors.push(await fundKey(rpc, ATTACKER.xonly, 200_000n)); }

    const tip = await rpc<number>("getblockcount");
    const F = fundingTree(roles, tip + 1 + 2000);
    const QA = appealTree(roles, "A", W);
    // Funding: 6 F outputs.
    const fp = btc.p2tr(A.xonly, undefined, REGTEST);
    const ftx = new btc.Transaction({ version: 2 });
    ftx.addInput({ txid: hexToBytes(funder.txid), index: funder.vout, witnessUtxo: { script: fp.script, amount: funder.amount }, tapInternalKey: A.xonly });
    for (let i = 0; i < 6; i++) addToTree(ftx, F, ESCROW);
    ftx.addOutput({ script: fp.script, amount: funder.amount - 6n * ESCROW - 2_000n });
    ftx.signIdx(A.priv, 0); ftx.finalize();
    const fundingHex = hex(ftx.extract());
    const [tma] = await rpc<any[]>("testmempoolaccept", [[fundingHex]]);
    if (!tma.allowed) { console.error("funding rejected", tma, funder, await rpc("gettxout", [funder.txid, funder.vout])); throw new Error("funding"); }
    await rpc("sendrawtransaction", [fundingHex]); await mine(rpc, 1);
    const fOut = (i: number) => ({ txid: ftx.id, vout: i, amount: ESCROW });

    // Zero-fee ruling template R_A (pre-signed by A, B; completed by R) for each F.
    const ruling = (i: number) => {
      const t = newSpend(F, "ruling", fOut(i)); addToTree(t, QA, ESCROW - ANCHOR_SATS); addP2A(t);
      t.signIdx(A.priv, 0); t.signIdx(B.priv, 0); t.signIdx(R.priv, 0);
      return finalize(t, F, "ruling");
    };
    const minRelay = 1; // sat/vB on regtest default (minrelaytxfee 1000 sat/kvB)
    const confs = async (txid: string) => ((await rpc<any>("gettxout", [txid, 0]))?.confirmations ?? 0) as number;
    const vsizeOf = async (raw: string) => (await rpc<any>("decoderawtransaction", [raw])).vsize as number;

    // ── M1: attacker pins with a maximal, low-feerate child; honest side must replace ──
    {
      const parent = ruling(0); const ptxid = txidOf(parent);
      // Attacker child: padded toward the TRUC child ceiling (1000 vB), at ~1 sat/vB.
      const pin = anchorChild(ptxid, 1, attackerSponsors[0], ATTACKER, 1_300n, { padBytes: 825 });
      const pinV = await vsizeOf(pin);
      const pkg = await rpc<any>("submitpackage", [[parent, pin]]);
      rec.record("M1a", `attacker pins: zero-fee ruling + ${pinV} vB child at ~${(1300 / (pinV + 208)).toFixed(2)} sat/vB package`, "ACCEPT", pkg.package_msg === "success", JSON.stringify(pkg));
      // Replacement rules (BIP125 as applied by Core + TRUC sibling eviction). Rather than
      // assert the formula, MEASURE the exact minimum accepted replacement fee.
      const probeV = await vsizeOf(anchorChild(ptxid, 1, honestSponsors[0], HONEST, 2_000n));
      const minAccepted = async (sponsor: typeof honestSponsors[0], attackerFee: bigint) => {
        for (let f = attackerFee; f <= attackerFee + 2_000n; f++) {
          const [r] = await rpc<any[]>("testmempoolaccept", [[anchorChild(ptxid, 1, sponsor, HONEST, f)]]);
          if (r.allowed) return f;
        }
        throw new Error("no replacement accepted");
      };
      const thr = await minAccepted(honestSponsors[0], 1_300n);
      await rec.probe("M1b", `honest sibling eviction one sat below the measured threshold (${thr - 1n} sat)`, anchorChild(ptxid, 1, honestSponsors[0], HONEST, thr - 1n), "REJECT");
      const honest2 = anchorChild(ptxid, 1, honestSponsors[0], HONEST, thr);
      await rec.probe("M1c", `honest sibling eviction at the measured threshold (${thr} sat)`, honest2, "ACCEPT", `pin cost to honest side = attacker's fee + ${thr - 1_300n} sat for a ${probeV} vB child`);
      await rpc("sendrawtransaction", [honest2]);
      const mem = await rpc<string[]>("getrawmempool");
      rec.record("M1d", "after replacement: attacker child evicted, honest child + ruling in mempool", "ACCEPT", mem.includes(txidOf(honest2)) && !mem.includes(txidOf(pin)) && mem.includes(ptxid), JSON.stringify(mem));
      await mine(rpc, 1);
      rec.record("M1e", "ruling confirmed after honest replacement", "ACCEPT", (await confs(ptxid)) === 1);
    }

    // ── M2: attacker pins at a HIGH feerate. Honest cost tracks the attacker's own spend. ──
    {
      const parent = ruling(1); const ptxid = txidOf(parent);
      const pin = anchorChild(ptxid, 1, attackerSponsors[1], ATTACKER, 12_000n, { padBytes: 825 });
      const pinV = await vsizeOf(pin);
      const pkg = await rpc<any>("submitpackage", [[parent, pin]]);
      rec.record("M2a", `attacker pins at ${(12000 / pinV).toFixed(1)} sat/vB with ${pinV} vB (attacker burns 12000 sat)`, "ACCEPT", pkg.package_msg === "success", JSON.stringify(pkg));
      let thr2 = 12_000n;
      for (; thr2 <= 14_000n; thr2++) { const [r] = await rpc<any[]>("testmempoolaccept", [[anchorChild(ptxid, 1, honestSponsors[1], HONEST, thr2)]]); if (r.allowed) break; }
      await rec.probe("M2b", `honest replacement one sat below the measured threshold (${thr2 - 1n} sat)`, anchorChild(ptxid, 1, honestSponsors[1], HONEST, thr2 - 1n), "REJECT");
      const honest = anchorChild(ptxid, 1, honestSponsors[1], HONEST, thr2);
      await rec.probe("M2c", `honest replacement at the measured threshold (${thr2} sat = attacker fee + ${thr2 - 12_000n})`, honest, "ACCEPT", "attacker burns ~what the honest side pays: griefing is bounded and symmetric");
      await rpc("sendrawtransaction", [honest]); await mine(rpc, 1);
    }

    // ── M3: TRUC ceilings bound the pin. Oversize child, extra child, non-v3 child. ──
    {
      const parent = ruling(2); const ptxid = txidOf(parent);
      await rpc("submitpackage", [[parent, anchorChild(ptxid, 1, honestSponsors[2], HONEST, 2_000n)]]);
      const big = anchorChild(ptxid, 1, attackerSponsors[2], ATTACKER, 30_000n, { padBytes: 1_200 });
      await rec.probe("M3a", `attacker child over the TRUC 1000 vB child ceiling (${await vsizeOf(big)} vB), even at high fee`, big, "REJECT");
      const v2 = anchorChild(ptxid, 1, attackerSponsors[2], ATTACKER, 5_000n, { version: 2 });
      await rec.probe("M3b", "attacker non-v3 child of a v3 parent", v2, "REJECT");
      // Second child: the parent's only other output is Q_A, which needs A+B or P+A+B. Nothing else to pin.
      rec.record("M3c", "second pin vector: parent has no other anyone-can-spend output (Q needs principal keys)", "REJECT", false, "structural: only one anchor exists", "not a mempool probe");
      await mine(rpc, 1);
    }

    // ── M4: sponsor liquidity must be confirmed (TRUC: one unconfirmed parent only). ──
    {
      const parent = ruling(3); const ptxid = txidOf(parent);
      // Honest party has only an UNCONFIRMED sponsor UTXO (sent to itself, v3, in mempool).
      const hp = btc.p2tr(HONEST.xonly, undefined, REGTEST);
      const self = new btc.Transaction({ version: 3 });
      self.addInput({ txid: hexToBytes(honestSponsors[3].txid), index: honestSponsors[3].vout, witnessUtxo: { script: hp.script, amount: 200_000n }, tapInternalKey: HONEST.xonly, sequence: 0xfffffffd });
      self.addOutput({ script: hp.script, amount: 199_000n });
      self.signIdx(HONEST.priv, 0); self.finalize();
      const selfHex = hex(self.extract());
      await rpc("sendrawtransaction", [selfHex]);
      const child = anchorChild(ptxid, 1, { txid: self.id, vout: 0, amount: 199_000n }, HONEST, 2_000n);
      const pkg = await rpc<any>("submitpackage", [[parent, child]]);
      rec.record("M4a", "anchor child spending an UNCONFIRMED sponsor (two unconfirmed parents)", "REJECT", pkg.package_msg === "success", JSON.stringify(Object.values(pkg["tx-results"] ?? {}).map((r: any) => r.error)).slice(0, 220), "confirmed fee liquidity is a hard requirement");
      await mine(rpc, 1);
      const child2 = anchorChild(ptxid, 1, { txid: self.id, vout: 0, amount: 199_000n }, HONEST, 2_000n);
      const pkg2 = await rpc<any>("submitpackage", [[parent, child2]]);
      rec.record("M4b", "same child once the sponsor is confirmed", "ACCEPT", pkg2.package_msg === "success", JSON.stringify(pkg2).slice(0, 160));
      await mine(rpc, 1);
    }

    // ── M5: a pin at min-relay feerate is still a confirmable package. ──
    {
      const parent = ruling(4); const ptxid = txidOf(parent);
      const pin = anchorChild(ptxid, 1, attackerSponsors[4], ATTACKER, 1_300n, { padBytes: 825 });
      await rpc("submitpackage", [[parent, pin]]);
      await mine(rpc, 1);
      rec.record("M5a", "attacker's min-relay pin gets mined when blocks are not full: attacker paid to confirm the honest ruling", "ACCEPT", (await confs(ptxid)) === 1, "", "a pin only delays under fee pressure; the ruling is never lost");
    }

    rec.report("Hostile fee matrix — Bitcoin Core " + (await rpc<any>("getnetworkinfo", [], "")).subversion,
      path.join(path.dirname(new URL(import.meta.url).pathname), "pinning-results.json"),
      { params: { ESCROW: Number(ESCROW), ANCHOR_SATS: Number(ANCHOR_SATS), minRelaySatPerVb: minRelay } });
  } finally { await node.stop(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
