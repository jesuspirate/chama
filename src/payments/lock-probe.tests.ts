// Lock invoice, Step 2a: the federation check starts when the Lock hold
// begins and is reused only for the same trade, on the same federation,
// while fresh, and only when it passed. Read-only throughout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOCK_PROBE_FRESH_MS, lockProbeKey, primeLockProbe, resetLockProbe, takeLockProbe, type ProbeResult } from "./lock-probe.js";

let now = 1_000_000;
const counter = (result: ProbeResult | Error) => {
  const probe = async () => { probe.calls++; if (result instanceof Error) throw result; return result; };
  probe.calls = 0;
  return probe;
};
const OK: ProbeResult = { ok: true };
const key = lockProbeKey("fed-a", "trade-1");

{
  resetLockProbe(() => now);
  assert.equal(lockProbeKey(null, "trade-1"), null, "no federation, no key");
  assert.equal(lockProbeKey("fed-a", "trade-1"), "fed-a:trade-1");

  // Pressed, then confirmed: the early check is used, nothing asked twice.
  const early = counter(OK), late = counter(OK);
  primeLockProbe(key, early);
  primeLockProbe(key, early);
  assert.equal(early.calls, 1, "one check per hold");
  now += 1_200;
  assert.deepEqual(await takeLockProbe(key, late), { result: OK, early: true });
  assert.equal(late.calls, 0);
  // Taken once: the next Lock asks again.
  assert.deepEqual(await takeLockProbe(key, late), { result: OK, early: false });
  assert.equal(late.calls, 1);
}

{
  // Another trade or federation: never reused.
  resetLockProbe(() => now);
  const early = counter(OK), late = counter(OK);
  primeLockProbe(key, early);
  assert.equal((await takeLockProbe(lockProbeKey("fed-b", "trade-1"), late)).early, false, "other federation");
  primeLockProbe(key, early);
  assert.equal((await takeLockProbe(lockProbeKey("fed-a", "trade-2"), late)).early, false, "other trade");
  primeLockProbe(key, early);
  assert.equal((await takeLockProbe(null, late)).early, false, "wallet not on the trade's federation");
  assert.equal(late.calls, 3);
}

{
  // Stale: asked again.
  resetLockProbe(() => now);
  const early = counter(OK), late = counter(OK);
  primeLockProbe(key, early);
  now += LOCK_PROBE_FRESH_MS;
  assert.equal((await takeLockProbe(key, late)).early, false);
  assert.equal(late.calls, 1);
}

{
  // A failed or thrown early check is never a refusal on its own: the Lock
  // path asks again, and only that answer decides.
  resetLockProbe(() => now);
  const failed = counter({ ok: false, error: "unreachable" }), late = counter(OK);
  primeLockProbe(key, failed);
  assert.deepEqual(await takeLockProbe(key, late), { result: OK, early: false });
  const thrown = counter(new Error("boom"));
  primeLockProbe(key, thrown);
  assert.deepEqual(await takeLockProbe(key, late), { result: OK, early: false });
  const stillDown = counter({ ok: false, error: "still unreachable" });
  primeLockProbe(key, failed);
  assert.deepEqual(await takeLockProbe(key, stillDown), { result: { ok: false, error: "still unreachable" }, early: false });
}

{
  // Nothing pressed (keyboard path, old builds): a normal check.
  resetLockProbe(() => now);
  const late = counter(OK);
  assert.deepEqual(await takeLockProbe(key, late), { result: OK, early: false });
}

{
  // Wiring: only the Lock hold starts the check; App reuses it only for the
  // trade's own federation; the hold calls it on press, never on confirm.
  const app = readFileSync(new URL("../ui/App.tsx", import.meta.url), "utf8");
  assert.match(app, /onLockHoldStart=\{lockOpts => primeLockPath\(selected, lockOpts\)\}/);
  assert.match(app, /const primeLockPath = \(trade: EscrowState[^)]*\): void => \{\s*if \(!walletOnTradeFederation\(trade\)\) return;\s*primeLockProbe\(lockProbeKey\(fedimint\.federationId, trade\.id\), actions\.probeFederation\);/);
  assert.match(app, /await takeLockProbe\(\s*walletOnTradeFederation\(selected\) \? lockProbeKey\(fedimint\.federationId, selected\.id\) : null,\s*actions\.probeFederation,\s*\);/);
  assert.equal((app.match(/primeLockPath\(/g) ?? []).length, 1, "wired once (the Lock hold)");
  const lts = readFileSync(new URL("../ui/screens/LiveTradeSurface.tsx", import.meta.url), "utf8");
  assert.equal((lts.match(/onHoldStart=\{onLockHoldStart/g) ?? []).length, 1, "only the Lock hold");
  const button = readFileSync(new URL("../ui/components/Button.tsx", import.meta.url), "utf8");
  assert.match(button, /haptic\("light"\);\s*onHoldStart\?\.\(\);\s*setState\(s => holdReducer\(s, \{ type: "press"/);
  const confirmEffect = button.slice(button.indexOf('if (state.kind === "confirmed" && !confirmedFired.current)'), button.indexOf("onConfirmRef.current();") + 30);
  assert.doesNotMatch(confirmEffect, /onHoldStart/, "confirming never calls the warm-up");
}
console.log("PASS lock probe: started on press, reused only for the same trade and federation while fresh and passing; read-only");
