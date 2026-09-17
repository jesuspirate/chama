// ══════════════════════════════════════════════════════════════════════════
// Chama — settlement-rail grouping (v6.4 runway #15, Jet 2026-09-18)
// ══════════════════════════════════════════════════════════════════════════
//
// Everywhere match results and listings render — the canvas match step,
// Browse shelves, cards — offers must read in three plain groups, never
// mixed flat: ecash/Lightning (the instant rails, one group), on-chain BTC,
// and other. The rail badge on each card says WHAT an offer settles in;
// this module says WHERE it sits on the page.
//
// Pure and DOM-free so the ordering law is testable: groups always come out
// in RAIL_ORDER, empty groups are dropped, and within a group the caller's
// order is preserved (recommendation ranking survives grouping).

export type SettlementRail = "ecash-ln" | "onchain" | "other";

export const RAIL_ORDER: readonly SettlementRail[] = ["ecash-ln", "onchain", "other"];

export const RAIL_LABEL_KEY: Record<SettlementRail, string> = {
  "ecash-ln": "common.railEcashLn",
  "onchain": "common.railOnchain",
  "other": "common.railOther",
};

/** Classify a listing's escrowMode. Absent means ecash (the historical
 *  default); any value this build doesn't recognize is honestly "other"
 *  rather than silently lumped with an instant rail. */
export function settlementRailOf(escrowMode: unknown): SettlementRail {
  if (escrowMode == null || escrowMode === "ecash") return "ecash-ln";
  if (escrowMode === "onchain") return "onchain";
  return "other";
}

export interface RailGroup<T> {
  rail: SettlementRail;
  items: T[];
}

/** Split items into RAIL_ORDER groups, dropping empty ones and preserving
 *  the caller's order inside each group. */
export function groupBySettlementRail<T>(
  items: readonly T[],
  railOf: (item: T) => SettlementRail,
): RailGroup<T>[] {
  const buckets = new Map<SettlementRail, T[]>();
  for (const item of items) {
    const rail = railOf(item);
    const bucket = buckets.get(rail);
    if (bucket) bucket.push(item);
    else buckets.set(rail, [item]);
  }
  return RAIL_ORDER
    .filter(rail => buckets.has(rail))
    .map(rail => ({ rail, items: buckets.get(rail)! }));
}

/** Whether a group needs its section header. A single all-ecash group reads
 *  flat exactly as before (the per-card badges already say ecash); the moment
 *  a second world appears — or the only world is NOT the instant rail — every
 *  group gets named so nothing is ever mixed flat. */
export function railHeadersNeeded<T>(groups: readonly RailGroup<T>[]): boolean {
  if (groups.length === 0) return false;
  if (groups.length > 1) return true;
  return groups[0].rail !== "ecash-ln";
}
