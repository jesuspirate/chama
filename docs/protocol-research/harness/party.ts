#!/usr/bin/env npx tsx
// One PARTICIPANT of the fixed-payout ruling contract, as its own process. REGTEST ONLY.
//
// Holds only its own keys. Talks to others only through a dumb relay directory of
// signed JSON messages (a stand-in for Nostr). Persists every artifact it will need
// to recover BEFORE acting on it. Never trusts a transaction it did not rebuild.
//
//   party.ts run     --role A|B|R --store DIR --relay DIR --terms FILE
//   party.ts recover --role A|B|R --store DIR --terms FILE           → JSON of rebuilt templates
//   party.ts rule    --role R     --store DIR --terms FILE --winner A|B → raw hex of the ruling
//
// env CRASH_AT=<point>   exit(99) at that boundary (see CRASH_POINTS)
// env TAMPER=1           (B only) sign a modified AP_A that pays B one extra sat
// env FORGE=1            (B only) publish messages signed with a wrong identity key
// env RPC_PORT           bitcoind regtest RPC (A broadcasts funding; R checks nothing)
// env MAX_WAIT_MS        give up waiting for peers (exit 3)
import * as fs from "node:fs";
import * as path from "node:path";
import { btc, hex, hexToBytes, schnorr, sha256, keypair, fundingTree, appealTree, newSpend, addToTree, addToKey, addP2A, templateSighash, attachSig, sigFor, finalize, makeRpc, ANCHOR_SATS, REGTEST, type Roles, type Tree, type Outpoint } from "./lib.js";

import { CRASH_POINTS } from "./lib.js";

type Role = "A" | "B" | "R";
interface Terms { escrowSats: string; W: number; refundHeight: number; keys: Record<"A" | "B" | "R" | "P", string>; idKeys: Record<Role, string>; funderInput: { txid: string; vout: number; amount: string } }
interface State {
  phase: string; unsignedFundingHex?: string; fundingTxid?: string; signedFundingHex?: string; broadcast?: boolean;
  ownSigs?: Record<string, string>; peerSigs?: Record<string, Record<string, string>>; verified?: string[]; abort?: string; seen: string[];
}
const TEMPLATE_IDS = ["R_A", "R_B", "AP_A", "AP_B"] as const;

// ── args / io ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const role = opt("role") as Role; const store = opt("store")!; const relay = opt("relay"); const termsFile = opt("terms")!;
const terms: Terms = JSON.parse(fs.readFileSync(termsFile, "utf8"));
const log = (...a: unknown[]) => console.error(`[${role}]`, ...a);
const crash = (point: string) => { if (process.env.CRASH_AT === point) { log("CRASH at", point); process.exit(99); } };

function persist(file: string, data: unknown) {
  const tmp = path.join(store, `.${file}.tmp`);
  const fd = fs.openSync(tmp, "w"); fs.writeSync(fd, JSON.stringify(data, null, 1)); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(tmp, path.join(store, file));
}
const load = <T>(file: string, dflt: T): T => fs.existsSync(path.join(store, file)) ? JSON.parse(fs.readFileSync(path.join(store, file), "utf8")) : dflt;

// keys: created once, never leave the store
fs.mkdirSync(store, { recursive: true });
const keys = load<{ escrow: string; id: string } | null>("keys.json", null);
if (!keys) throw new Error("keys.json missing: the orchestrator seeds each store with that party's own keys only");
const me = keypair(hexToBytes(keys.escrow));
const myId = keypair(hexToBytes(keys.id));
const roles: Roles = { A: hexToBytes(terms.keys.A), B: hexToBytes(terms.keys.B), R: hexToBytes(terms.keys.R), P: hexToBytes(terms.keys.P) };
if (hex(me.xonly) !== terms.keys[role]) throw new Error("my escrow key does not match the terms");
const ESCROW = BigInt(terms.escrowSats);

// ── relay ────────────────────────────────────────────────────────────────────
interface Msg { from: Role; kind: string; payload: unknown; sig: string }
function publish(kind: string, payload: unknown) {
  const body = JSON.stringify({ from: role, kind, payload });
  const signer = process.env.FORGE === "1" ? keypair() : myId;
  const sig = hex(schnorr.sign(sha256(new TextEncoder().encode(body)), signer.priv));
  const name = `${Date.now().toString().padStart(14, "0")}-${role}-${kind}.json`;
  fs.writeFileSync(path.join(relay!, name), JSON.stringify({ from: role, kind, payload, sig }));
  log("published", kind);
}
function readRelay(): Msg[] {
  return fs.readdirSync(relay!).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(relay!, f), "utf8")) as Msg)
    .filter((m) => {
      const body = JSON.stringify({ from: m.from, kind: m.kind, payload: m.payload });
      const ok = schnorr.verify(hexToBytes(m.sig), sha256(new TextEncoder().encode(body)), hexToBytes(terms.idKeys[m.from]));
      if (!ok) log("IGNORED forged message", m.kind, "claiming to be from", m.from);
      return ok;
    });
}

// ── deterministic contract construction (identical in every party) ──────────
function buildTemplates(fundingTxid: string) {
  const F = fundingTree(roles, terms.refundHeight, "A");
  const QA = appealTree(roles, "A", terms.W); const QB = appealTree(roles, "B", terms.W);
  const f0: Outpoint = { txid: fundingTxid, vout: 0, amount: ESCROW };
  const qAmt = ESCROW - ANCHOR_SATS;
  const rA = newSpend(F, "ruling", f0); addToTree(rA, QA, qAmt); addP2A(rA);
  const rB = newSpend(F, "ruling", f0); addToTree(rB, QB, qAmt); addP2A(rB);
  const apAmt = qAmt - ANCHOR_SATS;
  const tamper = process.env.TAMPER === "1" && role === "B" ? 1n : 0n;
  const apA = newSpend(QA, "appeal", { txid: rA.id, vout: 0, amount: qAmt }); addToKey(apA, roles.B, apAmt + tamper); if (!tamper) addP2A(apA); else addP2A(apA);
  const apB = newSpend(QB, "appeal", { txid: rB.id, vout: 0, amount: qAmt }); addToKey(apB, roles.A, apAmt); addP2A(apB);
  return {
    R_A: { tx: rA, tree: F, leaf: "ruling", amount: ESCROW }, R_B: { tx: rB, tree: F, leaf: "ruling", amount: ESCROW },
    AP_A: { tx: apA, tree: QA, leaf: "appeal", amount: qAmt }, AP_B: { tx: apB, tree: QB, leaf: "appeal", amount: qAmt },
    F,
  } as Record<string, { tx: btc.Transaction; tree: Tree; leaf: string; amount: bigint }> & { F: Tree };
}
function verifyFundingPlan(unsignedHex: string): string {
  const tx = btc.Transaction.fromRaw(hexToBytes(unsignedHex), { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknown: true });
  const F = fundingTree(roles, terms.refundHeight, "A");
  const o = tx.getOutput(0);
  if (hex(o.script!) !== hex(F.p.script) || o.amount !== ESCROW) throw new Error("funding plan output 0 is not the agreed escrow");
  if (tx.lockTime !== 0) throw new Error("funding plan has a locktime");
  return tx.id;
}

// ── state machine ───────────────────────────────────────────────────────────
async function run() {
  const st = load<State>("state.json", { phase: "init", seen: [] });
  const save = () => persist("state.json", st);
  const rpc = makeRpc(Number(process.env.RPC_PORT ?? 18899));
  const started = Date.now();
  const maxWait = Number(process.env.MAX_WAIT_MS ?? 20_000);

  // Restart hygiene: re-publish whatever this phase already committed to (dupes are harmless).
  const republish = () => {
    if (role === "A" && st.unsignedFundingHex) publish("FUNDING_PLAN", { unsignedHex: st.unsignedFundingHex });
    if (st.ownSigs) publish("SIGS", st.ownSigs);
    if (st.phase === "ready" || st.phase === "funded") publish("READY", {});
    if (st.phase === "funded") publish("FUNDED", { txid: st.fundingTxid });
  };
  republish();

  for (;;) {
    if (Date.now() - started > maxWait) { log("timeout in phase", st.phase); process.exit(3); }
    const msgs = readRelay();
    const from = (r: Role, k: string) => msgs.find((m) => m.from === r && m.kind === k);

    // A: build the funding plan (unsigned) and share it.
    if (role === "A" && st.phase === "init") {
      const fp = btc.p2tr(me.xonly, undefined, REGTEST);
      const tx = new btc.Transaction({ version: 2 });
      const inp = terms.funderInput;
      tx.addInput({ txid: hexToBytes(inp.txid), index: inp.vout, witnessUtxo: { script: fp.script, amount: BigInt(inp.amount) }, tapInternalKey: me.xonly });
      const F = fundingTree(roles, terms.refundHeight, "A");
      addToTree(tx, F, ESCROW);
      tx.addOutput({ script: fp.script, amount: BigInt(inp.amount) - ESCROW - 2_000n });
      st.unsignedFundingHex = hex(tx.unsignedTx); st.fundingTxid = tx.id;
      crash("A:plan-built-before-persist");
      st.phase = "planned"; save();
      crash("A:plan-persisted-before-publish");
      publish("FUNDING_PLAN", { unsignedHex: st.unsignedFundingHex });
    }
    // B / R: accept A's plan only after rebuilding and checking it.
    if (role !== "A" && st.phase === "init") {
      const m = from("A", "FUNDING_PLAN");
      if (m) {
        const unsignedHex = (m.payload as { unsignedHex: string }).unsignedHex;
        st.fundingTxid = verifyFundingPlan(unsignedHex); st.unsignedFundingHex = unsignedHex;
        st.phase = "planned"; save(); log("funding plan verified", st.fundingTxid);
      }
    }
    // Principals: sign all templates, persist, publish signatures only.
    if ((role === "A" || role === "B") && st.phase === "planned") {
      const T = buildTemplates(st.fundingTxid!);
      const own: Record<string, string> = {};
      for (const id of TEMPLATE_IDS) { T[id].tx.signIdx(me.priv, 0); own[id] = hex(sigFor(T[id].tx, me.xonly)); }
      crash(`${role}:templates-signed-before-persist`);
      st.ownSigs = own; st.phase = "signed"; save();
      crash(`${role}:sigs-persisted-before-publish`);
      publish("SIGS", own);
    }
    // Principals: verify the counterparty's signatures against OUR rebuilt templates.
    if ((role === "A" || role === "B") && st.phase === "signed") {
      const peer: Role = role === "A" ? "B" : "A";
      const m = from(peer, "SIGS");
      if (m) {
        const T = buildTemplates(st.fundingTxid!);
        const sigs = m.payload as Record<string, string>;
        const verified: string[] = [];
        for (const id of TEMPLATE_IDS) {
          try { attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[peer], hexToBytes(sigs[id] ?? "")); verified.push(id); }
          catch (e) { st.abort = `${id}: ${(e as Error).message}`; }
        }
        if (st.abort) { st.phase = "aborted"; save(); publish("ABORT", { reason: st.abort }); log("ABORT", st.abort); process.exit(2); }
        crash(`${role}:peer-sigs-verified-before-persist`);
        st.peerSigs = { [peer]: sigs }; st.verified = verified; st.phase = "ready"; save();
        crash(`${role}:ready-before-publish`);
        publish("READY", {});
        log("RECOVERY READY: all 4 templates carry both principal signatures, persisted");
      }
    }
    // A: fund only when both sides are recovery-ready.
    if (role === "A" && st.phase === "ready") {
      if (from("B", "READY")) {
        if (!st.signedFundingHex) {
          const fp = btc.p2tr(me.xonly, undefined, REGTEST);
          const tx = new btc.Transaction({ version: 2 });
          const inp = terms.funderInput;
          tx.addInput({ txid: hexToBytes(inp.txid), index: inp.vout, witnessUtxo: { script: fp.script, amount: BigInt(inp.amount) }, tapInternalKey: me.xonly });
          const F = fundingTree(roles, terms.refundHeight, "A");
          addToTree(tx, F, ESCROW);
          tx.addOutput({ script: fp.script, amount: BigInt(inp.amount) - ESCROW - 2_000n });
          if (tx.id !== st.fundingTxid) throw new Error("funding txid drifted from the plan");
          tx.signIdx(me.priv, 0); tx.finalize();
          crash("A:funding-signed-before-persist");
          st.signedFundingHex = hex(tx.extract()); save();
        }
        crash("A:funding-persisted-before-broadcast");
        // Idempotent broadcast: already known to the node? then it was broadcast before a crash.
        const known = await rpc<any>("gettxout", [st.fundingTxid, 0]).catch(() => null);
        const inMempool = (await rpc<string[]>("getrawmempool")).includes(st.fundingTxid!);
        if (!known && !inMempool) await rpc("sendrawtransaction", [st.signedFundingHex]);
        crash("A:funding-broadcast-before-persist");
        st.broadcast = true; st.phase = "funded"; save();
        publish("FUNDED", { txid: st.fundingTxid });
        log("FUNDED", st.fundingTxid); process.exit(0);
      }
    }
    if (role === "B" && st.phase === "ready" && from("A", "FUNDED")) { log("done"); process.exit(0); }
    // R: store both principals' verified signatures for all templates.
    if (role === "R" && st.phase === "planned") {
      const a = from("A", "SIGS"), b = from("B", "SIGS");
      if (a && b) {
        const T = buildTemplates(st.fundingTxid!);
        for (const id of TEMPLATE_IDS) {
          attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles.A, hexToBytes((a.payload as any)[id]));
          attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles.B, hexToBytes((b.payload as any)[id]));
        }
        crash("R:verified-before-persist");
        st.peerSigs = { A: a.payload as any, B: b.payload as any }; st.phase = "stored"; save();
        log("STORED: all templates verified with both principal signatures"); process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Rebuild everything from THIS store only and report which templates are completable. */
function recover() {
  const st = load<State>("state.json", { phase: "init", seen: [] });
  if (!st.fundingTxid) return console.log(JSON.stringify({ phase: st.phase, templates: {} }));
  const T = buildTemplates(st.fundingTxid);
  const out: Record<string, { txid: string; principalSigs: number }> = {};
  for (const id of TEMPLATE_IDS) {
    let n = 0;
    const allSigs: Record<string, string> = {};
    if (st.ownSigs) allSigs[role] = st.ownSigs[id];
    for (const [who, sigs] of Object.entries(st.peerSigs ?? {})) allSigs[who] = sigs[id];
    for (const [who, s] of Object.entries(allSigs)) { try { attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[who as Role], hexToBytes(s)); n++; } catch { /* invalid */ } }
    out[id] = { txid: T[id].tx.id, principalSigs: n };
  }
  console.log(JSON.stringify({ phase: st.phase, fundingTxid: st.fundingTxid, templates: out }));
}
/** R completes a ruling from its store alone. */
function rule() {
  const st = load<State>("state.json", { phase: "init", seen: [] });
  const winner = opt("winner") as "A" | "B";
  const T = buildTemplates(st.fundingTxid!);
  const id = `R_${winner}`;
  for (const who of ["A", "B"] as const) attachSig(T[id].tx, T[id].tree, T[id].leaf, T[id].amount, roles[who], hexToBytes(st.peerSigs![who][id]));
  T[id].tx.signIdx(me.priv, 0);
  console.log(finalize(T[id].tx, T[id].tree, T[id].leaf));
}

if (cmd === "run") run().catch((e) => { log("fatal", e); process.exit(1); });
else if (cmd === "recover") recover();
else if (cmd === "rule") rule();
else { console.error("usage: party.ts run|recover|rule ..."); process.exit(1); }
