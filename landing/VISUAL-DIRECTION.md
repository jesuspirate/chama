# It starts with people

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
