# Code-Claude brief: v0.2.0 — Federation-Follows-Listing

## Context

PHILOSOPHY.md is staged as of commit `1b9b5ce` (main). Read it first — Pillar 2.1 has been amended with the Chama promise ("no sats stranded, ever") and one-trade-at-a-time as design choice. Pillar 2.7 (educate at every opportunity) is new. §2.3 has been updated with federation-follows-listing as the resolution of cross-federation trade attempts.

This PR is the v1 UI + protocol convergence. The protocol foundation (PRs 1-5, atomic LOCK, communities-not-federations, NIP-44 envelope, balance guards) is structurally complete and 314/314 tests pass on v0.1.84. This PR is "make every UI surface honor what the protocol was always trying to do."

## Slicing approach

Use your judgment when you see the diff. Possible split:

- **v0.1.85 prep** (optional, recommended if diff is unwieldy): bottom nav refactor (Browse/Create/Me), community registry expansion with flag emoji + permissionless add-fed primitive, "wallet"→"Chama" rename sweep, SwitchFederationPanel relocates to `Settings → Advanced → Sandbox mode`
- **v0.2.0**: federation-follows-listing protocol layer + Browse/Listing/Create/Recovery UI surfaces

Or ship as single coherent v0.2.0 if the diff is reviewable. Your call. Federation-follows-listing protocol layer and UI surfaces must ship together within a single release — they're the same conceptual change at different layers and splitting them produces inconsistent behavior.

## Required changes — protocol layer

### 1. Listing-tap → federation derivation

When a user taps a listing in Browse:

1. Read the listing's `community` field
2. Resolve the federation via `resolveFederationForCommunity(slug)` (already exists in `src/communities/registry.ts`)
3. Compare to current active invite (`getActiveInvite()` from `src/fedimint/federation-config.ts`)
4. If matching → proceed to listing detail (current State A flow)
5. If non-matching AND `getBalance()` returns 0 msats → silently re-init Fedimint client against the listing's federation, persist new `chama_active_invite`, proceed to listing detail
6. If non-matching AND `getBalance()` returns > 0 msats → DO NOT proceed to listing detail. Surface the recovery banner (see UI section below) at the app-load level. The user has an unfinished trade; that takes priority over starting a new one.

**Important**: The silent re-init in step 5 is mechanically a `tearDown() + initFedimint(targetInvite)` sequence. It must complete before the listing detail screen renders, or the listing detail's "fund" button will fire against the wrong client. Briefly suspend rendering with an inline progress indicator if needed (`switchingToFederation: boolean` in app state).

### 2. App-load recovery banner detection

Already partially exists via `App.tsx` auto-init useEffect (v0.1.83). Extend the load logic:

1. After successful `initFedimint()`, check `getBalance()`
2. If balance > 0 AND there's no `currentEscrow` in active state from event replay, render the recovery banner instead of Browse
3. If balance > 0 AND `currentEscrow` exists, route directly to the active trade screen (the user has an in-flight trade, not stranded sats)
4. If balance == 0, render Browse normally

The recovery banner is a Browse-replacement, not a modal — see UI section.

### 3. One-trade-at-a-time gating

A user has at most one active trade. The gate fires on **commitment-creating actions**, not navigation:

- When user taps "Fund" on a listing detail, check if `currentEscrow` is set in app state and not in a terminal state
- If yes → block funding, surface a small banner: *"Finish your active trade with [counterparty] before starting a new one."* with a CTA to navigate to the active trade
- If no → proceed with current funding flow

**State matrix**:

| Balance | currentEscrow | Behavior |
|---------|---------------|----------|
| 0 | None | Normal Browse, normal Create, normal everything |
| 0 | Active | Route to active trade screen on tab taps; Create blocked; Browse stays open for research |
| > 0 | Active | Route to active trade screen (funded ecash IS the trade in flight — normal mid-funding state) |
| > 0 | None | Recovery banner replaces Browse + Create; Me remains accessible |

**Browse is intentionally NOT blocked when there's an active trade in flight** — users may want to peek at other listings to plan their next trade while waiting for this one to resolve. Peeking is fine; committing is gated. The fund button on individual listings is what fires the gate, not navigation to Browse.

This is design choice, not protocol limitation. Pillar 2.1 in PHILOSOPHY.md now codifies this. Don't soften the gate; it's load-bearing for the UX. But also don't over-block — the gate is precise about what it stops.

## Required changes — UI surfaces

### 4. Bottom navigation refactor

Three tabs, not four:

- **Browse** (replaces "Browse")
- **Create** (replaces "My Listings" — listing creation is the primary seller surface)
- **Me** (consolidates: profile, Nostr Profile sub-section, ratings, trade history, settings)

The active trade is *not a tab*. When a user has an active trade, every tab tap intercepts and routes to the active trade screen until it resolves (or include a small persistent "go to trade" pill at the top of any non-trade screen). Active trade is **the current state of being a Chama user**, not a navigable surface.

**Recovery banner scoping rule.** When the recovery banner is active (balance > 0 && no currentEscrow), it intercepts navigation to **Browse** and **Create** only. Me remains fully accessible — users may need to update their LN address, refresh their Nostr signer config, fetch counterparty kind:0, or check ratings/history *as part of resolving the recovery itself*. Blocking Me would create a catch-22 when LN routing failures stem from stale config that lives in Me.

Within Me → Settings → Advanced → Sandbox mode (if enabled), the recovery banner's gating logic extends to specific dangerous actions:

- **Block during recovery**: federation switch, custom invite paste, OPFS reset (any action that would destroy the stranded ecash the banner is asking the user to preserve)
- **Allow during recovery**: balance check (read-only), Sandbox mode toggle itself, all identity/profile/history surfaces

The generalized rule: **block UI surfaces that create new commitments or destroy active escrow state. Allow read/identity/diagnostic surfaces.** Tapping a blocked surface during recovery should surface a small inline notice ("Resolve your unfinished trade before [action]") with a CTA pointing at the recovery banner.

### 5. Browse with federation-aware muting

Reference: see `chama_browse_amber_tint_sorted` in design transcript.

- **Header**: app title, "N listings · M on your wallet" subtitle (where M = listings matching active federation), flag-pill on the right showing user's community (e.g. "🇸🇳 Senegal · CFA")
- **Filter chips**: All / P2P / Bill Pay / Market / Lending — horizontal scrollable
- **Sort order**: matching-federation listings first, then a divider labeled "N LISTINGS ON OTHER FEDERATIONS", then non-matching listings
- **Card styling**:
  - Matching: standard card background, normal text colors
  - Non-matching: `var(--color-background-warning)` card background with `var(--color-border-warning)` border, warning-tone text. Federation name appears inline with rating ("★ 4.7 · 23 · BLF")
- The amber tint must be *quiet*, not alarmist. It's a teaching affordance, not a warning.

### 6. Listing detail with State A and State B

Reference: see `chama_listing_detail_states` in design transcript.

**State A** (matching federation):
- Tiny secondary line under title: "runs on Bitcoin Principles · same as your Chama"
- CTA: "Fund trade · [amount]"
- Hint below: "2-of-3 Shamir split · ecash spent from your Chama"

**State B** (non-matching federation, zero balance):
- Tiny secondary line under title: "runs on BLF · we'll switch you in"
- Info card (info color, not warning): "Your balance is 0 sats so no funds are at risk. We'll provision a fresh Chama on BLF for this trade."
- CTA: "Switch and fund · [amount]"
- Hint below: "Switching is instant · no Lightning round-trip needed"
- Brief inline progress indicator on tap ("Switching to BLF...") while the silent re-init completes — sub-second, not a modal

State C (non-matching, non-zero balance) **does not exist** — the recovery banner intercepts at app-load before this state is reachable.

### 7. Three-step Create wizard

Reference: see `chama_create_flow` in design transcript.

**Step 1 — Category + Community**:
- 4 large cards: P2P Trade / Bill Pay / Marketplace / Lending
- Below: "List in community" pre-filled with user's home community + "change ›" affordance
- Federation **never named** at this step

**Step 2 — Vertical-specific form** (form morphs by category):
- P2P Trade: direction toggle (sell/buy sats) + amount + price + premium + payment rail picker with saved-handle prefill
- Bill Pay: utility name + bill amount + buyer's payment rail handle (no direction — asymmetric vertical)
- Marketplace: title + description + photos + delivery method + price (no direction)
- Lending: lender/borrower direction + principal + rate + term

**Step 3 — Review & Publish**:
- Two columns: left = editable bits (description, expires window), right = preview card + federation honesty paragraph
- Expiration windows: P2P 24h/**7d default**/30d, Bill Pay 24h/7d/**30d default**, Marketplace 7d/**30d default**/90d, Lending **7d default**
- Tooltip "?" on expiration: *"How long this listing stays in Browse. Active trades have their own timer."* (per Pillar 2.7)
- Federation honesty paragraph (one-time-per-account info card, dismisses on first publish): *"This listing will run on Bitcoin Principles — the federation backing the Senegal community. Buyers on other federations will be auto-switched when they tap your listing."*
- Two buttons: "Save draft" (secondary) | "Publish to community" (primary)

**Save draft persistence**: localStorage key `chama_create_draft` with `{vertical, formState, savedAt}`. One slot per vertical (overwrites if user starts a new draft of the same category). On Create entry, if draft exists, surface "Continue your last [P2P / Bill Pay / etc.] listing" card at the top with timestamp. Auto-saves silently on any field change. Clears on successful publish.

### 8. Recovery banner

Reference: see `chama_recovery_banner_v2` in design transcript.

This is a **Browse replacement**, not a modal. When `getBalance() > 0 && !currentEscrow`, render this in place of Browse and Create. Me remains accessible (users may need to update LN address, refresh Nostr signer, fetch counterparty kind:0, or check ratings/history *as part of resolving the recovery itself*).

**Counterparty resolution rule**: The brief says "balance > 0 && no currentEscrow" but counterparty identity must be resolved from the escrow chain history. Implement as a pure function:

```typescript
identifyStrandedEcashSource(
  escrowEvents: EscrowEvent[],
  userPubkey: string,
  balance: number
): { escrowId: string; counterpartyPubkey: string; role: 'buyer' | 'seller' } | null
```

Logic:
1. Find the most recent CLAIM event (kind:38104) the user signed
2. Get the escrow ID it references
3. Look up that escrow's LOCK event (kind:38102) to determine roles
4. Return the *other* role's pubkey (if user was buyer → return seller pubkey, vice versa)
5. If no CLAIM events exist or chain is broken → return null

**Display fallback when null**: render banner with "Trade with unknown counterparty" + generic withdraw flow, no trade ID line. Honest. Better than fabricating identity.

This is testable in the existing pure-function harness (no React, no client, no relays). Add tests for: known-claim-resolves-counterparty, missing-claim-returns-null, role-correctly-inverted.

- Header: app title, flag-pill on right (no welcome line — names are not asked, only fetched via kind:0 if user opted in)
- Amber-tinted card with:
  - Small caps header "CONTINUE YOUR TRADE" with amber dot
  - Headline: *"Your trade with [counterparty display] didn't finish"* (or "with unknown counterparty" fallback)
  - **Counterparty display rules**: truncated npub by default (e.g. "1c6abd8..."). Show name only if (a) Me → Nostr Profile has "fetch counterparty kind:0" toggle on AND (b) counterparty has self-published a kind:0 with name field
  - Explanation: *"Connection dropped before your sats landed in your Lightning wallet. Pick up where you left off."*
  - Trade card (real listing card styling): trade ID in mono font (or hidden if unknown), category pill, summary line, amount, "last action: Xh ago"
  - CTA: "Finish trade · withdraw [amount] sats"
  - Microcopy: "Sats land in your Lightning wallet · Chama frees up for the next trade"
- Bottom paragraph (50% opacity): *"Browse opens once your trade with [counterparty] is finished — Chama keeps it simple, one trade at a time."*

CTA opens QR-OUT modal with auto-generated invoice. After successful redemption, balance returns to 0, banner clears, Browse renders.

### 9. "Wallet" → "Chama" rename

Aggressive sweep across user-facing strings. Audit:

- `src/ui/**` and `src/components/**` for any `Wallet`, `wallet`, `your wallet` in JSX text content, button labels, headings, modal copy, tooltips, error messages
- Replace with: `Chama`, `your Chama`, etc.
- **Exception**: variable names, function names, type names, module names — leave alone. The rename is cosmetic on the UI surface, not architectural in the code. `useWallet`, `WalletState`, `walletBalance` all stay as-is. The principle: code refers to mechanism, UI refers to product.
- After the sweep, grep the codebase for remaining "Wallet" / "wallet" in `.tsx` JSX text and surface a list — Jetty will review for any that should remain (e.g. "Lightning wallet" in microcopy that genuinely refers to the user's external LN wallet, which is a real wallet, not Chama).

The sweep also catches the "Lightning wallet" / "external wallet" distinction — those stay. Only the Chama-as-self references get renamed.

### 10. Settings → Advanced → Sandbox mode

**Critical**: the current Advanced section visible underneath the federation picker — "switch or reset wallet" + custom invite paste + Reset local wallet — must move into the actual Settings → Advanced → Sandbox mode location. It currently sits in plain sight on the home/wallet screen, and that's wrong for v1 normie UX.

Plan:

- New `Settings → Advanced` page accessible from Me tab
- "Sandbox mode" toggle, off by default
  - Auto-on via `import.meta.env.DEV` in dev builds (for our own work)
  - Power users in prod can flip via `localStorage.setItem('chama_sandbox_mode', '1')` and the toggle shows up
- When sandbox mode is on, surface the existing dev surface:
  - Federation switcher panel (current `SwitchFederationPanel`)
  - Custom invite paste
  - OPFS reset button (with current DestroyEcashConfirmModal guard)
  - Balance check button
  - Any other diagnostic affordances currently visible on the home screen
- When sandbox mode is off, none of these surfaces render anywhere in the UI
- The existing federation picker for first-time users stays where it is (first-login flow), it's not part of sandbox mode — it's first-load onboarding

Test: production build with sandbox mode off should have no visible path to fed-switching, custom invite, or OPFS reset. Only first-time onboarding picker is exposed.

### 11. Community registry expansion

Currently 4 seeds in `src/communities/registry.ts`: `sn-cfa`, `ke-kes`, `sv-usd`, `global-usd`. Expand to a curated pre-seed list — federations with operational relationships or proven testing history. Other federations are intentionally left for community leaders to claim themselves via the permissionless add-community primitive.

**Pre-seed for v0.2.0** (these get hardcoded entries with federation invites Jetty will provide):

- 🇸🇳 Senegal · CFA (BP fallback — Jetty's home community)
- 🌎 Global · USD (BP — operated by Jetty)
- 🇰🇪 Kenya · Afribit · KES (Afribit invite — Adopting Bitcoin Nairobi demo partner)
- 🇺🇸 US · Bitcoin Life · USD (BLF invite — development testing federation)

**Intentionally NOT pre-seeded** (these will be added permissionlessly when their community leaders claim them):

- 🇰🇪 Kenya · Bitsacco
- 🇺🇸 US · Galoy
- 🇨🇮 Côte d'Ivoire (BP fallback when a leader emerges)
- 🇸🇻 El Salvador (BP fallback when a leader emerges)
- 🌍 Africa Free / OrangeClubAfrica / regional aggregators

**Schema for each entry** (each entry adds these fields):

- `flagEmoji: string`
- `displayName: string`
- `currency: string`
- `country: string | null` (null for global communities like 🌎)
- `federationInvite: string | null` (null falls through to BP default)
- `browserReliable: boolean` — `true` if the federation works reliably in browsers (HTTPS-clearnet guardian endpoints), `false` if it uses iroh-only transport that has known browser-WebSocket limitations. APK users are unaffected; browser users see a one-time honest warning when joining a `browserReliable: false` federation: *"This community runs on a federation that has limited browser support today. The mobile app gives you the best experience. Trade may be slower or fail intermittently from browser."* Per Pillar 2.7, this is education-not-shaming — users learn the architecture by encountering its honest current limits.
- `notes: string | null` — optional internal note, not shown to users (e.g. "Best experience on mobile app while we work with @fedimint/transport-web on browser-iroh support")
- `hiddenFromPicker: boolean` — defaults `false`; set `true` for slugs that must remain on-the-wire valid (so old listings resolve correctly) but should not appear in the community picker for new users. Migration safety: `sv-usd` is hidden from picker since it's been deprecated, but listings carrying `community: "sv-usd"` still resolve.

**Slug migration policy**: never delete or rename existing slugs. Listings carry slugs in their on-the-wire payload; renaming would orphan them. Update `displayName`, `flagEmoji`, `federationInvite`, `browserReliable`, `notes` in place. To deprecate a community, set `hiddenFromPicker: true`. The `ke-kes` entry gets updated in place with new displayName (🇰🇪 Kenya · Afribit · KES) and Afribit invite — slug stays.

**Pre-seed reliability assignments**:
- 🇸🇳 Senegal · CFA → BP fallback → `browserReliable: true`
- 🌎 Global · USD → BP → `browserReliable: true`
- 🇰🇪 Kenya · Afribit → Afribit invite → `browserReliable: true` (verify in testing — Afribit reportedly uses HTTPS guardians)
- 🇺🇸 US · Bitcoin Life → BLF invite → `browserReliable: false` (iroh-only, known to have browser-WebSocket asymmetry — APK works perfectly)

**Display rule**: if exactly one community per country, show country name only ("🇸🇳 Senegal"). If multiple, suffix with federation name ("🇰🇪 Kenya · Afribit"). When Bitsacco eventually claims their listing, the Afribit entry's display string will need updating to disambiguate — handle this gracefully via a `disambiguator: string | null` field that's null until needed.

**Permissionless add-community primitive**: implement `addCustomCommunity({ flagEmoji, displayName, currency, country, federationInvite })` that persists to localStorage `chama_custom_communities` and surfaces in the community picker alongside pre-seeded entries. v1 doesn't yet expose a UI for this beyond Sandbox mode (for testing); v1.5 will surface "Add your community" in Me. The function shape and persistence are part of v0.2.0; the polished UI is later.

**Rationale** (do not include in code, but informs design): pre-seeding only operational relationships avoids implicitly vouching for federations Jetty doesn't actually support. Each pre-seeded entry tells a story of relationship; each permissionless entry tells a story of community leader agency. This middle path between pure curation and empty-room permissionlessness gives v0.2.0 substance while preserving the principle that Chama doesn't gatekeep federation listings.

## Things that already work (do not break)

- Atomic LOCK protocol (no FUNDED state, JOIN as ack)
- NIP-44 3-recipient envelope at LOCK time
- Cold-start reconciliation balance guard with DestroyEcashConfirmModal
- Saved payment handles with sensitive-rail privacy gates
- Federation health probes
- 314/314 tests passing

If any of these break during the v0.2.0 work, stop and surface to Jetty. The protocol foundation is sacred; v0.2.0 is UI layered on top.

## Tests to add

- `should silently re-init client when user taps non-matching listing with zero balance`
- `should refuse to fund when currentEscrow is already set` (one-trade gate)
- `should render recovery banner when balance > 0 && no currentEscrow`
- `should route to active trade screen when balance > 0 && currentEscrow exists`
- `should default counterparty display to truncated npub when kind:0 not fetched`
- `should display kind:0 name when fetched and self-revealed`
- `addCustomCommunity persists to localStorage and surfaces in picker`

Target: 320+ tests passing post-PR.

## Out of scope (do not implement in this PR)

- 3D globe community picker (v1.5 — list-based picker stays for v1)
- Lightning routing visualization at fund/claim moments (v1.5 polish)
- Inline "Withdraw via Lightning" CTA on DestroyEcashConfirmModal (v0.2.1+ UX iteration)
- LN routing error surfacing on the recovery banner (e.g. "Last attempt failed: route timeout" — v0.2.1+ when we have richer error telemetry from `redeemEcash`)
- Bill Pay subscriptions for graduated bitcoiners (v1.5)
- Kind:38113 EXTEND mutual extension primitive (v1.5)
- **Published community claims (kind:38112)** — v1.5 layer where federation operators publish a signed npub-attested claim of their community + flag + invite, becoming discoverable to all Chama users. v0.2.0 ships only the local `addCustomCommunity` localStorage primitive; the published-discovery layer + community-level rating accumulation come in v1.5 once the v1 surface has real users exercising the local primitive.
- Browser-iroh transport fix in `@fedimint/transport-web` (separate upstream PR — v0.2.0 ships with `browserReliable` flag as the honest interim solution)
- OSS upstream contributions to @fedimint/transport-web and @fedimint/transport-node (separate PRs to upstream repos)

## Patcher discipline reminders

- `assert_unique` on every anchor before patching
- Dry-run against uploaded copies before touching real files
- Idempotency guards required
- No `npm version` for version bumps — use `sed -i '' 's/"version": .*/"version": "0.2.0",/' package.json`
- No multi-line heredoc commit messages — write to a temp file and pipe

## When you're done

- All tests pass
- `npm run predeploy` clean
- Push to main, tag `v0.2.0`
- Deploy via `./scripts/release.sh`
- Smoke test: 3 fresh Firefox profiles, full first-time onboarding → small testnet trade end-to-end on a single federation, then verify the federation-follows-listing UX by tapping a non-matching listing on Profile A
- Surface any "wallet" strings the grep flagged for Jetty's review

This PR is the gateway to v1. Once it ships, every architectural decision from PRs 1-5 is finally visible to the user as a coherent product, not a stack of internal correctness improvements. Take your time, ship it clean. 🚀
