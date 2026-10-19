import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { T } from "../theme.js";
import { OverlaySheet } from "./OverlaySheet.js";

// Jet (6.4.26-rc.5): the Android WebView draws a native select element as the
// system picker, which ignored Chama's theme (and drew the splash art behind
// its rows). Every choice opens the app's own sheet instead, like the
// payment-details picker. Only the look changes: the same values reach
// onChange.
export interface SheetSelectOption { value: string; label: string }

export function SheetSelect({ value, options, onChange, title, disabled = false, id, ariaLabel, style }: {
  value: string;
  options: SheetSelectOption[];
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
  const current = options.find(o => o.value === value);
  const choose = (next: string) => { setOpen(false); if (next !== value) onChange(next); };
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
    {open && createPortal(<OverlaySheet title={title} onClose={() => setOpen(false)} showDone={false} showClose>
      <div role="radiogroup" aria-label={title} style={{ display: "grid", gap: 8 }}>
        {options.map(o => {
          const selected = o.value === value;
          return <button key={o.value} type="button" role="radio" aria-checked={selected} onClick={() => choose(o.value)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", minHeight: 52, padding: "10px 14px",
              borderRadius: T.rs, textAlign: "left", cursor: "pointer", fontFamily: T.sans, fontSize: T.fs.body, fontWeight: selected ? 700 : 500,
              background: selected ? T.raised : T.surface, color: T.ink, border: `1px solid ${selected ? T.ink : T.borderHi}`,
            }}>
            <span style={{ overflowWrap: "anywhere" }}>{o.label}</span>
            {selected && <span aria-hidden>✓</span>}
          </button>;
        })}
      </div>
    </OverlaySheet>, document.body)}
  </>;
}
