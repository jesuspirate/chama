// Lock invoice Step 0+1 (Jet, 6.4.25): measure the wait, and warm the
// Lightning path before the press without creating anything payable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gatewayCount, resetGatewayWarmup, warmGatewayCount, warmGateways, GATEWAY_COUNT_FRESH_MS } from "./gateway-warmup.js";

const FED = "fed-a", OTHER = "fed-b";
const counter = (answers: Array<number | null | Error>) => {
  let calls = 0;
  const fetch = async () => {
    const a = answers[Math.min(calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, calls: () => calls };
};

{
  // Warmed on the trade screen → the sheet gets the answer without asking again.
  resetGatewayWarmup();
  const g = counter([3]);
  warmGateways(FED, g.fetch);
  assert.equal(await gatewayCount(FED, g.fetch), 3);
  assert.equal(g.calls(), 1, "one question, shared");
  assert.equal(warmGatewayCount(FED), 3);
  // Another federation never reuses it.
  assert.equal(warmGatewayCount(OTHER), null);
  const o = counter([1]);
  assert.equal(await gatewayCount(OTHER, o.fetch), 1);
  assert.equal(o.calls(), 1);
}
{
  // The sheet opens while the warm-up is still asking: it joins that question.
  resetGatewayWarmup();
  let release!: (n: number) => void;
  let calls = 0;
  const slow = () => { calls++; return new Promise<number | null>(r => { release = r; }); };
  warmGateways(FED, slow);
  const sheet = gatewayCount(FED, slow);
  release(2);
  assert.equal(await sheet, 2);
  assert.equal(calls, 1);
}
{
  // Zero, unknown and failures are never kept: the sheet asks again.
  for (const answer of [0, null, new Error("gateway lookup failed")]) {
    resetGatewayWarmup();
    const g = counter([answer, 4]);
    warmGateways(FED, g.fetch);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(warmGatewayCount(FED), null, `${String(answer)} is not kept`);
    assert.equal(await gatewayCount(FED, g.fetch), 4);
    assert.equal(g.calls(), 2);
  }
}
{
  // A kept answer goes stale after two minutes.
  resetGatewayWarmup();
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    const g = counter([5, 6]);
    warmGateways(FED, g.fetch);
    await gatewayCount(FED, g.fetch);
    t += GATEWAY_COUNT_FRESH_MS + 1;
    assert.equal(warmGatewayCount(FED), null);
    assert.equal(await gatewayCount(FED, g.fetch), 6);
    assert.equal(g.calls(), 2);
  } finally { Date.now = realNow; }
}
console.log("PASS Lock warm-up: one shared gateway question per federation; only a recent positive answer is reused");

{
  // Wiring. The warm-up only reads: it creates no invoice and never joins or
  // switches federations; the press path keeps its own fresh federation check.
  const app = readFileSync(new URL("../ui/App.tsx", import.meta.url), "utf8");
  const warm = app.slice(app.indexOf("const walletOnTradeFederation = "), app.indexOf("const lockGatewayCount = "));
  assert.match(warm, /!fedimint\.joined\) return false;/);
  assert.match(warm, /\}\)\.kind === "matching";/, "only on the trade's own federation");
  assert.match(warm, /const warmLockPath = \(trade: EscrowState\): void => \{\s*if \(!walletOnTradeFederation\(trade\)\) return;/);
  assert.match(warm, /void actions\.prewarmFunding\(\);/);
  assert.match(warm, /warmGateways\(fedimint\.federationId, actions\.getLightningGatewayCount\)/);
  assert.doesNotMatch(warm, /createFundingInvoice|fundAndLock|initFedimint|switchFederation|createInvoice/);
  assert.match(app, /getLightningGatewayCount=\{lockGatewayCount\}/, "the funding sheet reuses the warm answer");
  assert.match(app, /onLockShown=\{\(\) => warmLockPath\(selected\)\}/, "phone trade screen warms");
  assert.match(app, /onPrewarmFunding=\{\(\) => warmLockPath\(selected\)\}/, "full view warms the same way");
  const pressAt = app.indexOf("const tradeOnLock = async ("), press = app.slice(pressAt, pressAt + 4000);
  assert.match(press, /await takeLockProbe\([\s\S]{0,160}actions\.probeFederation,\s*\);/, "the press checks the federation (started on press-down when it can; see lock-probe)");
  const lts = readFileSync(new URL("../ui/screens/LiveTradeSurface.tsx", import.meta.url), "utf8");
  assert.match(lts, /\{onLockShown && <OnShown key=\{state\.id\} run=\{onLockShown\} \/>\}/);
  const fund = readFileSync(new URL("../ui/panels/AtomicFundingModal.tsx", import.meta.url), "utf8");
  assert.match(fund, /perfLockStep\("invoice created"\);\s*perfLockEnd\("invoice shown"\);/);
  assert.match(fund, /useEffect\(\(\) => \{\s*perfLockSheetOpened\(\);/, "the sheet starts the timing if nothing did");
}
console.log("PASS Lock warm-up wiring: read-only, own federation only, both trade views, press path unchanged");

{
  // Step 0: the readout records the Lock flow in steps when it is on, and
  // nothing at all when it is off.
  const values = new Map<string, string>();
  const session = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k),
  } });
  const perf = await import("../ui/perf-probe.js");
  // Jet (rc.6): Copy gave only the header line. With the readout off, or
  // switched off and on again, a Lock timing was never kept. Now the Lock
  // flow is always recorded, and off only hides it.
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k),
  } });
  perf.setPerfEnabled(false);
  assert.match(perf.perfReport(), /^Chama \S+ · Lock timing on · React profiler off \(release build\)\nNo timings yet: hold Lock/,
    "an empty copy says so, and names the build");
  perf.perfLockStart(); perf.perfLockStep("wallet ready"); perf.perfLockEnd("no invoice");
  assert.equal(perf.perfHistory().length, 1, "recorded while the readout is off");
  perf.setPerfEnabled(true);
  perf.setPerfEnabled(false);
  perf.setPerfEnabled(true);
  assert.equal(perf.perfHistory().length, 1, "off and on again keeps it");
  assert.match(perf.perfReport(), /Lock invoice · no invoice: \d+ ms total\n  wallet ready: \d+ ms/);
  assert.ok(session.get("chama_perf_history_v1")?.includes("Lock invoice"), "kept for the session (survives a reload)");
  perf.setPerfEnabled(true);
  perf.perfLockStart();
  for (const step of ["wallet ready", "federation check", "sheet opens", "gateway check · warm", "invoice created"]) perf.perfLockStep(step);
  perf.perfLockEnd("no invoice");
  const [flow] = perf.perfHistory();
  assert.equal(flow.flow, true);
  assert.match(flow.label, /^Lock invoice/);
  assert.deepEqual(flow.steps.map(s => s.name).slice(0, 5), ["wallet ready", "federation check", "sheet opens", "gateway check · warm", "invoice created"]);
  assert.match(perf.perfReport(), /Lock invoice · no invoice: \d+ ms total\n  wallet ready: \d+ ms\n/);
  // Ending twice (sheet closes after the invoice) records once.
  perf.perfLockEnd("no invoice");
  assert.equal(perf.perfHistory().length, 2);
  // A sheet opened without the press path (another entry point) still times.
  perf.perfLockSheetOpened();
  perf.perfLockStep("invoice created");
  perf.perfLockEnd("no invoice");
  assert.deepEqual(perf.perfHistory()[0].steps.map(s => s.name).slice(0, 2), ["sheet opens", "invoice created"]);
  perf.setPerfEnabled(false);
}
console.log("PASS Lock timing readout: steps from the hold to the invoice; recorded even with the readout off, kept when it is switched off and on, kept across a reload");
