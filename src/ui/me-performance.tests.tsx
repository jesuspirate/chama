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
import { MeScreen, ME_ROW_ANIMATED, meRowAnimation } from "./screens/MeScreen.js";
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
  assert.equal(ME_TRADE_PAGE_SIZE, 10);
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
  assert.equal(rows, ME_TRADE_PAGE_SIZE, "Me renders 10 of 150 trades");
  assert.match(html, /data-me-trade-show-more[^>]*>Show 10 more</, "a Show more button offers the next 10");
  assert.match(html, /data-me-trade-search/, "a search box appears once there are more trades than one page");
  const few = renderToStaticMarkup(
    <LangProvider>
      <MeScreen {...meProps(trades.slice(0, 8))} />
    </LangProvider>,
  );
  assert.equal(few.match(/data-me-trade-row/g)?.length ?? 0, 8);
  assert.doesNotMatch(few, /data-me-trade-show-more|data-me-trade-search/, "no paging or search for a short history");
}
console.log("PASS Me list: 10 rows, Show more, search box only for long histories");

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
