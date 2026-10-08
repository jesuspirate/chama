# Money-path security review (2026-10-07)

Asked by Jet before any Stack feature builds on the wallet: can Chama's own
wallet be the "Main" balance, and can browser trades be labelled safe?

Out of scope by request: the ecash locking gap (the locker can still spend
locked bearer notes before reissue), Fedimint federation custody and clawback,
and the Fedimint escrow module Harsh is building to replace ecash-split locks.

Method: five read-only audits run in parallel (browser wallet storage, escrow
protocol, payouts, on-chain multisig, web and native surface), then each
finding below re-read against the code. Nothing was run against a live
federation. Line numbers are from `e3f864f`.

## Verdict

**Browser trades are not ready to be labelled safe.** One critical and six
high findings below are outside the known ecash gap. Four are fixed on this
branch; the rest need product decisions or protocol changes.

**The browser wallet should not be Stack's Main balance.** That is a design
fact, not only a bug list. `src/hooks/useEscrow.ts:3910-3920` says it plainly:
"Chama is an escrow client, not a balance wallet." Since v6.1 the browser
wallet's seed is generated inside its own OPFS file and backed up nowhere
(`sdk-adapter.ts:3648-3659`). The "identity phrase" in Settings is the Nostr
key and restores no funds. So a browser balance dies with the tab's storage:
Safari eviction after 7 idle days (persistence is only requested once the app
is installed or already used, `storage/persistent-storage.ts:81-95`), a
federation switch (deletes the file, see H3/H4), or a cleared site.

The native wallet (Android APK, desktop) is closer: its seed lives in the
bridge's own database, not browser storage. But until C1 below ships, any
website the user visits could drain or delete it.

Recommendation for Stack v1: keep Chama's wallet as a pass-through for trades.
Stacks should either be a ledger over the **native** wallet only, after C1
ships and the bridge seed has a user-visible backup, or point at an external
wallet the user already backs up (Fedi, or their own on-chain keys). Fedi is
still Fedimint custody, so it carries the same federation trust you excluded
here, but it removes Chama's browser storage, XSS and wipe paths from the
picture, which is the temptation you wanted to abstract away.

## Findings, ranked

Status: **Fixed** = on this branch. **Open** = needs work.

### Critical

**C1. Any website can drain or wipe the desktop and Android wallet.** Fixed.
The native bridge serves `127.0.0.1:8787` with no token
(`native/fedimint-bridge/src/main.rs:2349`, the shells start it without
`--auth-token`: `src-tauri/src/main.rs:214-221`,
`android/.../MainActivity.java:143-149`) and CORS `allow_origin(Any)`
(`main.rs:2392-2396`). Routes include `/spend-notes` (returns bearer notes),
`/pay`, `/onchain/withdraw` and `/reset` (deletes `client.db`, which holds the
seed, `main.rs:1115-1149`). A page running
`fetch("http://127.0.0.1:8787/spend-notes", …)` gets the notes. On Android any
other app can call the port directly. Fix: each shell generates a token,
passes it to the bridge by environment (the bridge already honours
`CHAMA_BRIDGE_AUTH_TOKEN`), and hands it only to its own WebView (Tauri init
script, Android `ChamaDevice.bridgeToken()`). The client only ever sends the
shell token to a loopback URL.

### High

**H1. A link can point the browser wallet at an attacker's server.** Fixed.
`?nativeFedimint=1&nativeFedimintUrl=https://evil` switched wallet mode and
URL with no prompt (`native-bridge-adapter.ts:531-575`). From then on funding
invoices were the attacker's and redeemed escrow notes were posted to
`evil/reissue-notes`. The `#bridge=` fragment was already neutralised
(`main.tsx:27-50`); the query parameters were not. Fix: the URL is read only
in dev builds.

**H2. A pasted payout invoice is paid without checking its amount.** Fixed.
`runClaimAndPayout` sent `opts.bolt11` straight to `payInvoice`
(`claim-and-payout.ts:1006`). Lightning-address and NWC invoices were checked
(`lnurl.ts:394-400`, `nwc.ts:472-479`); pasted and swap-provider invoices
were not. Fedimint pays from the whole balance, so an oversized invoice takes
other claims' sats. Fix: amountless invoices and invoices above the payout are
refused before anything is claimed or sent.

**H3. Switching community or resetting wipes a wallet whose balance could not
be read.** Fixed. `switchFederation` and `resetLocalWallet` only guarded when
the balance read succeeded (`useEscrow.ts:4679`, `:4510`). A wallet that failed
to open (another tab, busy storage) or whose read threw was deleted, and with
it the only copy of the browser seed. `switchFederation` also skipped the
funding/claim-in-progress check the startup path has. Fix: an unreadable
balance refuses without `force`, and a live funding or claim blocks the switch.

**H4. Any listing can silently move a buyer onto the seller's federation.**
Open, needs a product call. `resolveListingInvite` falls back to the listing's
own `mintUrl` when its federation is not curated (`ui/decisions.ts:1634-1648`),
and balances under 2,000 sats switch silently (`:1732-1734`). The seller can
run that federation and its gateway. This is not the excluded custody risk:
the app picks the federation for the user. Suggested fix: silent switches only
to curated federation ids; anything else gets an explicit "unknown federation"
screen. Related: switching deletes the old file, so balances under 2,000 sats
and in-flight receives are destroyed (`payments/lightning-fees.ts:54-64`).
Park old files per federation (as arbiter routes already do) instead of
deleting them.

**H5. A seller can seat their own arbiter on a listing with no pool.** Open.
`handleJoin` refuses an arbiter JOIN on an empty pool only when `community` is
set (`state-machine.ts:717-728`); `handleLock` checks the pool only when it is
non-empty (`:917`). The buyer's client then locks with the seller's second key
as arbiter (`escrow-bridge.ts:293`), giving the seller 2-of-3 right after
LOCK. No warning shows for an empty pool (`TradeDetail.tsx:5032`). This is the
non-locker stealing, so the Fedimint escrow module does not fix it. Fix: the
bridge refuses to lock without a verifiable pool, and the reducer refuses
empty-pool arbiter JOINs on new chains (gate by CREATE time so old chains
still replay).

**H6. The locker controls the trade deadline, and the victim's own client
then votes REFUND.** Open. For non-chama trades `expiresAt = p.lockedAt +
timeout` (`state-machine.ts:1176`) and `lockedAt` is not tied to the event time
(only chama shares check it, `:837`). A buyer backdates `lockedAt`; after the
fake deadline `maybeAutoRefundExpired` (`escrow-client.ts:4361-4431`) makes the
seller's client vote REFUND. Fix: require `lockedAt` within a small skew of the
LOCK's `created_at`, gated by CREATE time for replay compatibility.

**H7. On-chain: a dust deposit freezes a co-signed payout until the funder's
refund timelock.** Open. `verifySettlementPsbt` requires the PSBT to spend
every known escrow UTXO (`onchain-escrow-settle.ts:326`). After the locked
settlement choice, a funder who sends 330 sats to the escrow address makes the
winner's finalize fail, cannot be rebuilt (same destination returns the stale
PSBT, `useEscrow.ts:3276`, `:3462`) and disables the arbiter path
(`onchain-stalled.ts:14`). After 30 days the funder takes the refund leaf. Fix:
require only that inputs are known escrow UTXOs including the committed
funding outpoint.

### Medium

- **M1. Anyone can make a funded trade fail to load.** Any key can publish a
  VOTE or CANCEL tagged with the trade id; replay fails the whole chain on
  non-benign codes (`state-machine.ts:2084-2120`). Known in
  `docs/replay-hardening-brief.md`, step 2 not implemented.
- **M2. Anyone can flip a live trade to EXPIRED** with a future-dated event;
  the expiry flip runs before any author check (`state-machine.ts:1914-1930`),
  and EXPIRED relaxes arbiter ordering.
- **M3. Storefront child terms are buyer-written** and not checked against the
  parent listing (price, mint, arbiter pool) (`state-machine.ts:363-380`,
  `escrow-client.ts:3065-3086`).
- **M4. Payout journal clears on uncoded post-submit errors**
  (`claim-and-payout.ts:1053`; internal-payment errors at
  `sdk-adapter.ts:793-808` carry no code), allowing a second send.
- **M5. Fail-open stashes.** `pending-fundings.ts` swallows write errors after
  Fedi ecash was generated; `loadStash` and the payout journal read corrupt data
  as empty.
- **M6. On-chain fee rate is uncapped** (`fund-watcher.ts:208-215`), so one
  bad explorer answer can burn a settlement to fees. Bonds cap at 100 sat/vB;
  escrows should too.
- **M7. On-chain funding trusts the first explorer to answer, at 1
  confirmation** (`fund-watcher.ts:50-56`, `:102-104`).
- **M8. No Content-Security-Policy** anywhere (`index.html`,
  `tauri.conf.json`), `withGlobalTauri: true`, and the webview may spawn the
  bridge sidecar with any arguments (`src-tauri/capabilities/default.json`).
  No XSS sink was found today; this is the backstop for a bad dependency.
- **M9. Plaintext secrets.** The saved nsec is plaintext in `localStorage`
  and in Android Preferences (`storage/saved-nsec.ts:18-24`); NWC strings
  likewise (`nwc-connections.ts:135`); the bridge seed is unencrypted on disk.
- **M10. On-chain escrow keys derive from a seed backed up only through
  Nostr** (`onchain-escrow-funding.ts:73-85`). Prompt a 12-word backup before
  the first on-chain funding.

### Low

LNURL accepts `http:` and skips `description_hash` checks (`lnurl.ts:159`);
funding is confirmed by balance growth, not the invoice's own state
(`fund-and-lock.ts:323-360`); the on-chain payout path has no journal;
`?amber_type=get_public_key` overwrites the cached Amber key
(`signers.ts:347-362`); fiat rates come from an `@latest` CDN path
(`fiat-rates.ts:40`); unknown categories invert the payout recipient
(`recipients.ts:34-37`); exported notes auto-refund after 24 h without saying
so.

## Checked and sound

Event signatures are verified on every frame (`relay-manager.ts:465-479`).
Votes, resolves and claims take the role from the signer, and the payout
recipient comes only from participants fixed at LOCK (`recipients.ts:26-41`).
Shares are NIP-44 to one holder with no NIP-04 fallback. LOCK amounts must
match the agreed split. No HTML injection sink exists in `src/`; listing
links allow only http(s). Trade deep links only open a trade. The Lightning
address and NWC paths check invoice amount and expiry. The payout journal
writes an intent before sending and re-attaches to in-flight payments. On-chain
scripts use a NUMS key, keys come only from committed CREATE/JOIN, the deposit
address is recomputed locally, and PSBTs are checked for inputs, sighash, a
single output and the locked destination before signing.

## Must fix before Stack ships

1. C1 (fixed here) and H1-H3 (fixed here), released to every channel.
2. A decision on where Main lives. If it is Chama's native wallet: a
   user-visible seed backup for the bridge wallet, M8 and M9, and H4's
   park-don't-delete so no switch ever deletes a funded file.
3. H5 and H6 before browser trades are called safe, since the Fedimint escrow
   module does not cover them.
4. H7 and M6 before on-chain trades are called safe.
