// In-app Help & FAQ — the third mirror of docs/FAQ.md (content lives in
// ../content/faq.ts). A long, scannable accordion: tap a question to expand its
// answer. Reuses the app's card visual language and reads T at render time so it
// follows the dark/light swap. Reached from Me → "Help & FAQ"; a full screen
// (not a modal) because the content is long.
//
// v4.1 readability pass (pre-ship): the answer is where learning happens, so it's
// BIG + full-contrast + spacious, numbered procedures render as a real aligned
// (hanging-indent) list, and opening one answer makes it the hero — everything
// else recedes (dim + a light blur) until the user collapses it.

import { useState, type CSSProperties, type ReactNode, type MouseEvent } from "react";
import { T } from "../theme.js";
import { OverlaySheet } from "../components/OverlaySheet.js";
import { CardBack } from "../components/CardBack.js";
import { getFaqIntro, getFaqSections, getFaqGlossary, FAQ_HELP, type FaqItem } from "../content/faq.js";
import { isTauriRuntime } from "../sign-in-environment.js";
import { openExternalUrl } from "../open-url.js";
import { useT } from "../../i18n/index.js";

// v4.1 B (#16): under Tauri an `<a target="_blank">` is a silent no-op, so the
// footer links were dead on desktop/APK. Keep the anchor (browser middle-click /
// copy stay intact) but intercept the click in the Tauri webview and hand the
// URL to the OS opener instead. These are Chama's own trusted URLs.
function openHelpLink(e: MouseEvent<HTMLAnchorElement>, url: string): void {
  if (isTauriRuntime()) {
    e.preventDefault();
    void openExternalUrl(url);
  }
}

  // The answer — the most legible thing on the screen: big, full contrast, airy.
const answerParaStyle = (): CSSProperties => ({
  fontFamily: T.sans, fontSize: T.fs.body, lineHeight: 1.7, color: T.text, margin: 0, whiteSpace: "pre-line",
});

export function renderFaqAnswer(a: FaqItem["a"]): ReactNode {
const answerPara = answerParaStyle();
  if (typeof a === "string") return <p style={answerPara}>{a}</p>;
  if ("rows" in a) return <>
    {a.intro && <p style={{ ...answerPara, marginBottom: 13 }}>{a.intro}</p>}
    <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontFamily: T.sans, fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>
      <thead><tr>{a.columns.map(column => <th key={column} scope="col" style={{ padding: "8px 5px", textAlign: "left", borderBottom: `1px solid ${T.border}` }}>{column}</th>)}</tr></thead>
      <tbody>{a.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => j === 0
        ? <th key={j} scope="row" style={{ padding: "10px 5px", textAlign: "left", verticalAlign: "top", borderBottom: `1px solid ${T.border}` }}>{cell}</th>
        : <td key={j} style={{ padding: "10px 5px", verticalAlign: "top", borderBottom: `1px solid ${T.border}` }}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {a.outro && <p style={{ ...answerPara, marginTop: 14 }}>{a.outro}</p>}
  </>;
  return (
    <>
      {a.intro && <p style={{ ...answerPara, marginBottom: 13 }}>{a.intro}</p>}
      {/* A real numbered list with a hanging indent: fixed number column + text
          column, so wrapped lines of a step align under the step text, not the "1.". */}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 13 }}>
        {a.steps.map((step, i) => (
          <li key={i} style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <span aria-hidden="true" style={{
              flex: "0 0 auto", minWidth: 20, textAlign: "right",
              fontFamily: T.sans, fontWeight: 700, fontSize: 15, color: T.accent,
            }}>{i + 1}.</span>
            <span style={{ ...answerPara, flex: 1, minWidth: 0 }}>{step}</span>
          </li>
        ))}
      </ol>
      {a.outro && <p style={{ ...answerPara, marginTop: 14 }}>{a.outro}</p>}
    </>
  );
}

export function HelpScreen({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen(cur => (cur === key ? null : key));
  // Resolved per render → follows the live language (useT re-renders on switch).
  const faqIntro = getFaqIntro();
  const faqSections = getFaqSections();
  const faqGlossary = getFaqGlossary();

  // Focus-on-expand: when one answer is open, everything else recedes so the open
  // answer is the hero. Receded rows stay tappable — a tap collapses the current
  // one or jumps straight to another question.
  const focusMode = open !== null;
  const recede = (active: boolean): CSSProperties => ({
    opacity: active ? 0.32 : 1,
    filter: active ? "blur(1.5px)" : "none",
    transition: "opacity .2s ease, filter .2s ease",
  });

  const sectionLabel: CSSProperties = {
    fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 800,
    color: T.muted, margin: "0 2px 8px",
  };
  const cardWrap: CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, overflow: "hidden",
  };
  const linkChip: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "9px 13px", borderRadius: 999, minHeight: 40, boxSizing: "border-box",
    background: T.surface, border: `1px solid ${T.border}`,
    color: T.accent, textDecoration: "none",
    fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
  };
  const renderAnswer = renderFaqAnswer;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "4px 2px", paddingBottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}>
      {/* Header — stays full (it's navigation; the back button must never recede). */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} aria-label={t("help.back")} style={{
          width: 38, height: 38, flex: "0 0 auto", borderRadius: 999,
          background: T.surface, border: `1px solid ${T.border}`, color: T.text,
          fontFamily: T.sans, fontSize: 20, fontWeight: 700, cursor: "pointer",
          display: "grid", placeItems: "center", lineHeight: 1,
        }}>←</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, color: T.accent, marginBottom: 2 }}>
            {t("help.helpFaq")}
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 18, fontWeight: 800, color: T.text }}>
            {t("help.howChamaWorks")}
          </div>
        </div>
      </div>

      {/* Intro */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r,
        padding: "14px 16px", marginBottom: 18,
        fontFamily: T.sans, fontSize: 13, lineHeight: 1.6, color: T.muted,
        ...recede(focusMode),
      }}>
        {faqIntro}
      </div>

      {/* Sections — accordion */}
      {faqSections.map(section => (
        <div key={section.id} style={{ marginBottom: 18 }}>
          <div style={{ ...sectionLabel, ...recede(focusMode) }}>{section.title}</div>
          <div style={cardWrap}>
            {section.items.map((item, i) => {
              const key = `${section.id}:${i}`;
              const isOpen = open === key;
              return (
                <div key={key} style={{
                  borderBottom: i < section.items.length - 1 ? `1px solid ${T.border}` : "none",
                  // Hero the open row: a faint accent wash + sit above the blurred
                  // siblings so it clearly reads as "on top."
                  background: isOpen ? `${T.accent}0c` : "transparent",
                  position: "relative", zIndex: isOpen ? 1 : 0,
                  ...recede(focusMode && !isOpen),
                }}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(key)}
                    style={{
                      width: "100%", textAlign: "left", cursor: "pointer",
                      background: "none", border: "none", padding: "14px 14px", minHeight: 46,
                      display: "flex", alignItems: "center", gap: 10,
                      fontFamily: T.sans, fontSize: 15, fontWeight: 700, color: T.text,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>{item.q}</span>
                    <span aria-hidden="true" style={{
                      flex: "0 0 auto", color: isOpen ? T.accent : T.muted, fontSize: 18,
                      transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s, color .2s",
                    }}>›</span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "4px 16px 18px" }}>
                      {renderAnswer(item.a)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Mini-glossary */}
      <div style={{ marginBottom: 18, ...recede(focusMode) }}>
        <div style={sectionLabel}>{t("help.miniGlossary")}</div>
        <div style={{ ...cardWrap, padding: "6px 14px" }}>
          {faqGlossary.map((g, i) => (
            <div key={g.term} style={{ padding: "9px 0", borderBottom: i < faqGlossary.length - 1 ? `1px solid ${T.border}` : "none" }}>
              <span style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 800, color: T.text }}>{g.term}</span>
              <span style={{ fontFamily: T.sans, fontSize: 12.5, lineHeight: 1.55, color: T.muted }}> — {g.def}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Still need a hand? */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r,
        padding: "16px", textAlign: "center",
        ...recede(focusMode),
      }}>
        <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 800, color: T.text, marginBottom: 10 }}>
          {t("help.stillNeedHand")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          <a href={`https://${FAQ_HELP.app}`} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, `https://${FAQ_HELP.app}`)} style={linkChip}>🌐 {FAQ_HELP.app}</a>
          <a href={FAQ_HELP.zapstore} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, FAQ_HELP.zapstore)} style={linkChip}>📦 Zapstore</a>
          <a href={FAQ_HELP.njump} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, FAQ_HELP.njump)} style={linkChip}>⚡ {t("help.followOnNostr")}</a>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 11, color: T.muted, marginTop: 12, lineHeight: 1.5 }}>
          {t("help.tagline")}
        </div>
      </div>
    </div>
  );
}

/**
 * v7 redesign (Jet): Help & FAQ as overlays. The entry sheet lists the
 * categories; each category opens its own small sheet. Back returns to the
 * list, and closing returns to wherever the person was (Me › Settings) —
 * nothing navigates, so the page underneath keeps its scroll position.
 */
export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [page, setPage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const sections = getFaqSections();
  const glossary = getFaqGlossary();
  const section = sections.find(s => s.id === page);
  const row: CSSProperties = {
    width: "100%", minHeight: T.size.touch, display: "flex", alignItems: "center", gap: 10,
    padding: "12px 4px", background: "none", border: "none", borderTop: `1px solid ${T.line}`,
    textAlign: "left", cursor: "pointer", fontFamily: T.sans, color: T.ink,
  };
  const chevron = <span aria-hidden="true" style={{ color: T.ink3, fontSize: 18 }}>›</span>;
  const linkChip: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 13px", borderRadius: 999,
    minHeight: 44, boxSizing: "border-box", background: T.raised, border: `1px solid ${T.line}`,
    color: T.ink, textDecoration: "none", fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
  };

  if (page === "glossary") {
    return (
      <OverlaySheet title={t("help.miniGlossary")} onClose={onClose}>
        <CardBack onClick={() => setPage(null)} />
        {glossary.map(g => (
          <div key={g.term} style={{ padding: "10px 0", borderTop: `1px solid ${T.line}`, fontFamily: T.sans }}>
            <div style={{ fontSize: T.fs.body, fontWeight: 700, color: T.ink }}>{g.term}</div>
            <div style={{ fontSize: T.fs.secondary, lineHeight: 1.5, color: T.ink2, marginTop: 2 }}>{g.def}</div>
          </div>
        ))}
      </OverlaySheet>
    );
  }
  if (section) {
    return (
      <OverlaySheet title={section.title} onClose={onClose}>
        <CardBack onClick={() => { setPage(null); setOpen(null); }} />
        {section.items.map((item, i) => {
          const key = `${section.id}:${i}`;
          const isOpen = open === key;
          return (
            <div key={key} style={{ borderTop: `1px solid ${T.line}` }}>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}
                style={{ ...row, borderTop: "none", fontSize: T.fs.body, fontWeight: 600 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{item.q}</span>
                <span aria-hidden="true" style={{ color: T.ink3, fontSize: 18, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
              </button>
              {isOpen && <div style={{ padding: "0 4px 16px" }}>{renderFaqAnswer(item.a)}</div>}
            </div>
          );
        })}
      </OverlaySheet>
    );
  }
  return (
    <OverlaySheet title={t("help.helpFaq")} subtitle={t("help.howChamaWorks")} onClose={onClose}>
      <div style={{ fontFamily: T.sans, fontSize: T.fs.secondary, lineHeight: 1.55, color: T.ink2, marginBottom: 10 }}>{getFaqIntro()}</div>
      {sections.map(s => (
        <button key={s.id} type="button" onClick={() => setPage(s.id)} style={row}>
          <span style={{ flex: 1, minWidth: 0, fontSize: T.fs.body, fontWeight: 600 }}>{s.title}</span>
          <span style={{ fontSize: T.fs.secondary, color: T.ink2 }}>{s.items.length}</span>
          {chevron}
        </button>
      ))}
      <button type="button" onClick={() => setPage("glossary")} style={row}>
        <span style={{ flex: 1, minWidth: 0, fontSize: T.fs.body, fontWeight: 600 }}>{t("help.miniGlossary")}</span>
        {chevron}
      </button>
      <div style={{ borderTop: `1px solid ${T.line}`, paddingTop: 14, marginTop: 4, textAlign: "center" }}>
        <div style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, color: T.ink, marginBottom: 10 }}>{t("help.stillNeedHand")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          <a href={`https://${FAQ_HELP.app}`} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, `https://${FAQ_HELP.app}`)} style={linkChip}>🌐 {FAQ_HELP.app}</a>
          <a href={FAQ_HELP.zapstore} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, FAQ_HELP.zapstore)} style={linkChip}>📦 Zapstore</a>
          <a href={FAQ_HELP.njump} target="_blank" rel="noopener noreferrer" onClick={(e) => openHelpLink(e, FAQ_HELP.njump)} style={linkChip}>⚡ {t("help.followOnNostr")}</a>
        </div>
      </div>
    </OverlaySheet>
  );
}
