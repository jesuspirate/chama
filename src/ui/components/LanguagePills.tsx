import { T } from "../theme.js";
import { LANGS, LANG_LABELS, useT } from "../../i18n/index.js";

// The language switcher, two shapes:
//   • <LanguagePills /> — the bare pill row (GlobeCountryPicker header, where
//     language pairs naturally with picking a country).
//   • <LanguageRow />  — a full settings row (MeScreen, mirrors the Appearance
//     row's label + hint + pills layout).
// Pills show ENDONYMS (English / Français / Español) — never translated, so a
// lost French speaker can always find their way home from any language.

export function LanguagePills() {
  const { lang, setLang } = useT();
  return (
    <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
      {LANGS.map((l) => {
        const active = lang === l;
        return (
          <button
            key={l}
            onClick={() => setLang(l)}
            style={{
              padding: "6px 10px", borderRadius: 999,
              border: `1px solid ${active ? T.accent + "66" : T.border}`,
              background: active ? T.accentDim : T.surface,
              color: active ? T.accent : T.muted,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {LANG_LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}

export function LanguageRow() {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("common.language")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("common.languageHint")}
        </div>
      </div>
      <LanguagePills />
    </div>
  );
}
