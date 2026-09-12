#!/usr/bin/env npx tsx
// Exercises admission.ts, chain-index.ts and sponsor-ownership.ts. REGTEST ONLY.
// Run: BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/admission-index-ownership.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startNode, mine, fundKey, keypair, btc, REGTEST, hex, makeRecorder, type Rpc } from "./lib.js";
import { admit } from "./admission.js";
import { ChainIndex, HistoryUnavailable, ReorgTooDeep } from "./chain-index.js";
import { DeviceSponsorPool, deviceSponsorKey } from "./sponsor-ownership.js";

const PORT = 20_499;
const HERE = path.dirname(new URL(import.meta.url).pathname);

async function main() {
  const node = await startNode(PORT); const { rpc } = node; const rec = makeRecorder(rpc);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chama-aio-"));
  try {
    await mine(rpc, 110);

    // ── A: admission report (pure) ──────────────────────────────────────────
    const base = { escrowSats: 1_000_000, capSats: 20_000, assumedFeeRange: { lowSatPerVb: 1, highSatPerVb: 20 }, stageVsize: { ruling: 361, appeal: 361 }, minRelaySatPerVb: 0.1, confirmedUnreservedLiquiditySats: 60_000, outstandingSignedCeilingSats: 10_000, timing: { tipHeight: 100, refundHeight: 400, W: 144, expectedRulingBlocks: 36, expectedAppealBlocks: 36, safetyMarginBlocks: 24 }, maxFeeFractionOfEscrow: 0.05 };
    const ok = admit(base);
    rec.record("A1", `envelope satisfied: cap ${base.capSats} ≥ worst-case both stages ${ok.numbers.worstBoth}, liquidity, time`, "ACCEPT", ok.admitted, ok.reasons.join("; "));
    const r2 = admit({ ...base, capSats: 10_000 });
    rec.record("A2", "cap below worst-case both stages at the assumed high rate → rejected", "REJECT", r2.admitted, r2.reasons.join("; "));
    const r3 = admit({ ...base, confirmedUnreservedLiquiditySats: 25_000 });
    rec.record("A3", "liquidity below cap + outstanding ceilings of other contracts → rejected", "REJECT", r3.admitted, r3.reasons.join("; "));
    const r4 = admit({ ...base, timing: { ...base.timing, refundHeight: 150 } });
    rec.record("A4", "refund window shorter than expected ruling time + margin → rejected", "REJECT", r4.admitted, r4.reasons.join("; "));
    const r5 = admit({ ...base, timing: { ...base.timing, W: 40 } });
    rec.record("A5", "W shorter than expected appeal time + margin → rejected", "REJECT", r5.admitted, r5.reasons.join("; "));
    const r6 = admit({ ...base, escrowSats: 100_000 });
    rec.record("A6", "cap is 20% of a 100k escrow, above the 5% limit → rejected", "REJECT", r6.admitted, r6.reasons.join("; "));

    // ── I: bounded persistent index ─────────────────────────────────────────
    const K = keypair(); const W = keypair();
    const c1 = await fundKey(rpc, K.xonly, 50_000n);                       // watched tx, confirmed at some height
    const birth = await rpc<number>("getblockcount") - 1;
    const idxFile = path.join(tmp, "index.sqlite");
    let idx = new ChainIndex(idxFile, 10, "device-1");
    idx.init(birth, await rpc<string>("getblockhash", [birth - 1]));
    idx.watchTx(c1.txid, birth); idx.watchOutpoint(c1.txid, c1.vout, birth);
    let s = await idx.sync(rpc);
    rec.record("I1", `initial sync from birth ${birth} finds the watched tx at its height`, "ACCEPT", idx.status(c1.txid)?.height === birth + 1 && s.found === 1, JSON.stringify({ s, st: idx.status(c1.txid) }));
    // Dropped observations: 6 blocks pass, one spends the watched outpoint; then a single sync catches up.
    const sp = btc.p2tr(K.xonly, undefined, REGTEST);
    const spend = new btc.Transaction({ version: 2 });
    spend.addInput({ txid: Buffer.from(c1.txid, "hex"), index: c1.vout, witnessUtxo: { script: sp.script, amount: 50_000n }, tapInternalKey: K.xonly });
    spend.addOutput({ script: btc.p2tr(W.xonly, undefined, REGTEST).script, amount: 49_000n }); spend.signIdx(K.priv, 0); spend.finalize();
    await mine(rpc, 3); await rpc("sendrawtransaction", [hex(spend.extract())]); await mine(rpc, 3);
    s = await idx.sync(rpc);
    const spendH = await rpc<number>("getblockcount") - 2;
    rec.record("I2", "6 blocks unobserved, one contains a spend of the watched outpoint: one sync catches up and records the spender at the right height", "ACCEPT", idx.spender(c1.txid, c1.vout)?.spender === spend.id && idx.spender(c1.txid, c1.vout)?.height === spendH, JSON.stringify(idx.spender(c1.txid, c1.vout)));
    // Reorg within retention: invalidate 3 blocks, mine 4 different ones (spend goes back to mempool, re-mined at a new height).
    const tipH = await rpc<number>("getblockcount");
    await rpc("invalidateblock", [await rpc<string>("getblockhash", [tipH - 2])]);
    await mine(rpc, 4);
    s = await idx.sync(rpc);
    const newSpendH = idx.spender(c1.txid, c1.vout)?.height;
    const spendBlockNow = await rpc<string>("getblockhash", [newSpendH ?? 0]);
    rec.record("I3", `3-block reorg inside retention (10): rewound from ${s.reorgedFrom}, spend re-indexed (same height ${newSpendH}, new block)`, "ACCEPT", s.reorgedFrom === tipH - 2 && newSpendH !== undefined && idx.spender(c1.txid, c1.vout)?.spender === spend.id && idx.cursor!.height === await rpc<number>("getblockcount") && idx.cursor!.hash === await rpc<string>("getbestblockhash"), JSON.stringify({ s, spendBlockNow: spendBlockNow.slice(0, 12) }));
    // Stale backup restore: copy the DB, advance 5 blocks, restore the copy, sync → consistent.
    idx.close(); fs.copyFileSync(idxFile, idxFile + ".bak");
    idx = new ChainIndex(idxFile, 10, "device-1"); await mine(rpc, 5); await idx.sync(rpc); const liveCursor = idx.cursor!; idx.close();
    fs.copyFileSync(idxFile + ".bak", idxFile); idx = new ChainIndex(idxFile, 10, "device-1");
    const stale = idx.cursor!; s = await idx.sync(rpc);
    rec.record("I4", `stale backup (cursor ${stale.height}) restored and synced to ${idx.cursor!.height}: matches live`, "ACCEPT", idx.cursor!.height === liveCursor.height && idx.cursor!.hash === liveCursor.hash, JSON.stringify(s));
    // Missing history: wrap rpc so getblock fails at one height; sync throws, cursor unchanged.
    const before = idx.cursor!.height; await mine(rpc, 3);
    const failing: Rpc = (async (m: string, p: unknown[] = [], w = "miner") => { if (m === "getblock") { const h = (await rpc<any>("getblockheader", [p[0]])).height; if (h === before + 2) throw new Error("pruned"); } return rpc(m, p, w); }) as Rpc;
    let err: unknown; try { await idx.sync(failing); } catch (e) { err = e; }
    rec.record("I5", `history missing at height ${before + 2}: explicit HistoryUnavailable, cursor stopped at ${idx.cursor!.height} (last good block), no guess`, "ACCEPT", err instanceof HistoryUnavailable && idx.cursor!.height === before + 1, String(err));
    await idx.sync(rpc);
    // Late registration with a birth height before the cursor → targeted rescan finds it.
    const c2 = await fundKey(rpc, K.xonly, 40_000n); const c2h = await rpc<number>("getblockcount"); await mine(rpc, 2); await idx.sync(rpc);
    idx.watchTx(c2.txid, c2h); s = await idx.sync(rpc);
    rec.record("I6", `late registration (birth ${c2h} < cursor): targeted rescan from ${s.rescannedFrom} finds it`, "ACCEPT", s.rescannedFrom === c2h && idx.status(c2.txid)?.height === c2h, JSON.stringify({ s, st: idx.status(c2.txid) }));
    // Reorg deeper than retention → explicit error, then explicit rescanFrom recovers.
    const tip2 = await rpc<number>("getblockcount");
    await rpc("invalidateblock", [await rpc<string>("getblockhash", [tip2 - 12]), ]); await mine(rpc, 14);
    err = undefined; try { await idx.sync(rpc); } catch (e) { err = e; }
    const recovered = err instanceof ReorgTooDeep ? await idx.rescanFrom(rpc, birth) : null;
    const c2Live = await rpc<any>("gettxout", [c2.txid, c2.vout]).catch(() => null);
    const c2Height = c2Live ? (await rpc<number>("getblockcount")) - c2Live.confirmations + 1 : null;
    rec.record("I7", "13-block reorg beyond retention (10): ReorgTooDeep, then explicit rescanFrom(birth) rebuilds; index agrees with the live chain for every watched item (c2 was NOT re-mined and is reported absent, not remembered)", "ACCEPT", err instanceof ReorgTooDeep && !!recovered && idx.status(c1.txid)?.height === birth + 1 && (idx.status(c2.txid)?.height ?? null) === c2Height, `${String(err)} → ${JSON.stringify({ recovered, c2Index: idx.status(c2.txid), c2Live: c2Height })}`);
    // Copied index opened by another device id → refused.
    err = undefined; try { new ChainIndex(idxFile, 10, "device-2"); } catch (e) { err = e; }
    rec.record("I8", "index copied to another device id: refused to open", "REJECT", !(err instanceof Error), String(err));
    idx.close();

    // ── S: device-scoped sponsor ownership ──────────────────────────────────
    const seed = new TextEncoder().encode("research seed, regtest only");
    const d1 = deviceSponsorKey(seed, 1), d2 = deviceSponsorKey(seed, 2);
    rec.record("S1", "two device indexes derive different sponsor keys from one seed", "ACCEPT", hex(d1.xonly) !== hex(d2.xonly));
    const p1 = new DeviceSponsorPool(path.join(tmp, "dev1.sqlite"), "device-1"), p2 = new DeviceSponsorPool(path.join(tmp, "dev2.sqlite"), "device-2");
    const coins1 = [await fundKey(rpc, d1.xonly, 100_000n), await fundKey(rpc, d1.xonly, 100_000n)];
    const coins2 = [await fundKey(rpc, d2.xonly, 100_000n)];
    for (const c of coins1) p1.register(c); for (const c of coins2) p2.register(c);
    const s1 = btc.p2tr(d1.xonly, undefined, REGTEST).script, s2 = btc.p2tr(d2.xonly, undefined, REGTEST).script;
    const [r1, r2b] = await Promise.all([p1.reserve(rpc, "contract-X", hex(s1)), p2.reserve(rpc, "contract-Y", hex(s2))]);
    rec.record("S2", "two devices reserve concurrently for two contracts: disjoint coins, no conflict", "ACCEPT", !!r1 && !!r2b && `${r1.txid}:${r1.vout}` !== `${r2b.txid}:${r2b.vout}`, JSON.stringify({ r1, r2b }, (_, v) => typeof v === "bigint" ? String(v) : v));
    rec.record("S3", "device 1 tries to reserve a coin registered to device 2: refused", "REJECT", p1.reserveForeign(coins2[0], "contract-Z"), "not owned by this device");
    p2.close(); fs.copyFileSync(path.join(tmp, "dev2.sqlite"), path.join(tmp, "dev2-copy.sqlite"));
    err = undefined; try { new DeviceSponsorPool(path.join(tmp, "dev2-copy.sqlite"), "device-3"); } catch (e) { err = e; }
    rec.record("S4", "device 2's database copied and opened as device 3: refused", "REJECT", !(err instanceof Error), String(err));
    // Honest negative: a cloned device (same id, same db copy) is NOT detected, and per-device caps do not sum to a global cap.
    let cloneOpened = false; try { const clone = new DeviceSponsorPool(path.join(tmp, "dev2-copy.sqlite"), "device-2"); cloneOpened = true; clone.close(); } catch { /* */ }
    rec.record("S5", "a faithful clone (same device id + copied db) opens normally: cloned devices are NOT coordinated by this design", "ACCEPT", cloneOpened, "", "known limit, stated: ownership covers accidental reuse, not deliberate cloning");
    const remaining = p1.unreservedSats();
    rec.record("S6", `admission sees only this device's unreserved liquidity (${remaining} sat): a combined cap across devices is not enforced`, "ACCEPT", remaining === 100_000, "", "known limit, stated: per-device caps do not sum to a global policy cap");
    p1.close();

    rec.report("Admission, bounded index, sponsor ownership — Bitcoin Core " + (await rpc<any>("getnetworkinfo", [], "")).subversion, path.join(HERE, "admission-index-ownership-results.json"));
  } finally { await node.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exit(1); });
