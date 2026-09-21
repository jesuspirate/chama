import { EscrowStatus, type EscrowState } from "../escrow-engine/types.js";
import { collapseCircleShares } from "../chama/wiring.js";
export type MeTradeFilter = "all" | "needs" | "live" | "listings" | "done";
export type MeTradeCounts = Record<MeTradeFilter, number>;

export function buildMeTradeCounts(
  trades: EscrowState[],
  needsYou: EscrowState[],
): MeTradeCounts {
  return {
    all: filterMeTrades(trades, needsYou, "all").length,
    needs: filterMeTrades(trades, needsYou, "needs").length,
    live: filterMeTrades(trades, needsYou, "live").length,
    listings: filterMeTrades(trades, needsYou, "listings").length,
    done: filterMeTrades(trades, needsYou, "done").length,
  };
}

export function filterMeTrades(
  trades: EscrowState[],
  needsYou: EscrowState[],
  filter: MeTradeFilter,
): EscrowState[] {
  const needsYouIds = new Set(needsYou.map((trade) => trade.id));
  // Runway #14: the "needs" view keeps every actionable trade (a share owed
  // to YOU must stay tappable); every other view collapses to one card per
  // circle — the parent carries the claim summary.
  if (filter === "needs") return trades.filter((trade) => needsYouIds.has(trade.id));
  // A parent can represent a share only when it appears in THIS tab.
  // Otherwise a CREATED parent would erase the LOCKED share from Live.
  if (filter === "live") return collapseCircleShares(trades.filter(isLiveTrade));
  if (filter === "listings") return collapseCircleShares(trades.filter(isOpenListing));
  if (filter === "done") return collapseCircleShares(trades.filter(isDoneTrade));
  return collapseCircleShares(trades);
}

/**
 * "Live" means IN FLIGHT: the trade has left the listing stage and has not
 * reached a terminal state. Deliberately broader than the escrow pill.
 *
 * An earlier attempt at this made the tab ask `liveCommitmentForViewer` —
 * the pill's predicate — so the two would agree. That was wrong twice over
 * (Jet, 2026-09-21): the pill's question is narrower ("money of MINE at
 * stake"), and because the tabs partition the list, every trade the pill
 * excludes but that is neither an open listing nor terminal — resolved in
 * the counterparty's favour, already CLAIMED, past its deadline — fell
 * through ALL of them and could be reached only under "All".
 *
 * A filter set that partitions must stay a partition. The pill and the tab
 * answer different questions, and the honest way to connect them is the
 * ring: tapping the pill glows the rows that make its number, and only
 * those. See `ringing` in the list below.
 */
export function isLiveTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.LOCKED ||
    trade.status === EscrowStatus.APPROVED ||
    trade.status === EscrowStatus.CLAIMED
  );
}

export function isOpenListing(trade: EscrowState): boolean {
  return trade.status === EscrowStatus.CREATED;
}

export function isDoneTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.COMPLETED ||
    trade.status === EscrowStatus.EXPIRED ||
    trade.status === EscrowStatus.CANCELLED
  );
}
