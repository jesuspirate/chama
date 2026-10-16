# iOS Safari federation join investigation

Date: 2026-10-03. Baseline: `8834e1df`, Chama 6.4.19.

## Status and evidence gate

Reported initially: locking a circle share fails in iPhone Safari with “Fedimint SDK did not join the federation”; Chrome on that iPhone succeeds. Jet now reports a **fresh-identity Safari run succeeding end to end**. The supplied excerpt has been saved verbatim as [ios-safari-join-console.txt](ios-safari-join-console.txt); the named file was absent from this checkout before this update.

The excerpt independently shows a 50-sat invoice being created and entering `waiting_for_payment`, after the Iroh relay reports “The network connection was lost”. It also contains Nostr relay disconnects. It does **not** contain the failed join's `Error joining federation` exception, `open_client` result, settlement, or completed LOCK. End-to-end success is Jet's report; the narrower invoice-stage observation comes from the pasted console.

Prioritize identity/browser-local wallet and session state. The successful Safari run argues against a blanket Safari incompatibility, and the WebSocket warnings in a successful run do not establish a fatal TLS/Private Relay problem. It does not yet identify the bad state or justify replacing a wallet file. The failing identity's SDK exception, exact `mintUrl`, iOS version and Private Relay setting remain unconfirmed.

This change instruments errors and ends failed funding UI waits. It does not change wallet selection, open/join decisions, recovery permission, filename rotation, deletion, funding, or LOCK publication. The user's gate remains: obtain the device console line before changing money-path behavior. No release/deployment was performed for this investigation.

## 1. Preserve the SDK error

Installed SDK: `@fedimint/core` and `@fedimint/transport-web` version `0.0.0-canary-c65cc1396f26b1b6593c3fae6ac0e820d96a4a10`.

The installed source confirms:

- `FedimintWallet.joinFederation()` catches the `join_federation` RPC rejection, logs `Error joining federation`, and returns `false`.
- `TransportClient` takes its logger from `transport.logger`. `WalletDirector` constructs that client. There is no logger constructor-options argument in this pinned version.
- The SDK logger defaults to `none`. Installing a capturing sink alone is insufficient: `director.setLogLevel("error")` is also necessary. Debug-level logging is deliberately not enabled because RPC payloads can contain wallet secrets.

`createRealWallet` now installs the sink **before** constructing each director, including its existing same-file retry and recovery construction paths. The capture belongs to that wallet instance and resets before each join. Both ordinary and already-authorized forced-recovery joins retain the hidden SDK detail when `false` is returned. Rejections thrown outside the SDK catch/logger (notably its already-open guard) are also preserved. The existing forced-recovery failure handler retains its journal and rollback behavior.

The same error message propagates through `initFedimint` to the existing toast callers and circle action error surface, rather than being replaced by the generic SDK message. It is also retained in the bounded, user-scoped `chama_funding_diagnostics_v1` ring as `fedimint_join_failed` (and in Android's existing funding diagnostic log when applicable). There is no separate browser crash-reporting service in this checkout; this persisted ring is the crash breadcrumb. Storage failure does not block error reporting.

Additional state-specific breadcrumbs now record `open_client` start/result/failure, the sanitized original open error, `isOpen()` at join dispatch, forced-recovery flag, per-instance join-attempt number, and successful join. On an already-open wallet, `fedimint_wallet_route` records the requested/actual registered federation IDs and match/mismatch/unregistered-invite comparison. These observations do not change the decision or swallow an open error. The next failed-identity capture can therefore distinguish an empty database from an already-open wallet and from a retry that never reopened it.

Only bounded error fields are retained; arbitrary SDK objects, configs, and wallet state are not serialized. Known mnemonic text, recognizable secret/token encodings, long hex strings, URL credentials, and sensitive URL query parameters are redacted. Console output uses the same sanitizer.

Funding UI changes:

- A funding action waiting for initialization now stops waiting when joining has failed, preserving the join error instead of waiting out the readiness timeout and substituting “wallet not ready”.
- `AtomicFundingModal` accepts the returned terminal phase even if initialization failed before a phase callback. A rejected action already enters its existing error handler. Both paths end “Generating invoice…”.
- No invoice or automatic retry is created as a result of an error. Error display remains local to the existing funding surface, following `.agents/skills/chama-bar/SKILL.md`.

## 2. Existing database: open versus join

Circle path: `CircleSurface.onLock` in `src/ui/App.tsx` computes the target from the circle's `mintUrl`/community using `decideListingTapEffect`. When that existing policy requires initialization, it calls `actions.initFedimint(targetInvite)`; a route switch follows the existing `switchFederation` path. It then probes readiness, creates the share, and opens `AtomicFundingModal` → `actions.fundAndLock`.

Within initialization, `FedimintClient.init()` calls the adapter's `open()`, which calls the SDK's `open_client`. The file's existence alone is not the join criterion: an OPFS database can contain a mnemonic but no federation client. `FedimintClient.joinFederation()` then examines `wallet.isOpen()` and the actual federation ID.

| Stored client state | Current behavior, pinned by regression test |
| --- | --- |
| Existing client, matching registered federation invite | `open()` once, reuse the open client, no `join_federation` |
| Empty/uninitialized client | `open()` reports the recognized “Client database not initialized” condition; `join_federation` once |
| Existing client, different registered federation invite | `open()` once, throw `FED_JOIN_MISMATCH`, no join, no switch/delete/reset |
| Unexpected open/storage failure | Propagate the error; no join |

The mismatch text now begins “This browser's wallet belongs to a different federation…” and retains requested/actual IDs. No guard condition changed.

**Important existing limitation:** `expectedFederationIdForInvite()` currently looks up Chama's registered invite constants. It does **not** decode arbitrary custom invites. Consequently the table's ID comparison is proven for registered routes, not every possible custom `mintUrl`. On the reopened-wallet path an unregistered invite can bypass that ID assertion; a later same-session differing invite is separately refused. Do not claim all three states are universally enforced. Extending the guard to parsed custom invites is deferred by the device-evidence gate.

A retry-specific candidate remains: `initFedimint` retains an in-memory `FedimintClient` after a join failure, and `isInitialized()` means the wallet object exists. A subsequent attempt can reuse that object and call join again without another open. If the earlier failed SDK RPC left persisted client state but did not mark the JS facade open, the following join could encounter existing database state. That conditional is not established by this trace; no automatic reopen/join retry, wipe, or reset was added. The open-result and attempt-number breadcrumbs are intended to prove or reject it on the affected identity.

A stale but readable wallet bound to a different registered federation should therefore produce `FED_JOIN_MISMATCH`, not the generic SDK false-return message. A file that appears uninitialized, an unregistered invite, a failed RPC, or another initialization state remains possible. This narrows the investigation; it does not identify Safari's cause.

## 3. Read-only pre-join diagnostics

Immediately before an actual browser join, the adapter calls the public `WalletDirector.parseInviteCode()` and `previewFederation()` APIs (`parse_invite_code` and `preview_federation`). They inspect/fetch configuration; no seed installation, join, recovery, or spend is added by the diagnostic helper.

The entire diagnostic probe has a five-second budget. It records the parse/fetch stage and invite endpoint. A fetch error is reported as “Could not fetch the federation configuration via <endpoint>: <underlying error>” alongside the SDK join error. Parse failures are identified separately. It does not claim that every preview failure is a TLS failure, or that a successful preview proves every guardian is healthy.

A preview failure/timeout does **not** block, retry, or replace the original join. The SDK has no cancellation API for this probe, so an in-flight read may finish later; a parse that finishes after the deadline will not start a new preview. This is observation, not a new money-path admission rule.

### Live endpoint inventory — default federation only, not yet the reported circle

The pasted Safari trace uses the same relay host as the inventory below, but does not give the circle's exact federation ID. The earlier read-only network check used the repository default `BLF_FEDERATION_INVITE` (Bitcoin Life Federation), federation ID:

`888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e`.

The returned configuration labels the federation `Bitcrazy`. Its four guardian endpoints are Iroh identities, **not** DNS hosts with individual public WebPKI TLS certificates:

| Peer | Config name | Endpoint |
| --- | --- | --- |
| 0 | Bitcrazy | `iroh://d73fffd06a88ff385b0eec582cd7dd51c7f4aab7637c9e75ae309a068179ac25` |
| 1 | e8slucfwunu0sdz8 | `iroh://3ad179523cbabcb0316bc9e5762f035b7bab7b3865ae7644f7f66248a93bad4b` |
| 2 | hkg2ez00olojdeca | `iroh://2645ce04e1c548d6d652a637244951fb031f99dc2df93d595370ecca29c843fe` |
| 3 | pgghlyxndvjcvpot | `iroh://3e269484579a205cbd17e0585e6878ca71e412f5a02512496dbc8db8b736773a` |

Direct guardian host/port/public TLS chain: not advertised in these `iroh://` URLs. The isolated browser fetched discovery records over HTTPS and opened the relay WebSocket below. All four fetched Pkarr records contained the same relay advertisement (the separate inventory reader extracts text, not an independent signature-verification result).

| Browser-facing service | Host as observed | Port | TLS check from this Mac |
| --- | --- | --- | --- |
| Guardian discovery | `dns.iroh.link` | 443 | TLS 1.3; Node trust/hostname validation succeeded |
| Relay `/relay` WebSocket | `use1-1.relay.elsirion.fedimint.iroh.link.` | 443 | TLS 1.3; Node trust/hostname validation succeeded, including the trailing-dot hostname |

At `2026-10-03T17:59:14Z`, both inspected chains built as:

`leaf → Let's Encrypt YE1 → ISRG Root YE → ISRG Root X2 → ISRG Root X1`.

This is the chain exposed by Node's peer-certificate API, including its trust anchor, not a claim that the server transmitted every certificate.

- Discovery leaf: DNS SAN `dns.iroh.link`; 256-bit key; serverAuth EKU; valid 2026-09-12 through 2026-12-11; SHA-256 fingerprint `45:19:E7:EE:53:CA:99:FF:C6:9B:3C:13:0E:75:C5:CA:34:07:AD:E2:D0:1B:1D:82:F5:38:E6:61:06:4A:34:A4`.
- Relay leaf: DNS SAN `use1-1.relay.elsirion.fedimint.iroh.link`; 256-bit key; serverAuth EKU; valid 2026-08-25 through 2026-11-23; SHA-256 fingerprint `D0:BD:53:9F:CB:9E:C1:C7:33:75:C1:32:8B:D2:EC:5B:ED:E8:92:40:A7:70:E7:5F:F2:24:04:16:20:F3:FF:71`.

The preview succeeded in a disposable headless Brave profile with a fresh diagnostic-only OPFS file. It never called `setMnemonic`, `generateMnemonic`, `joinFederation`, or a money operation. The user's browser storage was not accessed. Raw local results: `outputs/ios-safari-join/blf-preview.json`, `pkarr.json`, `tls.json` (ignored build/test artifacts).

### Private Relay / strict TLS conclusions

**No endpoint is proven to fail through Private Relay or iPhone WebKit.** Node and desktop Chromium success do not certify Safari, its trust store, its network path, or the failing circle's federation.

Apple documents that Private Relay covers Safari browsing, DNS, and insecure HTTP app traffic. Therefore using the same WebKit engine does not establish the same network path for Safari and Chrome. Apple also warns that IP filtering/rate limits may affect Private Relay users. See [Apple's server/network guidance](https://developer.apple.com/icloud/prepare-your-network-for-icloud-private-relay/).

The observed relay uses secure WebSockets on TCP 443. Apple's reference to QUIC/UDP 443 describes Private Relay connectivity; it is not evidence that a destination guardian must expose QUIC or that this relay is incompatible. Iroh describes relay connections as HTTPS upgraded to WebSocket, tunneling encrypted peer traffic: [Iroh transport description](https://www.iroh.computer/blog/iroh-on-QUIC-multipath).

Apple's published TLS requirements include suitable keys/signatures, DNS SANs, and serverAuth EKU; invalid chains, hostname mismatches, or untrusted roots can cause failure. The observed leaf names, key sizes, EKUs and validity windows do not identify such a failure. The relay's trailing-dot spelling and newer intermediate chain are worth recording for comparison with the actual Safari Network error, **not reasons to rewrite the URL or weaken certificate validation**. See [Apple certificate requirements](https://support.apple.com/en-us/103769) and [certificate lifetime policy](https://support.apple.com/en-us/102028).

A controlled follow-up can compare the same Safari origin/account/circle with Private Relay enabled and with Safari's per-site “Show IP Address” option, retaining the wallet file throughout. A change in result is evidence about that network path, not permission to reset the wallet. [Apple's per-site procedure](https://support.apple.com/en-us/102022).

## 4. iOS invoice handoff

On iPhone/iPad, including iPad desktop browsing and Chrome on iOS, the invoice action now renders an actual `<a href="lightning:…">Open in wallet</a>`. It requires neither Web Share support nor an asynchronous click handler. It never invokes `navigator.share` for this Lightning action.

The invoice's Copy control remains visible and explicitly labeled “Copy”; it copies the raw invoice. If a caller supplied only QR data, the card derives the raw-invoice Copy fallback from it. No timer guesses whether a wallet app opened, no automatic copy occurs on Open, and the UI does not claim a handoff succeeded. Desktop sharing, ecash sharing and Android's native wallet handoff retain their existing behavior. EN/ES/FR/SW labels were added.

The browser test intercepts the anchor to avoid opening a real app. Actual iPhone handler selection still needs an installed-wallet tap test; Chromium emulation cannot prove that external handoff.

## Verification and remaining device evidence

- `npm run typecheck`: passed.
- `npm test`: passed (full repository suite).
- `npm run build`: passed (existing bundle-size warnings).
- `node --import tsx src/fedimint/join-diagnostics.tests.ts`: passed (including preserved open errors and SDK already-open throws). Exercises the installed SDK's actual logger/false-return path through a fake transport, retry isolation, structured/string exceptions, redaction, preview success/failure/timeout, the three wallet states plus unreadable storage, and termination of the funding readiness wait.
- `CHAMA_PREVIEW=http://127.0.0.1:3211 node scripts/verify-join-error.mjs`: passed at 390 × 844. Both a thrown join error and a returned failure without a phase callback remove the invoice spinner, retain SDK detail, and display no invoice QR.

- `node --import tsx src/payments/ios-wallet-link.tests.tsx`: passed for iPhone Safari/Chrome, iPad desktop mode, no Web Share API, and visible raw-invoice Copy fallback.
- `CHAMA_PREVIEW=http://127.0.0.1:3211 node scripts/verify-ios-wallet-link.mjs`: passed in a disposable Chromium browser with an iPhone user agent/touch viewport. Anchor activation carries the expected `lightning:` URI; no share request or automatic clipboard write occurs; explicit Copy writes the raw invoice; no horizontal overflow at 390px.

Still needed before a causal money-path fix:

1. On the previously failing identity, identify the circle/federation, Safari origin, iOS version, and Private Relay setting. Repeat the endpoint inventory if this is not BLF.
2. Run the diagnostic build against the **same origin and existing Safari wallet**, then reproduce once. A different origin or fresh browser profile cannot test the stale-file hypothesis. This patch is local and has not been deployed to `getchama.app`.
3. Capture `[ERROR] Error joining federation …`, the preceding open-client/storage lines, and any Safari Network error for discovery/relay connections. Do not send seeds, ecash, or a raw storage dump.
4. If the error remains unclear, extract only entries with `issue` equal to `fedimint_wallet_lifecycle` / `fedimint_wallet_route` / `fedimint_join_preview` / `fedimint_join_failed` from the active account's `chama_funding_diagnostics_v1` storage key. Record whether the error is parse/preview/network, existing-client, recovery, or storage related before choosing a fix.

Jet's fresh-identity Safari success is recorded above. These desktop/unit checks do not establish the failed identity's root cause or verify an iPhone wallet-app handoff.

## Brief 6.4.22: preserve the failing Safari state

The brief suggested deleting Safari Website Data as a retry step. **Do not do
that while wallet custody is unknown.** It can erase a device-local Fedimint
wallet, including bearer ecash; an nsec restores identity, not those notes.
The fresh-identity success does not establish that the old wallet is disposable.
Keep the affected Safari session and website data intact. Deploy the diagnostic
build to the same origin, reopen the same account/circle, and capture the
sanitized join/open error before choosing a repair. Chapsmart's instrumented
retry has not been received; no retry success or root cause is claimed here.
No wallet reset, rotation, federation switch, or new join retry policy was added
for this brief.

## Iroh fallback finding (2026-10-03)

The installed npm canary is `c65cc1396f26b1b6593c3fae6ac0e820d96a4a10`.
Its [flake.lock](https://github.com/fedimint/fedimint-sdk/blob/c65cc1396f26b1b6593c3fae6ac0e820d96a4a10/flake.lock)
pins browser WASM to Fedimint `382afc209c80e5445c65ccfabd37edf282669291`.
Read the browser pin, rather than assuming the separate native Cargo.lock
applies to WASM.

At that revision:

- [`InviteCode::peers()`](https://github.com/fedimint/fedimint/blob/382afc209c80e5445c65ccfabd37edf282669291/fedimint-core/src/invite_code.rs)
  collects invite API entries into `BTreeMap<PeerId, SafeUrl>`: **one URL per
  guardian**, not a primary/fallback list. Multiple entries for the same peer
  collapse into a single map entry.
- [`FederationApi`](https://github.com/fedimint/fedimint/blob/382afc209c80e5445c65ccfabd37edf282669291/fedimint-api-client/src/api/mod.rs)
  likewise stores one URL per peer and obtains that URL's pooled connection.
- [`ConnectorRegistry::connect_guardian`](https://github.com/fedimint/fedimint/blob/382afc209c80e5445c65ccfabd37edf282669291/fedimint-connectors/src/lib.rs)
  selects the connector by the chosen URL's scheme. An explicit configured
  connection override can replace a URL; connection failure does not itself
  select a second `wss://` URL for that guardian.

Therefore **automatic iroh → guardian-WebSocket fallback is not established
and should not be promised**. Different guardians can advertise different
schemes, and a request might succeed through another guardian, but that is
not transport fallback for an unreachable peer. The observed BLF inventory
above advertises iroh URLs and depends on the shared relay host. Its successful
fresh Safari run does not prove behavior during a relay outage.

The Advanced capability probe now displays and copies a localized connectivity
note naming `*.relay.elsirion.fedimint.iroh.link`, the observed
`use1-1.relay.elsirion.fedimint.iroh.link`, secure WebSockets on port 443, and this
fallback limitation. No transport or money-routing policy was changed.
