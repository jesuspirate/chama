# Extension actions — 6.4.22 J/K

Checked 2026-10-03 against the local 6.4.19-based worktree. Unreleased.

Sign-in previously reached wallet auto-init, bond seed recovery, earnings
receipt decryption/backfill, background trade-envelope reads, automatic listing
renewal/cancellation and external notification signing. Wallet initialization
could also ask the extension to republish an old seed. These were independent
sources of prompts beyond the public-key request.

NIP-07 sign-in now requests only getPublicKey, caches that identity, and starts
public relay reads. App wallet auto-init and background signer chores are
suppressed for interactive extension accounts. Explicit Wallet use, funding or
on-chain key use may open the seed. Open trade/Refresh carries permission per
load; another concurrent background load cannot borrow that permission.
Background reads can reuse successful cached decrypts, but cannot request a new
one. Decrypt refusal propagates through envelope/share helpers and stops the
operation; it never permits a replacement wallet or seed.

Seed candidates were already newest-first and stopped at the first usable
mnemonic. Extension lookup now ranks the verified local encrypted copy with
relay candidates. It makes no automatic decrypt retries and stops immediately
on permission refusal. Identifiable legacy NIP-04 seeds use their matching
format directly, rather than an extra prompt after a failed NIP-44 attempt.

Provider failures (including timeout and error objects) become translated
SignerApprovalError sentences. Raw provider errors are console-only. Send
message states that nothing was sent; Open trade offers retry/key sign-in.
Generic multi-step action failures say Chama stopped, without falsely claiming
that an earlier publication or money operation never happened. A 30-second
request timeout cannot cancel an extension's own pending dialog; a late result
does not resume the failed application operation.

## Protocol limit

The brief's literal one-request-per-complete-action guarantee is not possible
with standard NIP-07 and the existing encrypted escrow protocol. Its primitives
are separate RPCs. Sending a message encrypts to its recipients and then signs
an event. A first legacy wallet creation encrypts the seed and signs its backup;
opening a history can decrypt multiple distinct messages. Merging these into
one extension request would require a signer/session protocol change. Encryption
and custody are not weakened to meet a popup count. The implemented guarantee
is exactly one public-key RPC at sign-in, no background cryptographic prompts,
no automatic permission retries, cached successful reads and an immediate stop
on refusal. The extension's Always allow setting controls remaining prompts.

Automatic external alert DMs, presence renewal/duplicate cancellation,
premium paying/redeeming/probing, seed health republishing, on-chain LOCK
recovery signing, deferred pre-login community reports and bond/earnings recovery do not silently prompt extension
accounts. Local-key and Fedi accounts retain their existing automation.
Uncached live encrypted chat/events also wait for an explicit Open/Refresh;
public events and previously decrypted content continue to update. An unopened
extension wallet displays an unknown balance, rather than claiming zero.
Manual Renew, Open/Refresh, wallet/funding and bond recovery paths remain; the
release must not promise those suppressed automations for extension accounts.

## Verification

- signer-approval.tests.ts: public-key caching; background vs explicit/cached
  trade reads; newest seed short-circuit; refusal without old-candidate,
  legacy-decrypt or automatic retry; refused voting and reconstruction shares
  stop without another request; rejected real CREATE publishes and applies
  no state; refusal messages contain no raw provider text; explicit retry works.
- verify-first-circle-phones.mjs: actual useEscrow startup with an injected
  extension stub remains at one public-key call through 11 seconds of background
  startup, reached through the actual ConnectScreen extension pill. The chooser
  and returning-flow selection make zero requests. The chooser has no inputs;
  Back unmounts each separate flow. Returning is password-only, valid paste signs
  in automatically, and Enter reads manager-filled values without a React event.
  No paste submit button or alternative grouping is rendered. The named extension
  pill is absent without a provider, raw refusal text is absent, and retry works.
  Its label is checked in all four languages.
- Those are automated Chromium/stub checks. Physical nos2x/Alby approvals,
  Always allow, Safari password-manager prompts and Pixel autofill still need
  device acceptance. No real funded identity was used or signed out for these
  checks.
