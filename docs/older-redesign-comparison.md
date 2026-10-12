# Older redesign comparison — 2026-10-06

The newer redesign-6422b worktree was preserved as-is on wip/redesign-6422b in commit 094f1a98 (170 files). The earlier snapshot 14a13f6a also remains on wip/redesign-6422.

Compared all 34 older changed files, including its staged additions, against the redesign-6422b snapshot. 8 files match byte for byte; 26 differ. A differing file is not itself lost work: most differences are later redesign revisions.

## Older behavior worth retaining as a review note

- The older LiveTradeSurface makes Collect itself a hold. The snapshot deliberately moves the final hold into the claim sheet outside Fedi and preserves a Collect hold inside Fedi. The old collecting-is-a-hold test therefore represents a superseded behavior, not an omitted fix.
- The older Button resets the hold on disabled changes and dims while busy. The snapshot replaces that with reset-on-new-action and reset-when-usable-again, keeping the completed hold visible while busy. Do not restore the older reset behavior during a merge.
- Refund and release hold handlers differ in spelling/wrapping but remain represented by the newer money-hold implementation and tests.

No separate guided matcher, escrow funding, payment data, or optimistic-vote fix was found in the older dirty patch. No unique older functional change was identified that should be copied into this fixes branch. After this comparison, Jet explicitly authorized removal when nothing unique remained. The old worktree and wip/redesign branch were removed. Its complete binary recovery patch is saved at /private/tmp/chama-old-redesign-before-removal.patch.

## Byte-identical files

- public/fonts/fonts.css
- src/escrow-engine/tests.ts
- src/i18n/en/common.ts
- src/i18n/es/common.ts
- src/i18n/fr/common.ts
- src/i18n/sw/common.ts
- src/ui/components/Badge.tsx
- src/ui/components/HomeHero.tsx

## Files with differences for the redesign owner to review

- .agents/skills/chama-bar/SKILL.md
- package.json
- src/i18n/en/browse.ts
- src/i18n/en/dash.ts
- src/i18n/es/browse.ts
- src/i18n/es/dash.ts
- src/i18n/fr/browse.ts
- src/i18n/fr/dash.ts
- src/i18n/sw/browse.ts
- src/i18n/sw/dash.ts
- src/ui/App.tsx
- src/ui/components/BottomNav.tsx
- src/ui/components/Button.tsx
- src/ui/components/CoachMarkTour.tsx
- src/ui/components/TradeCard.tsx
- src/ui/money-hold.tests.tsx
- src/ui/panels/AtomicFundingModal.tsx
- src/ui/panels/ChamaBar.tsx
- src/ui/panels/EcashExportModal.tsx
- src/ui/panels/RecoveryPayoutModal.tsx
- src/ui/redesign-foundation.tests.tsx
- src/ui/screens/BrowseView.tsx
- src/ui/screens/LiveTradeSurface.tsx
- src/ui/screens/TradeDetail.tsx
- src/ui/screens/tradedetail/PagerPills.tsx
- src/ui/theme.ts
