#!/usr/bin/env npx tsx
// Distributed RECOVERY-READY lifecycle, v3. Four separate processes (A, B, R, P), four
// stores, one dumb relay directory. REGTEST ONLY.
// Run: BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/codex-lifecycle-v3.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson } from "./contract-context.js";
import { sha256, schnorr, hexToBytes, startNode, mine, fundKey, keypair, hex, makeRecorder, CRASH_POINTS, btc, REGTEST } from "./lib.js";

const PORT = 19899;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PARTY = path.join(HERE, "party.ts");
const TSX = path.join(HERE, "../../../node_modules/.bin/tsx");
const IDS = ["R_A", "R_B", "AP_A", "AP_B"];
type Role = "A" | "B" | "R" | "P";

function runParty(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(TSX, [PARTY, ...args], { env: { ...process.env, RPC_PORT: String(PORT), ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function main() {
  const node = await startNode(PORT); const { rpc } = node; const rec = makeRecorder(rpc);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chama-distributed-"));
  const confs = async (txid: string) => ((await rpc<any>("gettxout", [txid, 0]).catch(() => null))?.confirmations ?? 0) as number;
  try {
    await mine(rpc, 110);

    async function scenario(name: string) {
      const dir = path.join(root, name); fs.mkdirSync(dir);
      const relay = path.join(dir, "relay"); fs.mkdirSync(relay);
      const esc = { A: keypair(), B: keypair(), R: keypair(), P: keypair() };
      const ids = { A: keypair(), B: keypair(), R: keypair(), P: keypair() };
      const funder = await fundKey(rpc, esc.A.xonly, 500_000n);
      const tip = await rpc<number>("getblockcount");
      const terms = { net: "regtest", escrowSats: "100000", W: 20, refundHeight: tip + 400,
        keys: Object.fromEntries((["A", "B", "R", "P"] as Role[]).map((r) => [r, hex(esc[r].xonly)])),
        idKeys: Object.fromEntries((["A", "B", "R", "P"] as Role[]).map((r) => [r, hex(ids[r].xonly)])),
        funderInput: { txid: funder.txid, vout: funder.vout, amount: String(funder.amount) } };
      const termsFile = path.join(dir, "terms.json"); fs.writeFileSync(termsFile, JSON.stringify(terms));
      const stores: Record<Role, string> = { A: "", B: "", R: "", P: "" };
      for (const r of ["A", "B", "R", "P"] as Role[]) {
        stores[r] = path.join(dir, `store-${r}`); fs.mkdirSync(stores[r]);
        fs.writeFileSync(path.join(stores[r], "keys.json"), JSON.stringify({ escrow: hex(esc[r].priv), id: hex(ids[r].priv) }));   // own keys ONLY
      }
      const run = (r: Role, env: Record<string, string> = {}, storeDir = stores[r]) => runParty(["run", "--role", r, "--store", storeDir, "--relay", relay, "--terms", termsFile], env);
      const recover = async (r: Role, storeDir = stores[r]) => JSON.parse((await runParty(["recover", "--role", r, "--store", storeDir])).out);
      const cmdHex = async (c: string, r: Role, extra: string[], storeDir = stores[r]) => (await runParty([c, "--role", r, "--store", storeDir, ...extra])).out.trim();
      return { dir, relay, termsFile, terms, esc, stores, run, recover, cmdHex };
    }
    const allComplete = (rc: any, ids = IDS) => ids.every((id) => rc.templates[id]?.principalSigs === 2);

    // Bind every nested term; old v2 encoder demonstrably erased them.
    {
      const s = await scenario("canonical");
      const old = (t: any) => JSON.stringify(t, Object.keys(t).sort());
      const variants = [
        {...s.terms, keys: {...s.terms.keys, P: hex(keypair().xonly)}},
        {...s.terms, idKeys: {...s.terms.idKeys, P: hex(keypair().xonly)}},
        {...s.terms, funderInput: {...s.terms.funderInput, txid: "aa".repeat(32)}},
        {...s.terms, funderInput: {...s.terms.funderInput, vout: 999}},
        {...s.terms, funderInput: {...s.terms.funderInput, amount: "600000"}},
      ];
      rec.record("N1", "v2 encoder collision reproduced for five nested-term mutations", "ACCEPT", variants.every(v => old(v) === old(s.terms)), "", old(s.terms));
      rec.record("N2", "fixed encoding distinguishes all five mutations and ignores object insertion order", "ACCEPT", variants.every(v => canonicalJson(v) !== canonicalJson(s.terms)) && canonicalJson({...s.terms, keys: Object.fromEntries(Object.entries(s.terms.keys).reverse())}) === canonicalJson(s.terms));
    }

    // ── D1: happy path, four concurrent processes; then every role acts from its store, offline ──
    {
      const s = await scenario("happy");
      const runs = Promise.all((["A", "B", "R", "P"] as Role[]).map((r) => s.run(r, { MAX_WAIT_MS: "40000" })));
      // B needs the funding confirmed before it reports done: mine once the funding shows up.
      for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await rpc<string[]>("getrawmempool")).length) { await mine(rpc, 1); break; } }
      const [a, b, r, p] = await runs;
      rec.record("D1a", "A funded, B confirmed, R stored, P stored (exit 0/0/0/0)", "ACCEPT", [a, b, r, p].every((x) => x.code === 0), `${a.code}/${b.code}/${r.code}/${p.code} ${b.err.slice(-120)}`);
      // OFFLINE RESTORE: copy each store to a fresh directory, delete relay and terms, recover from the copy alone.
      fs.rmSync(s.relay, { recursive: true }); fs.rmSync(s.termsFile);
      const copies: Record<Role, string> = { A: "", B: "", R: "", P: "" };
      for (const r of ["A", "B", "R", "P"] as Role[]) { copies[r] = path.join(s.dir, `restore-${r}`); fs.cpSync(s.stores[r], copies[r], { recursive: true }); }
      const rc = Object.fromEntries(await Promise.all((["A", "B", "R", "P"] as Role[]).map(async (r) => [r, await s.recover(r, copies[r])]))) as Record<Role, any>;
      const same = IDS.every((id) => new Set((["A", "B", "R", "P"] as Role[]).map((r) => rc[r].templates[id].txid)).size === 1);
      const ok = allComplete(rc.A) && allComplete(rc.B) && allComplete(rc.R, ["R_A", "R_B"]) && allComplete(rc.P, ["AP_A", "AP_B"]) && new Set(Object.values(rc).map((x: any) => x.contract)).size === 1;
      rec.record("D1b", "offline restore from a copied store (relay + terms deleted): identical templates, contract id, complete sigs per role", "ACCEPT", same && ok, JSON.stringify(rc).slice(0, 240));
      // R rules from its restored copy; mined directly (zero-fee template).
      const ruling = await s.cmdHex("rule", "R", ["--winner", "A"], copies.R);
      const blk = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [ruling]]).catch((e) => ({ error: String(e) }));
      rec.record("D1c", "R rules R_A from the restored copy; mined", "ACCEPT", !!blk.hash, JSON.stringify(blk).slice(0, 100));
      // P reverses from its restored copy; mined.
      const appeal = await s.cmdHex("appeal", "P", ["--winner", "A"], copies.P);
      const blk2 = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [appeal]]).catch((e) => ({ error: String(e) }));
      rec.record("D1d", "P completes the pre-signed reversal AP_A from its restored copy; mined (pays B)", "ACCEPT", !!blk2.hash, JSON.stringify(blk2).slice(0, 100));
      // Terminal-state restarts are idempotent.
      const re = await Promise.all((["A", "B", "R", "P"] as Role[]).map((r) => s.run(r, { MAX_WAIT_MS: "5000" }, copies[r])));
      rec.record("D1e", "restarting every completed participant exits 0 immediately", "ACCEPT", re.every((x) => x.code === 0), re.map((x) => x.code).join("/"));
    }

    // ── D2: crash matrix ──────────────────────────────────────────────────
    for (const point of CRASH_POINTS) {
      const who = point.split(":")[0] as Role;
      const s = await scenario(`crash-${point.replace(/[^a-z-]/gi, "_")}`);
      const others = (["A", "B", "R", "P"] as Role[]).filter((r) => r !== who);
      const otherRuns = Promise.all(others.map((r) => s.run(r, { MAX_WAIT_MS: "40000" })));
      const first = await s.run(who, { CRASH_AT: point, MAX_WAIT_MS: "40000" });
      const secondP = first.code === 99 ? s.run(who, { MAX_WAIT_MS: "40000" }) : Promise.resolve(first);
      for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await rpc<string[]>("getrawmempool")).length) { await mine(rpc, 1); break; } }
      const [second, rest] = await Promise.all([secondP, otherRuns]);
      const rc = await s.recover(who);
      const funded = (await confs(rc.fundingTxid)) >= 1;
      const ok = first.code === 99 && second.code === 0 && rest.every((x) => x.code === 0) && allComplete(rc, [...IDS].filter((id) => who === "R" ? id.startsWith("R_") : who === "P" ? id.startsWith("AP_") : true)) && funded;
      rec.record(`D2:${point}`, `crash at ${point}: exit 99, restart completes, store complete, funding CONFIRMED`, "ACCEPT", ok, `codes ${first.code}/${second.code}/${rest.map((x) => x.code)} ${second.err.slice(-160)}`);
    }

    // ── D3: tamper / forge / malformed / cross-contract replay ────────────
    {
      const s = await scenario("tamper");
      const [a] = await Promise.all([s.run("A", { MAX_WAIT_MS: "15000" }), s.run("B", { TAMPER: "1", MAX_WAIT_MS: "15000" })]);
      const st = JSON.parse(fs.readFileSync(path.join(s.stores.A, "state.json"), "utf8"));
      rec.record("D3a", "B signs AP_A paying itself +1 sat: A aborts (exit 2), never signs funding", "ACCEPT", a.code === 2 && st.phase === "aborted" && !st.signedFundingHex && !(await rpc<string[]>("getrawmempool")).length, `A ${a.code} ${st.abort ?? ""}`);
    }
    {
      const s = await scenario("forge");
      const [a] = await Promise.all([s.run("A", { MAX_WAIT_MS: "6000" }), s.run("B", { FORGE: "1", MAX_WAIT_MS: "6000" })]);
      const st = JSON.parse(fs.readFileSync(path.join(s.stores.A, "state.json"), "utf8"));
      rec.record("D3b", "B's messages carry a wrong identity signature: ignored; A times out unfunded (exit 3)", "ACCEPT", a.code === 3 && st.phase === "signed", `A ${a.code} phase ${st.phase}`);
    }
    {
      const s = await scenario("malformed");
      fs.writeFileSync(path.join(s.relay, "00000000000000-B-SIGS.json"), "{");
      fs.writeFileSync(path.join(s.relay, "00000000000001-B-READY.json"), JSON.stringify({ v: 1, net: "regtest", contract: "00", from: "B", kind: "READY", payload: 1, sig: "zz" }));
      fs.writeFileSync(path.join(s.relay, "00000000000002-B-SIGS.json"), "x".repeat(20_000));
      const runs = Promise.all((["A", "B", "R", "P"] as Role[]).map((r) => s.run(r, { MAX_WAIT_MS: "40000" })));
      for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await rpc<string[]>("getrawmempool")).length) { await mine(rpc, 1); break; } }
      const res = await runs;
      rec.record("D3c", "truncated JSON, wrong-schema, and oversize relay files present: all four participants still complete", "ACCEPT", res.every((x) => x.code === 0) && /dropped/.test(res[0].err), res.map((x) => x.code).join("/"));
    }
    {
      // Same identities, two contracts: replay contract-1 messages into contract-2's relay.
      const s1 = await scenario("replay-1");
      const [a1] = await Promise.all([s1.run("A", { MAX_WAIT_MS: "15000" }), s1.run("B", { MAX_WAIT_MS: "15000" })]);
      const s2 = await scenario("replay-2");
      for (const r of ["A", "B"] as Role[]) fs.writeFileSync(path.join(s2.stores[r], "keys.json"), fs.readFileSync(path.join(s1.stores[r], "keys.json")));
      const t2 = { ...s2.terms, keys: { ...s2.terms.keys, A: s1.terms.keys.A, B: s1.terms.keys.B }, idKeys: { ...s2.terms.idKeys, A: s1.terms.idKeys.A, B: s1.terms.idKeys.B } };
      fs.writeFileSync(s2.termsFile, JSON.stringify(t2));
      for (const f of fs.readdirSync(s1.relay)) fs.copyFileSync(path.join(s1.relay, f), path.join(s2.relay, f));   // replayed, authentically signed
      const a2 = await s2.run("A", { MAX_WAIT_MS: "6000" });
      const st = JSON.parse(fs.readFileSync(path.join(s2.stores.A, "state.json"), "utf8"));
      rec.record("D3d", "authentic messages from contract 1 replayed into contract 2 (same identities): dropped by contract binding; A times out unfunded", "ACCEPT", a1.code === 0 && a2.code === 3 && st.phase === "signed" && /other contract/.test(a2.err), `a1 ${a1.code} a2 ${a2.code} phase ${st.phase}`);
    }

    // A correctly authenticated malformed SIGS must not hide a later valid SIGS.
    {
      const s = await scenario("authenticated-malformed");
      const body = {v:2, net:"regtest", contract:hex(sha256(new TextEncoder().encode(canonicalJson(s.terms)))), from:"B", kind:"SIGS", payload:{}};
      const bkeys = JSON.parse(fs.readFileSync(path.join(s.stores.B,"keys.json"),"utf8"));
      const sig = hex(schnorr.sign(sha256(new TextEncoder().encode(JSON.stringify(body))),hexToBytes(bkeys.id)));
      fs.writeFileSync(path.join(s.relay,"000-authenticated-malformed.json"),JSON.stringify({...body,sig}));
      const runs = Promise.all((["A","B","R","P"] as Role[]).map(r=>s.run(r)));
      for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,100));if((await rpc<string[]>("getrawmempool")).length){await mine(rpc,1);break;}}
      const result=await runs;
      rec.record("N3", "authenticated malformed SIGS does not suppress later valid signatures", "ACCEPT", result.every(r=>r.code===0), result.map(r=>r.code).join("/"));
    }

    // ── D4: late arbiter and late panel reconstruct from relay + terms only ─
    {
      const s = await scenario("late");
      const runs = Promise.all([s.run("A"), s.run("B")]);
      for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await rpc<string[]>("getrawmempool")).length) { await mine(rpc, 1); break; } }
      const [a, b] = await runs;
      const [r, p] = await Promise.all([s.run("R"), s.run("P")]);
      const ruling = await s.cmdHex("rule", "R", ["--winner", "B"]);
      const blk = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [ruling]]).catch((e) => ({ error: String(e) }));
      const appeal = await s.cmdHex("appeal", "P", ["--winner", "B"]);
      const blk2 = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [appeal]]).catch((e) => ({ error: String(e) }));
      rec.record("D4", "R and P absent during setup; join after funding; R rules R_B, P reverses AP_B; both mined", "ACCEPT", [a, b, r, p].every((x) => x.code === 0) && !!blk.hash && !!blk2.hash, `${a.code}/${b.code}/${r.code}/${p.code}`);
    }

    // ── D5: funding block reorged after READY: nothing changes for anyone ──
    {
      const s = await scenario("reorg");
      const runs = Promise.all([s.run("A"), s.run("B"), s.run("R")]);
      let fundingTxid = "";
      for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 100)); const m = await rpc<string[]>("getrawmempool"); if (m.length) { fundingTxid = m[0]; await mine(rpc, 1); break; } }
      await runs;
      const h = await rpc<number>("getblockcount");
      await rpc("invalidateblock", [await rpc<string>("getblockhash", [h])]);
      const beforeStatus = JSON.parse(fs.readFileSync(path.join(s.stores.B,"state.json"),"utf8"));
      const status = JSON.parse(await s.cmdHex("status","B",[]));
      rec.record("N4", "status clears stale funding confirmation immediately after invalidation", "ACCEPT", beforeStatus.fundingConfirmed === true && status.fundingConfirmed === false && status.confirmations === 0 && JSON.stringify(beforeStatus) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(s.stores.B,"state.json"),"utf8"))), "", JSON.stringify(status));
      const backInMempool = (await rpc<string[]>("getrawmempool")).includes(fundingTxid);
      await mine(rpc, 2);
      const refreshed = JSON.parse(await s.cmdHex("status","B",[]));
      rec.record("N5", "status observes funding confirmation again on the replacement chain", "ACCEPT", refreshed.fundingConfirmed === true && refreshed.confirmations >= 2);
      const rc = await s.recover("R");
      const ruling = await s.cmdHex("rule", "R", ["--winner", "A"]);
      const blk = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [ruling]]).catch((e) => ({ error: String(e) }));
      rec.record("D5", "funding block invalidated after setup: funding returns to mempool, re-mined at a new height, templates unchanged, ruling mined", "ACCEPT", backInMempool && rc.fundingTxid === fundingTxid && !!blk.hash, `back=${backInMempool} ${JSON.stringify(blk).slice(0, 80)}`);
    }

    // Complete the principal-owned fallback commands from restored stores.
    for (const mode of ["refund", "collect"] as const) {
      const s=await scenario(`offline-${mode}`);
      const runs=Promise.all((["A","B","R","P"] as Role[]).map(r=>s.run(r)));
      for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,100));if((await rpc<string[]>("getrawmempool")).length){await mine(rpc,1);break;}}
      const completed=await runs;
      if(!completed.every(r=>r.code===0)) throw new Error("offline setup failed");
      const copy=path.join(s.dir,"restore-A");fs.cpSync(s.stores.A,copy,{recursive:true});
      fs.rmSync(s.relay,{recursive:true});fs.rmSync(s.termsFile);
      if(mode==="collect") {
        const raw=await s.cmdHex("rule","R",["--winner","A"]);
        await rpc("generateblock",[await rpc("getnewaddress"),[raw]]);await mine(rpc,s.terms.W-1);
      } else await mine(rpc,s.terms.refundHeight-await rpc<number>("getblockcount"));
      const raw=await s.cmdHex(mode,"A",["--winner","A","--to",hex(btc.p2tr(s.esc.A.xonly,undefined,REGTEST).script)],copy);
      const block=await rpc<any>("generateblock",[await rpc("getnewaddress"),[raw]]);
      rec.record(`N6-${mode}`, `offline copied funder store completes ${mode} and transaction mines`, "ACCEPT", !!block.hash);
    }

    rec.report("Distributed recovery-ready lifecycle v3 — Bitcoin Core " + (await rpc<any>("getnetworkinfo", [], "")).subversion, path.join(HERE, "codex-lifecycle-v3-results.json"), { crashPoints: CRASH_POINTS });
  } finally { await node.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exit(1); });
