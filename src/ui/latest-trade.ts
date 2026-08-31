import {
  EscrowEventKind,
  EscrowStatus,
  getEffectiveParticipantsAt,
  type EscrowState,
} from "../escrow-engine/types.js";
import {
  signedTradeActivityAt,
  signedTradeEnteredAt,
  type TradeIndexEntry,
} from "../escrow-engine/trade-index.js";

export type LatestTradePointer = Pick<
  EscrowState,
  "id" | "category" | "description" | "amountMsats" | "createdAt"
>;

/** Last signed activity that changes what a participant sees as "latest".
 *  COMPLETE therefore outranks an older still-live listing; auxiliary traffic
 *  is included so a freshly active settlement/chat does not look stale. */
export function tradeActivityAt(trade: EscrowState): number {
  return signedTradeActivityAt(trade);
}

/** When a participant entered this trade. Unlike generic activity, this does
 * not let a late vote, claim, chat, or relay-healed event promote an old trade
 * above the trade the user actually entered most recently. */
export function tradeEnteredAt(trade: EscrowState): number {
  return signedTradeEnteredAt(trade);
}

/** Canonical chronology for history/display. This is deliberately the signed
 * CREATE time, not the time hydration happened and not the newest later event:
 * relay delivery order is nondeterministic, while voting/chatting on an old
 * trade must not move it above a genuinely newer trade. */
export function tradeCreatedAt(trade: EscrowState): number {
  if (Number.isFinite(trade.createdAt) && trade.createdAt > 0) return trade.createdAt;
  return trade.eventChain.find(event => event.kind === EscrowEventKind.CREATE)?.timestamp ?? 0;
}

export function compareTradeChronology(a: EscrowState, b: EscrowState): number {
  return tradeCreatedAt(b) - tradeCreatedAt(a) || b.id.localeCompare(a.id);
}

/** A retired id represents a superseded STORE LISTING, not a tombstone for a
 * trade. A buyer can still act on the old relay-visible listing after the
 * seller has retired it locally. As soon as a JOIN or money-bearing state
 * lands, both participants must see that escrow in history/attention again.
 * CANCEL is deliberately not progress: edited/cleared listings remain hidden. */
export function retiredListingIsStillSuperseded(
  trade: EscrowState,
  retiredIds: ReadonlySet<string>,
): boolean {
  if (!retiredIds.has(trade.id)) return false;
  const hasJoin = trade.eventChain.some(event => event.kind === EscrowEventKind.JOIN);
  const hasLock = trade.lock?.lockedAt != null || trade.lock?.notesHash != null;
  return !hasJoin && !hasLock;
}

/** Latest hero means most recently entered shared trade. History itself stays
 * sorted by CREATE chronology; attention-required work is rendered separately
 * and must not distort this pointer merely because an old trade changed later. */
export function latestParticipantTrade(
  trades: readonly EscrowState[],
): EscrowState | null {
  return trades.length > 0
    ? [...trades].sort((a, b) =>
        tradeEnteredAt(b) - tradeEnteredAt(a) || b.id.localeCompare(a.id))[0]
    : null;
}

/** The Me hero must not claim an older loaded trade is latest merely because
 * the newest chain could only be recovered from the durable summary index. */
export function latestParticipantTradePointer(
  trades: readonly EscrowState[],
  archived: readonly TradeIndexEntry[] = [],
): LatestTradePointer | null {
  const loaded = latestParticipantTrade(trades);
  const rememberedEnteredAt = (entry: TradeIndexEntry) =>
    // Legacy summaries have no signed JOIN chronology. CREATE is deterministic;
    // updatedAt is only local hydration time and must never affect the hero.
    entry.enteredAt ?? entry.createdAt;
  const remembered = archived.length > 0
    ? [...archived].sort((a, b) =>
        rememberedEnteredAt(b) - rememberedEnteredAt(a) || b.id.localeCompare(a.id))[0]
    : null;
  if (!loaded) return remembered;
  if (!remembered) return loaded;
  const loadedAt = tradeEnteredAt(loaded);
  const rememberedAt = rememberedEnteredAt(remembered);
  return rememberedAt > loadedAt
    || (rememberedAt === loadedAt && remembered.id.localeCompare(loaded.id) > 0)
    ? remembered
    : loaded;
}

/** Durable summaries contain enough evidence to overturn a seller-local
 * retired-listing marker even when the full event chain cannot rehydrate. */
export function retiredTradeIndexEntryIsStillSuperseded(
  entry: TradeIndexEntry,
  retiredIds: ReadonlySet<string>,
): boolean {
  if (!retiredIds.has(entry.id)) return false;
  const moneyProgressed = entry.lastStatus === EscrowStatus.LOCKED
    || entry.lastStatus === EscrowStatus.APPROVED
    || entry.lastStatus === EscrowStatus.CLAIMED
    || entry.lastStatus === EscrowStatus.COMPLETED;
  return entry.counterparty === null && !moneyProgressed;
}

/** Participant history is intentionally independent of the public Browse
 * retention window. Once a signed event makes this identity a participant,
 * the loaded trade remains reachable for settlement recovery and history. */
export function participantTradeHistory(
  trades: Iterable<EscrowState>,
  pubkey: string | null,
  atSec: number,
  retiredIds: ReadonlySet<string> = new Set(),
): EscrowState[] {
  if (!pubkey) return [];
  return [...trades]
    .filter((trade) => {
      if (retiredListingIsStillSuperseded(trade, retiredIds)) return false;
      const participants = getEffectiveParticipantsAt(trade, atSec);
      return participants.buyer === pubkey
        || participants.seller === pubkey
        || participants.arbiter === pubkey;
    })
    .sort(compareTradeChronology);
}
