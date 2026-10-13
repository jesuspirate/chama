// Me with 100+ trades (Jet, after 6.4.23): paging, search over every trade,
// a short row animation, one rating lookup, and stable lists from App.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { parseEscrowEvent } from "../escrow-engine/event-parser.js";
import { replayEventChain } from "../escrow-engine/state-machine.js";
import { EscrowEventKind, type EscrowState, type NostrEvent } from "../escrow-engine/types.js";
import { LangProvider } from "../i18n/index.js";
import { ME_TRADE_PAGE_SIZE, searchMeTrades } from "./me-trade-filters.js";
import { MeScreen, ME_ROW_ANIMATED, ME_ROW_STYLE_OFFSCREEN, meRowAnimation } from "./screens/MeScreen.js";
import { sameList, sameRecord } from "./stable-list.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)),
  removeItem: (k: string) => storage.delete(k), key: () => null, get length() { return storage.size; },
} });

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const viewer = key();
function trade(i: number, description: string, fiatCurrency = "USD"): EscrowState {
  const at = 1_790_000_000 + i * 3600;
  const id = `me_perf_${i}`;
  const e = finalizeEvent({ kind: EscrowEventKind.CREATE, created_at: at, tags: [["d", id]], content: JSON.stringify({
    type: "escrow:create", description, amountMsats: (21_000 + i) * 1000, fiatAmount: 10 + i, fiatCurrency,
    category: "p2p-trade", mintUrl: "fed11q...", platformFeeBps: 0, platformFeePubkey: viewer.pk,
    arbiterFeeMsats: 1_000, paymentMethods: [i % 2 ? "M-Pesa" : "Zelle"], expirySeconds: 86400 * 3650, createdAt: at,
  }) }, viewer.sk);
  const raw: NostrEvent = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
  const parsed = parseEscrowEvent(raw, raw.content);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const replayed = replayEventChain([parsed.event]);
  if (!replayed.ok) throw new Error(replayed.error.message);
  return replayed.state;
}

const trades = Array.from({ length: 150 }, (_, i) => trade(i, i === 137 ? "Bicycle for Nairobi" : `Sats for cash ${i}`, i === 42 ? "KES" : "USD")).reverse();
const noName = () => null;
const noop = () => {};
const meProps = (list: EscrowState[]): ComponentProps<typeof MeScreen> => ({
  pubkey: viewer.pk, myTrades: list, allTrades: list, archivedTrades: [], myGivenRatings: [], ratings: [],
  balanceMsats: 0, onOpenTrade: noop, onSignOut: noop, onOpenSavedHandles: noop,
  onOpenPayoutDestinations: noop, onOpenAdvanced: noop, onOpenHelp: noop,
} as unknown as ComponentProps<typeof MeScreen>);

{
  assert.equal(ME_TRADE_PAGE_SIZE, 30);
  assert.equal(searchMeTrades(trades, "", noName), trades, "an empty search is the whole list, same array");
  assert.deepEqual(searchMeTrades(trades, "bicycle", noName).map(t => t.id), ["me_perf_137"],
    "search finds a trade far past the first page");
  assert.deepEqual(searchMeTrades(trades, "kes", noName).map(t => t.id), ["me_perf_42"], "search matches the currency");
  assert.equal(searchMeTrades(trades, "m-pesa", noName).length, 75, "search matches payment methods");
  assert.deepEqual(searchMeTrades(trades, "BICYCLE nairobi", noName).map(t => t.id), ["me_perf_137"], "every word must match, any case");
  assert.equal(searchMeTrades(trades, "bicycle zelle", noName).length, 0);
  const named = searchMeTrades(trades.slice(0, 3), "quick dikdik", pk => pk === viewer.pk ? "Quick Dikdik" : null);
  assert.equal(named.length, 3, "search matches the names of the people in a trade");
}
console.log("PASS Me search: whole list, every word, title, currency, payment method and names");

{
  for (let i = 0; i < ME_ROW_ANIMATED; i++) assert.match(meRowAnimation(i, false)!, /^fadeIn 0\.3s ease /);
  assert.equal(ME_ROW_ANIMATED, 8);
  assert.equal(meRowAnimation(8, false), undefined, "row 9 onwards appears at once");
  assert.equal(meRowAnimation(149, false), undefined);
  assert.match(meRowAnimation(7, false)!, /0\.28s both$/, "the last animated row starts within 0.3s");
  assert.match(meRowAnimation(40, true)!, /^chamaPillTarget 2\.6s ease-out 0s 2$/, "the Live pill ring still plays on any row");
  assert.match(meRowAnimation(2, true)!, /^fadeIn .*, chamaPillTarget /);
}
console.log("PASS Me rows: only the first 8 fade in; the Live ring still plays");

{
  const html = renderToStaticMarkup(
    <LangProvider>
      <MeScreen {...meProps(trades)} />
    </LangProvider>,
  );
  const rows = html.match(/data-me-trade-row/g)?.length ?? 0;
  assert.equal(rows, ME_TRADE_PAGE_SIZE, "Me renders 30 of 150 trades");
  assert.match(html, /data-me-trade-show-more[^>]*>Show 30 more</, "a Show more button offers the next 30");
  assert.match(html, /data-me-trade-search/, "a search box appears once there are more trades than one page");
  const few = renderToStaticMarkup(
    <LangProvider>
      <MeScreen {...meProps(trades.slice(0, 12))} />
    </LangProvider>,
  );
  assert.equal(few.match(/data-me-trade-row/g)?.length ?? 0, 12);
  assert.doesNotMatch(few, /data-me-trade-show-more|data-me-trade-search/, "no paging or search for a short history");
}
console.log("PASS Me list: 30 rows, Show more, search box only for long histories");

{
  const a = { id: "x", n: 1 }, b = { id: "y", n: 2 };
  assert.equal(sameList([a, b], [a, b]), true);
  assert.equal(sameList([a, b], [b, a]), false, "order matters");
  assert.equal(sameList([a], [{ ...a }]), false, "identity by default");
  assert.equal(sameList([a], [{ ...a }], sameRecord), true, "records compare field by field when asked");
  assert.equal(sameList([a], [{ ...a, n: 3 }], sameRecord), false);

  const me = readFileSync("src/ui/screens/MeScreen.tsx", "utf8");
  assert.match(me, /const MeTradeHistory = memo\(/);
  assert.match(me, /const SellerDashboardPanel = memo\(/);
  assert.match(me, /const ArbiterDashboardPanel = memo\(/);
  assert.match(me, /const MeTradeRow = memo\(/);
  assert.doesNotMatch(me, /myGivenRatings \?\? \[\]\)\.some\(/, "no per-row scan of every rating");
  assert.match(me, /onOpenTrade=\{openTrade\}/, "Me tabs get stable callbacks, not App's fresh ones");

  const app = readFileSync("src/ui/App.tsx", "utf8");
  for (const list of ["visibleTrades", "myTrades", "archivedTrades", "needsYouTrades"]) {
    assert.match(app, new RegExp(`const ${list} = useStableList\\(`), `App keeps ${list} stable between renders`);
  }
}
console.log("PASS Me stays still: memoised tabs and rows, stable callbacks, stable lists from App");

{
  // Jet (rc.1, 58 trades): returning to My trades from any Me tab lagged. A
  // trace at mid-range-phone speed showed 22-33 ms of layout per return (vs
  // 1-3 ms for other tabs): the kept-mounted pane was hidden with display:none,
  // which discards its layout, so every card was laid out again.
  const me = readFileSync("src/ui/screens/MeScreen.tsx", "utf8");
  assert.doesNotMatch(me, /hidden=\{shownTab !== /, "no Me tab hides with display:none where content-visibility works");
  for (const pane of ["trades", "seller", "sats", "arbiter", "profile", "settings", "community"]) {
    assert.match(me, new RegExp(`<MePane store=\\{tabs\\} id="${pane}">`), `${pane} sits behind a MePane gate`);
  }
  assert.match(me, /CSS\.supports\("content-visibility", "hidden"\)/, "feature-checked, with the display:none fallback");
  assert.match(me, /contentVisibility: "hidden"/);
  assert.deepEqual(ME_ROW_STYLE_OFFSCREEN, { contentVisibility: "auto", containIntrinsicSize: "auto 240px" },
    "rows below the screen skip layout until scrolled near");
  assert.match(me, /\(ringing \? null : ME_ROW_STYLE_OFFSCREEN\)/, "a ringing row is never paint-contained");
}
console.log("PASS Me tabs keep their layout: content-visibility panes and offscreen rows");

{
  // Hidden timing readout (?perf=1 or 7 taps on the version label).
  const probe = await import("./perf-probe.js");
  const { PerfReadout } = await import("./components/PerfReadout.js");
  storage.delete("chama_perf_readout_v1");
  assert.equal(probe.perfEnabled(), false, "off by default");
  assert.equal(renderToStaticMarkup(<PerfReadout />), "", "renders nothing while off");
  probe.perfTapStart("settings");
  assert.equal(probe.perfTiming(), false, "taps are not timed while off");

  const toggle = probe.versionTapToggle();
  for (let i = 0; i < 6; i++) toggle();
  assert.equal(probe.perfEnabled(), false, "six taps are not enough");
  toggle();
  assert.equal(probe.perfEnabled(), true, "the seventh tap turns it on");
  assert.equal(storage.get("chama_perf_readout_v1"), "1", "and it stays on across reloads");

  const frames: Array<() => void> = [];
  (globalThis as any).requestAnimationFrame = (fn: () => void) => { frames.push(fn); return frames.length; };
  probe.perfTapStart("settings");
  assert.equal(probe.perfTiming(), true);
  const checked = trades.slice(0, 5).map(t => probe.checkedTradeCreate(t));
  assert.deepEqual(checked, [true, true, true, true, true], "the counted check gives the same verdict");
  probe.perfMeasure("dashboard build", () => 1);
  probe.perfMeasure("needs-you build", () => 2);
  probe.perfTapCommitted("trades");
  assert.equal(frames.length, 0, "a commit of another tab does not end the tap");
  probe.perfTapCommitted("settings");
  frames.shift()!();
  await new Promise(r => setTimeout(r, 5));
  const [tap] = probe.perfHistory();
  assert.equal(tap.label, "settings");
  assert.ok(tap.totalMs >= tap.renderMs && tap.drawMs >= 0);
  const sig = tap.steps.find(s => s.name === "signature checks")!;
  assert.equal(sig.count, 5, "every signature check is counted");
  assert.ok(sig.extra <= 5, "uncached checks are counted separately");
  assert.deepEqual(tap.steps.filter(s => s.name !== "signature checks").map(s => s.name).sort(), ["dashboard build", "needs-you build"]);
  assert.equal(probe.perfTiming(), false, "the tap is finished");
  const report = probe.perfReport();
  assert.match(report, /^React profiler (on|off \(release build\))\nsettings: \d+ ms total \(React \d+ ms, browser draw \d+ ms\)/);
  assert.match(report, /\n  signature checks: \d+ ms · 5×/);
  assert.match(renderToStaticMarkup(<PerfReadout />), /data-perf-readout[\s\S]*settings/, "the readout shows the tap");

  probe.setPerfEnabled(false);
  assert.equal(storage.has("chama_perf_readout_v1"), false, "Off clears the flag");
  assert.equal(probe.perfHistory().length, 0);

  const app = readFileSync("src/ui/App.tsx", "utf8");
  assert.match(app, /onClick=\{onVersionTap\}/, "the version label carries the seven-tap toggle");
  assert.match(app, /<PerfReadout \/>/);
  const me = readFileSync("src/ui/screens/MeScreen.tsx", "utf8");
  assert.match(me, /perfTapStart\(key\);\s*tabs\.press\(key\);/, "every Me tab tap starts a timing");
  assert.match(me, /perfMeasure\("dashboard build"/);
  assert.match(me, /perfMeasure\("needs-you build"/);
  assert.match(app, /perfMeasure\("needs-you build"/);
  assert.match(readFileSync("src/ui/components/TradeCard.tsx", "utf8"), /perfAdd\("card drawing"/);
}
console.log("PASS timing readout: off by default, 7 taps or ?perf=1, per-tap total, React vs draw, named steps, copyable report");

{
  // Jet (rc.4 readout): a tab tap re-rendered the whole Me screen 3-5 times.
  // The open tab now lives in a store: the pill highlights at once, the pane
  // swaps a frame later, and the Me screen itself does not re-render.
  const { createMeTabStore } = await import("./me-tab-store.js");
  const frames: Array<() => void> = [];
  (globalThis as any).requestAnimationFrame = (fn: () => void) => { frames.push(fn); return frames.length; };
  const store = createMeTabStore("trades");
  let notified = 0;
  store.subscribe(() => notified++);
  assert.equal(store.isVisited("settings"), false);
  store.press("settings");
  assert.equal(store.getPressed(), "settings", "the pill highlights at once");
  assert.equal(store.getShown(), "trades", "the pane waits for the next frame");
  assert.equal(notified, 1);
  store.press("sats");
  frames.shift()!();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(store.getShown(), "trades", "a superseded press never shows its pane");
  frames.shift()!();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(store.getShown(), "sats");
  assert.equal(store.isVisited("sats"), true);
  assert.equal(store.isVisited("settings"), false, "a tab only flashed past is not mounted");
  store.set("community");
  assert.equal(store.getPressed(), "community");
  assert.equal(store.getShown(), "community", "programmatic navigation shows at once");

  const me = readFileSync("src/ui/screens/MeScreen.tsx", "utf8");
  assert.doesNotMatch(me, /useState<"trades" \| "sats"/, "the open tab is not Me screen state");
  assert.doesNotMatch(me, /useDeferredValue\(meTab\)/);
  assert.match(me, /const MeTabPills = memo\(/);
  assert.match(me, /useMePressedTab\(store\)/, "pills follow the pressed tab");
  assert.match(me, /useMeShownTab\(store\)/, "panes follow the shown tab");
  const app = readFileSync("src/ui/App.tsx", "utf8");
  for (const zone of ["Top bar", "Me screen", "Browse", "Bottom nav"]) assert.match(app, new RegExp(`<PerfZone id="${zone}">`));
  assert.match(readFileSync("src/main.tsx", "utf8"), /<PerfZone id="Whole app">/);
  assert.match(readFileSync("vite.config.ts", "utf8"), /CHAMA_PROFILING === "1"[\s\S]*react-dom\/profiling/, "profiling bundle only when asked for");
}
console.log("PASS Me tab store: instant pill, pane next frame, no Me re-render, profiler zones");
