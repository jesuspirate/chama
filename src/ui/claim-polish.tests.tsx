// Jet's 6.4.25 rc review on the Pixel and iPhone: saved wallets never show a
// full LNURL; one attention signal on Browse; one clock line in the trade room;
// a short, once-per-session message when a browser can't hold the wallet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider, translate } from "../i18n/index.js";
import { displayPayoutDestination, walletNameParts } from "../payments/payout-destinations.js";
import { walletName } from "./wallet-names.js";
import { SavedWalletRow } from "./components/SavedWalletRow.js";
import { oncePerSessionToastKey, toastText } from "./components/Toast.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k), key: (i: number) => [...storage.keys()][i] ?? null, get length() { return storage.size; },
} });
const FEDI = "lnurl1dp68gurn8ghj7urjdajzuun9vd6hyunfdenkgtnkv95nze3wdaexwtmvdemrztmsv9ukxmmyv4ej7ef5x3jnvepexp3kvv3hx9nxgetyxg6rzcfkxc6nxvp3x93kxer9vdjkze33vgek2vecvycn2et9xcexzepsx3nx2v3nvsmrzdpnxveqdvj4tm";

{
  // A named LNURL wallet: the name, then the short code — never the full LNURL.
  const named = { id: "1", label: "Fedi Bitcrazy", address: FEDI } as never;
  const html = renderToStaticMarkup(<LangProvider><SavedWalletRow label={walletName(named)} detail={displayPayoutDestination(FEDI)} onSelect={() => {}} /></LangProvider>);
  assert.match(html, />Fedi Bitcrazy</);
  assert.match(html, />lnurl1dp6…4tm</);
  assert.ok(!html.includes(FEDI), "the full LNURL never renders");
  // Unnamed wallets get a name people recognise, never the receive code.
  const plain = { id: "2", label: "", address: FEDI } as never;
  assert.equal(walletName(plain, "en"), "Fedi wallet", "Fedi's LNURL (recurringd) reads as Fedi wallet");
  assert.equal(walletName(plain, "fr"), "Portefeuille Fedi");
  assert.equal(walletName(plain, "es"), "Billetera Fedi");
  assert.equal(walletName(plain, "sw"), "Pochi ya Fedi");
  assert.equal(walletName({ address: "bitcrazy@strike.me" }, "en"), "Strike · bitcrazy");
  assert.equal(walletName({ address: "Bitcrazy@GetAlby.com" }, "en"), "Alby · bitcrazy");
  assert.equal(walletName({ address: "me@example.org" }, "en"), "me@example.org", "an unknown domain shows the address itself");
  assert.equal(walletName({ address: "bitcrazy@strike.me", label: "Cash out" }, "en"), "Cash out", "a name the person gave wins");
  assert.deepEqual(walletNameParts(FEDI), { kind: "fedi" });
  const other = "lnurl1" + "x".repeat(10);
  assert.equal(walletNameParts(other).kind, "plain", "a malformed LNURL still never shows in full");
  const unnamed = renderToStaticMarkup(<LangProvider><SavedWalletRow label={walletName(plain, "en")} detail={displayPayoutDestination(FEDI)} onSelect={() => {}} /></LangProvider>);
  assert.match(unnamed, />Fedi wallet</);
  assert.match(unnamed, />lnurl1dp6…4tm</);
  assert.ok(!unnamed.includes(FEDI));
  // A Lightning address is short already and shows as is.
  assert.equal(displayPayoutDestination("bitcrazy@getalby.com"), "bitcrazy@getalby.com");
  for (const file of ["./panels/ClaimPayoutModal.tsx", "./panels/PayoutDestinationsPanel.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /detail=\{destination\.label \? destination\.address/, `${file}: no full address under a wallet name`);
    assert.match(src, /detail=\{displayPayoutDestination\(destination\.address\)\}/);
    assert.match(src, /label=\{walletName\(destination\)\}/, `${file}: the friendly name is the row's label`);
  }
  // One tidy saved list: the same wallet saved twice (any case, with a
  // lightning: prefix) is kept once, newest first, and survives a restart
  // through the primary key and its backup.
  const { addOrTouchPayoutDestination, listPayoutDestinations } = await import("../payments/payout-destinations.js");
  addOrTouchPayoutDestination("bitcrazy@strike.me");
  addOrTouchPayoutDestination("lightning:BITCRAZY@strike.me");
  addOrTouchPayoutDestination(FEDI);
  const saved = listPayoutDestinations();
  assert.deepEqual(saved.map(d => d.address).sort(), [FEDI, "bitcrazy@strike.me"].sort(), "no duplicates");
  assert.ok(storage.has("chama_payout_destinations") && storage.has("chama_payout_destinations_backup"), "saved with a backup copy");
  storage.delete("chama_payout_destinations");
  assert.equal(listPayoutDestinations().length, 2, "restored from the backup if the main copy is lost");
  // Saved wallets persist per identity, with a backup copy (unchanged).
  const store = readFileSync(new URL("../payments/payout-destinations.ts", import.meta.url), "utf8");
  assert.match(store, /PAYOUT_DESTINATIONS_STORAGE_KEY = "chama_payout_destinations"/);
  assert.match(store, /PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY = "chama_payout_destinations_backup"/);
}
console.log("PASS saved wallets: a recognisable name (Fedi wallet, Strike · bitcrazy) and a short code, never the full LNURL; one de-duplicated list that survives restarts");

{
  // Browse: the top bar's "Needs you" pill is the one signal; no floating bell.
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /CanvasAttentionBell/);
  assert.doesNotMatch(app, /visibleAttentionTrade|attentionActionMode/);
  const bar = readFileSync(new URL("./panels/ChamaBar.tsx", import.meta.url), "utf8");
  assert.match(bar, /label\.kind === "needs-you"/, "the bar still carries needs-you");
}
console.log("PASS Browse attention: one signal, the top bar");

{
  // Trade room: a "Your turn" card shows the clock; the line under the people
  // card hides then, so the expiry appears once.
  const lts = readFileSync(new URL("./screens/LiveTradeSurface.tsx", import.meta.url), "utf8");
  assert.match(lts, /\{clock && <div data-decision-clock /);
  assert.match(lts, /body:has\(\[data-decision-clock\]\) \.lts-clock\{display:none\}/);
  assert.match(lts, /className="lts-clock"/, "the line stays for screens without a card");
  // Phone layout: the decision area shares the page background and the cards'
  // 16px sides, with even 12px gaps — no separate white panel.
  assert.match(lts, /\.lts-pane\.lts-votes\{background:\$\{T\.bg\};padding:12px 16px\}/);
  assert.match(lts, /\.lts-decision-well\{display:flex;flex-direction:column;gap:12px\}/);
  // rc.7 (Pixel 8, 412×915): the top half took 487px and the decision
  // scrolled inside the rest. Phones: compact amount and people cards, a
  // clear line between the halves, and the arbiter record only before the
  // viewer is seated (it stays one tap away on the arbiter).
  assert.match(lts, /\.lts-grid\{border-top:1px solid \$\{T\.line\}\}/);
  assert.match(lts, /\.lts-money-card\{padding:10px 14px!important;gap:10px!important\}/);
  assert.match(lts, /\.lts-room \[data-role-avatar\]\{zoom:\.75\}/);
  assert.match(lts, /\.lts-person-meta\{flex-direction:row!important/);
  assert.match(lts, /\{myRole === null && <TradeArbiterRecord /);
  assert.match(lts, /party\.role === Role\.ARBITER \? <TradeArbiterRecord /, "still in the arbiter's sheet");
}
console.log("PASS trade room: one clock line per screen; on phones one calm page, even gaps, aligned edges");

{
  // Wallet storage: one short sentence, in every language, once per session.
  const raw = "Chama could not open its secure local wallet storage. This is a browser storage failure—not evidence that your iPhone ran out of memory—and Reconnect cannot repair it in this browser.";
  for (const lang of ["en", "fr", "es", "sw"] as const) {
    const text = toastText(raw, key => translate(lang, key)) as string;
    assert.ok(text.includes("getchama.app") && text.includes("Safari") && text.length < 140, `${lang}: short, names Safari`);
    assert.doesNotMatch(text, /memory|Reconnect/);
  }
  assert.equal(toastText(raw, key => translate("en", key)), "This browser can't keep your Chama wallet. On iPhone, open getchama.app in Safari. Nothing was changed.");
  assert.equal(oncePerSessionToastKey(raw), "wallet-storage-unavailable");
  assert.equal(oncePerSessionToastKey("Joined as buyer"), null, "other toasts are never deduplicated");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const guard = app.slice(app.indexOf("const setToast = useCallback"), app.indexOf("toastRef.current = setToast;"));
  assert.match(guard, /oncePerSessionToastKey\(next\.message\)/);
  assert.match(guard, /if \(shownOnceToasts\.current\.has\(key\)\) return;/);
}
console.log("PASS wallet storage message: one short sentence in en/fr/es/sw, shown once per session");
