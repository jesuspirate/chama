# Trade-flow fixes — review notes, 2026-10-06

Implemented against the updated five-issue brief in `wip/trade-flow-fixes`, based on local `wip/6.4.22` (`bc0008e0`). The isolated checkout is `/Users/Jetty/.codex/worktrees/trade-flow-isolated/chama`. Jet authorized committing the fixes and these review notes on this branch for Claude’s review before merging toward 6.4.22. The branch has not been pushed.

## Result

1. Canvas availability and matching share community, federation, seller-seat and reservation checks. Untagged offers cannot be joined from the canvas and remain visible in Browse under All. My Chama uses the same community rule. A permanent legacy buyer seat remains reserved.
2. Funding options require committed buyer and seller seats and enough time to finish funding. A closed window shows an explanation. An already detected payment retains its recovery path. Post it again creates a new listing ID, carries no buyer or old seat deadline, and preserves listing terms and settlement routing. A new ranged Exchange join requires the buyer’s amount and selection.
3. A seller chooses a matching saved payment handle, saves a new one through canonical private storage, or explicitly chooses to send details in chat before locking. Funding preflight enforces that choice before new funding. Recovery and lock completion do not re-require it after sats have already been spent; legacy stash entries and since-deleted saved handles complete with the buyer’s existing chat fallback. The buyer sees agreed methods and the encrypted handle or chat fallback before the payment question. The existing encrypted LOCK handle channel and CREATE methods remain the wire data; no new public handle field is introduced.
4. A checked, just-signed vote appears immediately as a pending display preview. It cannot authorize another vote, a claim, recovery, or notifications. Positive relay acknowledgement commits the validated event locally without waiting for its echo; rejection or timeout restores committed state. Concurrent foreground and backfill publication of the same event share acknowledgement handling.
5. Bond Manage always shows announce again, post an additional bond, and reclaim. Disabled actions explain the current condition. Expired but unspent bonds stay in the current list. Claim requires a fresh chain tip and confirmed unspent outputs; failed reads do not fall back to cached funding. The unlock block is shown precisely instead of guessing a calendar date.

## Verification

- `npm run typecheck`: passed, including English/Spanish/French/Swahili translation coverage.
- `npm test`: full application suite passed; core escrow suite reported 4,230 passed and zero failed.
- `npm run build`: passed. Existing large-chunk warnings remain.
- After the final panel-placement and listing-routing refinements, the trade-flow regressions, guided matching, guided-offer truth, funding UI and Browse ordering checks passed again.
- `git diff --check`: passed.
- Browser fixture review at 390 × 844 covered light/dark rendering, the four languages, explicit chat choice, expired-bond visibility, all three Manage actions, and opening/closing the reclaim destination sheet. Temporary harness files were removed.

The new regression suite uses signed escrow events and controlled relay transport to check immediate preview, rejection, actual silence/timeout, acknowledgement without echo, and duplicate publication acknowledgement. It also checks matching/count parity, invalid funding seats, fresh repost/join windows, required amount, encrypted handle and chat fallback, and active/expiring/expired/reclaimed bond action states.

Jet’s specific bond was not inspected: its public address was not supplied. The conditions hiding the controls were reproduced with disposable fixtures. No live deposit, bond claim or payout was submitted during verification.

## Redesign merge notes

The latest redesign was preserved as-is in commit `094f1a98` on `wip/redesign-6422b`. The earlier `14a13f6a` snapshot remains on `wip/redesign-6422`. After comparison found no unique old functional work, Jet authorized removal of the old redesign checkout and branch; see [the comparison](older-redesign-comparison.md). The mode-only release-6419 checkout was removed, its release branch retained, and main was pushed at `e3f864f1`.

Merge the shared payment-choice and buyer-details behavior into the redesign’s layout, retaining its money hold interactions and styling. Keep the `paymentDetailsInChat` choice in private funding/recovery options and the pending vote marker out of committed claim decisions. The funding gate must retain recovery for payments already observed. Expect overlap in App, LiveTradeSurface, TradeDetail, AtomicFundingModal, BrowseView, bond UI, translations and package test registration.

Mutual cancel/eject and live-bond top-ups remain [proposals only](trade-flow-proposals.md). Jet confirmed that additional separate bonds should remain available now.

## Review follow-up to c14b6dbc

Moved `assertTradePaymentDetails` from shared `prepareLockContext` to `preflightLock` only. Structural escrow, seat/deadline, amount and federation checks remain in the shared context. A spent-stage stash without `paymentDetailsInChat`, including one referencing a deleted saved handle, now resumes through the actual bridge: reabsorb provably unpublished notes, re-spend, publish a signed LOCK, replay committed custody and clear the stash. The buyer receives agreed methods plus chat fallback. Regression coverage also proves new funding preflight still rejects missing or deleted details.
