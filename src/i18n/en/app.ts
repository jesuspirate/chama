// i18n namespace "app" — App.tsx shell (toasts, banners, fed-switch modal,
// switching overlay, coach tour, login splash) + decisions.ts user-visible
// labels (vote-prompt waiting copy, backup-arbiter countdown, community-name
// fallbacks). Filled by the Session A extraction sweep.
//
// NOT extracted (load-bearing, byte-exact — see the sweep notes):
//   • LN invoice descriptions ("Pay for Item" / "Fund Loan" / "Lock Sats" /
//     "Fund Escrow", "Chama claim payout") — money-ledger metadata.
//   • Internal error-return fields ("Aborted", "Mid-funding", …) and
//     kind/reason codes — compared by consumers, never rendered directly.
export const app: Record<string, string> = {
  "app.draftOrderCancelled": "Draft order cancelled. No sats moved.",
  "app.resumingDraftOrder": "Resuming your existing order…",
  "app.couldntCancelDraftOrder": "Couldn't cancel this draft order.",
  "app.anotherFundingInProgress":
    "Another funding operation is in progress. Complete it first.",
  "app.arbiterNoActionNeeded": "Buyer and seller agree; no arbiter action needed",
  "app.arbiterWaitingBothVotes":
    "Waiting for buyer and seller; arbiter only acts on a dispute",
  "app.archivedIncomplete":
    "This trade's history couldn't be rebuilt on this device, so the summary here is what's saved locally. It may rebuild later, or on another device that still holds the full chain.",
  "app.archivedNotOnRelay":
    "This trade's full history isn't on your Chama relay anymore — the summary here is what's saved on this device.",
  "app.archivedStillLoading":
    "Still fetching this trade's history — give it a moment and tap again.",
  "app.archivedUnreadable":
    "This trade's history can't be read with your current key — the summary here is what's saved on this device.",
  "app.askingNwcInvoice": "Asking your NWC wallet for an invoice…",
  "app.backHomeIn": "Back home in {name}.",
  "app.backupArbiterStepIn":
    "Dispute live — the assigned arbiter has the floor. As backup arbiter you can step in {countdown}.",
  "app.cartSaved": "Cart saved!",
  "app.claimFailed": "Claim failed",
  "app.claimInFlight": "⚡ Claim is in flight — your sats are on the way.",
  "app.claimStillPending":
    "Still pending on your Chama. Your sats will appear once settled — check back shortly.",
  "app.claimSubmittedWatching":
    "Claim submitted. Waiting for your Chama (up to 2 min)…",
  "app.claimedAfter": "arrived.",
  "app.claimedBefore": "Claimed!",
  "app.claimedRedeemed": "Claimed! Ecash redeemed to your Lightning wallet.",
  "app.claimingReconstructing": "Claiming… reconstructing ecash.",
  "app.coachBrowseBody":
    "Every trade your community has posted lives here. Tap a listing to see the deal and chat with the other side.",
  "app.coachBrowseTitle": "Browse the stores",
  "app.coachAssistedBody":
    "Not sure which trade to start? Tap ✦ and Chama will guide you to the right flow.",
  "app.coachAssistedTitle": "Start with Chama Assisted",
  "app.coachBrowsePreferencesBody":
    "My Chama and Cheapest are the defaults. Switch to All when you want to discover offers from other countries and communities.",
  "app.coachBrowsePreferencesTitle": "Choose what Browse shows",
  "app.coachCreateBody":
    "This ✎ button is always one tap away — swap cash for sats, pay a bill, or sell something.",
  "app.coachCreateTitle": "Start your own trade",
  "app.coachDashboardBody":
    "Your standing, stats, earnings, and ratings are coming here — the place that tracks how you're doing as you trade.",
  "app.coachDashboardTitle": "Your home base",
  "app.coachMeBody":
    "Your wallet, active trades, ratings, payout methods, and settings all live under Me.",
  "app.coachMeTitle": "Your space",
  "app.coachNext": "Next",
  "app.coachQuickTour": "Quick tour",
  "app.coachSkip": "Skip",
  "app.coachStepOf": "Step {step} of {total}",
  "app.confirmingOrder": "Confirming order...",
  "app.connectedSplash": "Connected!",
  "app.couldntDeleteListing": "Couldn't delete listing.",
  "app.couldntJoinChama": "Couldn't join your Chama. Try again?",
  // A refused runtime lease, not a network fault: this browser already has
  // the wallet open elsewhere (or a tab that never closed cleanly still
  // holds it). Naming the real cause is what stops the user hunting a
  // connection problem that was never there.
  "app.walletOpenInOtherTab": "Your wallet is open in another Chama tab.",
  "app.useWalletHere": "Use it here",
  "app.couldntLoadTrade": "Couldn't load trade {id}.",
  "app.couldntReconnect": "Couldn't reconnect. Try again?",
  "app.couldntStartOrder": "Couldn't start the order.",
  "app.couldntSwitchTo": "Couldn't switch to {label}. Try again.",
  "app.countdownHoursMinutes": "in ~{h}h {m}m",
  "app.countdownMinutes": "in ~{m}m",
  "app.countdownUnderMinute": "in under a minute",
  "app.createFailed": "Failed to create trade",
  "app.editComingSoon":
    "Edit will clone, cancel, and republish soon. Opening listing for now.",
  "app.enterPositiveAmount": "Enter a positive amount for a real Lightning escrow.",
  "app.fallbackAnotherCommunity": "another community",
  "app.fallbackListingCommunity": "the listing's community",
  "app.fallbackPreviousCommunity": "your previous community",
  "app.fallbackYourCommunity": "your community",
  "app.fedSwitchBodyAfter":
    "to pick up this trade where you left off — your sats are safe either way.",
  "app.fedSwitchBodyBefore":
    "Your wallet is on a different Chama right now. Switch to",
  "app.fedSwitchCta": "Switch to {flag} {name} →",
  "app.fedSwitchFailed":
    "Couldn't switch to {name}. If you have another live trade, finish that one first.",
  "app.fedSwitchPickedUp": "On {name} — trade picked up.",
  "app.fedSwitchTitle": "This trade lives in {flag} {name}",
  "app.fediNwcDisabledClaim":
    "Fedi claims directly into your Fedi wallet — NWC is disabled.",
  "app.fediNwcDisabledFund":
    "Fedi uses its built-in ecash flow here — NWC is disabled.",
  "app.foundTradesMany": "Found {count} trades from relays.",
  "app.foundTradesOne": "Found {count} trade from relays.",
  "app.fundingFailed": "Funding failed",
  "app.headerTagline": "Local money · Bitcoin rails",
  "app.invoiceExpired": "Invoice expired — no payment received.",
  "app.joinChamaFirst": "Join a Chama first — tap a community pill.",
  "app.joinFailed": "Failed to join",
  "app.joinFailedShort": "Join failed",
  "app.joined": "Joined!",
  "app.joinedAsRole": "Joined as {role}!",
  "app.joinedLabel": "Joined {label}!",
  "app.joiningAsRole": "Joining as {role}...",
  "app.joiningChama": "Joining Chama…",
  "app.keyScanned": "⚡ Key scanned — signing you in.",
  "app.listingDeleted": "Listing deleted.",
  // Shown once after a revoked friend-wallet token dropped this browser back
  // onto its own wallet. Must be explicit that the sats did NOT come with it.
  "app.remoteBridgeRevoked":
    "The Chama node this browser used no longer accepts it. You're back on your own wallet — any sats held on that node are still there. Ask whoever runs it for a new link.",
  "app.listingOtherChama":
    "That listing runs on another Chama — finish your live trade here first.",
  "app.loadFailed": "Failed to load",
  "app.loadingFromRelays": "Loading from relays...",
  "app.localChamaReset": "Local Chama reset.",
  "app.lockFinishRetrying":
    "Couldn't finish the lock yet — recovery keeps retrying automatically.",
  "app.lockFinished": "Lock finished — your sats are in escrow.",
  "app.lockNoLongerPossible":
    "This trade can no longer be locked — your sats are safe in your wallet.",
  "app.mintStalled":
    "Mint stalled. If sats need recovery, use Me or the Browse recovery prompt.",
  "app.noSatsMoveWhileSwitching": "no sats move while switching",
  "app.notNow": "Not now",
  "app.nwcWalletRefused": "NWC wallet refused",
  "app.onForTrade": "On {name} for this trade.",
  "app.onLabel": "On {label}.",
  "app.onMapReportSentMany":
    "You're on the map — request sent to {count} Chama arbiters.",
  "app.onMapReportSentOne":
    "You're on the map — request sent to {count} Chama arbiter.",
  "app.orderReady": "Order ready!",
  "app.payoutRecoverFromMe": "Payout failed. Your sats are safe — recover them from Me.",
  "app.payoutRetryClaim":
    "⚡ Payout couldn't be sent — your sats are safe. Tap Claim again to retry.",
  "app.payoutSafeInChama": "Payout couldn't be sent — your sats are safe in your Chama.",
  "app.payoutSent": "Payout sent!",
  "app.payoutSentConfirming":
    "Payout sent — confirming. Check your wallet; the trade finishes once it lands.",
  "app.periodReleased": "Period {n} released!",
  "app.phaseAwaitingPayment": "Waiting for payment…",
  "app.phaseClaiming": "Claiming…",
  "app.phaseCreatingInvoice": "Creating invoice…",
  "app.phaseFunding": "Funding…",
  "app.phaseInvoiceReady": "Invoice ready…",
  "app.phaseLocked": "Locked!",
  "app.phaseLocking": "Locking…",
  "app.phaseMintConfirming": "Confirming with federation…",
  "app.phaseMintConfirmingSlow": "Federation slow to confirm…",
  "app.phasePayingNwc": "Paying via NWC…",
  "app.phaseRecoveringShare": "Recovering your share…",
  "app.phaseSendingNwc": "Sending to NWC…",
  "app.phaseStillCreatingInvoice": "Still creating invoice…",
  "app.recoverAndSwitchSubtitle":
    "Send to your Lightning wallet, then switch to {label}.",
  "app.recoverAndSwitchTitle": "Recover & switch Chama",
  "app.recoverSatsTitle": "Recover sats",
  "app.recoveredToWallet": "Recovered to your wallet!",
  "app.refundedToast": "⚡ Refunded — your locked sats are back in your wallet.",
  "app.reinitFailed": "Re-init failed",
  "app.releaseFailed": "Release failed",
  "app.releasedToast": "⚡ Released — the sats just landed in your wallet.",
  "app.reloadingTrade": "Reloading trade…",
  "app.resetFailed": "Reset failed",
  "app.resettingLocalChama": "Resetting local Chama…",
  "app.returningTo": "Returning to {name}...",
  "app.satsLocked": "⚡ Sats locked in escrow — vote buttons are live.",
  "app.savingCart": "Saving cart...",
  "app.sendFailed": "Failed to send",
  "app.signerAuthenticated": "Signer authenticated via Nostr",
  "app.signerUriCopied": "Signer URI copied to clipboard.",
  "app.signingNip07": "Signing event with NIP-07...",
  "app.startingOrder": "Starting your order…",
  "app.strandedClaimBody":
    "⚠ This note IS the sats from your settled trade. Chama couldn't redeem it automatically — import it into Fedi or any Fedimint wallet on this federation, or save it somewhere safe NOW. Clearing browser data destroys the only copy.",
  "app.strandedClaimHeadline": "STRANDED CLAIM · BEARER NOTE",
  "app.strandedClaimUnresolvedBody":
    "⚠ This note was reported already-redeemed, but Chama couldn't confirm YOUR wallet was credited. Save it anyway, then check your balance — if the sats aren't there, this string is your evidence and recovery path.",
  "app.switchOverlayAfter": "…",
  "app.switchOverlayBefore": "Switching to",
  "app.switchingForTrade": "Switching to {name} for this trade...",
  "app.switchingTo": "Switching to {label}…",
  "app.switchingToDots": "Switching to {label}...",
  "app.tapDeleteAgain":
    "Tap Delete again to confirm — this cancels the listing and removes it from Browse.",
  "app.tradeForgotten": "Trade forgotten on this device — money stays in escrow.",
  "app.tradeLoaded": "Trade loaded!",
  "app.tradeNotFound": "Trade not found on relays",
  "app.tradeNotFoundYet": "Couldn't find trade {id} on relays yet.",
  "app.tradePublished": "Trade published! {escrowId}",
  "app.tradesUpToDate": "Your trades are up to date.",
  "app.unrecognizedQr": "Unrecognized QR code.",
  "app.voteAlreadyRecorded": "Vote already recorded for this trade.",
  "app.voteFailed": "Vote failed.",
  "app.votedOutcome": "Voted {outcome}!",
  "app.waitBillOwnerConfirm": "Waiting on the bill owner to confirm",
  "app.waitBuyerLoanArrived": "Waiting on buyer to confirm the loan arrived",
  "app.waitBuyerPaymentSent": "Waiting on buyer to confirm payment sent",
  "app.waitSellerConfirm": "Waiting on seller to confirm",
  "app.waitSellerDeliverFile": "Waiting on seller to deliver the file",
  "app.waitSellerDeliverService": "Waiting on seller to deliver the service",
  "app.waitSellerShip": "Waiting on seller to ship",
  "app.waitVolunteerPayBill": "Waiting on the volunteer to pay the bill",
  "app.walletDisconnectedReconnect":
    "Chama wallet disconnected. Tap Reconnect and try again.",
  "app.yourFederation": "your federation",
  "edit.title": "Edit your listing",
  "edit.description": "DESCRIPTION",
  "edit.priceSats": "PRICE (SATS)",
  "edit.priceFiat": "PRICE ({currency})",
  "edit.stock": "STOCK",
  "edit.save": "Save changes",
  "edit.saving": "Saving…",
  "edit.saved": "Listing updated.",
  "edit.savedOldRemains": "Updated. The old version may still show for a few hours until it lapses.",
  "edit.failed": "Couldn't save those changes.",
  "edit.badAmount": "Enter a price above zero.",
  "edit.buyerHolding": "A buyer is holding this offer right now, at the price they saw. Wait a few minutes for their hold to lapse, then edit.",
  "edit.blocked": "This can't be edited — only your own live, unfunded listings.",
  "edit.replacesNote": "Saving republishes your offer, so it gets a new listing ID and the old one is removed.",
};
