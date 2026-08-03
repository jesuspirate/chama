import {
  EscrowEventKind,
  getEffectiveParticipantsAt,
  type EscrowState,
} from "../escrow-engine/types.js";

/** Last signed activity that changes what a participant sees as "latest".
 *  COMPLETE therefore outranks an older still-live listing; auxiliary traffic
 *  is included so a freshly active settlement/chat does not look stale. */
export function tradeActivityAt(trade: EscrowState): number {
  const times = [
    trade.createdAt || 0,
    ...trade.eventChain.map(event => event.timestamp || 0),
    ...(trade.settlements ?? []).map(event => event.timestamp || 0),
    ...(trade.chatMessages ?? []).map(event => event.timestamp || 0),
    ...(trade.premiumNotes ?? []).map(event => event.timestamp || 0),
  ];
  return Math.max(...times);
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

/** Latest means newest signed CREATE chronology, independently of hydration
 *  order and of the separate needs-attention queue. */
export function latestParticipantTrade(
  trades: readonly EscrowState[],
): EscrowState | null {
  return trades.length > 0 ? [...trades].sort(compareTradeChronology)[0] : null;
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
      if (retiredIds.has(trade.id)) return false;
      const participants = getEffectiveParticipantsAt(trade, atSec);
      return participants.buyer === pubkey
        || participants.seller === pubkey
        || participants.arbiter === pubkey;
    })
    .sort(compareTradeChronology);
}
