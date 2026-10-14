// Jet's 6.4.25-rc.6 review on the Pixel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getRailByKey, railLabel, toRailKey, matchRails } from "../payments/rail-registry.js";

{
  // 1. "Cash App", not "$cashtag (Cash App)": a short label, so its chip is
  // one line and the row is no taller than the others. The stored name that
  // listings carry and every client matches on is unchanged.
  assert.equal(railLabel("cashtag"), "Cash App");
  assert.equal(railLabel("$cashtag (Cash App)"), "Cash App", "an old listing's stored name shows the label too");
  assert.equal(railLabel(getRailByKey("cashtag")), "Cash App");
  assert.equal(getRailByKey("cashtag")?.displayName, "$cashtag (Cash App)", "wire value unchanged");
  assert.equal(toRailKey("$cashtag (Cash App)"), "cashtag");
  assert.deepEqual(matchRails(["$cashtag (Cash App)", "Strike"], ["cashtag"], "us-usd").shared, ["cashtag"]);
  // Rails without a label show their name, unknown tokens show as they are.
  assert.equal(railLabel("strike"), getRailByKey("strike")?.displayName);
  assert.equal(railLabel("Zelle"), "Zelle");
  assert.equal(railLabel("Some future rail"), "Some future rail");
  assert.equal(railLabel(null), "");
  // Every place that shows a rail name uses the label.
  for (const file of ["./components/TradePaymentDetails.tsx", "./screens/LiveTradeSurface.tsx", "./screens/AssistedCanvas.tsx", "./panels/SavedHandlesPanel.tsx", "./components/TradeCard.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /getRailByKey\([^)]*\)\?\.displayName/, `${file}: shows the label, not the stored name`);
  }
  const create = readFileSync(new URL("./screens/CreateForm.tsx", import.meta.url), "utf8");
  assert.match(create, /onClick=\{\(\) => togglePaymentMethod\(rail\.displayName\)\}/, "Create still stores the unchanged name");
  assert.match(create, /\{selected \? "✓ " : ""\}\{railLabel\(rail\)\}/);
}
console.log("PASS payment methods: Cash App shows as \"Cash App\"; the stored name and matching are unchanged");
