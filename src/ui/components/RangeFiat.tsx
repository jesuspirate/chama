import { estimateFiatForMsats } from '../amount-display.js';
import { T } from '../theme.js';

interface QuoteProps {
  min: number | null;
  max?: number | null;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}
/** Live median estimates, never a locked price or a premium-adjusted quote. */
export function rangeFiatText({ min, max, currency, usdPerBtc, usdFiatRates }: QuoteProps): string | null {
  const estimate = (sats: number | null) => sats == null ? null : estimateFiatForMsats({ amountMsats: sats * 1000, currency, usdPerBtc, usdFiatRates });
  const low = estimate(min), high = max === undefined ? undefined : estimate(max);
  if (low === null || high === null) return null;
  const format = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `≈ ${format(low)}${high === undefined ? '' : `–${format(high)}`} ${currency}${high === undefined ? '' : " at today's rate"}`;
}
export function RangeFiat(props: QuoteProps) {
  const text = rangeFiatText(props);
  return text ? <div style={{ color: T.muted, fontSize: 12, fontWeight: 400, marginTop: 5 }}>{text}</div> : null;
}
