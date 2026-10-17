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
  // rc.5: the activity never leaves its launch theme, so a splash background
  // there drew the logo behind the federation picker and Copy/Paste bar.
  assert.doesNotMatch(styles, /<item name="android:background">/, "no theme-level background on any theme, launch included");
  assert.match(styles, /<item name="android:windowBackground">@drawable\/chama_splash<\/item>/, "the launch splash stays on the window");
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

{
  // The link was one way in. Jet actually looked for the offer in Browse, and
  // a trade can also be tapped or pasted (Browse › Load a trade). The real app
  // names the sandbox on every open, and Browse points to YOUR OWN sandbox
  // offers only (other people's stay silent: noise for a real user).
  const sightings = await import("../sim/sandbox-sightings.js");
  sightings.resetSandboxSightingsForTests();
  const me = "a".repeat(64);
  const other = "b".repeat(64);
  const simTag = ["chama-sim", "v1"];
  let fired = 0;
  const off = sightings.onSandboxSighting(() => { fired++; });

  setSimMode(false);
  sightings.noteDroppedSandboxEvent({ pubkey: me, tags: [["d", "sm_abc_1"], simTag] });
  sightings.noteDroppedSandboxEvent({ pubkey: me, tags: [["d", "sm_abc_1"], simTag] });
  sightings.noteDroppedSandboxEvent({ pubkey: other, tags: [["d", "sm_abc_2"], simTag] });
  sightings.noteDroppedSandboxEvent({ pubkey: me, tags: [["d", "sm_real_3"]] });
  sightings.noteDroppedSandboxEvent({ pubkey: me, tags: [["d", "not-a-trade"], simTag] });
  assert.equal(sightings.wasSeenAsSandboxTrade("sm_abc_1"), true);
  assert.equal(sightings.wasSeenAsSandboxTrade("sm_abc_2"), true);
  assert.equal(sightings.wasSeenAsSandboxTrade("sm_real_3"), false, "a real trade is never called sandbox");
  assert.equal(sightings.wasSeenAsSandboxTrade("not-a-trade"), false);
  assert.equal(sightings.sandboxTradeCountBy(me.toUpperCase()), 1, "only my own sandbox offers count");
  assert.equal(sightings.sandboxTradeCountBy(null), 0);
  assert.equal(fired, 2, "one signal per new sandbox trade");

  setSimMode(true);
  sightings.noteDroppedSandboxEvent({ pubkey: me, tags: [["d", "sm_abc_4"]] });
  assert.equal(sightings.wasSeenAsSandboxTrade("sm_abc_4"), false, "the sandbox dropping a real trade records nothing");
  setSimMode(false);
  off();

  const app = read("./App.tsx");
  assert.equal((app.match(/actions\.sawSandboxTrade\(id\) \? t\("app\.sandboxTradeLink"\)/g) ?? []).length, 3,
    "deep link, tap/paste and a failed refetch all say sandbox");
  const browse = read("./screens/BrowseView.tsx");
  assert.match(browse, /<SandboxOwnHiddenNote pubkey=\{pubkey\} \/>/);
  assert.match(browse, /if \(count === 0\) return null;/, "silent unless you have one");
  for (const lang of ["en", "es", "fr", "sw"]) {
    assert.match(read(`../i18n/${lang}/browse.ts`), /"browse\.sandboxOwnHidden": ".*poc\.getchama\.app/);
  }
}
console.log("PASS real app: every way into a sandbox trade says sandbox; Browse points to your own sandbox offers");

{
  // Jet (rc.13, iOS): pressing Enter in the chat kept the keyboard up, hiding
  // the chat's close button. On touch screens Enter sends and closes it.
  const chat = read("./panels/ChatPanel.tsx");
  assert.match(chat, /if \(e\.key !== "Enter" \|\| e\.shiftKey\) return;\s*handleSend\(\);/);
  assert.match(chat, /matchMedia\("\(pointer: coarse\)"\)\.matches\) e\.currentTarget\.blur\(\);/);
}
console.log("PASS chat: Enter on a phone sends and closes the keyboard");

{
  // Jet (rc.13 card: "Hold + left text"): Dispute is a press-and-hold like
  // every other money move. The hold only opens the mandatory reasons; a
  // reason still sends the vote. "→ back to sender" sits under the label,
  // away from the floating 💬 at the right edge.
  const lts = read("./screens/LiveTradeSurface.tsx");
  const refund = lts.slice(lts.indexOf("{showRefund && armed !== Outcome.REFUND && ("), lts.indexOf("{armed === Outcome.REFUND && ("));
  assert.match(refund, /<MoneyHold\s+variant="destructive"[\s\S]*?onConfirm=\{\(\) => armOrVote\(Outcome\.REFUND\)\}[\s\S]*?label=\{tr\("lts\.refundDispute"\)\}\s+sublabel=\{tr\("lts\.backToSender"\)\}/);
  assert.doesNotMatch(refund, /castVote/, "the hold itself never sends a vote");
  assert.match(refund, /\{showRefund && armed === Outcome\.REFUND && \(\s+<VoteButton[\s\S]*?label=\{tr\("lts\.pickReason"\)\}/);
  assert.match(lts, /onClick=\{\(\) => \{ disarm\(\); onSendChat\(reason\); void run\(\(\) => castVote\(Outcome\.REFUND\)\); \}\}/, "a reason sends the vote");
  assert.match(lts, /flexDirection: "column", alignItems: "center"[\s\S]{0,80}<span>\{label\}<\/span>\s+<span style=\{\{ fontSize: T\.fs\.secondary/, "sublabel under the label");
}
console.log("PASS dispute: press-and-hold opens the reasons; back-to-sender under the label");

{
  // Jet (rc.14): the back link read differently in Browse ("Change the last
  // answer", under the country chip) and Circles ("Back", above it). Both now
  // share one top row — "← Back" left, the chip right — and say "Back" on
  // every screen (src/ui/canvas-back.tests.tsx covers the row itself).
  const canvas = read("./screens/AssistedCanvas.tsx");
  assert.doesNotMatch(canvas, /tr\("canvas\.changeLast"\)/);
  assert.match(canvas, /<CanvasTopRow onBack=\{back \? \(\) => back\.run\(\) : null\} chip=\{community \? <CommunityChip slug=\{community\.slug\}/, "Browse: one row");
  const circle = read("./screens/CircleCanvas.tsx");
  assert.match(circle, /<CanvasTopRow onBack=\{step \? \(\) => setStep\(step - 1\) : onBack\} chip=\{<CommunityChip slug=\{community\} onOpen=\{onOpenCommunity\} \/>\} \/>/, "Circles: the same row");
}
console.log("PASS back link: same words, same place in Browse and Circles");
