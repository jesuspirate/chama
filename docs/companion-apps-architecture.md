# Companion apps — architecture note

Status: DIRECTION, not a spec. Depends on `docs/nip-draft-escrow.md` and the
replay hardening in `docs/replay-hardening-brief.md`.

## The split

**Chama is the money app.** It alone holds a wallet, locks, claims, and
signs Bitcoin transactions. It runs everywhere it runs today (web, Android,
desktop, StartOS).

**Companion apps never hold money.** A marketplace, a freelance board, or an
existing Nostr marketplace speaking the NIP. They own the experience:
listings, chat, tracking, evidence, ratings, votes. They can ship on the iOS
App Store as ordinary marketplace apps, because physical goods and services
are paid outside Apple's in-app purchase (guidelines 3.1.3(d), 3.1.3(e)) and
no wallet is inside them (3.1.5).

```
 Companion app (iOS / Android / web)          Chama (money app)
 ─────────────────────────────────           ──────────────────
 listings · chat · tracking · evidence        wallet (Fedimint / on-chain)
 votes (ecash) · disputes · ratings           LOCK · CLAIM · PSBT signing
        │   NIP-46 signer (user's Nostr key)          │
        └──────── Nostr relays (the NIP's events) ─────┘
                 hand-off link for lock / claim
```

## Who does what

| Step | Companion app | Chama | Notes |
|---|---|---|---|
| Sign in | NIP-46 | NIP-46 / NIP-55 / nsec | Same Nostr identity in both |
| Browse, list, chat | ✓ | ✓ | Plain NIP events |
| Join | ✓ | ✓ | JOIN carries no money |
| **Lock (fund)** | Hand-off link | ✓ | Payment can come from any wallet via Lightning or NWC; Chama builds the lock |
| Ship, track, evidence | ✓ | ✓ | Shipping spec, sections 4–5 |
| Vote (ecash) | ✓ | ✓ | The vote carries the voter's share, encrypted with their Nostr key: NIP-46 is enough |
| Vote (on-chain) | Hand-off link | ✓ | Needs the escrow key, which lives in Chama's wallet, not the Nostr key |
| **Claim** | Hand-off link | ✓ | Redeeming ecash or broadcasting the payout needs a wallet |

So the companion app hands off at most twice per trade (lock, claim), three
times on-chain.

## Hand-off

`https://getchama.app/?trade=sm_…&by=<creator npub>&do=lock&return=<url>`

- `by` is required (trade identity is creator + id, see the replay brief).
- `do` names the one action; Chama shows the trade and asks for that only.
- `return` brings the user back to the companion app afterwards. Chama only
  returns to URLs the user confirms, never automatically to an unknown host.
- The link carries no money and no secret. Everything it refers to is a
  signed event Chama verifies itself.

Android: verified App Links for `getchama.app`. iOS: the same https link
opens Chama on the web.

## Sign-in: NIP-46 like Primal

Companion apps and Chama share the user's identity through a remote signer.
Today Chama deliberately does **not** keep the NIP-46 client key between
sessions (`src/escrow-engine/nip46-signer.ts`: a key in `localStorage` can
be lifted by any script on the page), so users rescan the QR each session.
That is likely most of the gap with Primal's experience. To close it:

- Native shells (Android, desktop, iOS companions): keep the client key in
  the platform keystore, not in web storage.
- Web: decide explicitly whether a persisted key is acceptable, with a
  short expiry and a visible "signed in on this device" control.
- Study Primal's open-source apps (`primal-android-app`, `primal-ios-app`,
  `primal-web-app`) for their connection and reconnection flow. NIP-46
  itself runs over relays, so it shouldn't depend on Primal's caching
  server; their speed elsewhere probably does.

## Open questions

1. **Remote PSBT signing.** On-chain votes and payouts could stay in the
   companion app if it could ask the user's Chama to sign a PSBT over
   Nostr (NIP-46 signs Nostr events only, and Chama's escrow keys are
   deliberately separate from the Nostr key). Chama already moves PSBTs over
   Nostr in encrypted SETTLEMENT events; the missing piece is a
   request/approve/sign exchange, like a `sign_psbt` method. No standard
   for it that I know of: candidate for a NIP-46 extension or our NIP.
2. **Who runs the federation** a companion community uses (a church, a
   co-op): Chama is agnostic, but onboarding needs one.
3. **iOS money app.** Out of scope until there's an organization developer
   account and legal advice on the exchange category (guideline 3.1.5(iii)).
