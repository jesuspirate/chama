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

