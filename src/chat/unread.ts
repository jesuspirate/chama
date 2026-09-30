// ══════════════════════════════════════════════════════════════════════════
// Chat unread tracking (#15) — device-local, never on the escrow state
// ══════════════════════════════════════════════════════════════════════════
//
// "Unread" = chat messages from the OTHER party that arrived after you last
// opened that trade's Chat pane. The read mark is a per-trade unix timestamp in
// localStorage, scoped by trade id — a DEVICE PREFERENCE, deliberately NOT a
// field on EscrowState (it must never ride on the Nostr event chain, and it is
// naturally per-device). Same scoped-storage shape as notify-service's
// fired-tags. Failures are swallowed: read-tracking is cosmetic and must never
// stand between a user and their trade.

import { clearNativeTradeAlerts } from "../notifications/native-push.js";
import type { EscrowState, Role } from "../escrow-engine/types.js";

type ChatMessage = EscrowState["chatMessages"][number];

const STORE_KEY = "chama_chat_last_read_v1";
// Bound the map so a heavy trader's device can't grow it without limit. When it
// overflows we keep the most-recently-read trades (the ones still in play).
const MAX_ENTRIES = 600;

type ReadMap = Record<string, number>; // tradeId -> unix seconds last read

function readMap(): ReadMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ReadMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: ReadMap): void {
  try {
    let entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
    }
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Cosmetic preference only; a storage failure must never block trading.
  }
}

/** The unix-seconds mark up to which this trade's chat has been read (0 if never). */
export function getLastReadChatAt(tradeId: string): number {
  return readMap()[tradeId] ?? 0;
}

/** Mark a trade's chat read up to `at` (default: now). Forward-only — never
 *  rewinds the mark, so a stale call can't resurrect already-read messages.
 *  Returns the effective mark after the call. */
export function markChatRead(tradeId: string, at: number = Math.floor(Date.now() / 1000)): number {
  void clearNativeTradeAlerts(tradeId);
  const map = readMap();
  const prev = map[tradeId] ?? 0;
  if (at <= prev) return prev;
  map[tradeId] = at;
  writeMap(map);
  return at;
}

/** A chat message's timestamp in seconds — the sender's sentAt, falling back to
 *  the raw Nostr event's created_at. */
function messageAt(m: ChatMessage): number {
  const sentAt = m.payload?.sentAt;
  return typeof sentAt === "number" ? sentAt : (m.raw?.created_at ?? 0);
}

/** Count messages from the OTHER party that arrived after `since`. A null role
 *  (a non-participant, e.g. a Browse viewer) has no chat there ⇒ 0. */
export function countUnreadChat(
  messages: readonly ChatMessage[],
  myRole: Role | null,
  since: number,
): number {
  if (!myRole) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.payload?.senderRole === myRole) continue; // your own message never counts
    if (messageAt(m) > since) n++;
  }
  return n;
}

/** Convenience for a trade-list row: unread count for `state` from `myRole`'s
 *  perspective, against the device's stored read mark. */
export function unreadChatForTrade(state: EscrowState, myRole: Role | null): number {
  if (!myRole) return 0;
  return countUnreadChat(state.chatMessages, myRole, getLastReadChatAt(state.id));
}
