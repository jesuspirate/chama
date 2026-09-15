# The first real circle completion (gate for pressing 6.4)

DATE CORRECTION (2026-09-12): the round clock is createdAt + 7 days,
absolute — and this circle was born Monday Sep 7 at ~9:25 PM ET, so it
returns **Monday Sep 14, ~9:25 PM ET**, not Sunday. "Sunday" was our
shorthand for the planned weekly pulse; the app kept the actual promise.
(6.4 note, filed in the runway: the create canvas should offer snapping
the round end to a Sunday so a circle's payday isn't just its birthday.)

The 2-of-2 circle (1,000 sats each) is the first full round trip of the
flagship money path with real sats on prod. 6.4 ships on the back of it —
so every box below is a launch gate, not a formality.

Reality check on versions: the members complete on PROD 6.3.4 clients. That
build HAS the full money path (refund watcher, REFUND-only law) but NOT the
durable-claim queue or this week's fixes — those are in the tree for 6.4.
Keep one localhost dev build open as the observer: it sees the same relays
with better instrumentation, and its durable-claim drain covers your own
device's claim.

## Fill deadline — PASSED CLEAN (verified 2026-09-12, Jet's screenshot)

- [x] Circle flipped to RUNNING: "Locked together · return scheduled for
      Sep 14", 2,000 of 2,000 sats ring, calm countdown. Exactly as
      designed.
- [x] No refund-due misfire at the deadline second — the historical latch
      held with real sats.
- [x] Screenshot captured (launch-story material).

## Monday Sep 14, ~9:25 PM ET — roundEnd (running → complete, shares return)

Watch in this order; the watcher cadence is 60s, so "within minutes" is
healthy and "instant" is not expected.

- [ ] Status flips to COMPLETE on both devices at roundEnd.
- [ ] Each member's client auto-votes REFUND on their OWN share (event
      chain shows the VOTE; no prompt needed — "returning" copy, calm).
- [ ] Outcome on each share resolves REFUND. The REFUND-only law held:
      nothing ever offered RELEASE, no payout ever pointed at a
      counterparty (payoutRecipientFor stays null for non-REFUND).
- [ ] Each member CLAIMs and the exact share returns: 1,000 sats each,
      zero fees docked (share fee is pinned to 0).
- [ ] Wallet balances verified +1,000 vs pre-claim, both members.
- [ ] CLAIM events visible ON THE PREFERRED RELAY from a third device —
      this is the manual zombie-claim watch (prod lacks the durable queue;
      the dev build's drain covers only its own identity).
- [ ] Both shares read "returned"; the completed circle still shows its
      history (2 of 2 — never an empty circle after healing).
- [ ] The host is offered "next round" (auto-re-entry template, same
      rhythm, lineage threaded) — the pulse works.

## If something sticks

- The MANUAL return button appears 10 minutes after the automatic path had
  its chance (MANUAL_REFUND_GRACE_SEC). Use it — that is its job — rather
  than raw votes in the full view.
- CLAIM published but redeem failed → the pending-redemption stash retries
  on next boot. Do NOT re-claim from a second device; give the stash one
  app restart first.
- A share stuck LOCKED past roundEnd with no vote: open it on the dev
  build, note escrow id + last event id, and check which relay answered —
  before touching anything.
- Capture everything: escrow ids, event ids, relay responses, screenshots.
  A failure here is a 6.4 blocker and the evidence is the fix's spec.

## After — the 6.4 button

- [ ] Every box above green → flip CHAMA_CIRCLES_ENABLED to true,
      un-comment the landing "Save together" card (CHAMA_CIRCLES marker),
      write the Big Boss notes, `npm run ship`.
- [ ] Any box red → the fix lands in the tree FIRST; 6.4 ships carrying it.
      The launch waits for the money path, never the reverse.

## Completion night findings (2026-09-14, ~11 PM ET — live run)

WHAT WORKED: fill→running→complete clean on both devices; auto-REFUND votes
resolved; "Everyone made it." on both; host offered "Start the next round";
the new share cards + status pills rendered as designed.

FINDING 1 — the missing COLLECT flow (launch blocker, FIXED same night):
shares route to CircleSurface, which had onLock/onReturn/onNextRound but no
claim — "Your sats are coming back" was a promise with no hands, and READY
TO CLAIM shares had no button anywhere in the app. Fixed in the tree:
readyToClaim on the share adapter (APPROVED + resolved REFUND), a "collect"
move in the surface model (outranks the moot manual vote), "Collect your
sats" on CircleSurface firing the identical ClaimPayoutModal at the share
escrow (zero premium). +7 assertions (chama suite 93). SHIPS IN 6.4.

FINDING 2 — needs-you asymmetry between devices (by design, self-heals):
the attention queue only summons "Claim your payout" when the claim is
actually reconstructable (notesHash + ≥2 decrypted SSS shares in the local
view); a device that hasn't decrypted the second envelope yet stays quiet
while the My-trades status card already reads READY TO CLAIM. Conservative
on purpose; resolves with hydration.

FINDING 3 — returns need a SECOND voter online (by design, document it):
2-of-3 means one member's auto-REFUND vote resolves only when a second
participant's client (counterparty or arbiter healing) comes online and
agrees — observed live: the left device's claim banner appeared the moment
the right device hydrated and its watcher cast the agreeing vote. For
2-member circles this means returns land when both members' clients have
been online after roundEnd. Candidate v2 improvement: lean on the arbiter
pool's REFUND-only healing to be the always-on second voter.
