// i18n namespace "notify" — OS notification TITLE + BODY text built in
// src/notifications/ (trade-notifications.ts transition + chat notifications,
// notify-service.ts self-test). Resolved with translate(getCurrentLang(), …)
// INSIDE the builder functions at call time, so a language switch is picked up
// by the next notification. Keys MUST be prefixed "notify." — see
// src/i18n/en/connect.ts for the pattern.
//
// ⚠ NOT here on purpose (dedup TAGS / ids, compared or used as keys — never
//   translate): the `tag` strings ("{id}:locked", "{id}:chat:…", "selftest",
//   etc.) and escrowId sentinels stay hardcoded.
export const notify: Record<string, string> = {
  "notify.approvedBody":
    "Trade {label} resolved in your favor — open Chama to claim your sats.",
  "notify.approvedTitle": "✅ Your claim is ready",
  "notify.arbiterKeyBody": "On-chain trade {label} selected you. Open Chama and publish your escrow key so funding can begin.",
  "notify.arbiterKeyTitle": "🔑 An on-chain trade needs your key",
  "notify.buyerInterestBody": "A buyer is looking at your listing {label}. Open Chama to respond.",
  "notify.buyerInterestTitle": "👀 A buyer is looking at your listing",
  "notify.chatBody": "{who} messaged you on trade {label}.",
  "notify.chatSenderRole": "The {role}",
  "notify.chatSomeone": "Someone",
  "notify.chatTitle": "💬 New message",
  "notify.completedBody": "Trade {label} settled — the sats have moved.",
  "notify.completedTitle": "🎉 Trade complete",
  "notify.disputeBody":
    "Buyer and seller disagree on trade {label}. They're waiting on you — review and vote.",
  "notify.disputeTitle": "⚖️ A trade needs your ruling",
  // #79 — trade-critical DMs sent to a counterparty's Nostr client (external,
  // plaintext; trade id + link only, no amounts/keys).
  "notify.dmLockedMsg": "🔒 Your Chama trade {label} is locked — open the app to pay/act. {link}",
  "notify.dmVoteMsg": "🗳️ Your Chama trade {label} needs your vote. {link}",
  "notify.dmDisputeMsg": "⚖️ A Chama trade {label} you arbitrate needs your ruling. {link}",
  "notify.dmArbiterKeyMsg": "🔑 On-chain Chama trade {label} selected you as arbiter — open it and publish your escrow key. {link}",
  "notify.dmSettledMsg": "✅ Your Chama trade {label} settled — claim your payout. {link}",
  "notify.expiredBody":
    "Trade {label} reached its deadline. Open Chama to see where it landed.",
  "notify.expiredTitle": "⏰ Trade timed out",
  "notify.lockedBody": "Trade {label} is live — the other side funded it. Your move.",
  "notify.lockedTitle": "⚡ Sats locked in escrow",
  "notify.newListingBody": "New listing in {community}: {title}",
  "notify.newListingTitle": "🆕 New listing in your chama",
  "notify.savedIntentTitle": "A match just appeared",
  "notify.savedIntentSatsBody": "Someone is offering the sats you wanted. Tap to see it.",
  "notify.savedIntentGoodsBody": "Someone just listed “{query}”. Tap to see it.",
  "notify.savedIntentGoodsBodyGeneric": "A listing you were watching just appeared. Tap to see it.",
  "notify.newOrderBody": "A buyer funded order {label} on your storefront. Open Chama to fulfill it.",
  "notify.newOrderTitle": "New order on your storefront",
  "notify.selfTestBody":
    "If you can see this, OS notification delivery works on this build.",
  "notify.selfTestTitle": "Chama notifications OK",
};
