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
console.log("PASS canvas payment details: moving on saves what was typed, stops on one that can't be saved");
