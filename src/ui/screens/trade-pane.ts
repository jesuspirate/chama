// ══════════════════════════════════════════════════════════════════════════
// Chama — TradeDetail default-pane picker (#68)
// ══════════════════════════════════════════════════════════════════════════
//
// The TradeView pager has three panes: Chat (0), Details (1), Parties (2).
// When a party opens a trade, they should land on the pane that holds their
// NEXT action — never staring at a view with nothing to do.
//
// Pure + presentation-only: this decides only the LEADING pane on a trade's
// mount. It never touches the reducer / event chain. The caller preserves the
// "a manual swipe wins forever" guard (userMovedPaneRef) — this helper is only
// consulted to seed the initial pane and on a trade change, never to yank a
// user who has moved themselves.

import { EscrowStatus, Role } from "../../escrow-engine/types.js";

/** Pager pane indices (must match PAGER_TABS order in TradeDetail). */
export const TRADE_PANE = { CHAT: 0, DETAILS: 1, PARTIES: 2 } as const;

export interface DefaultPaneInput {
  status: EscrowStatus;
  /** The viewer's role in this trade (null = non-participant / browse view). */
  myRole: Role | null;
  /** Which role owes the fiat leg (payer). Null when not applicable. */
  fiatPayerRole: Role | null;
  /** True when the viewer is the payout winner (claim/approve owner). */
  iAmWinner: boolean;
  /** True when the trade title is disputed (suppresses the payer-at-LOCK landing). */
  titleDisputed: boolean;
  /** True when there are unread chat messages from the other party. */
  hasUnreadChat: boolean;
}

/**
 * Details is the stable entry surface for every trade state. It contains the
 * terms, cart configurator and money actions; Chat remains one tap/swipe away
 * and its unread badge remains visible. A deterministic default also removes
 * the post-JOIN role/status race that could bounce a buyer back to Chat.
 */
export function pickDefaultPane(_input: DefaultPaneInput): number {
  return TRADE_PANE.DETAILS;
}
