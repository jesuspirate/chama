// Jet's 6.4.25-rc.6 review on the Pixel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getRailByKey, railLabel, railEntryName, toRailKey, matchRails } from "../payments/rail-registry.js";

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
  for (const file of ["./components/TradePaymentDetails.tsx", "./screens/LiveTradeSurface.tsx", "./screens/AssistedCanvas.tsx", "./components/TradeCard.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /getRailByKey\([^)]*\)\?\.displayName/, `${file}: shows the label, not the stored name`);
  }
  // Jet (rc.6): where the handle is typed or managed, keep the full name so
  // people know to share their $cashtag.
  assert.equal(railEntryName("cashtag"), "$cashtag (Cash App)");
  assert.equal(railEntryName("$cashtag (Cash App)"), "$cashtag (Cash App)");
  const tradeDetails = readFileSync(new URL("./components/TradePaymentDetails.tsx", import.meta.url), "utf8");
  assert.match(tradeDetails, /\{railEntryName\(h\.rail\)\} · \{h\.handle\}/, "choosing saved details shows the full name");
  assert.match(tradeDetails, /<option key=\{key\} value=\{key\}>\{railEntryName\(key\)\}<\/option>/, "adding details shows the full name");
  const handles = readFileSync(new URL("./panels/SavedHandlesPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(handles, /railLabel/, "payment methods settings keep \"$cashtag (Cash App)\"");
  const canvas = readFileSync(new URL("./screens/AssistedCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /<span>\{rail\?\.displayName \?\? key\}<\/span>/, "the handle field keeps the full name");
  const create = readFileSync(new URL("./screens/CreateForm.tsx", import.meta.url), "utf8");
  assert.match(create, /onClick=\{\(\) => togglePaymentMethod\(rail\.displayName\)\}/, "Create still stores the unchanged name");
  assert.match(create, /\{selected \? "✓ " : ""\}\{railLabel\(rail\)\}/);
}
console.log("PASS payment methods: chips and listings say \"Cash App\"; the handle field and payment methods keep \"$cashtag (Cash App)\"; the stored name and matching are unchanged");

{
  // 2. Tapping the tab you're on goes back to the top; at the top, the tap
  // keeps its old meaning (Browse: back to the guided start).
  const { scrollToTopIfScrolled } = await import("./scroll-top.js");
  const calls: ScrollToOptions[] = [];
  const page = { scrollTop: 1800, scrollTo: (o: ScrollToOptions) => { calls.push(o); page.scrollTop = 0; } };
  assert.equal(scrollToTopIfScrolled(page, false), true);
  assert.deepEqual(calls, [{ top: 0, behavior: "smooth" }]);
  assert.equal(scrollToTopIfScrolled(page, false), false, "already at the top: nothing to do");
  page.scrollTop = 900;
  scrollToTopIfScrolled(page, true);
  assert.deepEqual(calls[1], { top: 0, behavior: "auto" }, "reduced motion jumps");
  assert.equal(scrollToTopIfScrolled(null, false), false);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const sw = app.slice(app.indexOf("const switchTab = (t: Tab) => {"), app.indexOf("// ── Not connected"));
  assert.match(sw, /if \(view !== "detail" && TAB_FOR_VIEW\[view\] === t && scrollToTopIfScrolled\(\)\) return;\s*if \(t === "browse"\)/,
    "every tab: same-tab tap scrolls up first; other taps unchanged");
}
console.log("PASS tab bar: tapping the tab you're on scrolls to the top; at the top it keeps its old meaning");

{
  // Jet (rc.6, GrapheneOS): holding the canvas heading selected it, with black
  // selection boxes. In the native apps, labels and headings don't select;
  // fields, codes, keys and chat messages still do. The web is unchanged.
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // Only chrome is unselectable; nothing turns selection off for the page.
  assert.match(html, /html\[data-native-app\] :is\(h1, h2, h3, h4, h5, h6, button, label, nav, summary, \[role="tab"\], \[role="button"\], \[data-chrome\], \.assisted-canvas\) \{\s*-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;/);
  assert.doesNotMatch(html, /html\[data-native-app\] body \{[^}]*user-select: none/, "addresses, invoices and keys are never switched off");
  assert.match(html, /html\[data-native-app\] :is\(input, textarea, \[contenteditable\], \[data-selectable\]\) \{\s*-webkit-user-select: text; user-select: text;/);
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(appSrc, /<div data-chrome onClick=\{onVersionTap\}/, "the version label (seven fast taps) never selects");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  assert.match(main, /if \(g\.Capacitor\?\.isNativePlatform\?\.\(\) \|\| g\.__TAURI__ \|\| g\.__TAURI_INTERNALS__\) \{\s*document\.documentElement\.dataset\.nativeApp = "1";/);
  const chat = readFileSync(new URL("./panels/ChatPanel.tsx", import.meta.url), "utf8");
  assert.match(chat, /\{payload\.message && \(\s*<div data-selectable/, "chat messages stay copyable");
}
console.log("PASS native apps: chrome (headings, labels, buttons, tabs, version label, canvas) doesn't select; addresses, invoices, keys and chat do; web unchanged");
