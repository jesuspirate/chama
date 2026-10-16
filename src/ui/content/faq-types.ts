// Shared FAQ content types (kept separate from faq.ts so the per-language
// content modules can import them without a circular value-import).

export interface FaqItem {
  q: string;
  /** A plain paragraph, OR a structured numbered procedure — an optional intro
   *  paragraph, an aligned step list, and an optional closing paragraph. Structured
   *  steps render as a real hanging-indent list in the Help screen. */
  a: string | { intro?: string; steps: string[]; outro?: string } | { intro?: string; columns: string[]; rows: string[][]; outro?: string };
}

export interface FaqSection {
  id: string;
  title: string;
  items: FaqItem[];
}

/** One language's full FAQ article content. `id`s in sections are stable across
 *  languages (they key nothing user-visible, but keep them identical so a future
 *  deep-link survives a language switch). */
export interface FaqContent {
  intro: string;
  sections: FaqSection[];
  glossary: { term: string; def: string }[];
}
