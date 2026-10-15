// Jet's rc.12 pass (Oct 15): in the sandbox the chat sheet's close button sat
// under the red banner; a pasted key still got "Did you save your key?"; and
// GrapheneOS drew text selection as black boxes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
const { setSimMode, shouldDropForSimPolicy } = await import("../sim/simMode.js");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

{
  // The banner publishes its real height (it wraps to two rows on phones) and
  // sheets start below it; the spacer under it matches.
  const pill = read("../sim/SimModeBanner.tsx");
  assert.match(pill, /export const SIM_PILL_HEIGHT_VAR = "--chama-sim-pill-height";/);
  assert.match(pill, /root\.style\.setProperty\(SIM_PILL_HEIGHT_VAR, `\$\{h\}px`\);/);
  assert.match(pill, /root\.style\.removeProperty\(SIM_PILL_HEIGHT_VAR\)/, "cleared when the banner goes");
  assert.match(pill, /<div aria-hidden="true" style=\{\{ height, flexShrink: 0 \}\} \/>/);
  const sheet = read("./components/OverlaySheet.tsx");
  assert.match(sheet, /padding: fullHeight \? "calc\(max\(12px, env\(safe-area-inset-top, 0px\)\) \+ var\(--chama-sim-pill-height, 0px\)\) 0 0"/, "a full-height sheet's header clears the banner");
  assert.match(sheet, /: "calc\(24px \+ var\(--chama-sim-pill-height, 0px\)\) 16px/);
}
console.log("PASS sandbox banner: sheets start below it, so the chat can be closed");

{
  // A key the person pasted is theirs already: login records it as saved, so
  // the reminder never asks. A key Chama generated still gets asked.
  const app = read("./App.tsx");
  const login = app.slice(app.indexOf("onConnectNsec={async"), app.indexOf("actions.connect();", app.indexOf("onConnectNsec={async")));
  assert.match(login, /if \(!wasGenerated\) \{/);
  assert.match(login, /if \(pasted\.ok\) markRecoveryKeyBackedUp\(getPublicKey\(pasted\.secretKey\)\);/);
  assert.match(login, /catch \{ \/\* The reminder only shows again; login goes on\. \*\/ \}/, "never blocks login");
}
console.log("PASS pasted key: no \"Did you save your key?\" afterwards");

{
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /html\[data-native-app\] ::selection \{ background: rgba\(128, 128, 128, 0\.35\); color: inherit; \}/);
}
console.log("PASS selection: the Android app draws its own soft highlight");

{
  // Profiles are shared: the sandbox reads real names, and the real app keeps
  // reading them too. Trade events stay split between the two worlds.
  const simTag = [["chama-sim", "v1"]];
  for (const on of [true, false]) {
    setSimMode(on);
    assert.equal(shouldDropForSimPolicy({ kind: 0, tags: [] }), false, `sim ${on}: a real profile is read`);
    assert.equal(shouldDropForSimPolicy({ kind: 0, tags: simTag }), false);
  }
  setSimMode(true);
  assert.equal(shouldDropForSimPolicy({ kind: 30078, tags: [] }), true, "sandbox still ignores real trades");
  assert.equal(shouldDropForSimPolicy({ kind: 30078, tags: simTag }), false);
  setSimMode(false);
  assert.equal(shouldDropForSimPolicy({ kind: 30078, tags: simTag }), true, "the real app still ignores sandbox trades");
  // And the sandbox never publishes a profile over the real one.
  const escrow = read("../hooks/useEscrow.ts");
  assert.match(escrow, /function refuseSandboxProfilePublish\(\): void \{\n  if \(isSimModeOn\(\)\) throw new Error/);
  assert.match(escrow, /const publishProfileName = useCallback\(async \(name: string\): Promise<void> => \{\n    refuseSandboxProfilePublish\(\);/);
  assert.match(escrow, /if \(isSimModeOn\(\)\) \{ saveAvatar\(pubkey, safe\); refuseSandboxProfilePublish\(\); \}\n    const events = await client\.queryOnce/);
}
console.log("PASS sandbox profiles: real names shown, never published over");

{
  // Follow-up: everything that reserves room for the banner uses its real
  // height, and the sandbox says plainly why a name or photo stays local.
  const app = read("./App.tsx");
  assert.match(app, /\$\{simOn \? `var\(--chama-sim-pill-height, \$\{SIM_PILL_HEIGHT\}px\)` : "0px"\}/, "trade room height");
  assert.match(read("./components/Toast.tsx"), /calc\(var\(--chama-sim-pill-height, \$\{SIM_PILL_HEIGHT\}px\) \+ 16px\)/, "toasts");
  const me = read("./screens/MeScreen.tsx");
  assert.match(me, /isSimModeOn\(\) \? "me\.sandboxProfileLocal" : "me\.tradeNameLocalOnly"/);
  assert.match(me, /isSimModeOn\(\) \? "me\.sandboxProfileLocal" : "me\.avatarFailed"/);
}
console.log("PASS sandbox follow-up: trade room and toasts reserve the real banner height; honest local-only profile copy");

{
  // Jet (GrapheneOS, rc.12): selecting text (pasting in Browse › Advanced
  // tools) drew black boxes with dark edges. Cause: the app theme set
  // android:background, which Android applies to every view inflated with
  // the theme, including the selection-handle and Copy/Paste pop-ups. Only
  // the window and the main layout carry the dark background now.
  const styles = readFileSync(new URL("../../android/app/src/main/res/values/styles.xml", import.meta.url), "utf8");
  const appThemes = styles.slice(styles.indexOf('<style name="AppTheme"'), styles.indexOf('<style name="AppTheme.NoActionBarLaunch"'));
  assert.doesNotMatch(appThemes, /<item name="android:background">/, "no theme-level background on the app themes");
  assert.equal((appThemes.match(/<item name="android:windowBackground">#05050A<\/item>/g) ?? []).length, 2, "the window stays dark");
  const layout = readFileSync(new URL("../../android/app/src/main/res/layout/activity_main.xml", import.meta.url), "utf8");
  assert.match(layout, /android:background="#05050A"/, "the screen itself stays dark");
}
console.log("PASS Android: no theme background, so selection handles and the Copy/Paste bar draw normally");

{
  // Jet (rc.12): a sandbox trade link opened in the real app said "Couldn't
  // find trade … on relays yet". The live app still drops sandbox events (so
  // they can never look real) but remembers the trade id, and the link says
  // it is a sandbox trade. Driven through the real EscrowClient drop path.
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k),
  } });
  const { EscrowClient } = await import("../escrow-engine/escrow-client.js");
  const { generateSecretKey, getPublicKey, finalizeEvent } = await import("nostr-tools/pure");
  const sk = generateSecretKey();
  const client = new EscrowClient({ getPublicKey: async () => getPublicKey(sk), signEvent: async (e: any) => finalizeEvent(e, sk),
    nip44Encrypt: async (v: string) => v, nip44Decrypt: async (v: string) => v } as any, { relays: [] });
  const drop = (client as any).relayManager.callbacks.shouldDropEvent as (event: any) => boolean;
  const sandboxEvent = { kind: 30078, tags: [["d", "sm_test_sandbox"], ["chama-sim", "v1"]] };
  const realEvent = { kind: 30078, tags: [["d", "sm_test_real"]] };
  assert.equal(drop(sandboxEvent), true, "the live app still drops sandbox events");
  assert.equal(drop(realEvent), false, "real events pass");
  assert.equal(client.sawSandboxTrade("sm_test_sandbox"), true, "but remembers the sandbox trade id");
  assert.equal(client.sawSandboxTrade("sm_test_real"), false);
  assert.equal(client.sawSandboxTrade("sm_never_seen"), false);
  const app = read("./App.tsx");
  assert.match(app, /: actions\.sawSandboxTrade\(id\) \? t\("app\.sandboxTradeLink"\)\s*: t\("app\.tradeNotFoundYet", \{ id \}\)/);
}
console.log("PASS sandbox trade link in the real app: says it is a sandbox trade, still never shown as real");
