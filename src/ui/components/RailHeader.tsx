import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { RAIL_LABEL_KEY, type SettlementRail } from "../settlement-rail.js";

// Slim section header naming the settlement world a group of offers lives in
// (runway #15). Rendered wherever grouped results need naming — canvas match
// step, Browse shelves, category lists.
const RAIL_GLYPH: Record<SettlementRail, string> = {
  "ecash-ln": "⚡",
  "onchain": "⛓",
  "other": "◇",
};

export function RailHeader({ rail, count, showRule = true }: { rail: SettlementRail; count?: number; showRule?: boolean }) {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 7,
      margin: "4px 0 2px",
      gridColumn: "1 / -1",
      color: rail === "onchain" ? T.amber : T.muted,
      fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 800,
    }}>
      <span style={{ fontSize: 11, lineHeight: 1 }}>{RAIL_GLYPH[rail]}</span>
      <span>{t(RAIL_LABEL_KEY[rail])}</span>
      {typeof count === "number" && (
        <span style={{ fontWeight: 500, color: T.muted }}>· {count}</span>
      )}
      {showRule && <span style={{ flex: 1, height: 1, background: T.border }} />}
    </div>
  );
}
