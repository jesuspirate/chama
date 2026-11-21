import { useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { T } from "../theme.js";
import { OverlaySheet } from "./OverlaySheet.js";

// Jet (6.4.26-rc.5): the Android WebView draws a native select element as the
// system picker, which ignored Chama's theme (and drew the splash art behind
// its rows). Every choice opens the app's own sheet instead, like the
// payment-details picker. Only the look changes: the same values reach
// onChange.
export interface SheetSelectOption {
  value: string;
  /** Shown on the trigger, and as the row's main line. */
  label: string;
  /** A second, quieter line under the label in the sheet only. */
  detail?: string;
  /** A flag or emoji drawn before the row's text in the sheet. */
  leading?: string;
  /** A short mark at the row's end, such as a currency symbol. */
  trailing?: string;
}

/** Optional search box above a long list. `rank` gets the typed text and
 *  returns the option values to show, best first; an empty query shows all. */
export interface SheetSelectSearch {
  placeholder: string;
  noMatches: string;
  rank: (query: string) => readonly string[];
}

export function SheetSelect({ value, options, onChange, title, disabled = false, id, ariaLabel, style, search }: {
  value: string;
  options: SheetSelectOption[];
  search?: SheetSelectSearch;
  onChange: (value: string) => void;
  /** The sheet's title; also the trigger's accessible name unless ariaLabel is given. */
  title: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  /** Trigger style, usually the style the old select element had. */
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = options.find(o => o.value === value);
  const close = () => { setOpen(false); setQuery(""); };
  const choose = (next: string) => { close(); if (next !== value) onChange(next); };
  const shown = useMemo(() => {
    if (!search || !query.trim()) return options;
    const byValue = new Map(options.map(o => [o.value, o]));
    return search.rank(query).flatMap(v => byValue.get(v) ?? []);
  }, [options, search, query]);
  return <>
    <button type="button" id={id} data-sheet-select aria-haspopup="dialog" aria-label={ariaLabel ?? title}
      disabled={disabled} onClick={() => setOpen(true)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        textAlign: "left", cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.label ?? value}</span>
      <span aria-hidden style={{ color: T.ink2, flexShrink: 0 }}>›</span>
    </button>
    {/* Portaled: a picker inside another sheet (the converter) must not be
        trapped in that sheet's stacking context and drawn behind it. */}
    {open && createPortal(<OverlaySheet title={title} onClose={close} showDone={false} showClose>
      {search && <input type="search" data-sheet-select-search value={query} onChange={e => setQuery(e.target.value)}
        placeholder={search.placeholder} aria-label={search.placeholder} autoComplete="off" autoCorrect="off" spellCheck={false}
        enterKeyHint="search"
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (shown.length === 1) choose(shown[0].value); } }}
        style={{
          display: "block", boxSizing: "border-box", width: "100%", minHeight: T.size.touch, padding: "0 14px", marginBottom: 10,
          borderRadius: T.rs, border: `1px solid ${T.borderHi}`, background: T.surface, color: T.ink,
          fontFamily: T.sans, fontSize: T.fs.body,
        }} />}
      {search && shown.length === 0 && <p role="status" style={{ margin: "8px 2px", color: T.ink2, fontFamily: T.sans, fontSize: T.fs.body, lineHeight: 1.4 }}>
        {search.noMatches}
      </p>}
      <div role="radiogroup" aria-label={title} style={{ display: "grid", gap: 8 }}>
        {shown.map(o => {
          const selected = o.value === value;
          return <button key={o.value} type="button" role="radio" aria-checked={selected} onClick={() => choose(o.value)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", minHeight: 52, padding: "10px 14px",
              borderRadius: T.rs, textAlign: "left", cursor: "pointer", fontFamily: T.sans, fontSize: T.fs.body, fontWeight: selected ? 700 : 500,
              background: selected ? T.raised : T.surface, color: T.ink, border: `1px solid ${selected ? T.ink : T.borderHi}`,
            }}>
            {o.leading && <span aria-hidden style={{ flexShrink: 0, fontSize: "1.3em", lineHeight: 1 }}>{o.leading}</span>}
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
              <span style={{ overflowWrap: "anywhere" }}>{o.label}</span>
              {o.detail && <span style={{ overflowWrap: "anywhere", color: T.ink2, fontSize: T.fs.secondary, fontWeight: 500, lineHeight: 1.35 }}>{o.detail}</span>}
            </span>
            {o.trailing && <span aria-hidden style={{ flexShrink: 0, color: T.ink2, fontWeight: 600 }}>{o.trailing}</span>}
            {selected && <span aria-hidden style={{ flexShrink: 0 }}>✓</span>}
          </button>;
        })}
      </div>
    </OverlaySheet>, document.body)}
  </>;
}
