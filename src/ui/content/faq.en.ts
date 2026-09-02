// English FAQ content — the source of truth (mirrors docs/FAQ.md).
// FR/ES live in faq.fr.ts / faq.es.ts; the selector in faq.ts picks by language.
import type { FaqContent } from "./faq-types.js";

export const faqEn: FaqContent = {
  intro:
    "Chama is a marketplace where you trade with your community using Bitcoin — without needing to understand Bitcoin. A chama is an East African savings circle: neighbours who pool what they have and settle on trust. Here the trust is cryptographic, and there's no company in the middle — just you, your counterparty, your community, and Nostr.",
  sections: [
    {
      id: "basics",
      title: "The basics",
      items: [
        { q: "What is Chama?", a: "A peer-to-peer marketplace. You can buy and sell Bitcoin, goods, and services with people in your community. Every trade is protected by an escrow that no company can freeze, seize, or switch off — because there is no company in the middle." },
        { q: "Do I need to know anything about Bitcoin?", a: "No. You pick your country and currency, you trade, and (in supported countries) your money can land straight in your mobile-money account like M-Pesa. Bitcoin is the plumbing; you don't have to think about it." },
        { q: "Is Chama free? What does it cost?", a: "The app is free to download, and Chama itself takes no cut — it's non-custodial, so no company sits between you and your money. On a completed trade, a small 0.5% insurance premium goes to the community arbiter who backs your trade (0.25% from each side), sent as ecash. It's included by default and you can turn it off before you settle. If a trade goes to an arbiter to settle a dispute, a small additional fee applies for that work. Sellers can also set their own premium on a listing (e.g. “+25%”) — that's the seller's price, not a Chama fee — and you always see the final amount before you commit." },
        { q: "Does Chama hold my money?", a: "No. Chama never touches your money. Your funds sit in a shared escrow only while a trade is active, and they move to you the moment the trade settles. Between trades, your balance is zero by design — there's no wallet for anyone to drain." },
      ],
    },
    {
      id: "start",
      title: "Getting started",
      items: [
        { q: "How do I get Chama?", a: "Android: install from Zapstore (zapstore.dev/apps/app.chama.market). Web & desktop: open getchama.app (also at chama.community)." },
        { q: "How do I sign in?", a: "Chama uses a key as your account (the Nostr standard) — there's no email/password and no sign-up form. The app can create a key for you, or you can use your existing Nostr key. Write your key down and keep it safe — it is your account." },
        { q: "What is a “community” and how do I choose one?", a: "A community is your currency + country + flag — for example Kenya · KES, or Senegal · CFA. You pick yours the first time you sign in. It decides the currency your trades are priced in and the neighbours you trade with. You can switch communities later in Settings → Advanced, but you stay “home” by default. You can also peek at other communities while browsing." },
      ],
    },
    {
      id: "trade",
      title: "Buying & selling",
      items: [
        { q: "How do I buy something?", a: { steps: [
          "On Browse, tap a listing that interests you.",
          "Tap Join as Buyer to reserve your spot (nothing moves yet).",
          "Build your order / confirm the amount, then fund it — this locks your sats safely in escrow.",
          "Pay the seller's fiat (e.g. M-Pesa, Airtel) the way the listing says, or receive your goods.",
          "When you've got what you paid for, tap to release — the sats go to the seller. Done.",
        ] } },
        { q: "How do I sell something?", a: { steps: [
          "Tap Create and post a listing (Exchange / Market goods / Community Bill Pay), set your price and which payment methods you accept.",
          "When a buyer joins and funds, the sats lock in escrow — you'll see “Sats locked in escrow.”",
          "Deliver the goods / send the agreed fiat, then tap Mark delivered (or “Mark sent”) — that's your confirmation.",
          "Once released, tap Claim to receive your sats — and cash out.",
        ] } },
        { q: "What are the steps of a trade?", a: "Reserved (someone joined) → Locked (sats funded into escrow) → the work happens (goods delivered / fiat sent) → Released (both sides agree) → Claim your payout → Settled. You can follow it on the trade's timeline, and chat with the other party at any time." },
        { q: "How does the escrow keep me safe?", a: "When a trade is funded, the money is split so that two of the three people in the trade — you, your counterparty, and a community arbiter — must agree before it can move. No single person (and no company) can run off with it. Normally you and your counterparty simply agree and it settles; the arbiter only steps in if something goes wrong." },
        { q: "What is an arbiter?", a: "A trusted member of your community who can help settle a trade only if there's a dispute. They can't take your money — they can only break a tie between buyer and seller. Arbiters build a reputation over time." },
        { q: "What if something goes wrong / I have a dispute?", a: "If you and your counterparty disagree (e.g. goods never arrived), each of you casts your vote — release or refund — and explain why. If you clash, the arbiter is brought in to decide fairly. You're never left stuck." },
        { q: "How do I cancel or back out?", a: "Before anything is funded, you can simply leave. After funding, backing out means casting a refund vote, which returns the sats to the right person (the arbiter is the backstop). Chama always shows you exactly where the money goes before you confirm." },
      ],
    },
    {
      id: "features",
      title: "Everything you can do",
      items: [
        { q: "What features does Chama have?", a: { intro: "Here is the whole app in one quick tour:", steps: [
          "Browse offers from your community or peek into another country and currency.",
          "Create an Exchange, Market, or Community Bill Pay listing, with prices, payment methods, menus, and quantities where they apply. Stack is coming soon.",
          "Join a listing, chat privately with the other people in the trade, fund the Bitcoin escrow, track each step, and vote to release or refund.",
          "Claim a payout to M-Pesa where supported, any Lightning address or invoice, a connected NWC wallet, or an on-chain Bitcoin address.",
          "Use Dashboard to see your Chama, active listings, arbiter activity, bonds, earnings, and any sats waiting for you.",
          "Use Me to see what needs your attention, pin or snooze work, review trade history and ratings, manage your profile, and change app settings.",
          "Receive reminders for joins, locks, messages, deadlines, claims, and disputes; tapping one takes you to the trade that needs you.",
          "Become a community arbiter, post a refundable Bitcoin bond, signal that you are available, settle disputes, build reputation, and earn the optional insurance premium.",
          "Run Chama in English, French, or Spanish on the web, Android, macOS, Windows, or Linux. Your Nostr key keeps the same identity across devices.",
        ], outro: "For step-by-step help, open the matching question below. Advanced settings also let you switch communities, federations, signers, and Chama nodes." } },
      ],
    },
    {
      id: "money",
      title: "Getting your money",
      items: [
        { q: "Where do the sats come from to fund a trade?", a: "You fund with Bitcoin (sats) you already hold — for example from a Lightning wallet. Chama doesn't sell you Bitcoin inside the app. In a typical trade the cash side happens between you and your counterparty directly (you send them M-Pesa/Airtel as the listing says); Chama escrows the Bitcoin side." },
        { q: "How do I get paid / cash out?", a: "When a trade is ready, tap Claim and choose where your money goes. Your options depend on your country: 🇰🇪 Kenya — cash out to M-Pesa in one tap (KES lands on your phone in seconds). Other countries — a local partner page opens where one exists (e.g. Banxaas in Senegal); more are coming. Lightning, anywhere — send to any Lightning address, invoice, or connected wallet (NWC). On-chain Bitcoin — paste a Bitcoin address (slower; network fees apply)." },
        { q: "How do I cash out to M-Pesa (Kenya)?", a: { steps: [
          "On a completed trade, tap Claim.",
          "Choose Cash out to M-Pesa.",
          "Enter your M-Pesa phone number (it's saved for next time).",
          "Confirm — you'll see the approximate KES amount, and shillings arrive in seconds.",
        ], outro: "No app to install, no account, no Bitcoin knowledge needed. (This uses Tando, a standards-based Lightning → M-Pesa bridge.)" } },
        { q: "Is there a limit on M-Pesa cash-out?", a: "Yes — M-Pesa cash-outs are capped per transfer. If your claim is over the limit, Chama shows you the maximum, so you can send a smaller amount or cash out the rest over Lightning instead." },
        { q: "Can I pay into a trade with M-Pesa (cash, not Bitcoin)?", a: "Not inside the app today. Cashing out to mobile money works in supported countries; cashing in (turning your mobile money into Bitcoin) is something you do beforehand with an outside service, or directly with your trading partner." },
      ],
    },
    {
      id: "safety",
      title: "Your account & safety",
      items: [
        { q: "Is my money safe?", a: "Yes — your funds are protected by the two-of-three escrow and are only ever committed to a specific trade. Chama, and any “Chama” entity, cannot seize, freeze, or move them." },
        { q: "Back up your account (important!)", a: "Your key is your account and your recovery path. If you lose your phone without a backup, you could lose access. When you sign in, save your key / recovery phrase somewhere safe and private (write it down offline; never share it). Anyone with your key controls your account — treat it like cash." },
        { q: "Is Chama private?", a: "You don't give Chama an email, phone number, or ID to use it. Your identity is just your key. Be mindful that what you post publicly (listings, chat in a trade) is shared over the Nostr network." },
      ],
    },
    {
      id: "trouble",
      title: "Troubleshooting",
      items: [
        { q: "It says “Connecting…” or asks me to “Reconnect.”", a: "Chama talks to the network over relays. On a weak connection a few can drop — tap Reconnect, or give it a moment; it reconnects on its own. Your trades and funds are never lost while this happens." },
        { q: "I finished a trade but it says my claim “needs attention.”", a: "Usually your money already arrived and the app just couldn't auto-confirm it — check your balance or your wallet. Chama keeps a backup copy of the note either way, so nothing is lost. If it's genuinely missing, the saved note is your recovery path." },
        { q: "Funding or claiming failed.", a: "Nothing moves unless it fully succeeds — a failed attempt means no sats were sent. Wait a moment and try again; if a route stays slow, tap Reconnect first. If you're on a brand-new install and a first join hangs, make sure you have a stable connection and retry." },
      ],
    },
  ],
  glossary: [
    { term: "Sats", def: "The small unit of Bitcoin (1 Bitcoin = 100,000,000 sats). Prices in Chama show in your local currency too." },
    { term: "Lightning", def: "The fast, cheap Bitcoin payment network Chama uses to move sats." },
    { term: "Escrow", def: "A safe “holding” of funds during a trade, released only when the right people agree." },
    { term: "Arbiter", def: "A community member who can settle a disputed trade — never able to take your money." },
    { term: "Key / npub", def: "Your account on Chama (and Nostr). Back it up." },
    { term: "M-Pesa / Tando", def: "Mobile money (Kenya) and the bridge that turns your sats into M-Pesa cash." },
  ],
};
