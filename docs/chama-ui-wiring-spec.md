# Chama UI wiring — implementation spec (2026-09-07)

Prereq: src/chama/ engine + money path are DONE and verified (4,113 engine +
64 circle + 35 gate tests green). This spec wires them to screens. Visual
reference: the published design canvas "Chama Circles" (Circle Home, Start a
Circle, Filling, Round Complete) — match its anatomy, not pixel-copy it.

Golden rule, inherited from the guided canvas: **one question per screen,
always a suggested default, never a blank field.** Money never moves without
an explicit confirmation.

## Entry points (three, no more)

1. **Create → Chama tile.** src/ui/screens/CreateForm.tsx line ~151: drop
   `comingSoon: true`. Tapping it opens the CircleCanvas (below), NOT the OG
   create form — a circle has no price, no counterparty, no rails.
2. **Browse.** Circle parents (category "chama") are already browsable
   (shouldShowOnBrowse passes them; shares are excluded). TradeCard needs a
   chama branch — see "Browse card".
3. **Me → My trades.** A member's share appears in history. Tapping ANY
   chama escrow (parent OR share) opens the CircleSurface for the PARENT —
   one surface for the whole circle, never a bare share room.

## Screen A — CircleCanvas (create), src/ui/screens/CircleCanvas.tsx

New file. Reuse AssistedCanvas's visual language wholesale: same
`canvasCss()` idiom (headingStyle/subStyle/QuestionCard/Primary/Back), same
fit-the-window vh-clamped rhythm, same footer with step dots. Four steps:

- **Q1 "How much per person?"** — preset chips (5k · 10k · 25k · Custom),
  the big dashed-underline amount input, live fiat estimate under it.
  Copy already exists in spirit: canvas.rangeWhy idiom. Default 10,000 sats.
- **Q2 "How many of you?"** — threshold stepper, minimum 2 (engine law).
  Default 5. Optional cap toggle ("Open to anyone" vs "Cap at N"); cap
  must be >= threshold or the Continue button disables with the reason.
- **Q3 "When does the round end?"** — weekly default (DEFAULT_ROUND_SEC).
  Offer 1 week / 2 weeks only; the two-week federation bound is a FEATURE,
  say it out loud: "Locked together, guaranteed back by <date>." Fill
  deadline defaults to createdAt + 40% of the round (round it to a day
  boundary in copy: "Seats close <weekday>").
- **Review + publish** — reviewStyle card: share, seats, "fills by", "back
  by", and the fill-or-refund promise in plain words. Primary = "Open the
  Circle". On tap: `escrowClient.createEscrow({ category: "chama",
  chamaCircle: {...}, expirySeconds: roundEndSec - now, ... })`.
  The engine gate validates; surface `chamaCreateError` text verbatim if it
  ever fires (it means the UI built an unlawful circle — a bug, show it).

The creator does NOT get a seat (engine law, member !== creator). The review
screen must say so plainly: "You host this Circle. Hosts don't hold a seat
in their own round." Do not hide it, do not apologise for it.

## Screen B — CircleSurface (live), src/ui/screens/CircleSurface.tsx

New file, LiveTradeSurface idiom: ONE status, ONE move. Reads
`circleProgress(circle, sharesForCircle(escrows, circleId), now)` — never
recomputes fill logic locally.

Header: circle name, `‹ <backLabel>` (dynamic, same rule as LiveTradeSurface).
Hero: the SEAT RING from the design canvas — SVG donut, filled seats in
T.accent, open seats dashed T.muted, pot in the centre ("30k of 50k sats").

State → status line → the one move:
- `filling`, no seat yet → "3 of 5 seats filled · seats close in 2 days"
  → **Lock your share** (calls `createChamaShare(parentId)` then the normal
  atomic funding modal — identical money path to any trade).
  If `canTakeSeat` refuses: show the reason (closed / full / already-seated)
  and no button.
- `filling`, seat locked → "Your share is in · waiting for 2 more"
  → **Invite your people** (shareTradeLink on the circle id).
- `running` → "Locked together · back by <date>" → no action, calm. Show the
  countdown to roundEnd, not a spinner.
- `refund-due` → "The circle didn't fill · your sats are coming back"
  → no button by default (the watcher votes automatically); after 10
  minutes with the share still unresolved, offer **Return my share now**
  (manual REFUND vote) as the escape hatch.
- `complete` → the Round Complete celebration: "Everyone made it." + the
  three stat tiles (circles completed / on-time / standing) + the
  re-entry card ("Your circle re-forms in 48h · I'm in / Sit this one out")
  — v1 keeps the card VISUAL only if auto-re-entry publishing isn't wired;
  in that case the primary is **Start the next round** (creator only),
  which opens CircleCanvas prefilled from `nextRoundTemplate`.

Always-visible footer line, all states: "Sats in, the same sats back.
Nobody is ever the only one who showed up."

## Browse card (TradeCard chama branch)

For `category === "chama"`: show the circle mark, name, `<share> sats each`,
`N of M seats`, and `seats close in <x>`. NO price, NO fiat quote, NO
counterparty line, NO rails chips. Seat counts come from
`sharesForCircle(allEscrows, circle.id)` — if the client hasn't loaded the
children yet, show "· open" rather than a wrong "0 of 5".

## Routing

In App.tsx `openEscrow`: if the loaded state is `category === "chama"` OR
`chamaPolicy === "share-v1"`, route to CircleSurface with the PARENT id
(resolve via `state.parent` for shares). Add `view === "circle"` alongside
detail; back label follows the same TAB_FOR_VIEW rule.

## i18n

New namespace `circle.*` in en/es/fr/sw (all four, same pass — no English-
only merges). Every string in this spec is a key. Kiswahili matters most
here: this is the vertical named in that language.

## Tests

`src/chama/tests.ts` additions (pure only — no DOM):
- a `circleCardModel(circle, shares, now)` selector: returns the Browse
  card's seat text and closing text; test the unloaded-children case
  returns "open", never "0 of N".
- a `circleSurfaceMove(circle, shares, viewerPubkey, now)` selector
  returning `{ status, move }` where move ∈ lock | invite | wait |
  returning | next-round | none. Test every state × (seated, unseated,
  creator) — this is the one-status-one-move contract as a pure function,
  so the component stays dumb and the logic stays tested.

Build the selectors FIRST, test them, then render them. No fill logic in
components.

## DO NOT in this phase

Notifications (VPS wake plumbing), rotation/collection order UI, standing
badges on profiles, auto-re-entry publishing, Dashboard chama tiles. Those
land after v1 circles are real on relays.

## Implementation notes (2026-09-07)

- Create now opens the four-step CircleCanvas; Browse cards and parent/share
  links open CircleSurface. The existing `src/chama/surface.ts` selectors own
  status and action selection. Components do not duplicate the fill policy.
- Funding uses the existing federation-switch guards and atomic funding modal.
  Failed-fill recovery uses the existing watcher and selector's ten-minute
  manual-return grace period. Loading errors can be retried.
- Next-round creation preserves the previous round's federation and lineage.
  Re-entry remains an explicit choice; no automatic re-entry controls or
  notification plumbing are presented.
- Light/dark five-seat SVG marks are shared across Landing and the webapp.
  Circle copy and error messages are available in en/es/fr/sw.
- Return-date copy says "return scheduled" rather than promising a guaranteed
  wall-clock settlement time; the existing recovery path requires connectivity.
- Verification: typecheck, full test suite, production build, repository hygiene,
  and isolated browser previews of the real components. Mobile creation was
  exercised in all four languages; desktop creation and both themes were checked.
  Preview publishing used a mock callback; no live circle or funded share was
  created as part of UI verification.

## Field findings, first live circles (Jet, 2026-09-07)

1. **"waiting for 0 more" (FIXED in the selector).** Copy counted
   `threshold - locked` and hit zero. `circleSurfaceModel` now exposes
   `filled` and `seatsStillOpen`, and a seated member in a CAPPED-full circle
   gets `wait`, not `invite`. Renderer must key its copy off `filled`:
   below threshold → "waiting for N more"; filled + seats open → "the round
   will go ahead · room for more"; filled + capped → "all seats taken ·
   locked until <date>". Never a countdown that reaches zero.
2. **Circle missing from Browse's Mine.** Verify circle parents survive the
   listing pipeline that feeds `matchingListings` / `countOwnListings` — a
   creator's own circle must appear under Mine, and a community circle under
   My Chama.
3. **After publishing, land ON the circle** with the invite link one tap
   away. Jet lost his circle by navigating away from the publish screen
   before copying the link; it was in My trades, but the flow should not
   require knowing that.
4. **"Lock your share" takes seconds before the funding options appear.**
   `createChamaShare` does parent resolution + `loadEscrow` + `loadChildren`
   (relay round trips) BEFORE the funding modal opens. Resolve the parent and
   prefetch children when the CircleSurface MOUNTS, so the tap only publishes
   the share CREATE. Show the funding sheet optimistically with a spinner
   rather than a dead button.
5. **Tiny-share economics (open question, not yet decided).** The app's
   funding floor is deliberately 1 sat (see funding-limits.ts) and circles
   inherit it. Circle-specific wrinkle: fill-or-refund means a failed circle
   makes every member pay to fund AND to cash out, so a 100-sat share can
   cost more in fees than it holds. Recommendation: no protocol floor
   (that contradicts the existing no-artificial-floors ruling), but a soft
   warning in CircleCanvas below a guidance threshold, and Browse
   de-emphasis rather than blocking, so testing stays possible.
