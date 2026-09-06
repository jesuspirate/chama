// src/i18n — lightweight, dependency-free i18n for Chama.
//
// Design contract (Session A, 2026-07-10):
//   • English is the SOURCE OF TRUTH. Every key exists in en/ (per-screen
//     namespace files, merged in en/index.ts).
//   • fr/es fall back to en; en falls back to the raw key (never a blank UI).
//   • {param} interpolation, no library, tiny bundle — fits the no-bloat ethos.
//   • Components use useT(); pure/non-React call sites (labels/, notifications/)
//     use translate(getCurrentLang(), key, params) — they're invoked during
//     render, so they pick up the live language at call time.
//   • Language is a DEVICE preference (chama_lang), not per-npub identity —
//     auto-detected from navigator.language on first run.
//
// Sessions B (fr) / C (es) only fill fr.ts / es.ts — no component changes —
// which is what makes the translation passes cleanly fan-out-able + reviewable.

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en } from "./en/index.js";
import { fr } from "./fr/index.js";
import { es } from "./es/index.js";
import { sw } from "./sw/index.js";

export type Lang = "en" | "fr" | "es" | "sw";
export const LANGS: readonly Lang[] = ["en", "fr", "es", "sw"] as const;
// Endonyms — NEVER translated: a French speaker hunting for their language
// must see "Français" no matter what language the app is currently in.
export const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  sw: "Kiswahili",
};

export type Dict = Record<string, string>;
export type TFunc = (key: string, params?: Record<string, string | number>) => string;

const DICTS: Record<Lang, Dict> = { en, fr, es, sw };

const LANG_STORAGE_KEY = "chama_lang";

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "en" || saved === "fr" || saved === "es" || saved === "sw") return saved;
  } catch {
    /* private mode / storage disabled — fall through to locale detect */
  }
  try {
    const nav = (navigator.language || "").slice(0, 2).toLowerCase();
    if (nav === "fr" || nav === "es" || nav === "sw") return nav as Lang;
  } catch {
    /* no navigator — English */
  }
  return "en";
}

// Non-React read path (labels/, notifications/). Kept in sync synchronously by
// setLang below, so label fns re-invoked by the post-switch render see the new
// language immediately.
let currentLang: Lang = detectInitialLang();
export function getCurrentLang(): Lang {
  return currentLang;
}

function interpolate(
  s: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = DICTS[lang][key] ?? en[key] ?? key;
  return interpolate(raw, params);
}

// ---- React binding ----
type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunc;
};
const LangCtx = createContext<Ctx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => currentLang);
  const setLang = (l: Lang) => {
    currentLang = l; // sync BEFORE the render so non-React readers agree
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* best-effort persist — the session still switches */
    }
  };
  const value = useMemo<Ctx>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang],
  );
  return createElement(LangCtx.Provider, { value }, children);
}

export function useT(): Ctx {
  const ctx = useContext(LangCtx);
  if (!ctx) {
    // Outside the provider (unit tests, storybook-style renders): English,
    // switch is a no-op. Never throws — a missing provider must not take
    // down a money-path screen.
    return {
      lang: "en",
      setLang: () => {},
      t: (key, params) => translate("en", key, params),
    };
  }
  return ctx;
}
