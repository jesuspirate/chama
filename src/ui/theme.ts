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

const DARK = {
  bg: "#0a0a0f", surface: "#111118", card: "#16161f",
  border: "#1e1e2e", borderHi: "#2a2a3e",
  text: "#e8e6e0", muted: "#6b6980",
  accent: "#f7931a", accentDim: "#f7931a33",
  green: "#22c55e", greenDim: "#22c55e22",
  red: "#ef4444", redDim: "#ef444422",
  purple: "#a78bfa", purpleDim: "#a78bfa22",
  teal: "#2dd4bf", tealDim: "#2dd4bf22",
  amber: "#fbbf24", amberDim: "#fbbf2422",
};

// Light palette: solids are darkened for contrast on paper (small bold mono
// text everywhere), while the Dim tints keep the BRIGHT hue at low alpha so
// fills stay warm. Role colors are not here — they're sacred and identical in
// both modes (PHILOSOPHY §5.2).
const LIGHT: typeof DARK = {
  bg: "#f4f3ee", surface: "#ffffff", card: "#faf9f4",
  border: "#e3e1d6", borderHi: "#cfccbe",
  text: "#1d1c24", muted: "#6e6c7e",
  accent: "#c47308", accentDim: "#f7931a24",
  green: "#15803d", greenDim: "#22c55e21",
  red: "#dc2626", redDim: "#ef444421",
  purple: "#7048e8", purpleDim: "#a78bfa28",
  teal: "#0f766e", tealDim: "#2dd4bf26",
  amber: "#b45309", amberDim: "#fbbf2430",
};

export const T = {
  ...DARK,
  r: 12, rs: 8,
  mono: "'JetBrains Mono','SF Mono','Fira Code',monospace",
  sans: "'DM Sans',-apple-system,sans-serif",
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
  try {
    const doc = globalThis.document;
    if (doc) {
      doc.documentElement.style.background = T.bg;
      if (doc.body) doc.body.style.background = T.bg;
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
export const STATUS = {
  CREATED:   { c: T.teal,   bg: T.tealDim,   l: "card.badgeOpen",        mode: "working"  as StatusMode },
  LOCKED:    { c: T.purple, bg: T.purpleDim, l: "card.badgeInEscrow",    mode: "working"  as StatusMode },
  APPROVED:  { c: T.accent, bg: T.accentDim, l: "card.badgeReadyClaim",  mode: "active"   as StatusMode },
  CLAIMED:   { c: T.amber,  bg: T.amberDim,  l: "card.badgeSettling",    mode: "working"  as StatusMode },
  CLAIM_FAILED: { c: T.red, bg: T.redDim, l: "card.badgeClaimFailed",     mode: "active"   as StatusMode },
  COMPLETED: { c: T.green,  bg: T.greenDim,  l: "card.badgeDone",        mode: "resolved" as StatusMode },
  EXPIRED:   { c: T.red,    bg: T.redDim,    l: "card.badgeTimedOut",    mode: "active"   as StatusMode },
  CANCELLED: { c: T.muted,  bg: T.surface,   l: "card.badgeCancelled",   mode: "resolved" as StatusMode },
} as Record<string, { c: string; bg: string; l: string; mode: StatusMode }>;

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
export const ROLE_COLOR_TEXT = { ...ROLE_COLOR };
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
  "bill-pay":    "🧾 Community Bill Pay",
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
  width: "100%", padding: "12px 14px",
  background: T.surface, border: `1px solid ${T.border}`,
  borderRadius: T.rs, color: T.text,
  fontFamily: T.sans, fontSize: 14, outline: "none", boxSizing: "border-box",
};

// STATUS and inputStyle capture T values at module load; rebuild them in
// place on every palette swap so importers' references stay live.
function refreshThemeDerived(): void {
  Object.assign(ROLE_COLOR_TEXT, resolvedTheme === "light"
    ? { buyer: "#9b3fd1", seller: "#c47308", arbiter: "#0e7aa8" }
    : ROLE_COLOR);
  Object.assign(STATUS.CREATED,      { c: T.teal,   bg: T.tealDim });
  Object.assign(STATUS.LOCKED,       { c: T.purple, bg: T.purpleDim });
  Object.assign(STATUS.APPROVED,     { c: T.accent, bg: T.accentDim });
  Object.assign(STATUS.CLAIMED,      { c: T.amber,  bg: T.amberDim });
  Object.assign(STATUS.CLAIM_FAILED, { c: T.red,    bg: T.redDim });
  Object.assign(STATUS.COMPLETED,    { c: T.green,  bg: T.greenDim });
  Object.assign(STATUS.EXPIRED,      { c: T.red,    bg: T.redDim });
  Object.assign(STATUS.CANCELLED,    { c: T.muted,  bg: T.surface });
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
