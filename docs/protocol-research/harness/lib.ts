// Shared builders for the settlement-research harnesses. REGTEST ONLY.
// Same construction pattern as src/bond-multisig/* (NUMS internal key, hand-assembled
// witnesses), same signing library the app ships with (@scure/btc-signer).
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

export const hex = bytesToHex;
export { hexToBytes, btc, schnorr, sha256 };
export const ANCHOR_SATS = 240n;
export const P2A_SCRIPT = hexToBytes("51024e73");
export const NUMS = hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
export const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

// ── rpc / node ──────────────────────────────────────────────────────────────
export function makeRpc(port: number) {
  const url = `http://127.0.0.1:${port}/`;
  const auth = "Basic " + Buffer.from("harness:harness").toString("base64");
  return async function rpc<T = any>(method: string, params: unknown[] = [], wallet = "miner"): Promise<T> {
    const res = await fetch(url + (wallet ? `wallet/${wallet}` : ""), {
      method: "POST", headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: "h", method, params }),
    });
    const body = await res.json() as { result: T; error: null | { code: number; message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}
export type Rpc = ReturnType<typeof makeRpc>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startNode(port: number): Promise<{ proc: ChildProcess; datadir: string; rpc: Rpc; stop: () => Promise<void> }> {
  const datadir = fs.mkdtempSync(path.join(os.tmpdir(), "chama-regtest-"));
  const bin = process.env.BITCOIND ?? "bitcoind";
  const proc = spawn(bin, [
    "-regtest", `-datadir=${datadir}`, `-rpcport=${port}`, `-port=${port - 1}`,
    "-rpcuser=harness", "-rpcpassword=harness", "-server=1", "-listen=0",
    "-fallbackfee=0.00001", "-debuglogfile=0", "-printtoconsole=0",
  ], { stdio: "ignore" });
  const rpc = makeRpc(port);
  for (let i = 0; i < 150; i++) {
    try { await rpc("getblockchaininfo", [], ""); break; } catch { await sleep(200); }
    if (i === 149) throw new Error("bitcoind did not come up");
  }
  try { await rpc("createwallet", ["miner"], ""); } catch { await rpc("loadwallet", ["miner"], ""); }
  const stop = async () => {
    try { await rpc("stop", [], ""); } catch { /* ignore */ }
    await sleep(500); proc.kill();
    fs.rmSync(datadir, { recursive: true, force: true });
  };
  return { proc, datadir, rpc, stop };
}
export async function mine(rpc: Rpc, n: number) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`refusing to mine ${n} blocks`);
  if (n === 0) return;
  await rpc("generatetoaddress", [n, await rpc<string>("getnewaddress")]);
}
/** Fund a P2TR key-path address from the miner wallet; returns the outpoint after 1 conf. */
export async function fundKey(rpc: Rpc, xonly: Uint8Array, sats: bigint): Promise<Outpoint> {
  const p = btc.p2tr(xonly, undefined, REGTEST);
  const txid = await rpc<string>("sendtoaddress", [p.address!, Number(sats) / 1e8]);
  await mine(rpc, 1);
  const vout = (await rpc<any>("gettransaction", [txid, true, true])).decoded.vout.find((o: any) => o.scriptPubKey.hex === hex(p.script)).n;
  return { txid, vout, amount: sats };
}

// ── keys / scripts / trees ──────────────────────────────────────────────────
export interface Keypair { priv: Uint8Array; xonly: Uint8Array }
export function keypair(priv = btc.utils.randomPrivateKeyBytes()): Keypair { return { priv, xonly: btc.utils.pubSchnorr(priv) }; }
export interface Outpoint { txid: string; vout: number; amount: bigint }

export const msScript = (m: number, keys: Uint8Array[]) => (btc.p2tr_ms(m, keys) as unknown as { script: Uint8Array }).script;
/** Minimal script-number push: OP_1..OP_16 for 1..16, else ScriptNum. (Codex correction 2.) */
export function minimalNum(n: number): unknown {
  if (n >= 1 && n <= 16) return n;               // @scure encodes small ints as OP_N
  return btc.ScriptNum().encode(BigInt(n));
}
export const cltvSingle = (height: number, xonly: Uint8Array) =>
  btc.Script.encode([minimalNum(height), "CHECKLOCKTIMEVERIFY", "DROP", xonly, "CHECKSIG"] as never);
export const csvSingle = (blocks: number, xonly: Uint8Array) =>
  btc.Script.encode([minimalNum(blocks), "CHECKSEQUENCEVERIFY", "DROP", xonly, "CHECKSIG"] as never);

export interface Tree { p: any; leaves: Record<string, Uint8Array>; keysByLeaf: Record<string, Uint8Array[]> }
export function tree(leaves: Record<string, Uint8Array>, keysByLeaf: Record<string, Uint8Array[]>): Tree {
  const p = btc.p2tr(NUMS, Object.values(leaves).map((script) => ({ script })) as never, REGTEST, true);
  return { p, leaves, keysByLeaf };
}
export interface Roles { A: Uint8Array; B: Uint8Array; R: Uint8Array; P: Uint8Array }
export function fundingTree(k: Roles, refundHeight: number, funder: "A" | "B" = "A"): Tree {
  return tree(
    { coop: msScript(2, [k.A, k.B]), ruling: msScript(3, [k.R, k.A, k.B]), refund: cltvSingle(refundHeight, k[funder]) },
    { coop: [k.A, k.B], ruling: [k.R, k.A, k.B], refund: [k[funder]] },
  );
}
export function appealTree(k: Roles, winner: "A" | "B", W: number): Tree {
  return tree(
    { default: csvSingle(W, k[winner]), appeal: msScript(3, [k.P, k.A, k.B]), coop: msScript(2, [k.A, k.B]) },
    { default: [k[winner]], appeal: [k.P, k.A, k.B], coop: [k.A, k.B] },
  );
}

// ── spends ──────────────────────────────────────────────────────────────────
export function leafEntry(t: Tree, leaf: string) {
  const script = t.leaves[leaf];
  const entry = (t.p.tapLeafScript as [unknown, Uint8Array][]).find((e) => hex(e[1].slice(0, -1)) === hex(script));
  const found = (t.p.leaves as { script: Uint8Array; controlBlock: Uint8Array }[]).find((l) => hex(l.script) === hex(script));
  if (!entry || !found) throw new Error(`leaf ${leaf} not in tree`);
  return { entry, controlBlock: found.controlBlock, script };
}
export function newSpend(t: Tree, leaf: string, from: Outpoint, opts: { sequence?: number; lockTime?: number; version?: number } = {}) {
  const { entry } = leafEntry(t, leaf);
  const tx = new btc.Transaction({ version: opts.version ?? 3, allowUnknownOutputs: true, lockTime: opts.lockTime ?? 0 });
  tx.addInput({
    txid: hexToBytes(from.txid), index: from.vout, witnessUtxo: { script: t.p.script, amount: from.amount },
    sequence: opts.sequence ?? 0xfffffffd, tapInternalKey: t.p.tapInternalKey, tapMerkleRoot: t.p.tapMerkleRoot, tapLeafScript: [entry] as never,
  });
  return tx;
}
export const addP2A = (tx: btc.Transaction) => tx.addOutput({ script: P2A_SCRIPT, amount: ANCHOR_SATS });
export const addToKey = (tx: btc.Transaction, xonly: Uint8Array, amount: bigint) => tx.addOutput({ script: btc.p2tr(xonly, undefined, REGTEST).script, amount });
export const addToTree = (tx: btc.Transaction, t: Tree, amount: bigint) => tx.addOutput({ script: t.p.script, amount });

/** Tapscript sighash for input 0 of a single-input template (what a co-signer must verify). */
export function templateSighash(tx: btc.Transaction, t: Tree, leaf: string, amount: bigint): Uint8Array {
  return tx.preimageWitnessV1(0, [t.p.script], btc.SigHash.DEFAULT, [amount], undefined, t.leaves[leaf], 0xc0);
}
/** Attach an externally produced signature for `xonly` on leaf `leaf` (after verifying it). */
export function attachSig(tx: btc.Transaction, t: Tree, leaf: string, amount: bigint, xonly: Uint8Array, sig: Uint8Array) {
  const msg = templateSighash(tx, t, leaf, amount);
  if (!schnorr.verify(sig, msg, xonly)) throw new Error("signature does not verify against the locally rebuilt template");
  const leafHash = leafHashOf(t, leaf);
  const existing = tx.getInput(0).tapScriptSig ?? [];
  tx.updateInput(0, { tapScriptSig: [...existing, [{ pubKey: xonly, leafHash }, sig]] as never });
}
export function leafHashOf(t: Tree, leaf: string): Uint8Array {
  const found = (t.p.leaves as { script: Uint8Array; hash: Uint8Array }[]).find((l) => hex(l.script) === hex(t.leaves[leaf]));
  if (!found) throw new Error("leaf missing");
  return found.hash;
}
export function sigFor(tx: btc.Transaction, xonly: Uint8Array): Uint8Array {
  const e = (tx.getInput(0).tapScriptSig ?? []).find(([m]) => hex(m.pubKey) === hex(xonly));
  if (!e) throw new Error("no signature for key");
  return e[1];
}
/** Hand-assemble the witness (CHECKSIGADD: reverse key order, empty slot for a missing sig). */
export function finalize(tx: btc.Transaction, t: Tree, leaf: string): string {
  const { controlBlock, script } = leafEntry(t, leaf);
  const sigs = tx.getInput(0).tapScriptSig ?? [];
  const byKey = new Map(sigs.map(([meta, sig]) => [hex(meta.pubKey), sig]));
  const keys = t.keysByLeaf[leaf];
  const stack = keys.map((k) => byKey.get(hex(k)) ?? new Uint8Array(0));
  if (keys.length > 1) stack.reverse();
  tx.updateInput(0, { finalScriptWitness: [...stack, script, controlBlock] });
  return hex(tx.extract());
}
export const txidOf = (rawHex: string) => btc.Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true }).id;

/** Anchor child: spends a P2A output (empty witness, patched in raw form) + a confirmed key-path sponsor UTXO. */
export function anchorChild(parentTxid: string, anchorVout: number, sponsor: Outpoint, sponsorKey: Keypair, feeSats: bigint, opts: { version?: number; padBytes?: number; sponsorScript?: Uint8Array } = {}): string {
  const sp = btc.p2tr(sponsorKey.xonly, undefined, REGTEST);
  const tx = new btc.Transaction({ version: opts.version ?? 3, allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes(parentTxid), index: anchorVout, witnessUtxo: { script: P2A_SCRIPT, amount: ANCHOR_SATS }, sequence: 0xfffffffd });
  tx.addInput({ txid: hexToBytes(sponsor.txid), index: sponsor.vout, witnessUtxo: { script: sp.script, amount: sponsor.amount }, tapInternalKey: sponsorKey.xonly, sequence: 0xfffffffd });
  const change = sponsor.amount + ANCHOR_SATS - feeSats;
  if (change < 330n) throw new Error("sponsor too small for fee");
  tx.addOutput({ script: sp.script, amount: change });
  if (opts.padBytes) tx.addOutput({ script: btc.Script.encode(["RETURN", new Uint8Array(opts.padBytes)] as never), amount: 0n });
  tx.signIdx(sponsorKey.priv, 1); tx.finalizeIdx(1);
  tx.updateInput(0, { finalScriptWitness: [new Uint8Array([0])] });
  const raw = btc.RawTx.decode(tx.extract());
  raw.witnesses![0] = [];
  return hex(btc.RawTx.encode(raw));
}

export const CRASH_POINTS = [
  "A:plan-built-before-persist", "A:plan-persisted-before-publish",
  "A:templates-signed-before-persist", "A:sigs-persisted-before-publish",
  "A:peer-sigs-verified-before-persist", "A:ready-before-publish",
  "A:funding-signed-before-persist", "A:funding-persisted-before-broadcast", "A:funding-broadcast-before-persist",
  "B:templates-signed-before-persist", "B:sigs-persisted-before-publish", "B:peer-sigs-verified-before-persist", "B:ready-before-publish",
  "R:verified-before-persist", "P:verified-before-persist",
] as const;

// ── results ─────────────────────────────────────────────────────────────────
export interface Row { id: string; scenario: string; expect: "ACCEPT" | "REJECT"; got: "ACCEPT" | "REJECT"; reason: string; vsize?: number; fees?: number; note?: string }
export function makeRecorder(rpc: Rpc) {
  const rows: Row[] = [];
  async function probe(id: string, scenario: string, rawHex: string, expect: "ACCEPT" | "REJECT", note?: string): Promise<boolean> {
    const [r] = await rpc<any[]>("testmempoolaccept", [[rawHex]]);
    const got = r.allowed ? "ACCEPT" : "REJECT";
    rows.push({ id, scenario, expect, got, reason: r.allowed ? "" : (r["reject-reason"] ?? "?") + (r["reject-details"] ? ` — ${r["reject-details"]}` : ""), vsize: r.vsize, fees: r.fees ? Math.round(r.fees.base * 1e8) : undefined, note });
    return r.allowed;
  }
  function record(id: string, scenario: string, expect: "ACCEPT" | "REJECT", ok: boolean, reason = "", note?: string) {
    if ((ok ? "ACCEPT" : "REJECT") !== expect) console.error(`[${id}] unexpected: ${reason}`);
    rows.push({ id, scenario, expect, got: ok ? "ACCEPT" : "REJECT", reason: ok ? "" : reason, note });
  }
  function report(title: string, file: string, extra: Record<string, unknown> = {}) {
    const allOk = rows.every((r) => r.expect === r.got);
    fs.writeFileSync(file, JSON.stringify({ title, date: new Date().toISOString(), ...extra, rowCount: rows.length, rows, allOk }, null, 2));
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`\n${title}\n`);
    console.log(pad("id", 6) + pad("expect", 8) + pad("got", 8) + pad("vsize", 7) + pad("fee", 7) + "scenario  [reason]");
    for (const r of rows) console.log(pad(r.id, 6) + pad(r.expect, 8) + pad(r.got, 8) + pad(r.vsize?.toString() ?? "", 7) + pad(r.fees?.toString() ?? "", 7) + r.scenario + (r.reason ? `  [${r.reason}]` : "") + (r.note ? `  {${r.note}}` : ""));
    console.log(`\n${rows.length} rows. ${allOk ? "ALL ROWS MATCH EXPECTATION" : "MISMATCH — see rows"}`);
    if (!allOk) process.exitCode = 1;
    return allOk;
  }
  return { rows, probe, record, report };
}
