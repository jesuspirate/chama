/** Same integer rounding for the public bill card and the go-live review. */
export function satsWithPremium(baseSats: number, premiumBps: number | undefined): number {
  if (!Number.isFinite(baseSats) || baseSats <= 0) return 0;
  return Math.max(1, Math.ceil(baseSats * Math.max(1, 10_000 + (premiumBps ?? 0)) / 10_000));
}
export function billPayQuote(baseSats: number, premiumBps: number) {
  const total = satsWithPremium(baseSats, premiumBps);
  return {base:baseSats, bonus:total - baseSats, total};
}
