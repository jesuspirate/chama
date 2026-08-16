// i18n namespace "claim" — payout/claim flow (ClaimPayoutModal,
// RecoveryPayoutModal, DestinationPicker + its pure logic,
// PayoutDestinationsPanel) and saved payment handles (SavedHandlesPanel,
// incl. the "Banks & apps" accordion).
//
// Before/After pairs wrap an inline <BitcoinAmount /> (or a styled span) that
// sits mid-sentence — translators translate BOTH halves as one sentence.
// Keys with {param} placeholders must keep the placeholders intact.
export const claim: Record<string, string> = {
  "claim.ecashMethod": "Ecash · no fees",
  "claim.ecashMethodBlurb": "Claim as a Fedi-ready bearer note. Chama keeps a recovery copy until you confirm the import.",
  "claim.ecashReadyHeadline": "CLAIM READY · IMPORT ECASH",
  "claim.ecashReadyBody": "Scan this with Fedi, then confirm only after Fedi shows the sats. Chama keeps this exact bearer note recoverable until you approve.",
  "claim.phaseExportingEcash": "Securing your ecash note…",
  "claim.yourFederation": "your federation",
  "claim.add": "Add",
  "claim.added": "Added",
  "claim.badgeCash": "cash",
  "claim.badgeComingSoon": "coming soon",
  "claim.badgeLive": "live",
  "claim.badgeLiveNow": "live now",
  "claim.badgeNative": "native",
  "claim.badgeNew": "new",
  "claim.badgeSoon": "soon",
  "claim.badgeTopPick": "top pick",
  "claim.banksAndApps": "Banks & apps",
  "claim.banksAndAppsBody":
    "Cards, PayPal, Zelle, bank transfer, UPI, Pix — mostly Western.",
  "claim.bestPathLn": "Best path. Send to a Lightning address, invoice, or NWC.",
  "claim.cashOutMpesa": "Cash out to M-Pesa",
  "claim.cashOutStrike": "Cash out · Strike",
  "claim.chapsmartBody":
    "Enter your M-Pesa number. Chama pays it straight from your claim and ChapSmart deposits TZS in seconds — no redirect, no pasting invoices.",
  "claim.chapsmartCardBlurb":
    "Cash out to M-Pesa with ChapSmart. Enter your phone — TZS lands in seconds.",
  "claim.chapsmartKicker": "M-PESA CLAIM · CHAPSMART",
  "claim.checkProvider": "Check {provider}",
  "claim.checkingChama": "Checking your Chama…",
  "claim.chooseWhere":
    "Choose where Chama sends the rebuilt ecash after your claim settles.",
  "claim.claimArrow": "CLAIM →",
  "claim.claimKicker": "CLAIM",
  "claim.claimOnchain": "Claim onchain",
  "claim.claimViaProviderInvoice": "Claim via {provider} invoice",
  "claim.claimYourSats": "Claim your sats",
  "claim.closeCheckLater": "Close & check later",
  "claim.closing": "Closing…",
  "claim.confirmCashReceive": "Confirm Cash receive",
  "claim.defaultBadge": "DEFAULT",
  "claim.defaultForMobileMoney": "Default for mobile money",
  "claim.delete": "Delete",
  "claim.edit": "Edit",
  "claim.errChapsmartAmountRange":
    "This amount is outside ChapSmart's M-Pesa limits. {message}",
  "claim.errChapsmartDns":
    "Couldn't reach ChapSmart (chapsmart.com). Check your connection and try again.",
  "claim.errChapsmartFallback": "Couldn't reach ChapSmart. Try again.",
  "claim.errChapsmartMalformed":
    "ChapSmart returned an unexpected response. Try again, or use Lightning.",
  "claim.errChapsmartServer":
    "ChapSmart's server is busy right now. Try again in a moment.",
  "claim.errChooseMethodAndId": "Choose a payment method and enter the payment ID",
  "claim.errChooseSavedOrEnter": "Choose a saved address or enter a destination",
  "claim.errConfirmCashReceive":
    "Confirm Strike is set to receive passive Lightning as Cash.",
  "claim.errClaimCouldNotStart":
    "Claim could not start. Reconnect your Chama and try again.",
  "claim.errDestinationMustBeText": "Destination must be text",
  "claim.errEnterDestination":
    "Enter a Lightning Address (you@wallet.app) or paste a BOLT11 invoice or NWC connection",
  "claim.errEnterPhone": "Enter a phone number",
  "claim.errEnterValidKenyanNumber":
    "Enter a valid Kenyan M-Pesa number, e.g. 0712 345 678.",
  "claim.errEnterValidTanzanianNumber":
    "Enter a valid Tanzanian Vodacom M-Pesa number, e.g. 0740 034 110.",
  "claim.errFederationUnreachable": "Federation still unreachable",
  "claim.errMpesaAddressInvalid":
    "That number didn't resolve to a valid M-Pesa cash-out address.",
  "claim.errNwcNoInvoice": "NWC wallet couldn't create a destination invoice",
  "claim.errNwcRefused": "NWC wallet refused the invoice request. {message}",
  "claim.errNwcRelayUnreachable": "Couldn't reach that NWC relay. {message}",
  "claim.errNwcUnexpected":
    "NWC wallet returned an unexpected response. {message}",
  "claim.errRawLnurl":
    "Raw LNURL isn't supported here. Use a Lightning Address, BOLT11 invoice, or NWC connection.",
  "claim.errResolveDestination": "Couldn't resolve destination",
  "claim.errSaveMethodFailed": "Failed to save payment method",
  "claim.errSavePhoneFailed": "Failed to save phone number",
  "claim.errTandoAmountRange":
    "This amount is outside Tando's M-Pesa limits. {message}",
  "claim.errTandoDns":
    "Couldn't reach Tando (bitcoin.co.ke). Check your connection and try again.",
  "claim.errTandoFallback": "Couldn't reach Tando. Try again.",
  "claim.errTandoMalformed":
    "Tando returned an unexpected response. Try again, or use Lightning.",
  "claim.errTandoServer": "Tando's server is busy right now. Try again in a moment.",
  "claim.errWalletServerUnhappy": "That wallet's server is unhappy. {message}",
  "claim.errWalletServerUnreachable":
    "Couldn't reach that wallet's server. {message}",
  "claim.errWalletUnexpected":
    "That wallet returned an unexpected response. {message}",
  "claim.errStrikeAmountRange":
    "This amount is outside Strike's receive limits. {message}",
  "claim.errStrikeDns":
    "Couldn't reach Strike (strike.me). Check your connection and try again.",
  "claim.errStrikeFallback": "Couldn't reach Strike. Try again.",
  "claim.errStrikeMalformed":
    "Strike returned an unexpected response. Try again, or use Lightning.",
  "claim.errStrikeParse":
    "That username didn't resolve to a valid Strike address.",
  "claim.errStrikeServer": "Strike's server is busy right now. Try again in a moment.",
  "claim.errEnterStrikeUsername": "Enter your Strike username, e.g. alice.",
  "claim.externalBlurbFallback":
    "Opens {provider} — cash out to {currency}, paste the invoice back.",
  "claim.externalLiveBodyAfter": ", then paste it back below.",
  "claim.externalLiveBodyBefore":
    "Opens {provider} in your browser — cash out to {currency} mobile money there, make an invoice up to",
  "claim.externalSoonBody":
    "{provider} lists this country as coming soon. Use Lightning or onchain for this claim today.",
  "claim.fastestNwcHeading": "⚡ FASTEST · CLAIM STRAIGHT TO SAVED NWC WALLET",
  "claim.feeReserveAfter": "stays available for Lightning fees.",
  "claim.feeReserveBefore": "About",
  "claim.insuranceBefore": "🛡",
  "claim.insuranceAfter": "stays behind for your arbiter’s insurance (0.25%).",
  "claim.ifCashReceiveOn": "if Cash receive is on",
  "claim.invoiceOnlyHint": "For invoice-only wallets or NWC make_invoice.",
  "claim.kenyanNumbersHint":
    "Kenyan mobile numbers look like 0712 345 678 or 254712345678.",
  "claim.lightningAddresses": "Lightning Addresses",
  "claim.lightningAddressesBody":
    "Saved Lightning Addresses for claims and recovery. These stay local to this browser and are never shown to a trade counterparty.",
  "claim.lnFast": "LN · FAST",
  "claim.longRunningEscape":
    "Taking longer than expected. Your claim is published, but wallet credit is not confirmed yet — close and check back, or let Chama keep checking in the background.",
  "claim.mask": "Mask",
  "claim.methodOnchainSlow": "ONCHAIN · SLOW",
  "claim.moreOptionsClosed": "▸ More options",
  "claim.moreOptionsOpen": "▾ More options",
  "claim.mpesaPhoneLabel": "M-PESA PHONE NUMBER",
  "claim.networkTags": "Network tags",
  "claim.noLightningAddresses":
    "No Lightning Addresses saved yet. Use Claim or Recover and choose remember.",
  "claim.noMatchYet": "No match yet. Try a country, app name, or \"bank\".",
  "claim.noSavedMethods":
    "No saved payment methods yet. Add a phone number or search for a payment app above.",
  "claim.noTagsYet": "No tags yet",
  "claim.nwcInvoiceBefore": "NWC invoice ·",
  "claim.openArrow": "OPEN →",
  "claim.onchainBlurb": "Paste a bitcoin address once. Fees are deducted from payout.",
  "claim.onchainClaimKicker": "ONCHAIN CLAIM",
  "claim.onchainSlowPath":
    "Slow path. Paste a fresh bitcoin address. Chama uses it only for this transaction and does not save it. Network and peg-out fees come out of the claimed amount.",
  "claim.oneTap": "one tap",
  "claim.openProviderSwap": "Open {provider} swap",
  "claim.optionalNetworkTags": "Optional network tags",
  "claim.orSendNewAddress": "OR SEND TO A NEW ADDRESS",
  "claim.pasteBolt11OrNwc": "PASTE BOLT11 INVOICE OR NWC",
  "claim.payInvoiceBefore": "Pay invoice ·",
  "claim.payingBefore": "Paying",
  "claim.paymentIdFallback": "Payment ID",
  "claim.paymentIdFor": "Payment ID for {rail}",
  "claim.paymentMethods": "Payment methods",
  "claim.paymentMethodsBody":
    "Save the ways people can pay you locally. Phone numbers stay private; public usernames can be opted into profile display one by one.",
  "claim.payoutConfirmingBody":
    "Your payout was sent and is confirming. Don't tap Claim again — check your destination wallet.",
  "claim.payoutFailedPlain": "{error}\n\nYour sats are safe in your Chama.",
  "claim.payoutFailedRetryClaim":
    "{error}\n\nYour sats are safe in your Chama. Close this and tap Claim again — the payout retries with a fresh invoice.",
  "claim.payoutFailedShowRecovery":
    "{error}\n\nYour sats are safe in your Chama. Tap Show recovery now to retry the payout only.",
  "claim.phaseClaiming": "Recovering your share…",
  "claim.phaseConfirming": "Confirming with the federation…",
  "claim.phaseConfirmingEcash":
    "Preparing exact ecash with the federation — no Lightning…",
  "claim.phasePayingOnchain": "Broadcasting onchain payout…",
  "claim.phasePayoutConfirming": "Confirming your payout…",
  "claim.phaseSendingMpesaChapsmart": "Sending to M-Pesa (ChapSmart)…",
  "claim.phaseSendingMpesaTando": "Sending to M-Pesa (Tando)…",
  "claim.phaseSendingProvider": "Sending to {provider}…",
  "claim.phaseSendingWallet": "Sending to your wallet…",
  "claim.phaseWorking": "Working…",
  "claim.phoneNumber": "Phone number",
  "claim.phoneProgressHint": "{country}: {expected} after +{code}",
  "claim.privacyPrivate": "Private",
  "claim.privacyPublicOptIn": "Public opt-in",
  "claim.privateBadge": "PRIVATE",
  "claim.providerClaimKicker": "{provider} CLAIM",
  "claim.publicBadge": "PUBLIC",
  "claim.reachingChapsmart": "Reaching ChapSmart…",
  "claim.reachingTando": "Reaching Tando…",
  "claim.recoveredToWallet": "Recovered to your wallet",
  "claim.recoveryConfirmingBody":
    "Your payout was sent and is confirming. Don't retry — check your destination wallet.",
  "claim.recoveryCouldntBeSent": "Recovery couldn't be sent",
  "claim.recoverySatsStillSafe":
    "Your sats are still in your Chama. Try again with a fresh invoice.",
  "claim.rememberNwcWallet": "Remember this NWC wallet",
  "claim.resolving": "Resolving…",
  "claim.reveal": "Reveal",
  "claim.safaricomKenya": "Safaricom M-Pesa, Kenya.",
  "claim.saveAndSendBefore": "Save & send ·",
  "claim.saveMethod": "Save method",
  "claim.savePhone": "Save phone",
  "claim.savedAddresses": "SAVED ADDRESSES",
  "claim.savedDestinations": "SAVED DESTINATIONS",
  "claim.savedMethods": "Saved methods",
  "claim.savedNwcWallets": "SAVED NWC WALLETS",
  "claim.savedStrike": "🇺🇸 SAVED STRIKE",
  "claim.searchBanksPlaceholder": "Search PayPal, UPI, Pix, bank transfer...",
  "claim.searchNetworks": "Search networks",
  "claim.searchNetworksForPhone": "Search networks for this phone",
  "claim.selectedCount": "{count} selected",
  "claim.sendOnceDontSave": "Send once — don't save",
  "claim.sendToAddressAfter": "to your Lightning address",
  "claim.sendToAddressBefore": "Send",
  "claim.sendToLightningAddress": "SEND TO LIGHTNING ADDRESS",
  "claim.sendToWalletAfter": "to your Lightning wallet",
  "claim.sendToWalletBefore": "Send",
  "claim.sendingToWalletCaps": "SENDING TO YOUR WALLET…",
  "claim.sentToMpesa": "Sent to M-Pesa",
  "claim.sentToProvider": "Sent to {provider}",
  "claim.sentToStrike": "Sent to Strike",
  "claim.sentToWallet": "Sent to your wallet",
  "claim.showRecoveryNow": "Show recovery now",
  "claim.strikeBodyAfter":
    ". Chama requests a fresh Strike invoice and pays it from this claim — no redirect, no invoice paste.",
  "claim.strikeBodyBefore": "Enter the name before",
  "claim.strikeCardBlurb":
    "Enter your Strike username — we add @strike.me and send.",
  "claim.strikeCashCheckbox":
    "Strike is set to receive passive Lightning payments as Cash.",
  "claim.strikeCashTitle": "Make it land as dollars",
  "claim.strikeSendsSats":
    "Chama sends sats; Strike applies the final conversion and any spread at receipt.",
  "claim.strikeUseDifferent": "Use a different Strike username.",
  "claim.strikeEstimate": "≈ {estimate} after Strike conversion, if Cash receive is on.",
  "claim.strikeHandleHint": "Use the Strike username only — we add @strike.me.",
  "claim.strikeKicker": "STRIKE · USD",
  "claim.strikeTitle": "Cash out through Strike",
  "claim.strikeUsernameLabel": "STRIKE USERNAME",
  "claim.strikeUsernameOnly": "Enter the username only — we add @strike.me.",
  "claim.submitSendBefore": "Send",
  "claim.phaseSendingStrike": "Sending to Strike (USD)…",
  "claim.reachingStrike": "Reaching Strike…",
  "claim.sendToStrike": "Send to Strike",
  "claim.tandoBody":
    "Enter your M-Pesa number. Chama pays it straight from your claim and Tando deposits KES in seconds — no redirect, no pasting invoices.",
  "claim.tandoCardBlurb":
    "Cash out to M-Pesa with Tando. Enter your phone — KES lands in seconds.",
  "claim.tandoKicker": "M-PESA CLAIM · TANDO",
  "claim.tanzanianNumbersHint":
    "Tanzanian Vodacom numbers look like 0740 034 110 or 255740034110.",
  "claim.railPlaceholderSpei": "CLABE / phone / bank alias",
  "claim.railPlaceholderBank": "Account number / IBAN",
  "claim.swapBlurbBanxaas": "Cash out to XOF mobile money via Banxaas.",
  "claim.tapToMask": "Tap to mask",
  "claim.tapToReveal": "Tap to reveal",
  "claim.titleClaimDidNotSettle": "Claim did not settle",
  "claim.titleCouldntReachChama": "Couldn't reach your Chama",
  "claim.titleCouldntRecoverShare": "Couldn't recover your share",
  "claim.titlePayoutCouldntBeSent": "Payout couldn't be sent",
  "claim.titlePayoutSentConfirming": "Payout sent — confirming",
  "claim.titleSatsStillArriving": "Your sats are still arriving",
  "claim.titleFederationClaimStuck": "This claim is stuck at the federation",
  "claim.pendingRecoverySummary":
    "Chama kept the original bearer note. Repeating the same claim will only resume the stalled operation. You can instead recover the saved note directly in Fedi.",
  "claim.openFediRecovery": "Open Fedi recovery copy",
  "claim.pendingRecoveryHeadline": "PENDING CLAIM · FEDI RECOVERY",
  "claim.pendingRecoveryBody":
    "This is the original escrow bearer note, preserved before the stalled federation reissue. Scan or paste it into Fedi. Keep it pending here until Fedi shows the sats, then explicitly clear Chama's copy.",
  "claim.tryAgain": "Try again",
  "claim.tryAmountBefore": "Try",
  "claim.vodacomTanzania": "Vodacom M-Pesa, Tanzania.",
  "claim.worksForWallets":
    "Works for M-Pesa, Wave, Airtel Money, Orange Money, mobile bank transfers, and most phone-based wallets.",
  "claim.youllReceiveMpesa": "You'll receive ≈ {estimate} to M-Pesa.",
  "claim.yourPaymentId": "Your payment ID",
};
