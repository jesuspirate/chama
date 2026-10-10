// v7 redesign foundation: tokens, type scales, buttons, nav, status capsule.
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { T, STATUS, ON_ATTN, applyThemeMode, typeScaleCss } from "./theme.js";
import { holdReducer, HOLD_TO_CONFIRM_MS, ASSISTIVE_CONFIRM_WINDOW_MS, type HoldState } from "./components/Button.js";
import { BottomNav, navCss } from "./components/BottomNav.js";
import { Badge } from "./components/Badge.js";
import { ChamaBar } from "./panels/ChamaBar.js";
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
  assert.match(css, /\.chama-create-plus,\.chama-create-fab\{display:none!important\}/, "phone Create hidden beside the sidebar");
}
console.log("PASS nav: Home/Browse/Circles/Me + Create, one active tab, unique coach targets, sidebar ≥1024px");

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

// ── Trade room step strip (Figma pass) ──────────────────────────────────────
{
  const { tradeStepsDone } = await import("./trade-steps.js");
  const { EscrowStatus, Outcome } = await import("../escrow-engine/types.js");
  const t = (o: Record<string, unknown>) => ({ category: "p2p-trade", status: EscrowStatus.CREATED, votes: {}, lock: { notesHash: null, lockedAt: null }, resolvedOutcome: null, ...o }) as never;
  assert.equal(tradeStepsDone(t({})), 0);
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.LOCKED, lock: { notesHash: "x", lockedAt: 1 } })), 1);
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.LOCKED, votes: { buyer: Outcome.RELEASE } })), 2);
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.LOCKED, votes: { buyer: Outcome.REFUND } })), 1, "a cancel vote is not a payment");
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE })), 3);
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.COMPLETED, resolvedOutcome: Outcome.RELEASE })), 4);
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.REFUND })), null, "refunds show no strip");
  assert.equal(tradeStepsDone(t({ status: EscrowStatus.CANCELLED })), null);
  assert.equal(tradeStepsDone(t({ category: "marketplace", status: EscrowStatus.LOCKED })), null, "only money-for-sats trades");
  console.log("PASS trade steps: read from committed state, hidden for refunds, closed trades and non-exchange categories");
}

// Wide New look uses one column, keeping both phone and Classic untouched.
{
  const { newLookDesktopCss } = await import('./desktop-layout.js');
  const css = newLookDesktopCss();
  assert.match(css, /@media \(min-width:1024px\)/);
  assert.match(css, /max-width:720px;margin:0 auto/);
  assert.match(css, /data-new-look="true".*\.chama-page-brand\{display:none!important\}/);
  assert.match(css, /h1\{font-size:1.75rem!important\}/);
  assert.match(css, /assisted-choice strong\{font-size:1.125rem\}/);
  assert.match(css, /assisted-canvas-footer\{display:flex/);
}
