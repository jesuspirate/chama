# Replay follow-ups — prepared for review, 2026-10-02

The user supplied an independent review of step 1 (`51a91413`) and step 2
(`1321ed64`) with no blocking findings. These subsequent changes are new and
require their own review. They are based on step 2 and must not enter the
creator-binding release.

## Cancellation before funding

Before: a buyer's ecash LOCK signed after an accepted seller cancellation
made replay fail with TERMINAL_STATE; the device's saved funding had no
positive refused-lock state to drive the existing recovery flow.

After: replay retains CANCELLED and records the exact refused signed LOCK,
without committing its hash or shares to escrow. Recovery uses the existing
saved-note hash match, federation check and measured wallet-credit path. The
shared recovery card describes refusal without claiming every refusal is a
lapsed seat. The existing needs-you signal makes the action reachable.

The exception requires a seated lawful locker, a strictly earlier accepted
initiator CANCEL, a present LOCK predecessor, no accepted LOCK, and ecash.
Unknown history, same-second races, wrong authors, cancellation after custody,
and on-chain deposits remain strict. This changes replay only; live applyEvent
continues to refuse the late LOCK. No actual money was used during validation.

Review the custody boundary in particular: recording a rejected LOCK must
never authorize redemption of notes committed by another accepted LOCK.

## Rotation cold loading

The parser and reducer already enforce sealed membership, cycle terms and
arbiter-pool pinning. The new signed cold-load fixture found overlapping
commitment-cycle reads being mistaken for recursive context resolution.

Concurrent readers now share an in-progress commitment-round read once its
round-1 anchor is known. Actual recursion remains refused. A share-v2 under
round 1 does not resolve rotation context, and child discovery checks the
signed public CREATE payload's parent before following a parent tag. These
controls prevent recursive malicious children from turning the shared read
into a dependency cycle.

The fresh-device fixture fetches the anchor and signed commitment shares from
mock relays through the real signature-verification/parser/replay path. It
rejects a backdated outsider CREATE, a member's altered arbiter pool, a forged
parent tag and an invalid share-v2 child. Among valid members, signed timestamp
then event id choose the root independently of relay delivery order. Missing
cycle evidence stays refused.

This fixture covers the first collection round. It is not proof of a complete
fresh-device multi-round cycle, physical notification delivery or fleet
compatibility; the v6.5 device and reader gates remain open.

## Release sequence

1. Integrate the reviewed step 1 after reconciling the existing unrelated work
   on main. Pixel acceptance must cover conflicting-listings copy, a shared
   creator-carrying link and notification opening.
2. Deploy the creator-binding release, then observe it for at least seven days.
3. Independently review these new follow-ups and step 2 before its separate
   release. Do not infer acceptance from local green tests.
4. Keep live circle writers disabled until every readiness gate has evidence.
