#!/usr/bin/env npx tsx
// Distributed RECOVERY-READY setup: three separate processes, three separate stores,
// one dumb relay directory, crash injection at every boundary, tampering, forgery,
// a late arbiter — then completion on regtest from each store alone. REGTEST ONLY.
//
// Run: BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/distributed-setup.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startNode, mine, fundKey, keypair, hex, makeRecorder, CRASH_POINTS } from "./lib.js";

const PORT = 19_899;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PARTY = path.join(HERE, "party.ts");
const TSX = path.join(HERE, "../../../node_modules/.bin/tsx");

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
  try {
    await mine(rpc, 110);

    async function scenario(name: string) {
      const dir = path.join(root, name); fs.mkdirSync(dir);
      const relay = path.join(dir, "relay"); fs.mkdirSync(relay);
      const esc = { A: keypair(), B: keypair(), R: keypair(), P: keypair() };
      const ids = { A: keypair(), B: keypair(), R: keypair() };
      const funder = await fundKey(rpc, esc.A.xonly, 500_000n);
      const tip = await rpc<number>("getblockcount");
      const terms = { escrowSats: "100000", W: 20, refundHeight: tip + 400, keys: { A: hex(esc.A.xonly), B: hex(esc.B.xonly), R: hex(esc.R.xonly), P: hex(esc.P.xonly) }, idKeys: { A: hex(ids.A.xonly), B: hex(ids.B.xonly), R: hex(ids.R.xonly) }, funderInput: { txid: funder.txid, vout: funder.vout, amount: String(funder.amount) } };
      const termsFile = path.join(dir, "terms.json"); fs.writeFileSync(termsFile, JSON.stringify(terms));
      const stores: Record<string, string> = {};
      for (const r of ["A", "B", "R"] as const) {
        stores[r] = path.join(dir, `store-${r}`); fs.mkdirSync(stores[r]);
        fs.writeFileSync(path.join(stores[r], "keys.json"), JSON.stringify({ escrow: hex(esc[r].priv), id: hex(ids[r].priv) }));   // own keys ONLY
      }
      const run = (r: "A" | "B" | "R", env: Record<string, string> = {}) => runParty(["run", "--role", r, "--store", stores[r], "--relay", relay, "--terms", termsFile], env);
      const recover = async (r: "A" | "B" | "R") => JSON.parse((await runParty(["recover", "--role", r, "--store", stores[r], "--terms", termsFile])).out);
      const ruleHex = async (w: "A" | "B") => (await runParty(["rule", "--role", "R", "--store", stores.R, "--terms", termsFile, "--winner", w])).out.trim();
      return { run, recover, ruleHex, stores, terms, relay };
    }

    // ── D1: happy path, three concurrent processes ──────────────────────────
    {
      const s = await scenario("happy");
      const [a, b, r] = await Promise.all([s.run("A"), s.run("B"), s.run("R")]);
      rec.record("D1a", "A funded, B ready, R stored (exit codes 0/0/0)", "ACCEPT", a.code === 0 && b.code === 0 && r.code === 0, `${a.code}/${b.code}/${r.code} ${a.err.slice(-200)}`);
      const [ra, rb, rr] = await Promise.all([s.recover("A"), s.recover("B"), s.recover("R")]);
      const same = ["R_A", "R_B", "AP_A", "AP_B"].every((id) => ra.templates[id].txid === rb.templates[id].txid && rb.templates[id].txid === rr.templates[id].txid);
      const complete = ["R_A", "R_B", "AP_A", "AP_B"].every((id) => ra.templates[id].principalSigs === 2 && rb.templates[id].principalSigs === 2 && rr.templates[id].principalSigs === 2);
      rec.record("D1b", "each store alone rebuilds identical templates with both principal signatures", "ACCEPT", same && complete, JSON.stringify({ ra, rb, rr }).slice(0, 300));
      await mine(rpc, 1);
      const hexR = await s.ruleHex("B");
      await rec.probe("D1c", "R completes ruling R_B from R's store alone (zero-fee template)", hexR, "REJECT", "zero-fee: needs an anchor child; structure is valid");
      const [tma] = await rpc<any[]>("testmempoolaccept", [[hexR]]);
      rec.record("D1d", "…and the rejection is fee-only, not script/signature", "ACCEPT", /min relay fee/.test(tma["reject-reason"] ?? ""), tma["reject-reason"]);
      const blk = await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [hexR]]).catch((e) => ({ error: String(e) }));
      rec.record("D1e", "ruling R_B mined directly (consensus-valid from R's store)", "ACCEPT", !!blk.hash, JSON.stringify(blk));
    }

    // Counterexamples: terminal-state restart and malformed transport input.
    {
      const s = await scenario("audit-terminal");
      await Promise.all([s.run("A"), s.run("B"), s.run("R")]);
      const [a, r] = await Promise.all([s.run("A", { MAX_WAIT_MS: "1000" }), s.run("R", { MAX_WAIT_MS: "1000" })]);
      rec.record("C1", "completed A and R restart time out instead of succeeding (known defect)", "ACCEPT", a.code === 3 && r.code === 3, `A=${a.code}, R=${r.code}`);
      await mine(rpc, 1);
    }
    {
      const s = await scenario("audit-malformed");
      fs.writeFileSync(path.join(s.relay, "000-malformed.json"), "{");
      const a = await s.run("A", { MAX_WAIT_MS: "1000" });
      rec.record("C2", "malformed relay JSON terminates participant (known defect)", "ACCEPT", a.code === 1 && /SyntaxError/.test(a.err), a.err.slice(0, 250));
    }

    // ── D2: crash matrix — every boundary, restart from store, complete ─────
    for (const point of CRASH_POINTS) {
      const who = point.split(":")[0] as "A" | "B" | "R";
      const s = await scenario(`crash-${point.replace(/[^a-z-]/gi, "_")}`);
      const others = (["A", "B", "R"] as const).filter((r) => r !== who);
      const otherRuns = Promise.all(others.map((r) => s.run(r, { MAX_WAIT_MS: "40000" })));
      const first = await s.run(who, { CRASH_AT: point });
      const second = first.code === 99 ? await s.run(who, { MAX_WAIT_MS: "40000" }) : first;
      const rest = await otherRuns;
      const ok = first.code === 99 && second.code === 0 && rest.every((x) => x.code === 0);
      const rec2 = await s.recover(who);
      const complete = ["R_A", "R_B", "AP_A", "AP_B"].every((id) => rec2.templates[id]?.principalSigs === 2);
      const funded = !!(await rpc<any>("gettxout", [rec2.fundingTxid, 0]).catch(() => null)) || (await rpc<string[]>("getrawmempool")).includes(rec2.fundingTxid);
      rec.record(`D2:${point}`, `crash at ${point}: exit 99, restart completes, store complete, funding on chain`, "ACCEPT", ok && complete && funded, `codes ${first.code}/${second.code}/${rest.map((x) => x.code)} ${second.err.slice(-160)}`);
      await mine(rpc, 1);
    }

    // ── D3: tampered counterparty template → A refuses to fund ─────────────
    {
      const s = await scenario("tamper");
      const [a, b] = await Promise.all([s.run("A", { MAX_WAIT_MS: "15000" }), s.run("B", { TAMPER: "1", MAX_WAIT_MS: "15000" })]);
      const st = JSON.parse(fs.readFileSync(path.join(s.stores.A, "state.json"), "utf8"));
      const unfunded = !(await rpc<string[]>("getrawmempool")).length && !st.signedFundingHex;
      rec.record("D3", "B signs AP_A paying itself +1 sat: A aborts (exit 2), never signs or broadcasts funding", "ACCEPT", a.code === 2 && st.phase === "aborted" && unfunded, `A ${a.code} ${st.abort ?? ""} B ${b.code}`);
    }

    // ── D4: forged relay messages are ignored ──────────────────────────────
    {
      const s = await scenario("forge");
      const [a, b] = await Promise.all([s.run("A", { MAX_WAIT_MS: "6000" }), s.run("B", { FORGE: "1", MAX_WAIT_MS: "6000" })]);
      const st = JSON.parse(fs.readFileSync(path.join(s.stores.A, "state.json"), "utf8"));
      rec.record("D4", "B's messages carry a wrong identity signature: A ignores them and times out unfunded (exit 3)", "ACCEPT", a.code === 3 && st.phase === "signed" && /IGNORED forged/.test(a.err), `A ${a.code} phase ${st.phase}; B ${b.code}`);
    }

    // ── D5: arbiter absent during setup, joins later from the relay alone ──
    {
      const s = await scenario("late-arbiter");
      const [a, b] = await Promise.all([s.run("A"), s.run("B")]);
      await mine(rpc, 1);
      const r = await s.run("R");
      const rr = await s.recover("R");
      const complete = ["R_A", "R_B", "AP_A", "AP_B"].every((id) => rr.templates[id]?.principalSigs === 2);
      const blk = complete ? await rpc<any>("generateblock", [await rpc<string>("getnewaddress"), [await s.ruleHex("A")]]).catch((e) => ({ error: String(e) })) : { error: "incomplete" };
      rec.record("D5", "R joins after funding, reconstructs from relay + terms, rules R_A (mined)", "ACCEPT", a.code === 0 && b.code === 0 && r.code === 0 && complete && !!blk.hash, JSON.stringify(blk).slice(0, 120));
    }

    rec.report("Distributed recovery-ready setup — Bitcoin Core " + (await rpc<any>("getnetworkinfo", [], "")).subversion, path.join(HERE, "codex-distributed-audit-results.json"), { crashPoints: CRASH_POINTS });
  } finally { await node.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exit(1); });
