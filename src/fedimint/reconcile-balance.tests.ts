// Jet (6.4.25): "balance unknown reported as 0 at start-up". At start-up the
// reconcile couldn't read the wallet balance, refused correctly, but reported
// 0 sats; App then took 0 as nothing-to-protect and switched federations
// without asking. Unknown must stay unknown and never start a switch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideReconcileBalance } from "./reconcile-balance.js";
import { decideDestroyConfirmRoute } from "../ui/decisions.js";
import { translate } from "../i18n/index.js";
import { toastText } from "../ui/components/Toast.js";

const sats = (n: number) => n * 1000;
const read = (value: number | Error) => async () => { if (value instanceof Error) throw value; return value; };

{
  // Unreadable or nonsense balances are unknown — never 0, never a replace.
  for (const bad of [new Error("bridge /info did not answer within 20s"), NaN, -1, Infinity, -Infinity]) {
    assert.deepEqual(await decideReconcileBalance(read(bad), false), { kind: "unknown" }, `${String(bad)} → unknown`);
  }
  // A read balance decides as before: empty or dust replaces, a real one asks.
  assert.deepEqual(await decideReconcileBalance(read(0), false), { kind: "replace", balanceMsats: 0 });
  assert.deepEqual(await decideReconcileBalance(read(sats(1)), false), { kind: "replace", balanceMsats: sats(1) });
  assert.deepEqual(await decideReconcileBalance(read(sats(50_000)), false), { kind: "refuse", balanceMsats: sats(50_000) });
  // Only the person's explicit confirmation (force) replaces; unknown stays null.
  assert.deepEqual(await decideReconcileBalance(read(new Error("x")), true), { kind: "replace", balanceMsats: null });
}
console.log("PASS reconcile balance: unreadable is unknown, never 0; read balances decide as before");

{
  // App's routing: only a read empty/dust balance switches without asking.
  for (const bad of [undefined, null, NaN, -1, Infinity]) {
    assert.equal(decideDestroyConfirmRoute(bad as never, false), "unknown", `${String(bad)} never switches`);
    assert.equal(decideDestroyConfirmRoute(bad as never, true), "unknown");
  }
  assert.equal(decideDestroyConfirmRoute(0, false), "switch");
  assert.equal(decideDestroyConfirmRoute(sats(1), false), "switch", "dust still switches");
  assert.equal(decideDestroyConfirmRoute(sats(50_000), false), "confirm");
  assert.equal(decideDestroyConfirmRoute(sats(50_000), true), "switch", "arbiter federations keep their wallets");
}
console.log("PASS switch routing: an unknown balance never switches without asking");

{
  // Wiring: the hook throws its own code with no amount; the refusal that
  // carries an amount only ever carries a real one; App's start-up handler
  // routes unknown to a plain message before any switch.
  const hook = readFileSync(new URL("../hooks/useEscrow.ts", import.meta.url), "utf8");
  assert.match(hook, /const decision = await decideReconcileBalance\(\(\) => reconcileWallet\.getBalance\(\), force\);/);
  const unknown = hook.slice(hook.indexOf('if (decision.kind === "unknown")'), hook.indexOf('if (decision.kind === "refuse")'));
  assert.match(unknown, /unknownErr\.code = "RECONCILE_REFUSED_BALANCE_UNKNOWN";/);
  assert.doesNotMatch(unknown, /balanceMsats/, "no amount on an unknown refusal");
  assert.doesNotMatch(hook, /opfsBalanceMsats = -1;|balanceMsats = opfsBalanceMsats > 0 \? opfsBalanceMsats : 0/, "no 0 or -1 stand-in");

  const app = readFileSync(new URL("../ui/App.tsx", import.meta.url), "utf8");
  const boot = app.slice(app.indexOf("actions.initFedimint(target.invite).catch("), app.indexOf("}, [connected, connectedRelays, autoInitDone"));
  const unknownAt = boot.indexOf('e?.code === "RECONCILE_REFUSED_BALANCE_UNKNOWN"');
  const confirmAt = boot.indexOf("queueDestroyConfirm(");
  assert.ok(unknownAt > 0 && unknownAt < confirmAt, "unknown is handled before the confirm/switch path");
  assert.match(boot.slice(unknownAt, confirmAt), /setToast\(\{ message: t\("app\.balanceUnknownNoSwitch"\)/);
  assert.match(boot, /RECONCILE_REFUSED_NONZERO_BALANCE" && !\(e\.balanceMsats > 0\)/, "a refusal without a real amount is unknown too");
  assert.doesNotMatch(boot, /balanceMsats: e\.balanceMsats \|\| 0/);
  const queue = app.slice(app.indexOf("const queueDestroyConfirm = "), app.indexOf("const switchStartedAt = Date.now();"));
  assert.match(queue, /const route = decideDestroyConfirmRoute\(request\.balanceMsats, preservesArbiterFederationBalances\);\s*if \(route === "unknown"\) \{/);

  // The other handlers (community tap, custom invite) don't recognise the new
  // code, so they show the error and switch nothing.
  const cmds = readFileSync(new URL("../ui/hooks/useFederationCommands.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cmds, /RECONCILE_REFUSED_BALANCE_UNKNOWN/);
}
console.log("PASS unknown-balance wiring: own code, no amount, handled before any switch");

{
  // Plain message, en/fr/es/sw, from either unknown refusal's English text.
  const raw = "Chama couldn't read this wallet's balance, so it won't switch communities right now. Nothing was changed. Close other Chama tabs and try again.";
  for (const lang of ["en", "fr", "es", "sw"] as const) {
    const text = toastText(raw, key => translate(lang, key)) as string;
    assert.equal(text, translate(lang, "app.balanceUnknownNoSwitch"));
    assert.ok(text && text !== "app.balanceUnknownNoSwitch");
  }
  assert.equal(translate("en", "app.balanceUnknownNoSwitch"),
    "Chama couldn't read your wallet balance, so it stayed on your current community. Nothing was changed. Try again in a moment.");
}
console.log("PASS unknown-balance message: one plain sentence set in en/fr/es/sw");
