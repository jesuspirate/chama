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
  assert.match(tradeDetails, /label: `\$\{railEntryName\(h\.rail\)\} · \$\{h\.handle\}`/, "choosing saved details shows the full name");
  assert.match(tradeDetails, /aria-checked=\{rail === key\}[^>]*>[\s\S]{0,400}\{railEntryName\(key\)\}<\/button>/, "adding details shows the full name");
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
  const fakeRoot = (scrollTop: number) => {
    const calls: ScrollToOptions[] = [];
    const root = { scrollTop, calls, scrollTo: (o: ScrollToOptions) => { calls.push(o); root.scrollTop = 0; } };
    return root;
  };
  // rc.7 on the Pixel: <body> is the scroller (html/body height 100% with
  // overflow-x hidden), so the document's scrolling element reads 0.
  let doc = fakeRoot(0), body = fakeRoot(1500);
  assert.equal(scrollToTopIfScrolled([doc, body], false), true, "body scrolled: the tap scrolls up");
  assert.deepEqual(body.calls, [{ top: 0, behavior: "smooth" }]);
  assert.deepEqual(doc.calls, [], "the unscrolled root is left alone");
  assert.equal(body.scrollTop, 0);
  // A layout where the window scrolls still works.
  doc = fakeRoot(1800); body = fakeRoot(0);
  assert.equal(scrollToTopIfScrolled([doc, body], false), true, "window scrolled: the tap scrolls up");
  assert.deepEqual(doc.calls, [{ top: 0, behavior: "smooth" }]);
  assert.deepEqual(body.calls, []);
  // At the top everywhere: nothing to do, the tap keeps its old meaning.
  doc = fakeRoot(0); body = fakeRoot(3);
  assert.equal(scrollToTopIfScrolled([doc, body], false), false, "already at the top: nothing to do");
  assert.deepEqual([...doc.calls, ...body.calls], []);
  assert.equal(scrollToTopIfScrolled([null, undefined], false), false);
  assert.equal(scrollToTopIfScrolled([], false), false);
  // Reduced motion jumps instead of gliding.
  body = fakeRoot(900);
  scrollToTopIfScrolled([fakeRoot(0), body], true);
  assert.deepEqual(body.calls, [{ top: 0, behavior: "auto" }], "reduced motion jumps");
  // Without scrollTo, scrollTop is set directly.
  const bare = { scrollTop: 700 };
  assert.equal(scrollToTopIfScrolled([bare], false), true);
  assert.equal(bare.scrollTop, 0);
  // The default candidates include <body>, not just the scrolling element.
  const src = readFileSync(new URL("./scroll-top.ts", import.meta.url), "utf8");
  assert.match(src, /\[document\.scrollingElement, document\.body\]/, "body is checked by default");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /html, body \{ height: 100%; \}/, "if this CSS changes, recheck which element scrolls");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const sw = app.slice(app.indexOf("const switchTab = (t: Tab) => {"), app.indexOf("// ── Not connected"));
  assert.match(sw, /if \(view !== "detail" && TAB_FOR_VIEW\[view\] === t && scrollToTopIfScrolled\(\)\) return;\s*if \(t === "browse"\)/,
    "every tab: same-tab tap scrolls up first; other taps unchanged");
}
console.log("PASS tab bar: tapping the tab you're on scrolls to the top; at the top it keeps its old meaning");

{
  // Jet (rc.6, GrapheneOS): holding the canvas heading selected it, with black
  // selection boxes; rc.7: the trade screen still selected. In the native
  // apps the page opts out and copyable things opt back in. The web is
  // unchanged.
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /html\[data-native-app\] body \{\s*-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;/);
  assert.match(html, /html\[data-native-app\] :is\(input, textarea, \[contenteditable\], \[data-selectable\], code, pre, kbd, samp, \[style\*="JetBrains Mono"\], \[style\*="monospace"\], \[style\*="break-all"\]\) \{\s*-webkit-user-select: text; user-select: text;/,
    "fields, chat, marked values and monospace or break-all addresses, invoices, keys and codes stay copyable");
  assert.doesNotMatch(html, /^\s*(html|body|#root)(?![^{]*data-native-app)[^{]*\{[^}]*user-select: none/m, "the web build never turns selection off");
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(appSrc, /<div data-chrome onClick=\{onVersionTap\}/, "the version label (seven fast taps) never selects");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  assert.match(main, /if \(g\.Capacitor\?\.isNativePlatform\?\.\(\) \|\| g\.__TAURI__ \|\| g\.__TAURI_INTERNALS__\) \{\s*document\.documentElement\.dataset\.nativeApp = "1";/);
  const chat = readFileSync(new URL("./panels/ChatPanel.tsx", import.meta.url), "utf8");
  assert.match(chat, /\{payload\.message && \(\s*<div data-selectable/, "chat messages stay copyable");
}
console.log("PASS native apps: nothing selects except fields, chat, marked values and monospace addresses, invoices, keys and codes; web unchanged");
