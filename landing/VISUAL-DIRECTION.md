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

The animated example is explicitly cash for Bitcoin. Daniel is the Bitcoin seller and locks sats. Amina is the Bitcoin buyer and sends local money. Payment and confirmations precede release of sats to Amina. Funding and release use a separate lower lane, away from the portraits and the Chama mark. The final receipts remain visible before the circle reveal. Mobile and reduced-motion visitors receive readable diagram states.

The create-form circle mark is reused unchanged at the photographic conclusion. The Bitcoin mark in the diagram is the actual Bitcoin Core PNG; asset provenance is recorded in `icons/bitcoin-source.md`. Generated photographs use this logo as an image reference, with plain orange chips instead of repeated generated glyphs.

Current assets supersede the earlier versions: `chama-circle-story-v4.mp4` (15.04 seconds, 1600 × 1066, about 2.3 MB), its `chama-circle-action-v4.jpg` poster, and `chama-circle-ending-v8.jpg` (1536 × 1024). Higgsfield Kling 3.0 Pro regenerated the film between reviewed opening and closing frames, with metallic gold coins and five orange checked Circle seats on the stationary phone. The closing still was edited with the built-in image tool. A duplicate front-camera cutout was caught during close-up review; the rejected intermediate still is not shipped. The accepted phone replacement was checked enlarged before integration.

## Hero continuity and framing

The film uses one continuous fixed shot. Quarter-second phone crops across all 15 seconds retain the phone and five-seat screen; one-second full-frame review covers contributions and the collection. The closing photograph uses matching gold coins. The video and its container share a rounded clip, with the progress line inset to avoid cutting across lower corners. Desktop light/dark and mobile layouts were reviewed.

## Single-coin refinement

Current hero: `chama-circle-story-v5.mp4`, six seconds, one large gold Bitcoin coin released within the first second, then basket collection and shared laughter. Poster: `chama-circle-action-v5.jpg`. This replaces the slow 15-second multi-coin contribution take. The phone retains the locked Circle. Agree begins animating while its chapter enters; duplicate agreement labels are removed and payment routes appear in sequence. The closing flag ring is oversized and cropped off the right edge behind the copy. “Good things start with people” replaces “human beginnings” in all three languages.
