import { createContext, useContext, useState } from "react";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { formatEstimatedFiatForMsats, type AmountDisplayMode } from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { T } from "../theme.js";

// ══════════════════════════════════════════════════════════════════════════
// Chama — one amount, shown the way the shell's toggle asks
// ══════════════════════════════════════════════════════════════════════════
//
// The big sats/fiat switch in the header used to reach Browse and nothing
// else, so flipping it left every past trade in sats (Jet, 2026-09-19: "it's
// not helping me see fiat amounts for my past trades"). Rather than drill two
// props through every queue row, the preference rides a context and this
// component answers it — falling back to sats whenever no honest quote exists
// (no price feed, no community currency), because an invented fiat number is
// worse than the number we know.

export interface AmountDisplayPreference {
  mode: AmountDisplayMode;
  currency: string | null;
}

const AmountDisplayContext = createContext<AmountDisplayPreference>({ mode: "sats", currency: null });

export const AmountDisplayProvider = AmountDisplayContext.Provider;

export function TradeAmount({ msats, size = 13, color = T.text, gap = 3, glyphScale = 1.15, interactive = false }: {
  msats: number;
  interactive?: boolean;
  size?: number;
  color?: string;
  gap?: number;
  glyphScale?: number;
}) {
  const preference = useContext(AmountDisplayContext);
  const [override, setOverride] = useState<AmountDisplayMode | null>(null);
  const mode = override ?? preference.mode;
  const currency = preference.currency;
  const price = useBitcoinPrice();
  const rates = useFiatRates();
  const fiat = mode === "fiat"
    ? formatEstimatedFiatForMsats({
        amountMsats: msats, currency,
        usdPerBtc: price.usd, usdFiatRates: rates.rates,
      })
    : null;
  const content = fiat ? <span style={{ fontFamily: T.mono, fontSize: size, fontWeight: 700, color, whiteSpace: "nowrap" }}>{fiat}</span>
    : <BitcoinAmount msats={msats} size={size} gap={gap} glyphScale={glyphScale} color={color} glyphColor={T.muted} />;
  return interactive ? <button type="button" onClick={() => setOverride(mode === "sats" ? "fiat" : "sats")}
    style={{ minHeight: 44, background: "none", border: 0, padding: 0, color, cursor: "pointer" }}>{content}</button> : content;
}
