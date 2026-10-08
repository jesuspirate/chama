import type { ReactNode } from "react";
import { T } from "../theme.js";
import { HelpTip } from "./HelpTip.js";

/** The fact stays inline; deeper help follows the shared Community overlay. */
export function InlineExplanation({ summary, children, title, label }: {
  summary: ReactNode;
  children: ReactNode;
  title?: string;
  label?: string;
}) {
  return <div data-inline-explanation style={{ fontFamily: T.sans, fontSize: T.fs.secondary, color: T.ink2, lineHeight: 1.5, overflowWrap: "anywhere" }}>
    <div style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44 }}>
      <span style={{ minWidth: 0 }}>{summary}</span>
      <HelpTip title={title} label={label}>{children}</HelpTip>
    </div>
  </div>;
}
