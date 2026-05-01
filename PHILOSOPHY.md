# Chama — Product Philosophy

> Living document. Captures the foundational thesis, the locked architectural decisions, and the user-facing language conventions that all future scope must be measured against.

---

## 1. The thesis in one sentence

**Chama is a coordinator, not a wallet.** Lightning is the universal interface in and out. Ecash exists only as the cryptographic substrate for the brief lock-claim window. Communities are the social layer that makes commerce trustworthy. The reputation system is the backbone primitive that makes graduated trust possible across every feature.

---

## 2. The six pillars

These are the load-bearing architectural commitments. Every feature must sit on top of these without bending them.

### 2.1 Option B — atomic funding, no persistent balance

The trade lifecycle is **BOLT11 IN at fund time → ecash lives in escrow only during LOCK→CLAIM → BOLT11 OUT at claim → OPFS drains.** There is no persistent balance UI in Chama. The "Wallet" mental model is dead. What replaces it is the **"In escrow"** surface — sats are visible only when they're actively committed to a trade, and they leave via Lightning the moment the trade resolves.

This pillar is the product's deepest ethical commitment. Chama does not custody funds. The federation does not custody unspent funds. The user's OPFS does not store idle balances. Every sat in the system is in transit through a specific trade, with a specific counterparty, toward a specific Lightning destination.

### 2.2 Funding IS the lock

The seller's old "lock" button is gone. The instant Chama detects the BOLT11 invoice paid, it mints internally and runs the SSS split atomically. Two states collapse into one event: **Funding → Locked.** The user sees one moment, not two. Three of SatoshiMarket's old approval gates (JOIN, READY, LOCK) become a single atomic side-effect of payment landing.

Only two consent gates remain in the entire flow: **VOTE** and **CLAIM**. Both are gates that move sats. Everything else was ceremony.

### 2.3 Communities, not federations

**Federations exist as invisible plumbing.** Every Chama wallet is backed by some Fedimint federation — that's the cryptographic substrate for the SSS-split ecash. But the user never selects a "federation." They select a **Community** at sign-in.

A community is defined as **currency-primary, country-and-language-multivalent**:

- **One currency (always).** The load-bearing axis. Currency anchors trading and is what listings advertise prominently.
- **One or more countries (often).** CFA spans 14 African countries. Euro spans 20. USD is multi-country. The community pill displays one or more flag glyphs depending on the community's reach.
- **One or more languages (often).** A CFA community might be French + Wolof + Bambara. USD is English + Spanish. Listings and chat happen in whatever language participants share — Chama does not enforce a single language per community.
- **A cultural/regional identity (always).** The "where my family lives" feeling — not a hard schema field but a real signal that drives matching and arbiter pool selection.

The community is the user-facing layer; the federation is the technical layer. A user picks a community, Chama silently provisions a wallet on the appropriate backing federation, and the user never has to think about Fedimint protocol semantics. Users can switch communities at sign-in or via Settings → Advanced — switching is deliberately deprioritized in the UI because Option B's LN-in/LN-out architecture means cross-community trading doesn't require a wallet switch. Curious users can tap their community pill to peek at other communities ("snoop in") without changing their own membership.

This is the deepest user-facing simplification in Chama. Most Bitcoin apps force users to learn the cryptographic vocabulary of their chosen primitive. Chama hides the primitive entirely and lets users pick a context that maps to their actual life: their currency, their country (or countries), the languages they share with their neighbors.

**No user is locked out by federation availability.** A community always has a backing federation, even if only Chama-defined defaults exist for that region. **Bitcoin Life Federation (BLF) is the universal fallback** — when a user picks a community whose region has no community-run federation yet, BLF backs the wallet silently. Solo users in countries without organized federations can still trade, list, and rate. The "create your own federation" path is always available for sovereignty-minded users and groups, but it is never a prerequisite for participation. Same logic applies to arbiter onboarding — the federation field on an arbiter profile is optional, defaulting to BLF when blank.

**Payment methods are first-class extensible data, not enumerated UI.** Geofencing by community/currency means each community surfaces a different set of payment rails (Wave/Orange Money in Senegal, M-Pesa/Airtel Money in Kenya, Revolut/Wise in Europe, Cash App/Zelle in the US, PIX in Brazil, etc.). The Create-listing form must be designed as a searchable/toggleable list rather than a fixed button row, because the rail count per community can be 5–20+. Localization at this layer is structural, not cosmetic.

### 2.4 The Trinity Ring as architectural truth

Chama is a 3-of-3 SSS escrow with 2-of-3 vote resolution, encoded into the brand at the deepest level. The Trinity Ring (orange/purple/teal arcs joined at three white knot dots) is not decoration — it's the visual shorthand for the entire trust model:

- **Orange = Seller** (Bitcoin Orange — locks the sats)
- **Purple = Buyer** (Nostr Purple — claims the sats)
- **Teal = Arbiter** (Signal Teal — breaks ties)

When the ring is whole, the trade is whole. When an arc is missing, a participant is missing. When the ring fills in front of the user during the funding-to-locked transition, they understand the trust model viscerally — without us writing a sentence about Shamir Secret Sharing.

### 2.5 One codebase, every surface

**Web is canonical.** Chama is one app that adapts to its viewport, distributed through four vectors:

- **Web (canonical):** `chama.community` — the warmer brand surface and primary app entry point. `chama.exchange` is an owned alternate for institutional/partner/press contexts and as an optional LN address suffix. Both redirect to the same app. `chama.app` is the eventual canonical short identity when the domain becomes available.
- **Phone (Capacitor):** iOS and Android binaries wrapping the same web code in a native shell.
- **Sovereignty packages (`.s9pk` for Start9, `.umbrel-app` for Umbrel):** the same web app, packaged so node runners can self-host the frontend on their own infrastructure. This is not a different version of Chama — it is the same frontend served from the user's own machine. The privacy win is knowing your Chama UI isn't being served by anyone else.
- **Desktop binaries (Tauri, optional, post-v1):** a thin native wrapper for users who prefer dock icons over bookmarks. Same code as web.

Every component is responsive-capable from day one — applied early it costs nothing, retrofitted later it requires rewriting most of the UI layer:

- **Phone (≤640px):** full-bleed cards, single-column feed, bottom nav (Browse / My Trades / Me).
- **Tablet (640–1024px):** two-column feed, bottom nav retained, slightly denser cards.
- **Desktop (≥1024px):** three-column feed or sidebar nav + detail pane pattern. Bottom nav is replaced by left rail or top bar. Trade detail and embedded chat render side-by-side without tab-switching — desktop is potentially the best surface for power users.

Capabilities that the underlying environment unlocks (e.g. a self-hosted Lightning daemon as native QR-IN/QR-OUT target on a node-packaged install) are **runtime-detected enhancements**, never reasons to fork the codebase. Singularity holds.

### 2.6 Reputation as the backbone primitive

Every trade produces rating events. Public aggregate counts and percentages are visible on every npub's profile. Individual comments are NIP-44 encrypted to the recipient, who can later self-publish them as testimonials in v2. The rating events are Nostr-native (custom kind in the 30000-39999 range), portable across clients, and chain-replayable.

This dataset is **the substrate for graduated authority across the entire platform.** It's not decoration. It's structural. Two ladders run on it:

- **Arbiter graduation:** auto-assigned (v1) → manual-pickable (v1.5) → community-elected with terms (v2)
- **Merchant graduation:** regular seller → recurring-payment-eligible → (future tiers)

Both ladders use the same fuel: rating events accumulating on each npub over time. Earned authority replaces gatekept authority. New decisions about who-gets-what-power must always be measured against this primitive: does the rating system already provide the signal needed, or are we inventing trust where reputation could earn it?

---

## 3. The eight-state spine (locked v1)

The trade lifecycle, decision-locked, vertical-agnostic.

### State 1 — Buyer flow (entry)
Tap Buy on a listing → straight to QR-IN. **No confirmation screen.** The QR-IN screen carries a calm safety microcopy beat ("you're safe — sats lock the moment you pay"). Bright red Cancel always reachable. Pre-payment cancel = soft-fail, no rating impact. Post-payment, no cancel — only arbiter-refund path.

### State 2 — Seller flow
Sellers get pinged when a buyer initiates. Notifications opt-in. **One-hour seller-acknowledgment window** post-lock — if seller never marks "Ready to ship/receive fiat/pay bill" within an hour, arbiter auto-engages refund. The lock holds; the failure mode is graceful. Buyer identity hidden until payment lands.

### State 3 — Arbiter flow
**Auto-assigned in v1.** Arbiter is gated until buyer + seller disagree (cannot vote on happy path). Arbiter's expanded "healing" powers are reserved for v2 — specifically the ability to act on stale trades without consensus, essential for Lending repayment which has no server-side timer. Arbiter graduation: auto-assigned → manual-pickable → community-elected.

### State 4 — Vote moment
**Buyer and seller vote symmetrically** (any order, no first/second). Arbiter is gated temporally — only sees vote buttons after both others have voted in disagreement. Asymmetric confirmation gates: buyer votes directly (low-stakes — voting on own experience), seller and arbiter get 2-step "are you sure" gates (higher-stakes — voting on someone else's outcome).

The vote tally panel renders the Trinity Ring with each glyph in one of five states: joined-no-vote (muted), voted-release (color ring + checkmark), voted-refund (amber ring + dispute icon), winner (green glow), loser (dimmed).

Synchronized 15-minute countdown visible to all three participants throughout QR-IN. Per-vertical trade duration matrix:
- Digital (Market) / P2P / Bill Pay: **1 hour**
- In-person Market: dropped (use shipping with shorter window)
- Shipped Market: **14 days**
- Lending: TBD per loan terms (separate repayment cycle)

### State 5 — Receipt + rating
Three-zone receipt: trade summary (top), primary action (Claim → QR-OUT for winners; dismiss-after-rate for losers), secondary surfaces (rating, integrations placeholder, share). Integration zone is a placeholder slot in v1, expanded in v0.1.78+ with Flash, Chapsmart, etc.

**Mandatory lightweight 3-tap rating** before QR-OUT unlocks for the winner:
- Three-step sentiment (👍 / neutral / 👎) — fast, honest, no five-star inflation
- One optional vertical-aware tag from a curated list
- Optional 200-char free-text comment
- Loser gets a "reason" selector that includes "I just disagree with the outcome" — separates emotional venting from substantive arbiter quality signal

**Rating visibility model:**
- Public aggregate (count, %positive, vertical breakdown) on every npub's profile
- Individual comments NIP-44 encrypted to recipient
- v2: self-reveal gesture for testimonials
- v2+: NIP draft proposed for cross-client adoption (organic growth, not pre-emptive)

### State 6 — QR-OUT
Mirror of QR-IN, reversed direction. Single user action: paste BOLT11 invoice → ecash reconstructs from shares → CLAIM event publishes → federation redeems → Lightning routes → OPFS drains. **Claim and Sweep are collapsed** into one tap.

Locked decisions:
- No platform fee in v1 (revisit in v0.1.78+ once flow is proven)
- Routing fees absorbed by payer (standard LN merchant pattern); graceful retry if fees push above amount
- Copy raw ecash hidden under "Advanced" (power-user shortcut, not primary flow)
- No hard timeout on claim; soft notifications only (no risky waiting state in collapsed flow)
- Arbiter fees deferred to batch-claim (arbiter doesn't need to be online with invoice ready per trade)
- **Auto-sweep detection (v1.1):** if OPFS balance > trade amount when winner reaches QR-OUT, offer "Sweep everything ({total} sats) instead?" — drains all orphans and dust in one move

### State 7 — Global state surfaces
**Three-button bottom nav: Browse / My Trades / Me.** Vertical filter chips at top of Browse for Market/P2P/Bill Pay/Lending/Recurring. My Listings nested under Me (distinct from My Trades — listings I've published vs escrows I'm a participant in). Chat is escrow-scoped, embedded inside the trade detail view, not a global inbox tab.

**"In escrow" banner** at the top of Browse and My Trades only (not Settings, not inside individual trade views — would be redundant). Copy: "In escrow: 50,000 sats" or "Active trades: 3 · 50,000 sats" when multiple. Neutral coloring, informational not alarming.

**Orphan-ecash alarm** is separate, red, action-oriented: "⚠️ Unswept sats detected — sweep them out now to keep your funds safe" with a Sweep now CTA that opens QR-OUT directly. Failure-state metrics tracked silently for future debugging surface.

### State 8 — Per-vertical inheritance
All four verticals share the spine; only labels and per-listing fields differ.

- **Marketplace:** physical / service / digital fulfillment types, per-listing delivery window. Vote labels: "I received it" / "Item delivered" (physical), "I received the service" / "Service rendered" (service), "I received the file" / "Delivered" (digital).
- **P2P:** seller-of-sats locks. No cash-in-person — purely remote fiat exchange via bank/mobile rails. Image upload in chat via Blossom + NIP-44 dual-encrypted to all three participants. Vote labels: "I sent the fiat" / "Fiat received."
- **Bill Pay:** trojan horse for new users to get their first sats. Volunteer-payer (sats-receiver) is the new-user funnel. Generic structured payment-instructions field ("$45 via Revolut, here's my Revtag" / "350 KSH via M-Pesa, here's my number") — no PII. Vote labels: "Bill has been paid" / "My bill was paid."
- **Lending:** two stacked Option B cycles (loan + repayment), each a complete Market-style trade. Lender locks principal; borrower accepts; later borrower locks repayment; lender claims. Same npub appears in both cycles with reversed roles, no double-voting risk.
- **Recurring payments:** not a vertical. A graduated Marketplace feature. Sellers earn the right to offer recurring payments after accumulating enough positive ratings — same reputation primitive that powers arbiter graduation. Sats.coffee is the design partner.

---

## 4. User-facing language conventions

The words we use shape the mental model. These are locked.

| Concept | User-facing | Internal/Advanced |
|---|---|---|
| Fedimint federation | **Community** | Federation |
| Locked sats during trade | **In escrow** | Escrow / SSS-split |
| Wallet balance | **Active funds in escrow** | OPFS balance |
| Trade tie-breaker | **Arbiter** | Arbiter |
| Trade where seller of sats locks | **P2P** | P2P |
| Trade where buyer of sats locks | **Marketplace** | Marketplace |
| Pay someone else's bill | **Bill Pay** | Bill Pay |
| Lend sats over time | **Lending** | Lending |
| Recurring payments | **Recurring** (graduated Marketplace) | Subscription primitive |
| Reputation event | **Rating** | NIP-44 encrypted Nostr event |
| Federation member group | **My community** | Federation members |

The word "Federation" appears nowhere on the user-facing surfaces. It lives in Settings → Advanced → Wallet federation (for users who want to dig in), in debug screens, and in technical documentation. Everywhere else it's "Community" — and Community always implies the bundle of language + currency + country/region + cultural context, never just the technical primitive.

---

## 5. Brand expression

### 5.1 The Trinity Ring is the product

The C-shaped Trinity Ring (with aperture at 3 o'clock) is the wordmark glyph and lockup mark. The closed Trinity Ring (three arcs at 120° intervals, three white knot dots) is the trade-status indicator. **When the ring is whole, the trade is whole.** This is the deepest brand-product alignment: the logo IS the status indicator. UI states render the closed ring with role-color arcs at varying opacity to show the state of each participant.

### 5.2 Role colors are sacred

- **Bitcoin Orange (#F7931A → #FFB340 gradient)** = Seller / sats-locker
- **Nostr Purple (#BF5AF2 → #7A3CD0 gradient)** = Buyer / sats-claimer
- **Signal Teal (#5AC8FA → #2997FF gradient)** = Arbiter / tie-breaker

These three colors carry semantic load throughout the product. A purple button means a buyer-side action. An orange chip means a seller-side actor. A teal indicator means arbiter presence. Designers do not use these three colors for any decorative purpose — they are reserved for role identification.

### 5.3 Surface language

Apple-grade dark mode (#0a0a0a base, #f5f5f7 primary text, #86868b secondary text). Cards float on rgba(255,255,255,0.03). Borders are 0.5px hairlines at low opacity. No drop shadows. No skeumorphism. Type is Inter for UI, JetBrains Mono for cryptographic strings (BOLT11 invoices, npubs, etc.). Sentence case throughout — "Send sats to my wallet" not "Send Sats to My Wallet."

---

## 6. Versioning roadmap

### v1 (current trajectory)
- The eight-state spine, locked
- Communities replace Federations on the user-facing surface
- Auto-assigned arbiter
- Mandatory lightweight rating
- Three-button bottom nav
- Four verticals + Recurring as graduated Marketplace feature
- Browse + Create with community filtering and currency-tagged listings

### v1.5
- Manual arbiter selection (surface stats, optional manual pick)
- Recurring payments unlock for graduated merchants (sats.coffee as design partner)
- Auto-sweep detection at QR-OUT
- **3D globe community picker.** Replace the v1 list-based picker with a cinematic interactive globe at first-login. Currencies-grouped or region-grouped highlights, live activity dots showing where trades are happening in real time. The "from the dark, the world appears" first-impression moment. Built deliberately as polish, not as load-bearing — v1's list picker remains as the keyboard-accessible / low-bandwidth fallback.
- **LN address / NWC pre-fill at QR-OUT.** User adds a static Lightning address (e.g. `user@getalby.com`) or connects via NWC in Settings. QR-OUT pre-fills the destination — paste-invoice flow becomes a fallback, not the default. NWC enables true one-tap claims with no app-switching. The QR-OUT screen must gracefully degrade to the paste-invoice flow when neither is configured.
- **Self-hosted LN addresses (`username@chama.community`, `username@chama.exchange`, eventually `username@chama.app`).** Using [`lnaddrd`](https://github.com/elsirion/lnaddrd) on the Chama domains, users can opt to receive a Chama-domain Lightning address that forwards to their NWC connection or registered LNURL. Chama never holds custody — just provides the friendly identity. Particularly valuable for Fedi users who visit Chama and want a portable LN identity.
- Self-reveal gesture for individual ratings
- Dashboard for failure-state telemetry (orphan-detection counts, drainPendingRedemptions recoveries)

### v2
- Community-elected arbiters with term limits ("Power to the Chamacitos")
- Arbiter as trade healer with bounded autonomous powers — essential for Lending repayment timeline enforcement
- NIP draft for cross-client rating/reputation events
- Merchant tier system beyond recurring-eligible
- **Community gating, three layers, all opt-in by community/arbiter:**
  - **Listing visibility gates:** creator picks `public` / `my community only` / `verified peers only` (rating threshold). Nostr-tag-based; Chama clients respect the convention.
  - **Trade participation gates:** seller can require same-community, min-rating, min-trade-count, or arbiter-vouched buyers. The vouch model lets arbiters curate without per-trade work.
  - **Arbiter opt-in:** arbiters can refuse auto-assignment for certain trade types, users, or federations. Combined with elected arbiters, creates a real political economy where arbiters compete on community service.
  - **Principle:** gating is earned, not toggled. v1 is open-by-default to let signal accumulate; v2 unlocks gating capabilities only after rating data justifies them. Same graduated-trust primitive as everywhere else.

### v2+
- Cross-community discovery as a deliberate feature (arbitrage flows, multi-currency users, etc.)
- The Chamacito democracy: proposal/vote system for community-level decisions
- Reputation portability: Chama ratings rendered on Primal, Damus, Amethyst via adopted NIP

---

## 7. The scope-creep test

Every proposal for new feature work must pass this test:

1. **Does it sit on the five pillars without bending them?**
   If it requires Chama to custody funds, persist a balance, hide a community signal, gate without graduated authority, or break the Trinity Ring as architectural truth → reject.

2. **Does the existing reputation primitive provide the trust signal needed?**
   If a feature requires a new gating mechanism, ask: can it be a graduated capability earned via rating accumulation instead? If yes, do that.

3. **Does it move the user closer to the spine, or sideways?**
   The spine (Browse → trade → QR-IN → trade-active → vote → receipt → QR-OUT) is the core loop. Features that thicken sideways surfaces (more nav buttons, more profile sections, more discovery layers) bear a higher burden of proof than features that smooth the spine.

4. **Does it preserve the language conventions?**
   No surfacing of "Federation" to normies. No reintroduction of "Wallet" or "Balance." No five-star ratings. No optional ratings. No multi-step confirmations where one tap suffices.

5. **Does it earn its place against simpler alternatives?**
   Settings toggles, dashboards, and customization options are seductive but expensive. Each new toggle is a maintenance burden, a test surface, a support question, and a decision the new user has to make before they understand the product. Default to one path, no toggle, until production usage demands the option.

---

## 8. The genius nobody else has built

Chama is not "another P2P escrow app." The pieces that make it singular:

1. **Lightning is the universal interface, not Fedimint.** Cross-federation trading is mechanically free because no ecash crosses boundaries — buyer's federation mints, winner's federation ingests via Lightning. Two separate federation events bridged by LN.

2. **Communities map to language + currency + country, not protocol.** No other Bitcoin app lets users pick "Senegal · French · CFA" as a single primitive that handles localization, currency formatting, listing filtering, and arbiter pool selection in one move.

3. **Reputation is the structural backbone, not a UX afterthought.** Arbiter graduation, merchant graduation, and recurring-payment eligibility all run on the same rating dataset. Earned authority replaces gatekept authority.

4. **The brand is the architecture made visual.** The Trinity Ring isn't a logo applied to a product — it's the trust model rendered as a glyph. Users understand SSS-split escrow viscerally because they see three arcs join into one ring when their trade locks.

5. **Bill Pay is a stealth onboarding funnel.** Volunteers earn their first sats by paying someone else's fiat bill. No "buy Bitcoin" friction, no exchange signup, no KYC. The most emotionally generous transaction in the product is also the most strategically important for adoption.

6. **The "Wallet" mental model is dead.** Sats are visible only when actively in escrow. OPFS drains after every trade. The user never sees an idle balance because there is none. This is the deepest commitment Chama makes against custodial drift.

7. **Recurring payments solve a real Lightning gap.** No LN wallet currently offers reliable user-to-user recurring payments because it requires exactly the trust model Chama builds. Recurring payments to a stranger over LN is too risky. Recurring payments to a npub with 200+ positive ratings on Chama is reasonable. Chama's reputation layer makes recurring payments safe in a way that pure-LN cannot be.

---

*Last updated: April 2026. Next review: after Browse + Create lands in v0.1.78.*
