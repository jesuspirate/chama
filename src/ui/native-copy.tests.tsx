// Jet's Android rc.5 screenshots: the app told people "Clearing browser data
// erases funds" and offered an "OPFS reset" although its wallet lives in the
// native bridge's database, where neither phrase means anything. This suite
// renders Settings → Advanced and reads the wallet copy for each place the
// wallet can live, so a browser-only line can't come back to the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
} });

const { LangProvider, translate } = await import("../i18n/index.js");
const { walletHome } = await import("./wallet-location.js");
const { SettingsAdvanced, resetLocalChamaCopy } = await import("./screens/SettingsAdvanced.js");
const { writeBrowserWalletRecoveryJournal } = await import("../fedimint/browser-wallet-recovery-journal.js");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const BROWSER_ONLY = /OPFS|browser data|site data|this browser|in your browser|browser storage|browser wallet|WEBLN PROBE/i;
const LANGS = ["en", "es", "fr", "sw"] as const;

const setShell = (on: boolean) => {
  if (on) (globalThis as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
  else delete (globalThis as any).Capacitor;
};

const fedimint = {
  initialized: true, joined: true, federationId: "fed-test", federationName: "Test route",
  balanceMsats: 0, busy: false, error: null, lastHealthOk: true, lastHealthAt: 0,
} as any;

const renderAdvanced = () => renderToStaticMarkup(
  <LangProvider>
    <SettingsAdvanced
      fedimint={fedimint}
      onBack={() => {}}
      onSwitchFederation={async () => {}}
      onResetLocalWallet={async () => {}}
      onSandboxFund={() => {}}
      userPubkey={"ab".repeat(32)}
    />
  </LangProvider>,
);
// Rendered HTML escapes apostrophes; compare the text the person reads.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

// Power-user mode on, so every Advanced card that can show is shown.
storage.set("chama_sandbox_mode", "1");

{
  // The Android app: the wallet is the native bridge on this device.
  setShell(true);
  assert.equal(walletHome(), "app");
  // A stale browser repair receipt must not describe the native wallet.
  assert.ok(writeBrowserWalletRecoveryJournal("ab".repeat(32), {
    version: 1, stage: "completed", operationId: "op-test", federationId: "fed-test",
    requestedAt: 1, updatedAt: 2,
  } as any), "a stale browser repair receipt is stored");
  const html = text(renderAdvanced());
  assert.ok(html.includes("RESET LOCAL CHAMA"), "the reset card still shows: it deletes the bridge database");
  assert.ok(html.includes(resetLocalChamaCopy("app", false)));
  assert.match(html, /this app's Fedimint wallet database for the open federation, on this device/);
  assert.match(html, /local wallet reset/, "the power-user toggle names the reset without OPFS");
  const hit = html.match(BROWSER_ONLY);
  assert.equal(hit, null, `browser-only copy in the Android Advanced screen: ${hit?.[0]}`);
}
console.log("PASS Android Advanced: no OPFS, browser data or Fedi WASM probe; reset says what it deletes");

{
  // A browser on a Chama node (StartOS, a friend's node): the wallet is on the node.
  setShell(false);
  storage.set("chama_native_fedimint", "1");
  assert.equal(walletHome(), "node");
  const html = text(renderAdvanced());
  assert.ok(html.includes(resetLocalChamaCopy("node", false)));
  assert.equal(html.match(/OPFS|browser data/i), null, "a node wallet has no OPFS file");
  storage.delete("chama_native_fedimint");
}
console.log("PASS Chama node Advanced: reset names the node's database");

{
  // The plain browser keeps its true browser copy.
  setShell(false);
  assert.equal(walletHome(), "browser");
  const html = text(renderAdvanced());
  assert.ok(html.includes(resetLocalChamaCopy("browser", false)));
  assert.match(html, /this browser's Fedimint wallet file \(OPFS\)/);
  assert.match(html, /FEDI WEBLN PROBE/, "the Fedi WASM probe stays for browsers");
  assert.match(html, /BROWSER WALLET REPAIR ATTEMPT/, "the browser repair receipt stays for browsers");
}
console.log("PASS browser Advanced: OPFS copy stays where it is true");

{
  // The sandbox wipes its practice wallets, never an OPFS file.
  assert.doesNotMatch(resetLocalChamaCopy("browser", true), /OPFS/);
  for (const lang of LANGS) {
    assert.doesNotMatch(translate(lang, "chat.switchWipeWarning"), /OPFS/, lang);
    assert.doesNotMatch(translate(lang, "recovery.keepUsingFooter"), /OPFS/, lang);
  }
}
console.log("PASS sandbox and recovery copy: no OPFS");

{
  // Me → Wallet and the stranded-claim surfaces pick the app's sentence in
  // the app, and the app's sentences never mention a browser.
  const me = read("./screens/MeScreen.tsx");
  assert.equal(me.match(/t\("me\.withdrawEcashBackupHint"\)/g), null, "no hard-coded browser hint left");
  assert.equal(me.match(/t\(withdrawEcashHintKey\(\)\)/g)?.length, 2, "both Withdraw-as-ecash hints are platform-aware");
  assert.match(me, /home === "app" \? "me\.withdrawEcashBackupHintApp"\n\s+: home === "node" \? "me\.withdrawEcashBackupHintNode"/);
  assert.match(me, /walletHome\(\) === "app" \? "me\.strandedClaimBodyApp" : "me\.strandedClaimBody"/);
  assert.match(me, /isNativeAppShell\(\) \? "me\.bgPushBlockedApp" : "me\.bgPushBlocked"/);
  assert.match(read("./App.tsx"), /walletHome\(\) === "app" \? "app\.strandedClaimBodyApp" : "app\.strandedClaimBody"/);
  assert.match(read("./screens/ConnectScreen.tsx"), /isTauriRuntime\(\) \? "connect\.lastChamaHereApp" : "connect\.lastChamaHere"/);
  const appKeys = [
    "me.withdrawEcashBackupHintApp", "me.strandedClaimBodyApp", "app.strandedClaimBodyApp",
    "me.bgPushBlockedApp", "me.bgPushUnsupportedApp", "connect.lastChamaHereApp",
  ];
  const BROWSER_WORD = { en: /browser|OPFS/i, es: /navegador|OPFS/i, fr: /navigateur|OPFS/i, sw: /kivinjari|OPFS/i } as const;
  for (const lang of LANGS) {
    for (const key of appKeys) {
      const s = translate(lang, key);
      assert.notEqual(s, key, `${lang} ${key} exists`);
      assert.doesNotMatch(s, BROWSER_WORD[lang], `${lang} ${key}`);
    }
    // A node wallet says who holds it.
    assert.notEqual(translate(lang, "me.withdrawEcashBackupHintNode"), "me.withdrawEcashBackupHintNode");
  }
  assert.match(translate("en", "me.withdrawEcashBackupHintNode"), /Whoever runs that node holds its sats/);
}
console.log("PASS Me → Wallet, stranded claims, alerts and sign-in: the app's own sentences");

setShell(false);
storage.clear();
console.log("native-copy: all passed");
