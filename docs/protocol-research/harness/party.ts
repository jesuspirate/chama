#!/usr/bin/env npx tsx
// One PARTICIPANT of the fixed-payout ruling contract, as its own process. REGTEST ONLY.
//
// v2 (after Codex's fee/recovery review):
//  • every message is bound to {v, net, contract} where contract = sha256(canonical terms);
//    messages for another contract, network or protocol version are dropped before crypto
//  • bounded, schema-checked, malformed-tolerant relay reading; atomic (tmp+rename) publish
//  • the store is SELF-CONTAINED: authenticated terms are copied into it on first run;
//    recover / rule / appeal / collect read ONLY the store
//  • READY carries the funding txid and all four template txids; a mismatch aborts
//  • terminal phases restart idempotently (exit 0)
//  • P (appeal panel) is a real participant with its own store; `appeal` completes AP_w
//  • B distinguishes FUNDED-announced from funding-confirmed (checks the chain itself)
//
//   party.ts run     --role A|B|R|P --store DIR --relay DIR [--terms FILE]
//   party.ts recover --role X --store DIR                    → JSON: rebuilt templates + sig counts
//   party.ts rule    --role R --store DIR --winner A|B       → raw hex
//   party.ts appeal  --role P --store DIR --winner A|B       → raw hex (reversal of R_winner)
//   party.ts collect --role A|B --store DIR --winner A|B --to HEX_SCRIPT → raw hex (default award after W)
//
// env CRASH_AT=<point>  exit(99) at that boundary       env TAMPER=1 / FORGE=1 (B) as before
// env RPC_PORT          regtest RPC                      env MAX_WAIT_MS  give up (exit 3)
import * as fs from "node:fs";
import * as path from "node:path";
import { btc, hex, hexToBytes, schnorr, sha256, keypair, fundingTree, appealTree, newSpend, addToTree, addToKey, addP2A, attachSig, sigFor, finalize, makeRpc, ANCHOR_SATS, REGTEST, CRASH_POINTS, type Roles, type Tree, type Outpoint } from "./lib.js";

type Role = "A" | "B" | "R" | "P";
const ROLES: Role[] = ["A", "B", "R", "P"];
interface Terms { net: "regtest"; escrowSats: string; W: number; refundHeight: number; keys: Record<Role, string>; idKeys: Record<Role, string>; funderInput: { txid: string; vout: number; amount: string } }
interface State {
  phase: string; unsignedFundingHex?: string; fundingTxid?: string; signedFundingHex?: string; fundingConfirmed?: boolean;
  ownSigs?: Record<string, string>; peerSigs?: Record<string, Record<string, string>>; abort?: string;
}
const TEMPLATE_IDS = ["R_A", "R_B", "AP_A", "AP_B"] as const;
const PROTO = 1;
const MAX_MSG_BYTES = 16_384;

// ── args / io ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const role = opt("role") as Role; const store = opt("store")!; const relay = opt("relay");
const log = (...a: unknown[]) => console.error(`[${role}]`, ...a);
const crash = (point: string) => { if (process.env.CRASH_AT === point) { log("CRASH at", point); process.exit(99); } };
if (!ROLES.includes(role)) { console.error("bad --role"); process.exit(1); }

function persist(file: string, data: unknown) {
  const tmp = path.join(store, `.${file}.tmp`);
  const fd = fs.openSync(tmp, "w"); fs.writeSync(fd, JSON.stringify(data, null, 1)); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(tmp, path.join(store, file));
  const dfd = fs.openSync(store, "r"); fs.fsyncSync(dfd); fs.closeSync(dfd);   // directory entry durability
}
const load = <T>(file: string, dflt: T): T => fs.existsSync(path.join(store, file)) ? JSON.parse(fs.readFileSync(path.join(store, file), "utf8")) : dflt;

// ── keys and terms: the store is the only source of truth after first run ──
fs.mkdirSync(store, { recursive: true });
const keys = load<{ escrow: string; id: string } | null>("keys.json", null);
if (!keys) throw new Error("keys.json missing: the orchestrator seeds each store with that party's own keys only");
const me = keypair(hexToBytes(keys.escrow));
const myId = keypair(hexToBytes(keys.id));
const canonical = (t: Terms) => JSON.stringify(t, Object.keys(t).sort());
let terms = load<Terms | null>("terms.json", null);
if (!terms) {
  const f = opt("terms"); if (!f) throw new Error("first run needs --terms");
  const t = JSON.parse(fs.readFileSync(f, "utf8")) as Terms;
  if (t.net !== "regtest") throw new Error("terms are for another network");
  if (t.keys[role] !== hex(me.xonly) || t.idKeys[role] !== hex(myId.xonly)) throw new Error("terms do not name my keys");
  for (const r of ROLES) if (!/^[0-9a-f]{64}$/.test(t.keys[r]) || !/^[0-9a-f]{64}$/.test(t.idKeys[r])) throw new Error("bad key in terms");
  persist("terms.json", t); terms = t;
}
const CONTRACT = hex(sha256(new TextEncoder().encode(canonical(terms))));
const roles: Roles = { A: hexToBytes(terms.keys.A), B: hexToBytes(terms.keys.B), R: hexToBytes(terms.keys.R), P: hexToBytes(terms.keys.P) };
const ESCROW = BigInt(terms.escrowSats);

// ── relay: bounded, schema-checked, contract-bound, atomic ──────────────────
interface Msg { v: number; net: string; contract: string; from: Role; kind: string; payload: unknown; sig: string }
const KINDS = new Set(["FUNDING_PLAN", "SIGS", "READY", "FUNDED", "ABORT"]);
function publish(kind: string, payload: unknown) {
  const env = { v: PROTO, net: terms!.net, contract: CONTRACT, from: role, kind, payload };
  const body = JSON.stringify(env);
  const signer = process.env.FORGE === "1" ? keypair() : myId;
  const sig = hex(schnorr.sign(sha256(new TextEncoder().encode(body)), signer.priv));
  const name = `${Date.now().toString().padStart(14, "0")}-${role}-${kind}.json`;
  const tmp = path.join(relay!, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...env, sig })); fs.renameSync(tmp, path.join(relay!, name));
  log("published", kind);
}
function readRelay(): Msg[] {
  const out: Msg[] = []; const seen = new Set<string>();
  for (const f of fs.readdirSync(relay!).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
    try {
      const st = fs.statSync(path.join(relay!, f)); if (st.size > MAX_MSG_BYTES) { log("dropped oversize", f); continue; }
      const m = JSON.parse(fs.readFileSync(path.join(relay!, f), "utf8")) as Msg;
      if (typeof m !== "object" || m === null) continue;
      if (m.v !== PROTO || m.net !== terms!.net || m.contract !== CONTRACT) { log("dropped: other contract/net/version", f); continue; }
      if (!ROLES.includes(m.from) || !KINDS.has(m.kind) || typeof m.sig !== "string" || !/^[0-9a-f]{128}$/.test(m.sig)) { log("dropped: schema", f); continue; }
      const key = `${m.from}:${m.kind}`; if (seen.has(key)) continue;   // first authenticated message of a kind wins
      const body = JSON.stringify({ v: m.v, net: m.net, contract: m.contract, from: m.from, kind: m.kind, payload: m.payload });
      if (!schnorr.verify(hexToBytes(m.sig), sha256(new TextEncoder().encode(body)), hexToBytes(terms!.idKeys[m.from]))) { log("IGNORED forged message", m.kind, "claiming", m.from); continue; }
      seen.add(key); out.push(m);
    } catch (e) { log("dropped malformed", f, (e as Error).message.slice(0, 40)); }
  }
  return out;
}
const isSigMap = (p: unknown): p is Record<string, string> => typeof p === "object" && p !== null && TEMPLATE_IDS.every((id) => /^[0-9a-f]{128}$/.test((p as any)[id] ?? ""));

// ── deterministic contract construction (identical in every party) ──────────
function buildTemplates(fundingTxid: string) {
  const F = fundingTree(roles, terms!.refundHeight, "A");
  const QA = appealTree(roles, "A", terms!.W); const QB = appealTree(roles, "B", terms!.W);
  const f0: Outpoint = { txid: fundingTxid, vout: 0, amount: ESCROW };
  const qAmt = ESCROW - ANCHOR_SATS;
  const rA = newSpend(F, "ruling", f0); addToTree(rA, QA, qAmt); addP2A(rA);
  const rB = newSpend(F, "ruling", f0); addToTree(rB, QB, qAmt); addP2A(rB);
  const apAmt = qAmt - ANCHOR_SATS;
  const tamper = process.env.TAMPER === "1" && role === "B" ? 1n : 0n;
  const apA = newSpend(QA, "appeal", { txid: rA.id, vout: 0, amount: qAmt }); addToKey(apA, roles.B, apAmt + tamper); addP2A(apA);
  const apB = newSpend(QB, "appeal", { txid: rB.id, vout: 0, amount: qAmt }); addToKey(apB, roles.A, apAmt); addP2A(apB);
  return {
    R_A: { tx: rA, tree: F, leaf: "ruling", amount: ESCROW }, R_B: { tx: rB, tree: F, leaf: "ruling", amount: ESCROW },
    AP_A: { tx: apA, tree: QA, leaf: "appeal", amount: qAmt }, AP_B: { tx: apB, tree: QB, leaf: "appeal", amount: qAmt },
    F, QA, QB,
  } as Record<string, { tx: btc.Transaction; tree: Tree; leaf: string; amount: bigint }> & { F: Tree; QA: Tree; QB: Tree };
}
const templateTxids = (T: ReturnType<typeof buildTemplates>) => Object.fromEntries(TEMPLATE_IDS.map((id) => [id, T[id].tx.id]));
function verifyFundingPlan(unsignedHex: string): string {
  if (typeof unsignedHex !== "string" || !/^[0-9a-f]+$/.test(unsignedHex) || unsignedHex.length > 8000) throw new Error("bad plan encoding");
  const tx = btc.Transaction.fromRaw(hexToBytes(unsignedHex), { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknown: true });
  const F = fundingTree(roles, terms!.refundHeight, "A");
  const o = tx.getOutput(0);
  if (hex(o.script!) !== hex(F.p.script) || o.amount !== ESCROW) throw new Error("funding plan output 0 is not the agreed escrow");
  if (tx.lockTime !== 0) throw new Error("funding plan has a locktime");
  const inp = tx.getInput(0);
  if (hex(inp.txid!) !== terms!.funderInput.txid || inp.index !== terms!.funderInput.vout) throw new Error("funding plan does not spend the agreed funder input");
  return tx.id;
}
function buildFundingTx() {
  const fp = btc.p2tr(me.xonly, undefined, REGTEST);
  const tx = new btc.Transaction({ version: 2 });
  const inp = terms!.funderInput;
  tx.addInput({ txid: hexToBytes(inp.txid), index: inp.vout, witnessUtxo: { script: fp.script, amount: BigInt(inp.amount) }, tapInternalKey: me.xonly });
  addToTree(tx, fundingTree(roles, terms!.refundHeight, "A"), ESCROW);
  tx.addOutput({ script: fp.script, amount: BigInt(inp.amount) - ESCROW - 2_000n });
  return tx;
}
/** Which templates this role needs both principal signatures for. */
const needed = (r: Role): readonly string[] => r === "R" ? ["R_A", "R_B"] : r === "P" ? ["AP_A", "AP_B"] : TEMPLATE_IDS;

// ── state machine ───────────────────────────────────────────────────────────
async function run() {
  const st = load<State>("state.json", { phase: "init" });
  const save = () => persist("state.json", st);
  const rpc = makeRpc(Number(process.env.RPC_PORT ?? 18899));
  const started = Date.now();
  const maxWait = Number(process.env.MAX_WAIT_MS ?? 20_000);
  const TERMINAL = new Set(["funded", "stored", "done", "aborted"]);
  if (TERMINAL.has(st.phase)) { log("already terminal:", st.phase); process.exit(st.phase === "aborted" ? 2 : 0); }

  // Restart hygiene: re-publish whatever this phase already committed to (dupes are ignored by readers).
  if (role === "A" && st.unsignedFundingHex) publish("FUNDING_PLAN", { unsignedHex: st.unsignedFundingHex });
  if (st.ownSigs) publish("SIGS", st.ownSigs);
  if (st.phase === "ready" && st.fundingTxid) publish("READY", { fundingTxid: st.fundingTxid, templates: templateTxids(buildTemplates(st.fundingTxid)) });

  for (;;) {
    if (Date.now() - started > maxWait) { log("timeout in phase", st.phase); process.exit(3); }
    const msgs = readRelay();
    const from = (r: Role, k: string) => msgs.find((m) => m.from === r && m.kind === k);

    if (role === "A" && st.phase === "init") {
      const tx = buildFundingTx();
      st.unsignedFundingHex = hex(tx.unsignedTx); st.fundingTxid = tx.id;
      crash("A:plan-built-before-persist");
      st.phase = "planned"; save();
      crash("A:plan-persisted-before-publish");
      publish("FUNDING_PLAN", { unsignedHex: st.unsignedFundingHex });
    }
    if (role !== "A" && st.phase === "init") {
      const m = from("A", "FUNDING_PLAN");
      if (m) {
        try {
          st.fundingTxid = verifyFundingPlan((m.payload as any)?.unsignedHex); st.unsignedFundingHex = (m.payload as any).unsignedHex;
          st.phase = "planned"; save(); log("funding plan verified", st.fundingTxid);
        } catch (e) { st.abort = `plan: ${(e as Error).message}`; st.phase = "aborted"; save(); publish("ABORT", { reason: st.abort }); process.exit(2); }
      }
    }
    if ((role === "A" || role === "B") && st.phase === "planned") {
      const T = buildTemplates(st.fundingTxid!);
      const own: Record<string, string> = {};
      for (const id of TEMPLATE_IDS) { T[id].tx.signIdx(me.priv, 0); own[id] = hex(sigFor(T[id].tx, me.xonly)); }
      crash(`${role}:templates-signed-before-persist`);
      st.ownSigs = own; st.phase = "signed"; save();
      crash(`${role}:sigs-persisted-before-publish`);
      publish("SIGS", own);
    }
    if ((role === "A" || role === "B") && st.phase === "signed") {
      const peer: Role = role === "A" ? "B" : "A";
      const m = from(peer, "SIGS");
      if (m) {
        if (!isSigMap(m.payload)) { log("peer SIGS malformed; waiting for a valid one"); }
        else {
          const T = buildTemplates(st.fundingTxid!);
          for (const id of TEMPLATE_IDS) {
            try { attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[peer], hexToBytes(m.payload[id])); }
            catch (e) { st.abort = `${id}: ${(e as Error).message}`; }
          }
          if (st.abort) { st.phase = "aborted"; save(); publish("ABORT", { reason: st.abort }); log("ABORT", st.abort); process.exit(2); }
          crash(`${role}:peer-sigs-verified-before-persist`);
          st.peerSigs = { [peer]: m.payload }; st.phase = "ready"; save();
          crash(`${role}:ready-before-publish`);
          publish("READY", { fundingTxid: st.fundingTxid, templates: templateTxids(T) });
          log("RECOVERY READY: all 4 templates carry both principal signatures, persisted with terms");
        }
      }
    }
    if (role === "A" && st.phase === "ready") {
      const m = from("B", "READY");
      if (m) {
        const mine = templateTxids(buildTemplates(st.fundingTxid!));
        const p = m.payload as any;
        const bound = p?.fundingTxid === st.fundingTxid && TEMPLATE_IDS.every((id) => p?.templates?.[id] === mine[id]);
        if (!bound) { st.abort = "B's READY names a different funding tx or template set"; st.phase = "aborted"; save(); publish("ABORT", { reason: st.abort }); process.exit(2); }
        if (!st.signedFundingHex) {
          const tx = buildFundingTx();
          if (tx.id !== st.fundingTxid) throw new Error("funding txid drifted from the plan");
          tx.signIdx(me.priv, 0); tx.finalize();
          crash("A:funding-signed-before-persist");
          st.signedFundingHex = hex(tx.extract()); save();
        }
        crash("A:funding-persisted-before-broadcast");
        const known = await rpc<any>("gettxout", [st.fundingTxid, 0]).catch(() => null);
        if (!known) await rpc("sendrawtransaction", [st.signedFundingHex]);
        crash("A:funding-broadcast-before-persist");
        st.phase = "funded"; save();
        publish("FUNDED", { txid: st.fundingTxid });
        log("FUNDED (announced; confirmation is the chain's job)", st.fundingTxid); process.exit(0);
      }
    }
    if (role === "B" && st.phase === "ready") {
      const m = from("A", "FUNDED");
      if (m && (m.payload as any)?.txid === st.fundingTxid) {
        // Announcement ≠ confirmation: check the chain ourselves.
        const o = await rpc<any>("gettxout", [st.fundingTxid, 0]).catch(() => null);
        if (o && o.confirmations >= 1) { st.fundingConfirmed = true; st.phase = "done"; save(); log("funding CONFIRMED", o.confirmations); process.exit(0); }
      }
    }
    if ((role === "R" || role === "P") && st.phase === "planned") {
      const a = from("A", "SIGS"), b = from("B", "SIGS");
      if (a && b && isSigMap(a.payload) && isSigMap(b.payload)) {
        const T = buildTemplates(st.fundingTxid!);
        try {
          for (const id of needed(role)) {
            attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles.A, hexToBytes(a.payload[id]));
            attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles.B, hexToBytes(b.payload[id]));
          }
        } catch (e) { st.abort = (e as Error).message; st.phase = "aborted"; save(); process.exit(2); }
        crash(`${role}:verified-before-persist`);
        st.peerSigs = { A: a.payload, B: b.payload }; st.phase = "stored"; save();
        log("STORED: my templates verified with both principal signatures"); process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── offline commands: STORE ONLY ─────────────────────────────────────────────
function allSigsFor(st: State, id: string): Record<string, string> {
  const s: Record<string, string> = {};
  if (st.ownSigs) s[role] = st.ownSigs[id];
  for (const [who, sigs] of Object.entries(st.peerSigs ?? {})) s[who] = sigs[id];
  return s;
}
function recover() {
  const st = load<State>("state.json", { phase: "init" });
  if (!st.fundingTxid) return console.log(JSON.stringify({ phase: st.phase, contract: CONTRACT, templates: {} }));
  const T = buildTemplates(st.fundingTxid);
  const out: Record<string, { txid: string; principalSigs: number }> = {};
  for (const id of TEMPLATE_IDS) {
    let n = 0;
    for (const [who, s] of Object.entries(allSigsFor(st, id))) { try { attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[who as Role], hexToBytes(s)); n++; } catch { /* invalid */ } }
    out[id] = { txid: T[id].tx.id, principalSigs: n };
  }
  console.log(JSON.stringify({ phase: st.phase, contract: CONTRACT, fundingTxid: st.fundingTxid, templates: out }));
}
function complete(id: string) {
  const st = load<State>("state.json", { phase: "init" });
  const T = buildTemplates(st.fundingTxid!);
  for (const [who, s] of Object.entries(allSigsFor(st, id))) attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[who as Role], hexToBytes(s));
  T[id].tx.signIdx(me.priv, 0);
  console.log(finalize(T[id].tx, T[id].tree, T[id].leaf));
}
function collect() {
  // Default award: winner alone after W confirmations of R_winner.
  const st = load<State>("state.json", { phase: "init" });
  const w = opt("winner") as "A" | "B"; if (w !== role) throw new Error("only the winner collects");
  const T = buildTemplates(st.fundingTxid!);
  const Q = w === "A" ? T.QA : T.QB; const parent = T[`R_${w}`].tx;
  const tx = newSpend(Q, "default", { txid: parent.id, vout: 0, amount: ESCROW - ANCHOR_SATS }, { sequence: terms!.W });
  tx.addOutput({ script: hexToBytes(opt("to")!), amount: ESCROW - ANCHOR_SATS - 500n });
  tx.signIdx(me.priv, 0);
  console.log(finalize(tx, Q, "default"));
}

if (cmd === "run") run().catch((e) => { log("fatal", e); process.exit(1); });
else if (cmd === "recover") recover();
else if (cmd === "rule") { if (role !== "R") throw new Error("rule is R's command"); complete(`R_${opt("winner")}`); }
else if (cmd === "appeal") { if (role !== "P") throw new Error("appeal is P's command"); complete(`AP_${opt("winner")}`); }
else if (cmd === "collect") collect();
else { console.error("usage: party.ts run|recover|rule|appeal|collect ..."); process.exit(1); }
