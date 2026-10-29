// Jet (Oct 26, rc.2 sandbox and 6.4.30): payment details typed in the canvas
// were kept only if Save was tapped; "Prepare my offer" moved on and dropped
// them, so every new offer asked again. Moving on now saves what was typed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLocalStorageUserScope } from "../storage/user-scope.js";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
} });
setLocalStorageUserScope("canvas-save-details-test");
const { saveTypedDrafts } = await import("./screens/AssistedCanvas.js");
const { addSavedHandle, listSavedHandles } = await import("../payments/saved-handles.js");

{
  // Typed details are saved; empty boxes are left alone.
  const saved: string[] = [];
  const drafts = { strike: "jet", zelle: "  ", "cash-app": "$jet" };
  assert.equal(saveTypedDrafts(["strike", "zelle", "cash-app"], drafts, key => { saved.push(key); addSavedHandle(key, drafts[key as keyof typeof drafts]); return true; }), true);
  assert.deepEqual(saved, ["strike", "cash-app"]);
  assert.deepEqual(listSavedHandles().map(h => h.rail).sort(), ["cash-app", "strike"], "kept for the next offer");
  // Nothing typed: nothing to save, the step goes on.
  assert.equal(saveTypedDrafts(["zelle"], {}, () => { throw new Error("must not save"); }), true);
  // A detail that can't be saved stops the step; later ones stay as typed.
  const tried: string[] = [];
  assert.equal(saveTypedDrafts(["zelle", "paypal"], { zelle: "bad", paypal: "jet@example.com" }, key => { tried.push(key); return key !== "zelle"; }), false);
  assert.deepEqual(tried, ["zelle"]);
}

{
  // Both buttons that leave the step save first.
  const canvas = readFileSync(new URL("./screens/AssistedCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /onClick=\{\(\) => \{ if \(saveTypedPaymentDetails\(\)\) setSurface\("premium"\); \}\}>\{tr\("canvas\.continue"\)\}/, "Bill Pay: Continue");
  assert.match(canvas, /onClick=\{\(\) => \{ if \(saveTypedPaymentDetails\(\)\) void finishRoute\(\); \}\}>/, "Exchange: Prepare my offer");
  assert.doesNotMatch(canvas, /onClick=\{\(\) => void finishRoute\(\)\}/, "no way past the step that skips saving");
}
{
  // Jet (Oct 26): a claim address that returned an invoice is kept before the
  // payout runs, so a failed or timed-out claim doesn't lose it.
  const modal = readFileSync(new URL("./panels/ClaimPayoutModal.tsx", import.meta.url), "utf8");
  const resolve = modal.slice(modal.indexOf("const resolveDestination = "), modal.indexOf("void dispatchClaim(lastDispatchRef.current);\n  };"));
  assert.match(resolve, /if \(opts\.saveAfter && opts\.addressUsed\) \{\n\s+try \{ addOrTouchPayoutDestination\(opts\.addressUsed\); \} catch \{\}/, "saved before the claim is dispatched");
  const { addOrTouchPayoutDestination, listPayoutDestinations } = await import("../payments/payout-destinations.js");
  const { isStrikeLightningAddress, strikeUsernameFromAddress } = await import("../payments/strike-offramp.js");
  addOrTouchPayoutDestination("Jet@strike.me");
  const strike = listPayoutDestinations().find(d => isStrikeLightningAddress(d.address));
  assert.equal(strike && strikeUsernameFromAddress(strike.address), "jet", "the next Strike claim is pre-filled");
}
{
  // Jet (Oct 27): one set of rules for payment details on every screen.
  const { paymentHandleNeedsCountryCode } = await import("../payments/saved-handles.js");
  for (const rail of ["zelle", "phone-number", "paypal", "venmo", "cashtag"]) {
    assert.equal(paymentHandleNeedsCountryCode(rail, "336 647 6911"), true, `${rail}: a number needs its country code`);
    assert.throws(() => addSavedHandle(rail, "3366476911"), /country code/, `${rail}: refused at save`);
    assert.equal(addSavedHandle(rail, "+13366476911").handle, "+1 336-647-6911", `${rail}: saved in one format`);
  }
  for (const [rail, value] of [["paypal", "jet@example.com"], ["venmo", "@jet"], ["cashtag", "$jet"], ["bank-transfer", "3366476911"], ["strike", "jet"]]) {
    assert.equal(paymentHandleNeedsCountryCode(rail, value), false, `${rail}: ${value} is not a phone number`);
  }
  // Settings, Create and the funding step all show the nudge from the same
  // rule and save through the same checked function; a refused save says why.
  const settings = readFileSync(new URL("./panels/SavedHandlesPanel.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("./screens/AssistedCanvas.tsx", import.meta.url), "utf8");
  const funding = readFileSync(new URL("./components/TradePaymentDetails.tsx", import.meta.url), "utf8");
  assert.match(settings, /\|\| paymentHandleNeedsCountryCode\(selectedRail\.key, addValue\)/);
  assert.match(canvas, /\|\| paymentHandleNeedsCountryCode\(key, draft\)/);
  assert.match(funding, /paymentHandleNeedsCountryCode\(rail, handle\) && <div data-payment-country-code/);
  assert.match(funding, /try \{\n\s+const saved = addSavedHandle\(rail, handle\.trim\(\)\)[^\n]*\n\s+\} catch \(e\) \{\n\s+setSaveError\(/, "funding: a refused save is shown, not swallowed");
  assert.match(funding, /\{saveError && <div role="alert"/);
}
console.log("PASS saved details: canvas moving on saves what was typed, stops on one that can't be saved; claim addresses kept before payout; phone rules match on every screen");
