import { syncNativeAppearance } from './native-appearance.js';
// ══════════════════════════════════════════════════════════════════════════
// Chama — Design tokens + small format helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §5.3: Apple-grade dark mode, JetBrains Mono for
// cryptographic strings, sentence case throughout. Role colors are sacred
// and reserved for role identification (no decorative use).

import type { CSSProperties } from "react";
import { Role } from "../escrow-engine/types.js";

// ── Dark / light theming (#50, DECISIONS.md 2026-06-07) ─────────────────────
// The whole UI reads `T` at render time (inline styles, ~200 alpha-concat
// sites like `${T.accent}aa`). Theming therefore swaps the palette IN PLACE
// (`Object.assign(T, …)`) and the App root re-renders — no CSS variables, no
// context, no component edits. The one footgun: anything that captures a T
// value at module load goes stale on switch. STATUS / inputStyle below are
// rebuilt by refreshThemeDerived(); don't add new module-scope captures —
// read T at render time instead.

export type ThemeMode = "dark" | "light" | "system";
export const THEME_STORAGE_KEY = "chama_theme_mode";

// v7 redesign (approved canvas, 2026-10): four colour families, each with one
// job. Ground + ink build every screen; role colours (ROLE_COLOR below) name
// people and nothing else; state colours say what happened; "in escrow" is
// neutral ink with a lock glyph — normal and safe, so no alarm colour.
//
// The legacy keys (accent, card, border, muted, green, red, amber, purple,
// teal) stay so the ~200 inline-style sites keep working; they now point at
// the new families. Every value is a 6-digit hex because call sites append an
// alpha (`${T.accent}66`). Primary buttons are INK: `accent` is ink, and text
// on an ink fill is `onInk` — never a literal #fff/#000.
const DARK = {
  // ground and ink
  bg: "#0B0B0F", surface: "#16161D", raised: "#1F1F28", line: "#2A2A35",
  ink: "#F2F1EC", ink2: "#B0AFBC", ink3: "#8A899A", onInk: "#0B0B0F",
  /** Tab bar / sidebar chrome. */
  chrome: "#111117",
  /** The brand orange — wordmark dot, loader orbit. Never a role, button or
   *  state colour, and never recoloured by the redesign (Jet, 2026-10-05).
   *  Same per-theme inks as the landing page's --dot token. */
  brand: "#F7931A",
  // state
  attn: "#FFC53D", attnBg: "#FFC53D24", attnInk: "#FFC53D",
  pos: "#3DD68C", posBg: "#3DD68C24",
  crit: "#FF6B6B", critBg: "#FF6B6B1f",
  // legacy aliases
  card: "#16161D",
  border: "#2A2A35", borderHi: "#3A3A47",
  text: "#F2F1EC", muted: "#8A899A",
  accent: "#F2F1EC", accentDim: "#F2F1EC1a",
  green: "#3DD68C", greenDim: "#3DD68C24",
  red: "#FF6B6B", redDim: "#FF6B6B1f",
  purple: "#CF8BF6", purpleDim: "#BF5AF229",
  teal: "#5AC8FA", tealDim: "#5AC8FA29",
  amber: "#FFC53D", amberDim: "#FFC53D24",
};

// Light: ink tones darken for contrast on paper; state TEXT tones are the
// darkened canvas values (attention text #8A5A00, positive #0F7A43, critical
// #C62828) while the attention FILL stays #FFC53D with dark text on it.
const LIGHT: typeof DARK = {
  bg: "#F6F5F0", surface: "#FFFFFF", raised: "#EEECE5", line: "#E1DED4",
  ink: "#15141B", ink2: "#4E4D58", ink3: "#6B6A75", onInk: "#FFFFFF",
  chrome: "#FFFFFF",
  brand: "#C47308",
  attn: "#FFC53D", attnBg: "#FFC53D38", attnInk: "#8A5A00",
  pos: "#0F7A43", posBg: "#0F7A431a",
  crit: "#C62828", critBg: "#C6282814",
  card: "#FFFFFF",
  border: "#E1DED4", borderHi: "#CFCBBF",
  text: "#15141B", muted: "#6B6A75",
  accent: "#15141B", accentDim: "#15141B12",
  green: "#0F7A43", greenDim: "#0F7A431a",
  red: "#C62828", redDim: "#C6282814",
  purple: "#8E2FC0", purpleDim: "#BF5AF21f",
  teal: "#0B6E99", tealDim: "#5AC8FA2e",
  amber: "#8A5A00", amberDim: "#FFC53D38",
};

// ── Type scale (v7 redesign) ────────────────────────────────────────────────
// Two scales in one set of tokens. Phones (narrow OR coarse pointer) read
// bigger — many Chama users have low vision — and desktops/Start9 keep a
// denser scale. The values are CSS custom properties in rem, declared by
// typeScaleCss() under media queries, so: (1) the right scale applies with no
// JS resize listener, and (2) the phone's own text-size setting (Android font
// scale, iOS text size, browser zoom) scales everything further. Use these in
// inline styles (`fontSize: T.fs.body`) instead of px literals.
export const FS = {
  /** Money amounts on trade / lock / claim screens. Phone ≥ 40px. */
  amount: "var(--chama-fs-amount)",
  /** Fiat value beside an amount. Phone 20px. */
  fiat: "var(--chama-fs-fiat)",
  largeTitle: "var(--chama-fs-large-title)",
  title1: "var(--chama-fs-title1)",
  title2: "var(--chama-fs-title2)",
  headline: "var(--chama-fs-headline)",
  /** Body copy. Phone ≥ 17px, desktop 15px. */
  body: "var(--chama-fs-body)",
  /** Secondary text. Phone ≥ 15px. */
  secondary: "var(--chama-fs-secondary)",
  /** Warnings and confirmations. Phone 18px. */
  warn: "var(--chama-fs-warn)",
  /** Keys, addresses, transaction ids (mono). */
  key: "var(--chama-fs-key)",
  /** Label on a money-action button. Phone 19px. */
  moneyButton: "var(--chama-fs-money-button)",
  /** Label on any other button. */
  button: "var(--chama-fs-button)",
  /** Tab labels. */
  tab: "var(--chama-fs-tab)",
} as const;

/** Control heights, same two-scale rule as FS. */
export const SIZE = {
  /** Money-action buttons (fund, lock, release, claim). Phone 60px. */
  moneyButton: "var(--chama-h-money-button)",
  /** Every other button. Phone 52px, desktop 48px. */
  button: "var(--chama-h-button)",
  /** Minimum touch target. Phone 48px. */
  touch: "var(--chama-h-touch)",
} as const;

/** The two scales. Desktop is the default; phone overrides it. */
export function typeScaleCss(): string {
  return `
  :root{
    --chama-fs-amount:2.25rem;--chama-fs-fiat:1.0625rem;
    --chama-fs-large-title:1.75rem;--chama-fs-title1:1.5rem;--chama-fs-title2:1.25rem;
    --chama-fs-headline:0.9375rem;--chama-fs-body:0.9375rem;--chama-fs-secondary:0.8125rem;
    --chama-fs-warn:0.9375rem;--chama-fs-key:0.8125rem;
    --chama-fs-money-button:1rem;--chama-fs-button:0.9375rem;--chama-fs-tab:0.75rem;
    --chama-h-money-button:3rem;--chama-h-button:3rem;--chama-h-touch:2.5rem;
  }
  @media (max-width: 767px), (pointer: coarse){
    :root{
      --chama-fs-amount:2.5rem;--chama-fs-fiat:1.25rem;
      --chama-fs-large-title:2.125rem;--chama-fs-title1:1.75rem;--chama-fs-title2:1.375rem;
      --chama-fs-headline:1.0625rem;--chama-fs-body:1.0625rem;--chama-fs-secondary:0.9375rem;
      --chama-fs-warn:1.125rem;--chama-fs-key:0.9375rem;
      --chama-fs-money-button:1.1875rem;--chama-fs-button:1.0625rem;--chama-fs-tab:0.8125rem;
      --chama-h-money-button:3.75rem;--chama-h-button:3.25rem;--chama-h-touch:3rem;
    }
  }`;
}

export const T = {
  ...DARK,
  /** r: buttons / tiles. rs: chips, inputs. rCard: cards. rSheet: sheet tops. */
  r: 14, rs: 10, rCard: 20, rSheet: 28,
  fs: FS,
  size: SIZE,
  mono: "'JetBrains Mono','SF Mono','Fira Code',monospace",
  sans: "'DM Sans',-apple-system,sans-serif",
  /** Logotype only — the landing page's wordmark face. Not for body copy. */
  display: "'Manrope','DM Sans',-apple-system,sans-serif",
};

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "system" ? value : "dark";
}

export function readThemeMode(): ThemeMode {
  try {
    return normalizeThemeMode(globalThis.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Cosmetic preference only; storage failure should not block trading.
  }
}

export function resolveThemeMode(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

let resolvedTheme: "dark" | "light" = "dark";

/** The currently painted palette ("dark" | "light") after system resolution. */
export function activeResolvedTheme(): "dark" | "light" {
  return resolvedTheme;
}

/**
 * Swap the active palette into T, rebuild the module-load derivations, and
 * sync the document chrome (boot background, color-scheme, theme-color).
 * Callers must trigger a React re-render afterwards (the App root does).
 */
export function applyThemeMode(mode: ThemeMode): void {
  resolvedTheme = resolveThemeMode(mode);
  Object.assign(T, resolvedTheme === "light" ? LIGHT : DARK);
  refreshThemeDerived();
  syncNativeAppearance(resolvedTheme, T.bg);
  try {
    const doc = globalThis.document;
    if (doc) {
      doc.documentElement.style.background = T.bg;
      if (doc.body) doc.body.style.background = T.bg;
      // index.html's boot pre-paint styles #root too (an ID selector, which
      // outranks the app's html,body rule) — repaint it or a system-light
      // boot leaves cream gutters around a dark session forever.
      const root = doc.getElementById("root");
      if (root) root.style.background = T.bg;
      doc.documentElement.style.colorScheme = resolvedTheme;
      doc.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolvedTheme === "light" ? LIGHT.bg : "#000000");
    }
  } catch {
    // No DOM (tests/SSR) — palette swap above is all that matters there.
  }
}

// v0.1.66.33: human-first status vocabulary + three visual modes.
//   mode "active"   → filled pill, pulsing dot (user action required)
//   mode "working"  → filled pill, static dot  (system working)
//   mode "resolved" → outlined pill, no dot    (done)
export type StatusMode = "active" | "working" | "resolved";

// `l` holds an i18n KEY (card.badge*), resolved with t() where the Badge
// renders it (Badge.tsx) — this module isn't a component so it can't call the
// hook. `.c`/`.bg`/`.mode` are style-only and stay literal.
//
// v7 redesign mapping (canvas "Trade status mapping"): no state borrows a role
// colour any more. Open/Settling are neutral, In escrow is a solid ink pill
// with a lock (`fg` + `icon`), Ready to collect is the attention fill, Done is
// positive, failures are critical, Cancelled is outlined.
//   c    — the state's text/stroke tone on a normal surface
//   bg   — the pill background ("transparent" ⇒ outlined)
//   fg   — text colour when bg is a SOLID fill (absent ⇒ c)
//   icon — a glyph that carries the meaning without colour
export type StatusStyle = {
  c: string; bg: string; l: string; mode: StatusMode;
  fg?: string; icon?: "lock";
};
/** Text on the attention fill: dark in both themes (the fill never flips). */
export const ON_ATTN = "#15141B";
export const STATUS = {
  CREATED:   { c: T.ink2, bg: T.raised, l: "card.badgeOpen",        mode: "working"  as StatusMode },
  LOCKED:    { c: T.ink,  bg: T.ink,    l: "card.badgeInEscrow",    mode: "working"  as StatusMode, fg: T.onInk, icon: "lock" as const },
  APPROVED:  { c: T.attnInk, bg: T.attn, l: "card.badgeReadyClaim", mode: "active"   as StatusMode, fg: ON_ATTN },
  CLAIMED:   { c: T.ink2, bg: T.raised, l: "card.badgeSettling",    mode: "working"  as StatusMode },
  CLAIM_FAILED: { c: T.crit, bg: T.critBg, l: "card.badgeClaimFailed", mode: "active" as StatusMode },
  COMPLETED: { c: T.pos,  bg: T.posBg,  l: "card.badgeDone",        mode: "resolved" as StatusMode },
  EXPIRED:   { c: T.crit, bg: T.critBg, l: "card.badgeTimedOut",    mode: "active"   as StatusMode },
  CANCELLED: { c: T.ink2, bg: "transparent", l: "card.badgeCancelled", mode: "resolved" as StatusMode },
} as Record<string, StatusStyle>;

// Brand-pack role colors (PHILOSOPHY.md §5.2, sacred — reserved for role
// identification, no decorative use).
//   Buyer   = Nostr Purple   #BF5AF2
//   Seller  = Bitcoin Orange #F7931A
//   Arbiter = Signal Teal    #5AC8FA
export const ROLE_COLOR = { buyer: "#BF5AF2", seller: "#F7931A", arbiter: "#5AC8FA" };
// v3.2: TEXT-legible role colours. The sacred ROLE_COLOR hexes are tuned for
// fills/borders/dots on the dark palette; as TEXT on light-mode tinted cards
// the seller orange and arbiter sky-blue fall below readable contrast. Use
// THIS map for role-coloured text (kickers, links, button labels); keep raw
// ROLE_COLOR for fills, borders, and dots. Rebuilt by refreshThemeDerived().
export const ROLE_COLOR_TEXT = { buyer: "#CF8BF6", seller: ROLE_COLOR.seller, arbiter: ROLE_COLOR.arbiter };
/** Role tints for avatar discs and role-tinted panels (canvas: 16% on dark). */
export const roleTint = (role: keyof typeof ROLE_COLOR) =>
  `${ROLE_COLOR[role]}${resolvedTheme === "light" ? "24" : "29"}`;
export const ROLE_ICON  = { buyer: "B", seller: "S", arbiter: "A" };

// v0.3.0 Phase 6 (item 8): Trinity Ring participant render order.
// PHILOSOPHY.md §5.2 brand mark places the arbiter at the apex with
// buyer/seller flanking below. TradeDetail's participant row mirrors
// this — arbiter is the structural center, not a third-party
// afterthought. Order: Buyer (left) · Arbiter (middle) · Seller (right).
//
// This constant is the source of truth — TradeDetail.tsx imports it
// for the .map render. The §43 test pins the order directly so a
// future refactor that "tidies" rendering can't silently re-sort
// participants and break brand coherence.
export const TRINITY_RING_ORDER: readonly Role[] = [
  Role.BUYER,
  Role.ARBITER,
  Role.SELLER,
];

export const CAT_ICON = { "p2p-trade": "⚡", "bill-pay": "🧾", marketplace: "", work: "🛠️", lending: "🤝" } as Record<string, string>;
export const CAT_LABEL: Record<string, string> = {
  "p2p-trade":   "⚡ Exchange",
  "bill-pay":    "🧾 Bill Pay",
  marketplace:   "Market",
  work:          "🛠️ Work",
  lending:       "🤝 Lending",
  "raw-escrow":  "🔧 Raw Escrow",
};

// Browse tab category filter pills. `id` matches state.category values
// (or "all" as a cross-cutting filter).
// `l` holds an i18n KEY (browse.*), resolved with t() at the render sites in
// BrowseView (the filter chips + the section headers) — this module is not a
// React component so it can't call the hook itself.
export const BROWSE_CATS: { id: string; l: string; i: string }[] = [
  { id: "all",          l: "browse.catAll",      i: "" },
  { id: "p2p-trade",    l: "browse.catExchange", i: "⚡" },
  { id: "bill-pay",     l: "browse.catBillPay",  i: "🧾" },
  { id: "marketplace",  l: "browse.catMarket",   i: "" },
  // v7 redesign: circles moved to their own tab, so no Chama chip here.
  // Work is parked for a future release. Its protocol support remains so old
  // trades can still be recovered and settled safely.
  // { id: "work", l: "browse.catWork", i: "🛠️" },
];

export const fmtSats = (ms: number) => Math.floor(ms / 1000).toLocaleString();

// Who receives sats on a REFUND outcome, by category. Mirrors the
// getWinner() logic in state-machine.ts for the REFUND branch:
//   marketplace: buyer locks → refund returns to buyer
//   p2p-trade / bill-pay / lending / raw-escrow: seller locks → refund to seller
export function refundRecipientFor(category: string): "buyer" | "seller" {
  return category === "marketplace" ? "buyer" : "seller";
}

export const inputStyle: CSSProperties = {
  width: "100%", padding: "12px 14px", minHeight: SIZE.touch,
  background: T.surface, border: `1px solid ${T.border}`,
  borderRadius: T.rs, color: T.text,
  fontFamily: T.sans, fontSize: FS.body, outline: "none", boxSizing: "border-box",
};

// STATUS and inputStyle capture T values at module load; rebuild them in
// place on every palette swap so importers' references stay live.
function refreshThemeDerived(): void {
  Object.assign(ROLE_COLOR_TEXT, resolvedTheme === "light"
    ? { buyer: "#8E2FC0", seller: "#A85A00", arbiter: "#0B6E99" }
    : { buyer: "#CF8BF6", seller: ROLE_COLOR.seller, arbiter: ROLE_COLOR.arbiter });
  Object.assign(STATUS.CREATED,      { c: T.ink2, bg: T.raised });
  Object.assign(STATUS.LOCKED,       { c: T.ink,  bg: T.ink, fg: T.onInk });
  Object.assign(STATUS.APPROVED,     { c: T.attnInk, bg: T.attn });
  Object.assign(STATUS.CLAIMED,      { c: T.ink2, bg: T.raised });
  Object.assign(STATUS.CLAIM_FAILED, { c: T.crit, bg: T.critBg });
  Object.assign(STATUS.COMPLETED,    { c: T.pos,  bg: T.posBg });
  Object.assign(STATUS.EXPIRED,      { c: T.crit, bg: T.critBg });
  Object.assign(STATUS.CANCELLED,    { c: T.ink2 });
  Object.assign(inputStyle, {
    background: T.surface,
    border: `1px solid ${T.border}`,
    color: T.text,
  });
}

// Apply the persisted mode at module load — before the first React render, so
// a light-mode user never sees a dark first paint (index.html handles the
// pre-bundle moment).
applyThemeMode(readThemeMode());
