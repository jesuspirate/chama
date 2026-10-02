# It starts with people

> This document records successive design revisions, including superseded assets.
> Older stills, films, and their provenance notes were moved to the local review
> archive at `outputs/design-review-archive/2026-09-21/`. Resolve historical paths
> through [the archive inventory](../assets/landing/archive-inventory.json);
> the archive binaries are intentionally not committed. The current shipping
> asset list is [deploy-files.txt](deploy-files.txt).

The opening is a film with a beginning, a handover, and a next turn. Desktop visitors enter a full-viewport scene. It plays once, holds its final frame, restores the headline, and invites a native scroll into the explanation. The scroll is never captured or delayed. Mobile places the headline above an inline, tap-to-play film; it does not download video automatically.

Meet → Agree → Trade is one continuous illustration: two people connect, a community arbiter joins, the seller locks sats, the buyer sends local money, and confirmations release the sats to the buyer. The concluding photographic reveal, “And a circle begins,” returns to the same people and bowl as the opening. It is a consequence of the three steps, not a fourth step or a savings instruction manual.

## References and story

Reviewed the full scrolling journeys at [Strike](https://strike.me) and [Buzz](https://buzz.xyz). Strike connects a consistent dark visual world with product demonstrations, proof, and history. Buzz changes the color and scale of one recurring visual world, revealing its product before returning to its oversized identity. The relevant lesson is continuity and controlled reveals, not copying their artwork or layout.

The [FAO group savings resource book](https://www.fao.org/4/y4094e/y4094e04.htm) describes rotating contributions and the significance of receiving a pooled sum. [VICOBA field research](https://journals.openedition.org/anthropodev/846) describes a related but distinct accumulating savings-and-credit model. The film uses reciprocity as its human theme, not a claim that every savings tradition has identical rules.

Rotating payouts are currently gated by `CHAMA_ROTATION_ENABLED = false`. The hero is explicitly labelled a vision of rotating savings, coming next. The trade chapters describe the existing escrow safeguards. No reputation scoring, arbiter certification, or new savings behavior is added by this PR.

## Film and assets

The hero is a silent, 15-second Higgsfield film generated from the approved four-person circle artwork, followed by a Genjutsu correction of phone logos and chip markings. It shows contributions, a first recipient, and another handover. It is an illustrative film, not recorded application UI. The source uses 3:2 framing; desktop uses cover framing and mobile preserves the full view.

Production video: `img/chama-circle-story-v4.mp4`, H.264, 1600 × 1066, 15.04 seconds, approximately 2.3 MB, no audio, fast-start metadata. The opening poster is extracted at 1 second. The closing photograph is a separately reviewed edit. Public-safe prompts are recorded alongside the assets.

Playback pauses outside the viewport and in hidden tabs, preserves an explicit pause, and never loops. Reduced-motion and data-saving preferences prevent automatic video loading. Manual playback remains available. Reduced motion also disables continuous scroll transformations. With JavaScript unavailable, still images and ordinary document chapters remain readable.

## Scope and shipping

Only landing-page assets and presentation change. English, Spanish and French follow the same sequence. Existing FAQs, app and sandbox links, and community destinations are retained. The previously approved versioned social banner remains the replacement for the old live banner.

The deploy manifest includes reviewed assets and FAQ dependencies. Application work remains separate. Deploy only through the documented `npm run ship -- --only landing` entry point; this PR does not deploy itself.

## Coordination revision

Reviewed the current application philosophy and canvas at application commit `e8f44036`: `PHILOSOPHY.md`, `src/guided/canvas-routing.ts`, the assisted canvas, its English prompts, and create-form arbiter seating. The story starts from complementary needs, with amount, payment method and community compatibility. Named illustrative people remain the protagonists; Chama coordinates their match. A community arbiter joins through the eligible-pool rules, so the page does not promise an unrestricted mutual arbiter picker.

The animated example is explicitly cash for Bitcoin. Daniel is the Bitcoin seller and locks sats. Daneka is the Bitcoin buyer and sends local money. Payment and confirmations precede release of sats to Daneka. Funding and release use a separate lower lane, away from the portraits and the Chama mark. The final receipts remain visible before the circle reveal. Mobile and reduced-motion visitors receive readable diagram states.

The create-form circle mark is reused unchanged at the photographic conclusion. The Bitcoin mark in the diagram is the actual Bitcoin Core PNG; asset provenance is recorded in `icons/bitcoin-source.md`. Generated photographs use this logo as an image reference, with plain orange chips instead of repeated generated glyphs.

Current assets supersede the earlier versions: `chama-circle-story-v4.mp4` (15.04 seconds, 1600 × 1066, about 2.3 MB), its `chama-circle-action-v4.jpg` poster, and `chama-circle-ending-v8.jpg` (1536 × 1024). Higgsfield Kling 3.0 Pro regenerated the film between reviewed opening and closing frames, with metallic gold coins and five orange checked Circle seats on the stationary phone. The closing still was edited with the built-in image tool. A duplicate front-camera cutout was caught during close-up review; the rejected intermediate still is not shipped. The accepted phone replacement was checked enlarged before integration.

## Hero continuity and framing

The film uses one continuous fixed shot. Quarter-second phone crops across all 15 seconds retain the phone and five-seat screen; one-second full-frame review covers contributions and the collection. The closing photograph uses matching gold coins. The video and its container share a rounded clip, with the progress line inset to avoid cutting across lower corners. Desktop light/dark and mobile layouts were reviewed.

## Single-coin refinement

Current hero: `chama-circle-story-v5.mp4`, six seconds, one large gold Bitcoin coin released within the first second, then basket collection and shared laughter. Poster: `chama-circle-action-v5.jpg`. This replaces the slow 15-second multi-coin contribution take. The phone retains the locked Circle. Agree begins animating while its chapter enters; duplicate agreement labels are removed and payment routes appear in sequence. The closing flag ring is oversized and cropped off the right edge behind the copy. “Good things start with people” replaces “human beginnings” in all three languages.

## Digital-first audience note

The intended demographic remains an open product question. Do not infer Bitcoin competence from age, or present older African people as the default target market. A contemporary adult cast is a creative hypothesis, not established market research. FinAccess 2021/2024 youth cohort work finds increasing digital connectivity and continued informal-finance use among younger adults; this supports testing a phone-first presentation, not claiming a Chama-specific audience profile. Source: https://www.fsdkenya.org/wp-content/uploads/2025/03/Youth-cohort-analysis-from-FinAccess.pdf

Current hero and conclusion use `chama-digital-community-v1.jpg`. The physical basket and coin films are superseded. An authored, five-second phone illustration shows ready to claim → collect → received using the app’s “Collect your sats” action language. This depicts an already-ready claim with destination preparation omitted, not currently enabled rotating payouts. It pauses offscreen and in hidden tabs, respects reduced motion, and can be replayed or manually advanced. Intent cards appear as thought bubbles tied to Daneka and Daniel.

## Both moments, with a static phone mark (September 16)

The approved six-second single-coin film returns as the hero. A tracked screen replacement freezes the original five-orange-seat mark while preserving the original acting and phone hardware (see `img/chama-circle-film-v6.md`). The final caption explicitly says to keep locking sats for the next person after collecting, and remains in the film's context line after playback. The digital community scene and independent claim illustration now close the Circle section. Each plays once, pauses out of view, and supports replay; mobile and reduced-motion visitors start playback themselves. Hero captions are translated in English, Spanish, and French. The hero remains labeled as a future vision of rotating savings.

### Phone stability correction

v7 replaces v6's independently tracked screen with one rigid first-frame phone plate. The logo, screen and hardware move together on a smooth translation path, eliminating frame-to-frame corner jitter and relative artwork movement. Both narrative moments and the continuing-contribution message remain unchanged.

## Mobile scroll experience correction

The earlier phone layout replaced the pinned trade sequence with three static diagrams and disabled automatic film playback. Mobile now retains one pinned diagram across Meet, Agree and Trade, with scroll-driven matching, arbiter entrance, funding, payment, confirmations and release. A full-height inline film leads into that sequence. Muted playback is attempted on mobile when motion/data preferences allow; the existing play button remains available when a browser blocks autoplay. Reduced-motion visitors retain the readable static chapters and manual playback.

Theme controls now use fixed SVG sun/moon icons instead of platform-dependent Unicode emoji. Mobile header spacing, the orange brand dot, and monochrome external arrows are consistent in both themes. Mobile review at 390×844 verified live phase progression, both themes, settlement completion, no horizontal overflow and no console errors. The local Wi-Fi preview is refreshed; Sites publication remains intentionally paused following the user's local-only choice.

## Hero motion refinement

The hero's retreat now uses a compositor scale instead of repeatedly changing container padding, which resized and recropped the playing video. Inline video measurements run on resize, image load and font readiness rather than every scroll frame. Hidden mobile diagrams are not animated during ordinary scrolling; unchanged coordination states skip redundant writes. Desktop and phone checks confirm stable video layout dimensions during scrolling (842×1137 and 390×774 respectively), with no console errors or horizontal overflow. No other narrative sections, copy, brand assets or theme styling changed in this refinement.


## Logo-first cards and authentic Circle capture (revamp 39)
Everyday cards now begin with the app symbols and reveal photography on hover/tap, with opacity-only transitions. The home medley decodes images before playback and translates by the exact width of one repeated set; resizing preserves playback phase.

The finale uses `img/circle-lock-app-v1.png`, a real 390px-wide app capture taken after a separate simulated participant locked 10,000 fake sats in a five-seat circle. Only the app card is cropped into the phone; the red sim banner is outside the crop. The surrounding caption identifies simulated sats. This is a static capture of the completed lock, not a recording of the transition. No app or wallet behavior was changed. French seller pseudonym: G🏄.

Film direction pending generation: keep the approved fourth man visibly consistent with the lower-left participant, give each collector a distinct lively reaction, composite four seats in rounds 1–4 and five when the younger friend joins. Week labels should be authored overlays, not generated text. No credits spent for this revision.


## Revamp 40 follow-up (visual verification pending)
Arbiter links now intersect each portrait along the center-to-center diagonal and meet the role border, rather than stopping eight pixels outside Grace's left/right midpoints. Coordinates are measured after current animation properties are applied. Everyday tiles have a 25px turned corner showing the photograph below the initial logo.

Film expansion is deferred at the user's request. Reminder scheduled October 1, 2026. Round 1 is free by design; do not label the future collection films as five paid rounds starting at 1. Reconfirm labels beginning at round 2 before generation.

The requested actual invite → lock → claim sequence remains unfinished. A real two-person five-minute simulated circle named “Our first circle” was created on BLF, both participants locked 10,000 fake sats, and screenshots of the real funding/lock celebration were recorded in `/private/tmp/chama-lock-record/`. Do not replace the current still with a pretend claim. Browser automatic approval review failed because its review model reached capacity, blocking both landing navigation and simulator inspection before the claim capture. The pending landing changes have syntax checks only, not visual approval.


## Revamp 42 peel polish
The tile corner now has a shaded paper underside, a soft shadow, and a lift-away transition; the symbols themselves remain stationary. Verified logo-first and photo-revealed states in the browser, in light and dark themes. Grace's connector endpoints now use the measured border-inclusive radius, overlapping by one pixel to avoid the remaining gap. The hero is unchanged. The actual claim recording remains a separate unfinished follow-up.


## Experience layer (revamp 47, pending review)
The hero film, the Meet → Agree → Trade sequence, the circle reveal, the everyday tiles and the closing are unchanged. `experience.css` and `experience.js` are additive: removing the two tags restores revamp 46 exactly. Native scrolling is still never intercepted.

Added: a chapter thread (right-edge rail from 1100px, a progress line under the header below that); line-by-line headline reveals and single-use entrance reveals, released after they finish so hover states are untouched; a section on the name, with a five-seat circle that fills, contributes and pays one seat per turn; an interactive two-of-three explanation in the safeguards, reusing Daneka, Daniel and Grace; four plain facts. Fixed: trade chapter copy no longer slides under the chapter nav at the end of the sequence.

Claims added by this revision, each to be confirmed before shipping: savings circles are open today and return everyone's exact sats; rotating turns are coming next (the circle keeps the existing "vision of rotating savings" label and shows no round numbers); any two of buyer, seller and arbiter settle a trade and Chama has no vote; Chama runs on web, Android, desktop and StartOS; the code is MIT licensed.

Reduced motion shows every section in its finished state, with the circle full and one settled pair. Without JavaScript the new sections render as static content. English, Spanish and French are complete; the Spanish and French lines are new and need a native read. Verified at 375×812, 1024×768 and 1360×800, light and dark, with no console errors or horizontal overflow.

### Revamp 47 review round (2026-09-29)
The circle now shows the rule, not only the happy path: every round each seat locks again, the locked sats wait on the ring, and only a full round pays out. Alternate circles fall one seat short in their third round; the waiting seats are refunded and the circle ends, matching the rotation spec's atomic rounds. The same rule is stated in copy beneath the definition, so it does not depend on watching the animation. A seat that has collected carries the Bitcoin logo, not a typed character.

Also in this round: the footer wordmark matches the header (lowercase, orange dot); the name's reveal mask no longer clips the final letter; everyday tiles use the section's own colour in both themes; both carousel rows move at 30px/s, which lands on whole device pixels per frame at 60 and 120Hz (26 and 28px/s did not, and hitched several times a second).

A coded hero film draft lives outside the deploy tree in `outputs/hero-film/` (canvas, deterministic per frame, EN/ES/FR captions, MP4 export through `export.mjs`). It is a proposal only; the approved hero film is unchanged.

### Revamp 47, second review round (2026-09-29)
One marker per seat. A seat shows a tick while its share is locked; once that seat has collected, the same marker becomes the Bitcoin logo and stays. Sats are no longer parked on the ring: they appear only in motion, into the pot or back to their seats on a refund. The refund round is unchanged. The hero film draft follows the same rule.

The phone mock in the circle reveal now carries the header's wordmark (same weight, same orange dot) in place of a typed bullet.

## Revamp 48: the drawn hero film (pending review)
The hero is now a drawn film, not a photographed one: one continuous pull-back from two people, to a trade with a community arbiter, to a circle of five, to a field of circles that keeps turning. It is code (`outputs/hero-film/film.js`), rendered to video once per language and framing because names and captions are part of the picture: `img/chama-film-{wide,tall}-{en,es,fr}.mp4` with a matching `.jpg` poster. `story.js` picks the file from the page language and the viewport, and resumes from the same moment when either changes. Desktop shows the 16:9 frame whole; phones get a 9:16 framing of the same film. The hero cut ends on the living field with no title of its own, so the page's headline returns over it.

The photographed film is kept. `img/chama-circle-story-v13.mp4` and its poster remain in the deploy manifest, and `?hero=classic` plays it with its original captions. To go back for good, set `classicHero` to true in `story.js`.

After the first circle completes the circle does not stop: a new one starts at once, and the neighbouring circles keep paying out. Six short tags name what a payout becomes (a debt paid off, school fees, a trip home, a first car, a home, a fresh start).

The price display copies the app's hero price pill and replays BTC/USD for a closed decade, January 2016 to December 2025, first day of each month, from the blockchain.com market price chart (read 2026-09-29). It includes the falls. It is labelled as past prices and not a promise. It deliberately shows no invented or projected prices: the circle brief's rule is "No price promises. Ever." A closed decade also never goes stale, because it never claims to be today.

Names: English keeps Daneka, G🏄🏿 and Grace. Spanish is Marisol, Ramón and Esperanza. French is Nadège, Basile and Félicité.

Also in this revision: "For the everyday. Week after week."; a fourth everyday tile, circles first ("Save together"); each part of the page makes one entrance when it comes into view and re-arms once it has left; moving between chapters from the thread or the header is a cut (a brief dip to paper, then the chapter's entrance) and never a long scroll.

### Bridge copy (revamp 48)
The old bridge asked "What makes that possible?", which set up the trade explanation after a film that showed only a savings circle. The drawn film already shows the trade, so the bridge now says the repeat is deliberate: "Now, at your pace. One trade, step by step." The film tells the whole story once, quickly; the scroll sequence tells the trade again at the reader's speed, with the detail the film skips.

### Footer and preview server (revamp 48)
The footer is now a conventional one: brand, line and ethos on the left, then three plain columns (Chama, Learn Bitcoin, Find us in public) and a base line. Learn Bitcoin links to Learn Me A Bitcoin, Plan ₿ Academy (planb.academy), Yzer and the whitepaper; each address was checked on 2026-09-29. Mi Primer Bitcoin is left out for now (its address redirects to es.myfirstbitcoin.io).

The local preview now runs `.claude/serve-landing.mjs`, which answers Range requests. Python's `http.server` does not, so a language switch restarted the film from zero in preview. With Range support the film resumes from the same moment, as it will behind Caddy.

### Final review before shipping revamp 48 (2026-09-29)
Checked by script in a headless browser: markup balance, duplicate ids, in-page anchors, every copy key in English, Spanish and French, every local file referenced by pages, styles and scripts, the deploy manifest, and every external link. Then the whole page was walked in three languages at 340, 375, 820, 1360 and 1920 pixels, light and dark, with motion reduced, with JavaScript off, and with `?hero=classic`: no script errors, no failed files, no sideways overflow, nothing left hidden on screen.

One fault found and fixed: with motion reduced on a phone the hero is a paper page with an inline still, and the new film background had turned that page dark under dark text. The dark surface now applies only where the film fills the hero.

Known and left alone: `?film=original|varied` in `story.js` names files under `img/circle-turns/` that are not in the tree (older experiment, not reachable from the page); on a phone with JavaScript off the hero shows the wide still, cropped.

### Readability and the phone chapter copy (2026-10-01)
Type across the page and the FAQ was raised so nothing a reader must read sits under 12px and body copy sits at 16px or more; sizes inside the trade diagram stay a step smaller so its parts keep their places. On phones the chapter copy (Meet, Agree, Trade) used to travel up through the pinned portraits on its way to the top, and was then faded out by the desktop rule once it got there. It now waits until it reaches its seat under the chapter tabs, appears there above the diagram, and fades only once it scrolls on past.

### Chapter emphasis (2026-10-01)
The pinned trade diagram now points at what each chapter is about, with a bold pulse: the two intent cards while matching, the three people once the agreement is in place, the local-money note as it crosses, then the sats as they leave escrow. The emphasis follows the diagram's own progress values, so it lands exactly when each thing happens. Reduced motion shows none of it. The "A vision of rotating savings · coming next" line is no longer shown over the hero: the film has its own captions, and the name section carries the open-today / coming-next distinction.

