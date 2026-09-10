// Codex extension of Claude commit 1d7e57e: exact heights, copied-signature attack,
// both zero-fee stages, and a policy-versus-consensus block test. Regtest only.
// ─────────────────────────────────────────────────────────────────────────────
// Chama settlement research — REGTEST harness for the fixed-payout ruling graph
//
//   F (funding)  ── coop: A+B ───────────────────────────────────▶ anywhere (by consent)
//                ── ruling: R+A+B (3-of-3) ── pre-signed R_A / R_B ─▶ Q_A / Q_B
//                ── refund: funder after CLTV(H_refund) ─────────▶ funder
//
//   Q_w (appeal stage) ── default: winner after CSV(W) ──────────▶ winner
//                      ── appeal:  P+A+B (3-of-3) ── pre-signed AP_w ─▶ loser (reversal)
//                      ── coop:    A+B ─────────────────────────────▶ anywhere (by consent)
//
// Both principals (A, B) sign R_A, R_B, AP_A, AP_B BEFORE the funding tx is
// broadcast. R (first-instance arbiter) can then only choose R_A or R_B. P
// (appeal panel) can then only complete AP_w. Neither can invent a destination.
//
// Every row below is decided by Bitcoin Core consensus/policy on a throwaway
// regtest node, using @scure/btc-signer — the library the app ships with — and
// the same hand-assembled-witness pattern as src/bond-multisig/*.
//
// Run:  npx tsx docs/protocol-research/harness/regtest-graph.ts
// Env:  BITCOIND=/path/to/bitcoind  (default: bitcoind on PATH)
//       HARNESS_DATADIR=/tmp/...     (default: a fresh temp dir)
//
// ⚠ REGTEST ONLY. Throwaway keys. Not a wallet, not a deployment, not an audit.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

// ── parameters ──────────────────────────────────────────────────────────────
const ESCROW_SATS = 100_000n;
const TEMPLATE_FEE = 1_000n;        // fee committed inside a pre-signed template
const ANCHOR_SATS = 240n;           // P2A dust floor (Core policy)
const DEFAULT_FEE = 500n;           // winner default / refund / coop spends
const W = 20;                       // appeal window: CSV blocks on Q_w. ⚠ Must be >16: ScriptNum push of 1..16 is non-minimal (needs OP_N); Core rejects "Data push larger than necessary".
const REFUND_AFTER = 100;            // CLTV: blocks after funding height
const P2A_SCRIPT = hexToBytes("51024e73");
const NUMS = hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const RPC_PORT = 18_699;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/`;
const RPC_AUTH = "Basic " + Buffer.from("harness:harness").toString("base64");

// ── rpc ─────────────────────────────────────────────────────────────────────
async function rpc<T = any>(method: string, params: unknown[] = [], wallet = "miner"): Promise<T> {
  const res = await fetch(RPC_URL + (wallet ? `wallet/${wallet}` : ""), {
    method: "POST",
    headers: { Authorization: RPC_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "h", method, params }),
  });
  const body = await res.json() as { result: T; error: null | { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startNode(): Promise<{ proc: ChildProcess; datadir: string }> {
  const datadir = process.env.HARNESS_DATADIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "chama-regtest-"));
  const bin = process.env.BITCOIND ?? "bitcoind";
  const proc = spawn(bin, [
    "-regtest", `-datadir=${datadir}`, `-rpcport=${RPC_PORT}`, "-port=18698",
    "-rpcuser=harness", "-rpcpassword=harness", "-server=1", "-listen=0",
    "-fallbackfee=0.00001", "-txindex=0", "-debuglogfile=0", "-printtoconsole=0",
  ], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { await rpc("getblockchaininfo", [], ""); break; } catch { await sleep(200); }
    if (i === 99) throw new Error("bitcoind did not come up");
  }
  try { await rpc("createwallet", ["miner"], ""); } catch { await rpc("loadwallet", ["miner"], ""); }
  return { proc, datadir };
}

// ── keys ────────────────────────────────────────────────────────────────────
function keypair() {
  const priv = btc.utils.randomPrivateKeyBytes();
  return { priv, xonly: btc.utils.pubSchnorr(priv) };
}
const A = keypair();   // buyer  (funder in this run)
const B = keypair();   // seller
const R = keypair();   // first-instance arbiter — dedicated per-trade key
const P = keypair();   // appeal panel — single key here; FROST t-of-n later
const ATTACKER = keypair();
const FEE = keypair(); // pays CPFP fees in the anchor scenario
const hex = bytesToHex;

// ── scripts ─────────────────────────────────────────────────────────────────
const msScript = (m: number, keys: Uint8Array[]) =>
  (btc.p2tr_ms(m, keys) as unknown as { script: Uint8Array }).script;

function csvPrefixed(blocks: number, inner: Uint8Array): Uint8Array {
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(blocks)), "CHECKSEQUENCEVERIFY", "DROP",
    ...(btc.Script.decode(inner) as never[]),
  ] as never);
}
function cltvSingle(height: number, xonly: Uint8Array): Uint8Array {
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(height)), "CHECKLOCKTIMEVERIFY", "DROP", xonly, "CHECKSIG",
  ] as never);
}
function csvSingle(blocks: number, xonly: Uint8Array): Uint8Array {
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(blocks)), "CHECKSEQUENCEVERIFY", "DROP", xonly, "CHECKSIG",
  ] as never);
}

interface Tree { p: any; leaves: Record<string, Uint8Array>; keysByLeaf: Record<string, Uint8Array[]> }

function tree(leaves: Record<string, Uint8Array>, keysByLeaf: Record<string, Uint8Array[]>): Tree {
  const p = btc.p2tr(NUMS, Object.values(leaves).map((script) => ({ script })) as never, REGTEST, true);
  return { p, leaves, keysByLeaf };
}

/** F: funding output. */
function fundingTree(refundHeight: number): Tree {
  return tree(
    {
      coop: msScript(2, [A.xonly, B.xonly]),
      ruling: msScript(3, [R.xonly, A.xonly, B.xonly]),
      refund: cltvSingle(refundHeight, A.xonly),
    },
    { coop: [A.xonly, B.xonly], ruling: [R.xonly, A.xonly, B.xonly], refund: [A.xonly] },
  );
}
/** Q_w: appeal-stage output for winner w. */
function appealTree(winner: Uint8Array): Tree {
  return tree(
    {
      default: csvSingle(W, winner),
      appeal: msScript(3, [P.xonly, A.xonly, B.xonly]),
      coop: msScript(2, [A.xonly, B.xonly]),
    },
    { default: [winner], appeal: [P.xonly, A.xonly, B.xonly], coop: [A.xonly, B.xonly] },
  );
}

// ── spend construction ──────────────────────────────────────────────────────
interface Outpoint { txid: string; vout: number; amount: bigint }

function leafEntry(t: Tree, leaf: string) {
  const script = t.leaves[leaf];
  const entry = (t.p.tapLeafScript as [unknown, Uint8Array][]).find((e) => hex(e[1].slice(0, -1)) === hex(script));
  const found = (t.p.leaves as { script: Uint8Array; controlBlock: Uint8Array }[]).find((l) => hex(l.script) === hex(script));
  if (!entry || !found) throw new Error(`leaf ${leaf} not in tree`);
  return { entry, controlBlock: found.controlBlock, script };
}

function newSpend(t: Tree, leaf: string, from: Outpoint, opts: { sequence?: number; lockTime?: number; version?: number } = {}) {
  const { entry } = leafEntry(t, leaf);
  const tx = new btc.Transaction({ version: opts.version ?? 3, allowUnknownOutputs: true, lockTime: opts.lockTime ?? 0 });
  tx.addInput({
    txid: hexToBytes(from.txid), index: from.vout,
    witnessUtxo: { script: t.p.script, amount: from.amount },
    sequence: opts.sequence ?? 0xfffffffd,
    tapInternalKey: t.p.tapInternalKey, tapMerkleRoot: t.p.tapMerkleRoot,
    tapLeafScript: [entry] as never,
  });
  return tx;
}
function addP2A(tx: btc.Transaction) { tx.addOutput({ script: P2A_SCRIPT, amount: ANCHOR_SATS }); }
function addTo(tx: btc.Transaction, xonly: Uint8Array, amount: bigint) {
  tx.addOutput({ script: btc.p2tr(xonly, undefined, REGTEST).script, amount });
}
function addToTree(tx: btc.Transaction, t: Tree, amount: bigint) { tx.addOutput({ script: t.p.script, amount }); }

/** Sign input 0 with `priv` for the leaf; returns the signature bytes. */
function sign(tx: btc.Transaction, priv: Uint8Array) { tx.signIdx(priv, 0); }

/** Hand-assemble the witness (CHECKSIGADD: reverse key order, empty slot for missing sigs). */
function finalize(tx: btc.Transaction, t: Tree, leaf: string): string {
  const { controlBlock, script } = leafEntry(t, leaf);
  const sigs = tx.getInput(0).tapScriptSig ?? [];
  const byKey = new Map(sigs.map(([meta, sig]) => [hex(meta.pubKey), sig]));
  const keys = t.keysByLeaf[leaf];
  const stack = keys.map((k) => byKey.get(hex(k)) ?? new Uint8Array(0));
  if (keys.length > 1) stack.reverse();
  tx.updateInput(0, { finalScriptWitness: [...stack, script, controlBlock] });
  return hex(tx.extract());
}
const txidOf = (rawHex: string) => btc.Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true }).id;

// ── results ─────────────────────────────────────────────────────────────────
interface Row { id: string; scenario: string; expect: "ACCEPT" | "REJECT"; got: "ACCEPT" | "REJECT"; reason: string; vsize?: number; tipHeight?: number }
const rows: Row[] = [];
async function probe(id: string, scenario: string, rawHex: string, expect: "ACCEPT" | "REJECT"): Promise<boolean> {
  const [r] = await rpc<any[]>("testmempoolaccept", [[rawHex]]);
  const got = r.allowed ? "ACCEPT" : "REJECT";
  rows.push({ id, scenario, expect, got, reason: r.allowed ? "" : (r["reject-reason"] ?? r["reject-details"] ?? "?"), vsize: r.vsize, tipHeight: await rpc<number>("getblockcount") });
  return r.allowed;
}
async function mine(n: number) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid mining count ${n}`);
  const addr = await rpc<string>("getnewaddress");
  await rpc("generatetoaddress", [n, addr]);
}
async function broadcastAndMine(id: string, scenario: string, rawHex: string) {
  const ok = await probe(id, scenario, rawHex, "ACCEPT");
  if (!ok) throw new Error(`${id} unexpectedly rejected: ${rows.at(-1)!.reason}`);
  await rpc("sendrawtransaction", [rawHex]);
  await mine(1);
  return txidOf(rawHex);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const { proc, datadir } = await startNode();
  try {
    await mine(110);
    const tip0 = await rpc<number>("getblockcount");
    const refundHeight = tip0 + 2 + REFUND_AFTER;      // +1 funder coin, +1 funding tx
    const F = fundingTree(refundHeight);
    const QA = appealTree(A.xonly);
    const QB = appealTree(B.xonly);

    // Fund the fee key (CPFP scenario) and the funder key, then let the FUNDER
    // build the funding tx itself: 7 identical F outputs from one input.
    const feeAddr = btc.p2tr(FEE.xonly, undefined, REGTEST).address!;
    const feeFundTxid = await rpc<string>("sendtoaddress", [feeAddr, 0.001]);
    const funderP = btc.p2tr(A.xonly, undefined, REGTEST);
    const funderTxid = await rpc<string>("sendtoaddress", [funderP.address!, 0.01]);
    await mine(1);
    const funderVout = (await rpc<any>("gettransaction", [funderTxid, true, true])).decoded.vout
      .find((o: any) => o.scriptPubKey.hex === hex(funderP.script)).n;
    const fundingTx = new btc.Transaction({ version: 2 });
    fundingTx.addInput({ txid: hexToBytes(funderTxid), index: funderVout, witnessUtxo: { script: funderP.script, amount: 1_000_000n }, tapInternalKey: A.xonly });
    for (let i = 0; i < 7; i++) addToTree(fundingTx, F, ESCROW_SATS);
    fundingTx.addOutput({ script: funderP.script, amount: 1_000_000n - 7n * ESCROW_SATS - 2_000n });
    fundingTx.signIdx(A.priv, 0); fundingTx.finalize();
    const fin = { hex: hex(fundingTx.extract()) };
    const fundingTxid: string = fundingTx.id;
    const fOuts: Outpoint[] = Array.from({ length: 7 }, (_, i) => ({ txid: fundingTxid, vout: i, amount: ESCROW_SATS }));
    if (fOuts.length !== 7) throw new Error("expected 7 escrow outputs");

    // ── SETUP: pre-sign templates for every F output BEFORE broadcast ─────
    const qAmount = ESCROW_SATS - TEMPLATE_FEE - ANCHOR_SATS;
    const apAmount = qAmount - TEMPLATE_FEE - ANCHOR_SATS;
    type Templates = { rA: btc.Transaction; rB: btc.Transaction; apA: btc.Transaction; apB: btc.Transaction; qA: Outpoint; qB: Outpoint };
    const T: Templates[] = fOuts.map((f) => {
      const rA = newSpend(F, "ruling", f); addToTree(rA, QA, qAmount); addP2A(rA);
      const rB = newSpend(F, "ruling", f); addToTree(rB, QB, qAmount); addP2A(rB);
      sign(rA, A.priv); sign(rA, B.priv); sign(rB, A.priv); sign(rB, B.priv);
      // Children reference the parent's txid, which is fixed once the parent's
      // inputs/outputs are fixed (segwit: signatures do not change the txid).
      const qA: Outpoint = { txid: rA.id, vout: 0, amount: qAmount };
      const qB: Outpoint = { txid: rB.id, vout: 0, amount: qAmount };
      const apA = newSpend(QA, "appeal", qA); addTo(apA, B.xonly, apAmount); addP2A(apA);   // reversal: A won, appeal pays B
      const apB = newSpend(QB, "appeal", qB); addTo(apB, A.xonly, apAmount); addP2A(apB);   // reversal: B won, appeal pays A
      sign(apA, A.priv); sign(apA, B.priv); sign(apB, A.priv); sign(apB, B.priv);
      return { rA, rB, apA, apB, qA, qB };
    });
    // Recovery-ready gate: every template carries both principal signatures.
    for (const t of T) for (const tx of [t.rA, t.rB, t.apA, t.apB]) {
      if ((tx.getInput(0).tapScriptSig ?? []).length !== 2) throw new Error("template missing a principal signature");
    }
    // Zero-fee ruling AND appeal are also pre-signed before funding broadcast.
    const zR = newSpend(F, "ruling", fOuts[6]);
    addToTree(zR, QA, ESCROW_SATS - ANCHOR_SATS); addP2A(zR);
    sign(zR, A.priv); sign(zR, B.priv);
    const zQ = { txid: zR.id, vout: 0, amount: ESCROW_SATS - ANCHOR_SATS };
    const zAP = newSpend(QA, "appeal", zQ);
    addTo(zAP, B.xonly, zQ.amount - ANCHOR_SATS); addP2A(zAP);
    sign(zAP, A.priv); sign(zAP, B.priv);
    // Only now does the funder release the funding transaction.
    await rpc("sendrawtransaction", [fin.hex]);
    await mine(1);
    const fundingHeight = await rpc<number>("getblockcount");
    if (fundingHeight + REFUND_AFTER !== refundHeight) throw new Error("refund height drifted");

    // ── S1: cooperative settlement A+B ─────────────────────────────────────
    {
      const tx = newSpend(F, "coop", fOuts[0]); addTo(tx, B.xonly, ESCROW_SATS - DEFAULT_FEE);
      sign(tx, A.priv); sign(tx, B.priv);
      await broadcastAndMine("S1", "F coop leaf: A+B pay seller", finalize(tx, F, "coop"));
    }

    // ── S2: ruling R_A, then default winner path before/after W ───────────
    {
      const t = T[1];
      sign(t.rA, R.priv);
      const rulingHex = finalize(t.rA, F, "ruling");
      await broadcastAndMine("S2a", "ruling R_A completed by arbiter (pre-signed by A,B)", rulingHex);
      const early = newSpend(QA, "default", t.qA, { sequence: W }); addTo(early, A.xonly, qAmount - DEFAULT_FEE);
      sign(early, A.priv);
      await probe("S2b", `Q_A default leaf: winner spends before W=${W} blocks`, finalize(early, QA, "default"), "REJECT");
      await mine(W - 1);   // Q_A confirmed 1 block ago + (W-1) = W confirmations
      await broadcastAndMine("S2c", `Q_A default leaf: winner spends at W=${W} confirmations`, finalize(early, QA, "default"));
    }

    // ── S3: ruling R_B, then appeal reversal by P (no delay) ───────────────
    {
      const t = T[2];
      sign(t.rB, R.priv);
      await broadcastAndMine("S3a", "ruling R_B completed by arbiter", finalize(t.rB, F, "ruling"));
      sign(t.apB, P.priv);
      await broadcastAndMine("S3b", "Q_B appeal leaf: P completes pre-signed reversal → pays A, undelayed", finalize(t.apB, QB, "appeal"));
    }

    // ── S4: authority limits — arbitrary destinations must fail ───────────
    {
      const f = fOuts[3];
      // R + A try to pay the attacker from F (B never signed this tx).
      const steal = newSpend(F, "ruling", f); addTo(steal, ATTACKER.xonly, ESCROW_SATS - DEFAULT_FEE);
      sign(steal, R.priv); sign(steal, A.priv);
      await probe("S4a", "F ruling leaf: R+A pay attacker, B's signature absent", finalize(steal, F, "ruling"), "REJECT");
      // R alone tries to complete a *different* transaction than the template.
      const alone = newSpend(F, "ruling", f); addToTree(alone, QA, qAmount - 1n); addP2A(alone);
      sign(alone, R.priv);
      await probe("S4b", "F ruling leaf: R alone, non-template outputs", finalize(alone, F, "ruling"), "REJECT");
      const reused = newSpend(F, "ruling", f); addTo(reused, ATTACKER.xonly, ESCROW_SATS - DEFAULT_FEE);
      sign(reused, R.priv); sign(reused, A.priv);
      const oldB = T[3].rA.getInput(0).tapScriptSig!.find(([meta]) => hex(meta.pubKey) === hex(B.xonly))!;
      reused.updateInput(0, { tapScriptSig: [...reused.getInput(0).tapScriptSig!, oldB] });
      await probe("S4f", "R+A redirect with B's actual template signature copied into witness", finalize(reused, F, "ruling"), "REJECT");
      // Legit ruling on this F, then P + A try to redirect Q_A to the attacker.
      const t = T[3]; sign(t.rA, R.priv);
      await broadcastAndMine("S4c", "ruling R_A (setup for panel redirection attempt)", finalize(t.rA, F, "ruling"));
      const redirect = newSpend(QA, "appeal", t.qA); addTo(redirect, ATTACKER.xonly, qAmount - DEFAULT_FEE);
      sign(redirect, P.priv); sign(redirect, A.priv);
      await probe("S4d", "Q_A appeal leaf: P+A pay attacker, B's signature absent", finalize(redirect, QA, "appeal"), "REJECT");
      const panelOnly = newSpend(QA, "appeal", t.qA); addTo(panelOnly, ATTACKER.xonly, qAmount - DEFAULT_FEE);
      sign(panelOnly, P.priv);
      await probe("S4e", "Q_A appeal leaf: P alone pays attacker", finalize(panelOnly, QA, "appeal"), "REJECT");
      // ── S6 (on the same Q_A): the race after W. Both paths valid; panel path does not expire.
      await mine(W);
      const winner = newSpend(QA, "default", t.qA, { sequence: W }); addTo(winner, A.xonly, qAmount - DEFAULT_FEE);
      sign(winner, A.priv);
      const winnerHex = finalize(winner, QA, "default");
      await probe("S6a", `Q_A default leaf after W: winner's spend valid`, winnerHex, "ACCEPT");
      sign(t.apA, P.priv);
      const apHex = finalize(t.apA, QA, "appeal");
      await probe("S6b", "Q_A appeal leaf after W: P's pre-signed reversal STILL valid (no expiry)", apHex, "ACCEPT");
      await rpc("sendrawtransaction", [apHex]); await mine(1);
      await probe("S6c", "Q_A default leaf after reversal confirmed: winner's spend now conflicts", winnerHex, "REJECT");
    }

    // ── S5: refund races ───────────────────────────────────────────────────
    {
      // Early refund on F[4]
      const early = newSpend(F, "refund", fOuts[4], { sequence: 0xfffffffe, lockTime: refundHeight - 1 });
      addTo(early, A.xonly, ESCROW_SATS - DEFAULT_FEE); sign(early, A.priv);
      await probe("S5a", `F refund leaf: funder spends with nLockTime < H_refund`, finalize(early, F, "refund"), "REJECT");
      const wrongDomain = newSpend(F, "refund", fOuts[4], { sequence: 0xffffffff, lockTime: refundHeight });
      addTo(wrongDomain, A.xonly, ESCROW_SATS - DEFAULT_FEE); sign(wrongDomain, A.priv);
      await probe("S5b", "F refund leaf: correct nLockTime but nSequence=0xffffffff (CLTV disabled)", finalize(wrongDomain, F, "refund"), "REJECT");
      // Ruling confirmed on F[5] first: refund of F[5] can never spend.
      const t5 = T[5]; sign(t5.rB, R.priv);
      if (await rpc<number>("getblockcount") >= refundHeight - 1) throw new Error("S5c is no longer before refund maturity");
      await broadcastAndMine("S5c", "ruling R_B on F[5] confirmed before H_refund", finalize(t5.rB, F, "ruling"));
      // Advance to H_refund.
      const now = await rpc<number>("getblockcount");
      await mine(refundHeight - 1 - now);
      const premature = newSpend(F, "refund", fOuts[4], { sequence: 0xfffffffe, lockTime: refundHeight });
      addTo(premature, A.xonly, ESCROW_SATS - DEFAULT_FEE); sign(premature, A.priv);
      await probe("S5boundary", "valid CLTV witness at tip H-1 is non-final for next candidate block H", finalize(premature, F, "refund"), "REJECT");
      await mine(1);
      if (await rpc<number>("getblockcount") !== refundHeight) throw new Error("refund boundary missed");
      const ok = newSpend(F, "refund", fOuts[4], { sequence: 0xfffffffe, lockTime: refundHeight });
      addTo(ok, A.xonly, ESCROW_SATS - DEFAULT_FEE); sign(ok, A.priv);
      await probe("S5d", "F refund leaf: funder spends at H_refund (no ruling ever confirmed)", finalize(ok, F, "refund"), "ACCEPT");
      const late = newSpend(F, "refund", fOuts[5], { sequence: 0xfffffffe, lockTime: refundHeight });
      addTo(late, A.xonly, ESCROW_SATS - DEFAULT_FEE); sign(late, A.priv);
      await probe("S5e", "F refund leaf on F[5] after H_refund: input already consumed by ruling", finalize(late, F, "refund"), "REJECT");
      // Race: at H_refund, a *not yet broadcast* ruling on F[4] and the refund are both valid.
      const t4 = T[4]; sign(t4.rA, R.priv);
      await probe("S5f", "F[4] at H_refund: pre-signed ruling R_A ALSO valid — pure mempool race", finalize(t4.rA, F, "ruling"), "ACCEPT");
    }

    // ── S7: zero-fee template + P2A anchor CPFP as a TRUC package ──────────
    {
      const f = fOuts[6];
      const parent = zR;
      sign(parent, R.priv);
      const parentHex = finalize(parent, F, "ruling");
      await probe("S7a", "zero-fee ruling alone", parentHex, "REJECT");
      const parentTxid = txidOf(parentHex);
      // child: spends the anchor (empty witness) + the fee key's UTXO, pays fee.
      const feeUtxo = (await rpc<any>("gettransaction", [feeFundTxid, true, true])).decoded.vout
        .find((o: any) => o.scriptPubKey.hex === hex(btc.p2tr(FEE.xonly, undefined, REGTEST).script));
      const child = new btc.Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true });
      child.addInput({ txid: hexToBytes(parentTxid), index: 1, witnessUtxo: { script: P2A_SCRIPT, amount: ANCHOR_SATS }, sequence: 0xfffffffd });
      const feeP = btc.p2tr(FEE.xonly, undefined, REGTEST);
      child.addInput({ txid: hexToBytes(feeFundTxid), index: feeUtxo.n, witnessUtxo: { script: feeP.script, amount: 100_000n }, tapInternalKey: FEE.xonly, sequence: 0xfffffffd });
      child.addOutput({ script: feeP.script, amount: 100_000n + ANCHOR_SATS - 3_000n });
      child.signIdx(FEE.priv, 1);
      child.finalizeIdx(1);
      // P2A policy requires an EMPTY witness on the anchor input. @scure refuses to
      // serialize an empty finalScriptWitness, so give it a placeholder and clear
      // it in the raw serialization.
      child.updateInput(0, { finalScriptWitness: [new Uint8Array([0])] });
      const raw = btc.RawTx.decode(child.extract());
      raw.witnesses![0] = [];
      const childHex = hex(btc.RawTx.encode(raw));
      const pkg = await rpc<any>("submitpackage", [[parentHex, childHex]]);
      const accepted = pkg.package_msg === "success";
      rows.push({ id: "S7b", scenario: "zero-fee ruling + P2A anchor child via submitpackage (TRUC)", expect: "ACCEPT", got: accepted ? "ACCEPT" : "REJECT", reason: accepted ? "" : JSON.stringify(pkg) });
      if (!accepted) throw new Error("zero-fee ruling package rejected");
      await mine(1);
      // The zero-fee appeal's parent is now confirmed. Sponsor with the first
      // child's confirmed change, keeping this relay unit parent+child too.
      sign(zAP, P.priv);
      const apZeroHex = finalize(zAP, QA, "appeal");
      await probe("S7c", "pre-signed zero-fee appeal alone", apZeroHex, "REJECT");
      const sponsor = new btc.Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true });
      sponsor.addInput({ txid: hexToBytes(txidOf(apZeroHex)), index: 1, witnessUtxo: { script: P2A_SCRIPT, amount: ANCHOR_SATS }, sequence: 0xfffffffd });
      const feeChange = 100_000n + ANCHOR_SATS - 3_000n;
      sponsor.addInput({ txid: hexToBytes(txidOf(childHex)), index: 0, witnessUtxo: { script: feeP.script, amount: feeChange }, tapInternalKey: FEE.xonly, sequence: 0xfffffffd });
      sponsor.addOutput({ script: feeP.script, amount: feeChange + ANCHOR_SATS - 3_000n });
      sponsor.signIdx(FEE.priv, 1); sponsor.finalizeIdx(1);
      sponsor.updateInput(0, { finalScriptWitness: [new Uint8Array([0])] });
      const sponsorRaw = btc.RawTx.decode(sponsor.extract()); sponsorRaw.witnesses![0] = [];
      const apPkg = await rpc<any>("submitpackage", [[apZeroHex, hex(btc.RawTx.encode(sponsorRaw))]]);
      rows.push({ id: "S7d", scenario: "pre-signed zero-fee appeal + fee sponsor after ruling confirmation", expect: "ACCEPT", got: apPkg.package_msg === "success" ? "ACCEPT" : "REJECT", reason: apPkg.package_msg, tipHeight: await rpc("getblockcount") });
      if (apPkg.package_msg !== "success") throw new Error("appeal fee package rejected");
      await mine(1);
    }

    // S8: separate standard relay rules from consensus for a small CSV push.
    {
      const small = tree({ default: csvSingle(10, A.xonly) }, { default: [A.xonly] });
      const setup = newSpend(F, "coop", fOuts[4]);
      addToTree(setup, small, ESCROW_SATS - DEFAULT_FEE);
      sign(setup, A.priv); sign(setup, B.priv);
      const setupHex = finalize(setup, F, "coop");
      await broadcastAndMine("S8setup", "create non-minimal-push CSV=10 script output", setupHex);
      await mine(10);
      const spend = newSpend(small, "default", { txid: txidOf(setupHex), vout: 0, amount: ESCROW_SATS - DEFAULT_FEE }, { sequence: 10 });
      addTo(spend, A.xonly, ESCROW_SATS - 2n * DEFAULT_FEE); sign(spend, A.priv);
      const raw = finalize(spend, small, "default");
      await probe("S8policy", "non-minimal data push for CSV=10 under standard mempool policy", raw, "REJECT");
      let blockAccepted = false, why = "";
      try {
        await rpc("generateblock", [await rpc("getnewaddress"), [raw]]);
        blockAccepted = true;
      } catch (e) { why = String(e); }
      rows.push({ id: "S8consensus", scenario: "same CSV=10 spend submitted directly in a block", expect: "ACCEPT", got: blockAccepted ? "ACCEPT" : "REJECT", reason: why, tipHeight: await rpc("getblockcount") });
    }

    // ── report ─────────────────────────────────────────────────────────────
    const allOk = rows.every((r) => r.expect === r.got);
    const out = { date: new Date().toISOString(), core: (await rpc<any>("getnetworkinfo", [], "")).subversion, params: { ESCROW_SATS: Number(ESCROW_SATS), TEMPLATE_FEE: Number(TEMPLATE_FEE), ANCHOR_SATS: Number(ANCHOR_SATS), W, REFUND_AFTER }, rows, allOk };
    fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "codex-extended-results.json"), JSON.stringify(out, null, 2));
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`\nBitcoin Core ${out.core}\n`);
    console.log(pad("id", 5) + pad("expect", 8) + pad("got", 8) + pad("vsize", 7) + "scenario  [reason]");
    for (const r of rows) console.log(pad(r.id, 5) + pad(r.expect, 8) + pad(r.got, 8) + pad(r.vsize?.toString() ?? "", 7) + r.scenario + (r.reason ? `  [${r.reason}]` : ""));
    console.log(`\n${allOk ? "ALL ROWS MATCH EXPECTATION" : "MISMATCH — see rows"}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    try { await rpc("stop", [], ""); } catch { /* ignore */ }
    await sleep(500); proc.kill();
    if (!process.env.HARNESS_DATADIR) fs.rmSync(datadir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
