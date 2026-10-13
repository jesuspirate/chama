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

/** How many trades Me shows before "Show more" (Jet, 6.4.24: Me lagged with
 *  100+ trades because every row rendered and animated at once). */
export const ME_TRADE_PAGE_SIZE = 30;

/** Text a trade can be found by in Me's search: what its card shows (title,
 *  amount, currency, community, payment methods), its id, and the names of
 *  the people in it as the viewer sees them. */
export function meTradeSearchText(
  trade: EscrowState,
  nameFor: (pubkey: string) => string | null,
): string {
  const people = [trade.participants.buyer, trade.participants.seller, trade.participants.arbiter, trade.initiator?.pubkey]
    .filter((pk): pk is string => Boolean(pk))
    .map(pk => nameFor(pk) ?? "");
  const sats = Math.floor(trade.amountMsats / 1000);
  return [
    trade.description, trade.id, trade.community, trade.category, trade.status,
    trade.fiatCurrency, trade.fiatAmount != null ? String(trade.fiatAmount) : "",
    String(sats), sats.toLocaleString("en-US"),
    ...(trade.paymentMethods ?? []), ...people,
  ].filter(Boolean).join("\n").toLowerCase();
}

/** Every trade in `trades` matching all words of `query` (case-insensitive).
 *  Searches the whole list, never just the page that is on screen. */
export function searchMeTrades(
  trades: EscrowState[],
  query: string,
  nameFor: (pubkey: string) => string | null,
): EscrowState[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return trades;
  return trades.filter(trade => {
    const text = meTradeSearchText(trade, nameFor);
    return words.every(word => text.includes(word));
  });
}
