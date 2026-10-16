// v7 redesign foundation: tokens, type scales, buttons, nav, status capsule.
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { T, STATUS, ON_ATTN, applyThemeMode, typeScaleCss } from "./theme.js";
import { holdReducer, HOLD_TO_CONFIRM_MS, ASSISTIVE_CONFIRM_WINDOW_MS, type HoldState } from "./components/Button.js";
import { BottomNav, CreateButton, navCss, trackScrollActivity, SCROLL_STILL_FALLBACK_MS } from "./components/BottomNav.js";
import { Badge } from "./components/Badge.js";
import { ChamaBar } from "./panels/ChamaBar.js";
import { StatusBarScrim } from "./components/StatusBarScrim.js";
import { toastText } from "./components/Toast.js";
import { app as enApp } from "../i18n/en/app.js";
import { readFileSync } from "node:fs";
import { LangProvider } from "../i18n/index.js";

// ── WCAG contrast ────────────────────────────────────────────────────────────
function lum(hex: string): number {
  const n = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
for (const mode of ["dark", "light"] as const) {
  applyThemeMode(mode);
  for (const ground of [T.bg, T.surface]) {
    for (const [name, fg] of [["ink", T.ink], ["ink2", T.ink2], ["ink3", T.ink3], ["attnInk", T.attnInk], ["pos", T.pos], ["crit", T.crit]] as const) {
      assert.ok(contrast(fg, ground) >= 4.5, `${mode}: ${name} on ${ground} is AA (${contrast(fg, ground).toFixed(2)})`);
    }
    assert.ok(contrast(T.ink, ground) >= 7, `${mode}: amounts (ink) are AAA on ${ground}`);
  }
  assert.ok(contrast(T.onInk, T.ink) >= 7, `${mode}: money-button label on ink is AAA`);
  assert.ok(contrast(ON_ATTN, T.attn) >= 7, `${mode}: text on the attention fill is AAA`);
  // Every palette value must stay 6-digit hex: call sites append alphas.
  for (const k of ["bg", "surface", "raised", "line", "ink", "ink2", "ink3", "onInk", "accent", "border", "muted", "green", "red", "amber", "purple", "teal"] as const) {
    assert.match(T[k], /^#[0-9A-Fa-f]{6}$/, `${mode}: T.${k} is 6-digit hex`);
  }
  // No trade state borrows a role colour; In escrow is ink with a lock.
  assert.equal(STATUS.LOCKED.bg, T.ink);
  assert.equal(STATUS.LOCKED.icon, "lock");
  assert.equal(STATUS.APPROVED.bg, T.attn);
  for (const s of Object.values(STATUS)) {
    for (const role of ["#BF5AF2", "#F7931A", "#5AC8FA"]) assert.notEqual(s.c.toUpperCase(), role);
  }
  // Buttons are ink.
  assert.equal(T.accent, T.ink);
}
applyThemeMode("dark");
console.log("PASS palette: AA text in both themes, AAA amounts/money buttons/attention, ink buttons, no role colour in states");

// ── Type scales ──────────────────────────────────────────────────────────────
{
  const css = typeScaleCss();
  const [desktop, phone] = css.split("@media");
  const px = (block: string, v: string) => {
    const m = block.match(new RegExp(`--${v}:([0-9.]+)rem`));
    assert.ok(m, `${v} declared`);
    return parseFloat(m![1]) * 16;
  };
  assert.match(phone, /max-width: 767px\), \(pointer: coarse\)/, "phone scale = narrow OR coarse pointer");
  assert.ok(px(phone, "chama-fs-body") >= 17, "phone body ≥ 17px");
  assert.ok(px(phone, "chama-fs-secondary") >= 15, "phone secondary ≥ 15px");
  assert.ok(px(phone, "chama-fs-amount") >= 40, "phone amounts ≥ 40px");
  assert.equal(px(phone, "chama-fs-fiat"), 20, "phone fiat 20px");
  assert.equal(px(phone, "chama-h-money-button"), 60, "phone money buttons 60px");
  assert.equal(px(phone, "chama-fs-money-button"), 19, "phone money-button label 19px");
  assert.ok(px(phone, "chama-h-touch") >= 48, "phone touch targets ≥ 48px");
  assert.equal(px(phone, "chama-fs-warn"), 18, "phone warnings 18px");
  assert.equal(px(desktop, "chama-fs-body"), 15, "desktop body 15px");
  assert.equal(px(desktop, "chama-h-button"), 48, "desktop buttons 48px");
  assert.doesNotMatch(css, /--chama-[a-z0-9-]+:[0-9.]+px/, "scale is rem-only so OS text size scales it further");
  assert.match(T.fs.amount, /^var\(--chama-fs-amount\)$/);
}
console.log("PASS type scales: phone ≥17/15/40/20, money buttons 60px/19px, 48px touch, 18px warnings; desktop 15px/48px; rem only");

// ── Hold to confirm ──────────────────────────────────────────────────────────
{
  const H = HOLD_TO_CONFIRM_MS;
  let s: HoldState = { kind: "idle" };
  s = holdReducer(s, { type: "press", at: 0 });
  s = holdReducer(s, { type: "tick", at: H - 1 });
  assert.equal(s.kind, "holding", "not confirmed before the hold completes");
  s = holdReducer(s, { type: "release", at: H - 1 });
  assert.equal(s.kind, "idle", "lifting early cancels");
  s = holdReducer(holdReducer({ kind: "idle" }, { type: "press", at: 0 }), { type: "tick", at: H });
  assert.equal(s.kind, "confirmed", "a full hold confirms");
  assert.equal(holdReducer(s, { type: "press", at: H + 5 }).kind, "confirmed", "confirmed is terminal (no double fire)");
  // A pointer tap (press + immediate release) never confirms.
  s = holdReducer(holdReducer({ kind: "idle" }, { type: "press", at: 0 }), { type: "release", at: 80 });
  assert.equal(holdReducer(s, { type: "tick", at: 5000 }).kind, "idle");
  // Assistive tech: first activation arms, second within the window confirms.
  s = holdReducer({ kind: "idle" }, { type: "assistive-activate", at: 0 });
  assert.equal(s.kind, "armed");
  assert.equal(holdReducer(s, { type: "assistive-activate", at: 1000 }).kind, "confirmed");
  const expired = holdReducer(s, { type: "tick", at: ASSISTIVE_CONFIRM_WINDOW_MS + 1 });
  assert.equal(expired.kind, "idle", "an armed confirm expires");
  assert.equal(holdReducer(expired, { type: "assistive-activate", at: ASSISTIVE_CONFIRM_WINDOW_MS + 2 }).kind, "armed",
    "after expiry the next activation only re-arms");
}
console.log("PASS hold to confirm: hold confirms once, early lift cancels, taps never confirm, assistive double-activation confirms in-window only");

// ── Nav ──────────────────────────────────────────────────────────────────────
{
  const html = renderToStaticMarkup(<LangProvider><BottomNav active="circles" onSelect={() => {}} onCreate={() => {}} badges={{ home: 2 }} /></LangProvider>);
  for (const label of ["Home", "Browse", "Circles", "Me", "Create"]) assert.match(html, new RegExp(`>${label}<`));
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /aria-current="page"[^>]*data-coach="nav-circles"/);
  for (const c of ["nav-home", "nav-browse", "nav-circles", "nav-me", "fab-create"]) {
    assert.equal(html.split(`data-coach="${c}"`).length - 1, 1, `${c} exists once`);
  }
  assert.match(html, /<nav[^>]*aria-label="Main"/);
  assert.match(html, />2</, "Home carries the needs-you count");
  const css = navCss();
  assert.match(css, /@media \(min-width:1024px\)\{[\s\S]*\.chama-nav\{top:0;right:auto;width:240px/, "sidebar from 1024px");
  assert.match(css, /\.chama-create-fab\{display:none!important\}/, "phone Create hidden beside the sidebar");
  assert.doesNotMatch(css, /chama-create-plus/, "no top-bar plus anywhere");
  // Jet (6.4.25): Create floats on every phone, iPhone included, never as a
  // "+" beside the version; the user agent no longer decides.
  for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "Mozilla/5.0 (Linux; Android 15; Pixel 8)", "Mozilla/5.0 (Macintosh)"]) {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: ua } });
    const fab = renderToStaticMarkup(<LangProvider><CreateButton onCreate={() => {}} /></LangProvider>);
    assert.match(fab, /class="chama-create-fab-wrap"[\s\S]*class="chama-create-fab"[\s\S]*>Create</, `${ua}: floating "+ Create"`);
  }
  // No fade between glass and solid: the switch is instant both ways.
  assert.doesNotMatch(css, /\.chama-create-fab\{[^}]*transition/, "no transition on the Create button");
  assert.doesNotMatch(css, /\.chama-create-fab-scrolling \.chama-create-fab\{[^}]*transition/);
  assert.match(css, /\.chama-create-fab-wrap\{display:none!important\}/, "the Android Create wrapper is hidden beside the sidebar too");
  // Android FAB (6.4.23 RC): while the page scrolls the button itself is
  // frosted glass, about half see-through (no halo around it), and every page
  // ends with room to scroll its last control clear of the button.
  assert.match(css, /\.chama-create-fab-scrolling \.chama-create-fab\{background:#[0-9A-Fa-f]{6}26;[^}]*backdrop-filter:blur\(3px\)[^}]*text-shadow:/, "while scrolling the Create button is a light, clearly see-through glass (15% page tint, 3px blur), at once");
  assert.doesNotMatch(css, /\.chama-create-fab-scrolling \.chama-create-fab\{[^}]*background:#[0-9A-Fa-f]{6}80/, "not the half-ink tint that read as flat grey");
  assert.doesNotMatch(css, /\.chama-create-fab-wrap::before/, "no halo around the Create button");
  assert.match(css, /body:has\(\.chama-create-fab\) \.chama-shell-nav::after\{content:"";display:block;height:84px\}/);
}
// Status bar (6.4.23 rc): a fixed strip covers the safe-area inset so the
// top bar never scrolls under the phone's clock, on every shell branch.
{
  const scrim = renderToStaticMarkup(<StatusBarScrim />);
  assert.match(scrim, /position:fixed;top:0;left:0;right:0;z-index:150;height:env\(safe-area-inset-top, 0px\)/);
  assert.match(scrim, /pointer-events:none/); assert.match(scrim, /aria-hidden="true"/);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/<style>\{globalCss\(\)\}<\/style>\n\s*\{useSafeAreaInsets && <StatusBarScrim \/>\}/g) ?? []).length, 3);
}
console.log("PASS nav: Home/Browse/Circles/Me + Create, one active tab, unique coach targets, sidebar ≥1024px, floating Create on every phone");
{
  // Create button glass (Jet, 6.4.25): on the moment a finger touches the
  // page, held while it moves, solid the instant it is still. No idle delay.
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const timers = {
    set: (fn: () => void, _ms: number) => { const id = nextId++; pending.set(id, fn); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
  };
  const fireAll = () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); };

  // Browsers with scrollend (Chrome, Android WebView, Firefox): no timers at all.
  const seen: boolean[] = [];
  const a = trackScrollActivity((on) => seen.push(on), true, timers);
  a.onPress();
  assert.deepEqual(seen, [true], "glass the moment the finger touches the page, before any scroll");
  a.onRelease();
  assert.deepEqual(seen, [true, false], "a touch with no movement is solid again the instant the finger lifts");
  a.onPress(); a.onScroll(); a.onScroll();
  a.onRelease();
  assert.deepEqual(seen, [true, false, true], "a fling keeps the glass after the finger lifts, while the page still moves");
  a.onScrollEnd();
  assert.deepEqual(seen, [true, false, true, false], "solid the instant the page reports it stopped");
  a.onPress(); a.onScroll(); a.onScrollEnd();
  assert.deepEqual(seen.slice(4), [true], "the finger still down keeps the glass even if movement stops");
  a.onRelease();
  assert.deepEqual(seen.slice(4), [true, false]);
  a.onScroll(); a.onScrollEnd();
  assert.deepEqual(seen.slice(6), [true, false], "a wheel or keyboard scroll also turns it on and off");
  assert.equal(pending.size, 0, "no timer is ever used where scrollend exists");

  // Safari (no scrollend): still once no scroll has arrived for ~2 frames.
  assert.equal(SCROLL_STILL_FALLBACK_MS, 34);
  const safari: boolean[] = [];
  const b = trackScrollActivity((on) => safari.push(on), false, timers);
  b.onPress(); b.onScroll(); b.onScroll();
  assert.equal(pending.size, 1, "one stillness timer, restarted by each scroll, never stacked");
  b.onRelease();
  assert.deepEqual(safari, [true], "still moving after the lift");
  fireAll();
  assert.deepEqual(safari, [true, false], "solid once the page is still");
  b.onPress(); b.onRelease();
  assert.deepEqual(safari, [true, false, true, false], "a still tap is instant on Safari too");
  b.onScroll(); b.dispose();
  assert.equal(pending.size, 0, "unmount clears the timer");
}
console.log("PASS Create glass: on at first touch, held while moving, solid the instant the page is still, no fade");

// ── Badge + capsule ──────────────────────────────────────────────────────────
{
  const locked = renderToStaticMarkup(<LangProvider><Badge status="LOCKED" /></LangProvider>);
  assert.match(locked, /<svg/, "In escrow carries a lock");
  assert.doesNotMatch(locked, /uppercase/, "sentence case");
  const needs = renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{ joined: true } as any} chamaLabel={{ kind: "needs-you", count: 2 }} onTapStranded={() => {}} onInit={() => {}} showReconnect={false} /></LangProvider>);
  assert.match(needs, new RegExp(`background:${T.attn}`), "needs-you is the attention fill");
  const inTrade = renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{ joined: true } as any} chamaLabel={{ kind: "in-trade", sats: 250000, activeTradeCount: 1 }} onTapStranded={() => {}} onTapInTrade={() => {}} onInit={() => {}} showReconnect={false} /></LangProvider>);
  assert.match(inTrade, /<svg/, "in-trade capsule carries the lock");
  assert.doesNotMatch(inTrade, /#BF5AF2|#a78bfa/i, "in-trade no longer uses the buyer's purple");
}
{
  const bar = (chamaLabel: any) => renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{ joined: true } as any} chamaLabel={chamaLabel} onTapStranded={() => {}} onTapInTrade={() => {}} onInit={() => {}} showReconnect={false} /></LangProvider>);
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const needs = bar({ kind: "needs-you", count: 2 });
  assert.match(needs, /aria-label="Needs you: 2"/, "count is in the accessible name");
  assert.match(text(needs), /2 Needs you/);
  assert.match(text(bar({ kind: "stranded", sats: 4200 })), /4,200 to recover/, "amount first, then what to do");
  assert.match(text(bar({ kind: "in-trade", sats: 250000, activeTradeCount: 1 })), /1 trade · .*250,000 locked/);
  assert.match(text(bar({ kind: "unreachable" })), /Can't reach your Chama · Retry|Can&#x27;t reach your Chama · Retry/);
  assert.match(text(bar({ kind: "ready" })), /Ready/);
  for (const h of [needs, bar({ kind: "stranded", sats: 1 }), bar({ kind: "unreachable" }), bar({ kind: "in-trade", sats: 1, activeTradeCount: 2 })]) {
    assert.doesNotMatch(h, /⚠|⚡/, "no emoji in the capsule");
  }
}
console.log("PASS badge + capsule: lock on In escrow, sentence case, attention fill for needs-you, neutral in-trade, canvas wording without emoji");

// ── Converter: grouped number typing ────────────────────────────────────────
{
  const { separatorsFor, parseTyped, formatRaw, meaningfulBefore, caretAfter } = await import("./grouped-number.js");
  const en = separatorsFor("en"), fr = separatorsFor("fr"), es = separatorsFor("es"), sw = separatorsFor("sw");
  assert.deepEqual([en.group, en.decimal], [",", "."]);
  assert.equal(fr.decimal, ",");
  assert.deepEqual([es.group, es.decimal], [".", ","]);
  assert.equal(formatRaw(parseTyped("1250000", en, 0), en), "1,250,000");
  assert.equal(formatRaw(parseTyped("1250000", es, 0), es), "1.250.000");
  assert.equal(formatRaw(parseTyped("1250000", sw, 0), sw), "1,250,000");
  assert.equal(formatRaw(parseTyped("1234", fr, 0), fr), `1${fr.group}234`);
  // Our own grouping and pasted text read back to the same raw value.
  assert.equal(parseTyped("1,250,000", en, 0), "1250000");
  assert.equal(parseTyped("1.250.000", es, 0), "1250000");
  assert.equal(parseTyped("12,345.67 sats", en, 0), "1234567", "sats never take a decimal");
  // Fiat decimals: locale decimal key, two places, trailing point kept while typing.
  assert.equal(parseTyped("12.", en, 2), "12.");
  assert.equal(parseTyped("12,5", fr, 2), "12.5");
  assert.equal(parseTyped("12.5", fr, 2), "12.5", "French users can type a point too");
  assert.equal(parseTyped("1.234,567", es, 2), "1234.56");
  assert.equal(formatRaw("1234.5", fr), `1${fr.group}234,5`);
  assert.equal(parseTyped("0007", en, 0), "7");
  assert.equal(parseTyped(".5", en, 2), "0.5");
  assert.equal(parseTyped("", en, 2), "");
  // Caret stays after the same digit when a separator appears.
  const typed = "1250"; // caret at the end, about to become "1,250"
  assert.equal(caretAfter(formatRaw(parseTyped(typed, en, 0), en), meaningfulBefore(typed, 4, en), en), 5);
  // Typing in the middle: "1,2|50" + "9" → "12,9|50"
  const mid = "1,29,50"; // the field after inserting 9 at caret 4
  assert.equal(caretAfter(formatRaw(parseTyped(mid, en, 0), en), meaningfulBefore(mid, 4, en), en), 4);
  console.log("PASS converter grouping: locale separators, raw round-trip, fiat decimals, stable caret");
}

{
  // Jet (6.4.23-rc.5): a raw wallet-bridge error filled the screen in a toast.
  const t = (key: string) => (enApp as Record<string, string>)[key] ?? key;
  const unreachable = "Native Fedimint bridge is enabled but unreachable at http://127.0.0.1:8787/health. Start the local Rust bridge and tap Reconnect.\n\nChama diagnostics:\n{\n  \"issue\": \"native_fedimint_bridge_unavailable\"\n}";
  assert.equal(toastText(unreachable, t), "Your wallet is still starting. Give it a few seconds, then try again.");
  const slow = "Native Fedimint bridge /join did not answer within 30s. No sats moved.\n\nChama diagnostics:\n{\"issue\": \"native_fedimint_bridge_timeout\"}";
  assert.equal(toastText(slow, t), "Your wallet didn't answer in time. Check your balance before you try again.");
  // The timeout error is shared by every bridge call, payments included, so the
  // toast must never claim that no sats moved.
  assert.doesNotMatch(toastText(slow, t) as string, /no sats/i);
  assert.equal(toastText("Something failed.\n\nChama diagnostics:\n{\"issue\": \"x\"}", t), "Something failed.", "diagnostics never reach a toast");
  assert.equal(toastText("Joined as buyer", t), "Joined as buyer");
  for (const lang of ["en", "es", "fr", "sw"]) {
    const src = readFileSync(`src/i18n/${lang}/app.ts`, "utf8");
    assert.match(src, /"app\.walletStarting":/, `${lang} has the wallet-starting line`);
    assert.match(src, /"app\.walletSlow":/, `${lang} has the wallet-slow line`);
  }
}
console.log("PASS toasts: wallet-bridge errors read as plain sentences, diagnostics stripped");

// First screen (Jet, 6.4.25): "Log in" on top, "Sign up" below, in every language.
{
  const { ConnectScreen, CONNECT_DOORS, CONNECT_DOOR_LABEL } = await import("./screens/ConnectScreen.js");
  assert.deepEqual([...CONNECT_DOORS], ["returning", "create"], "Log in (returning) first, Sign up (create) second");
  const words: Record<string, [string, string]> = {
    en: ["Log in", "Sign up"], fr: ["Se connecter", "S'inscrire"], es: ["Iniciar sesión", "Registrarse"], sw: ["Ingia", "Jisajili"],
  };
  for (const [lang, [login, signup]] of Object.entries(words)) {
    const src = readFileSync(`src/i18n/${lang}/me.ts`, "utf8");
    assert.ok(src.includes(`"${CONNECT_DOOR_LABEL.returning}": ${JSON.stringify(login)}`), `${lang}: ${login}`);
    assert.ok(src.includes(`"${CONNECT_DOOR_LABEL.create}": ${JSON.stringify(signup)}`), `${lang}: ${signup}`);
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0", language: "en", languages: ["en"] } });
  const html = renderToStaticMarkup(<LangProvider><ConnectScreen onConnect={() => {}} onConnectNsec={() => {}} loading={false} error={null} /></LangProvider>);
  const doors = [...html.matchAll(/data-connect-door="([a-z]+)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(doors, [["returning", "Log in"], ["create", "Sign up"]], "rendered top to bottom: Log in, then Sign up");
  const { T } = await import("./theme.js");
  const tag = (door: string) => [...html.matchAll(/<button[^>]*>/g)].map(m => m[0]).find(t => t.includes(`data-connect-door="${door}"`)) ?? "";
  const filled = (door: string) => tag(door).includes(`background:${T.accent}`);
  assert.equal(filled("create"), true, "Sign up is the filled button");
  assert.equal(filled("returning"), false, "Log in is the outlined button");
}
console.log("PASS first screen: Log in on top, Sign up below (filled), in en, fr, es and sw");
