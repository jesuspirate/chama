# Custody surfaces and contextual explanations

The wallet header, generic fund modal, atomic funding/lock modal, live lock
confirmation and direct Bitcoin escrow panel now name the holder. Help & FAQ
has a “Who holds my money?” table in English, Spanish, French and Kiswahili.
The old FAQ assertions that balances are always zero between trades, and that
federation-backed money cannot be affected by any company, were corrected.

A small circled question mark has a translated “What's this?” accessible name.
The deeper explanation uses the shared Community-style floating overlay,
closes on outside tap, Escape, Tab or browser Back, and respects reduced motion. Its small visual has a 44px touch target. Holder,
guardian count, duration and earned warnings stay visible. Reading help starts
no signing, wallet initialization, payment or clipboard action.

## Source of each fact

- Wallet custody uses the joined wallet's actual resolved invite, not an
  unverified setup default. Before the wallet is joined its holder and balance
  remain unknown. A federation name comes from the configured preset, public
  federation metadata or its short ID; guardian count comes from configuration.
- All AtomicFundingModal rails acquire federation-issued ecash. Its Bitcoin
  deposit is a deposit **to the federation**, not a direct Bitcoin escrow.
  Displayed deposit names now follow the target trade, including when the
  currently open wallet belongs to another federation.
- Pre-lock trade duration uses the committed trade timeout. The listing expiry
  is not relabelled as the trade's funding deadline. Locked trades and circle
  shares use their committed expiry. The text distinguishes settlement from
  the dispute deadline; that deadline is not an automatic ecash refund.
- Direct Bitcoin escrow shows the refund block from committed funding/LOCK
  terms. If those terms are unavailable it says so, without inventing a date.
- Circle funding keeps one holder line. Its existing public configuration
  warnings still use the circle creator's key and fixed round deadline.

| Where sats are | Holder | Duration |
|---|---|---|
| Bitcoin in a user's own wallet | Under that user's key | Until sent |
| Direct Bitcoin escrow | The trade's Bitcoin script | Until settlement or the funder's refund block |
| Lightning in flight | Payment route | Usually seconds; failures/pending payments require checking |
| Ecash in a wallet, trade or circle | Named federation's guardians | While notes are held; circles may span a whole cycle |
| Arbiter bond | Bond's Bitcoin script | Its stated term and refund path |

## Checks

`src/ui/custody-liveness.tests.tsx` covers unknown values, deadline selection,
refund-height rendering and failed liveness evidence. The existing federation
inspection suite covers guardian/configuration and earned-warning conditions.
`scripts/verify-custody-liveness.mjs` exercises collapsed/expanded help, 44px
controls, Escape, phone-width overflow, the FAQ table, unknown guardian counts,
long holds and warnings visible while help is closed. It asserts that reading
fund/lock explanations invokes no money callback and that circle funding does
not duplicate the holder line. Wallet and FAQ screenshots cover four languages
in both themes in `outputs/first-circle-phones/`.

`scripts/verify-help-disclosures.mjs` checks matching Wallet and Community
controls at 320px, 390px and desktop width, both themes and all four languages.
It also covers repeated opens, keyboard focus and dismissal, draft retention,
viewport edges and clipping, reduced motion, nested funding/settings sheets,
back navigation and no payment or community-selection callback from reading.

These are UI and public-read changes. No wallet, custody, lock, claim or refund
protocol was changed, and no release was published.
