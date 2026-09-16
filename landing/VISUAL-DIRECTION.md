# It starts with people

The opening is a film with a beginning, a handover, and a next turn. Desktop visitors enter a full-viewport scene. It plays once, holds its final frame, restores the headline, and invites a native scroll into the explanation. The scroll is never captured or delayed. Mobile places the headline above an inline, tap-to-play film; it does not download video automatically.

Meet → Agree → Trade is one continuous illustration: two people connect, their chosen arbiter joins, the agreement closes around locked sats, and settlement moves to the seller. The concluding photographic reveal, “And a circle begins,” returns to the same people and bowl as the opening. It is a consequence of the three steps, not a fourth step or a savings instruction manual.

## References and story

Reviewed the full scrolling journeys at [Strike](https://strike.me) and [Buzz](https://buzz.xyz). Strike connects a consistent dark visual world with product demonstrations, proof, and history. Buzz changes the color and scale of one recurring visual world, revealing its product before returning to its oversized identity. The relevant lesson is continuity and controlled reveals, not copying their artwork or layout.

The [FAO group savings resource book](https://www.fao.org/4/y4094e/y4094e04.htm) describes rotating contributions and the significance of receiving a pooled sum. [VICOBA field research](https://journals.openedition.org/anthropodev/846) describes a related but distinct accumulating savings-and-credit model. The film uses reciprocity as its human theme, not a claim that every savings tradition has identical rules.

Rotating payouts are currently gated by `CHAMA_ROTATION_ENABLED = false`. The hero is explicitly labelled a vision of rotating savings, coming next. The trade chapters describe the existing escrow safeguards. No reputation scoring, arbiter certification, or new savings behavior is added by this PR.

## Film and assets

Higgsfield Kling 3.0 Pro, silent, 15 seconds, generated from the approved four-person circle artwork. Job: `f1bb715a-ce6a-4244-b28a-7249718776ae`. The result shows lit Bitcoin phone screens, symbolic orange tokens contributed to a bowl, a first recipient, then another handover. It is an illustrative film, not recorded application UI. The model retained the source's 3:2 framing despite the requested 16:9 ratio; desktop uses cover framing and mobile preserves the full 3:2 view.

Production video: `img/chama-circle-story-v2.mp4`, H.264, 1600 × 1066, 15.04 seconds, approximately 6.2 MB, no audio, fast-start metadata. The opening poster is extracted at 2.5 seconds and the closing photograph at 13.9 seconds. No generative edits were made during encoding or frame extraction. The exact generation prompt is recorded alongside the asset.

Playback pauses outside the viewport and in hidden tabs, preserves an explicit pause, and never loops. Reduced-motion and data-saving preferences prevent automatic video loading. Manual playback remains available. Reduced motion also disables continuous scroll transformations. With JavaScript unavailable, still images and ordinary document chapters remain readable.

## Scope and shipping

Only landing-page assets and presentation change. English, Spanish and French follow the same sequence. Existing FAQs, app and sandbox links, and community destinations are retained. The previously approved versioned social banner remains the replacement for the old live banner.

The deploy manifest includes reviewed assets and FAQ dependencies. Application work remains separate. Deploy only through the documented `npm run ship -- --only landing` entry point; this PR does not deploy itself.
