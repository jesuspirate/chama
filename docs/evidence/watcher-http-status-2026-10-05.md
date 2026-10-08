# Watcher provider-status receipts

Requested by Jet for Row 3's cold-listing regression. Deployed October 5,
2026 at 21:47:24 EDT (October 6, 01:47:24 UTC) to the existing
`chama-webpush-watcher.service` on `getchama.app`.

Ordinary wake receipts now read:

```text
<UTC> wake <opaque tag prefix> <transport> sent <elapsed>ms http=<status>
<UTC> wake <opaque tag prefix> <transport> failed <elapsed>ms http=<status>
```

`http=unknown` means no valid numeric HTTP response status was available, such
as a network failure or timeout. Accepted HTTP responses prove only provider
acceptance. They do not prove that Android received or displayed a notification.
FCM receipts preserve the provider's actual HTTP status; its existing internal
410 dead-token pruning signal is unchanged and can differ from a raw 404.
OAuth rejection statuses are also retained. No provider body, endpoint capability,
token, authentication key, trade id or message is added to receipts.

## Verification and deployment

- Syntax checks passed for `watcher.mjs` and `delivery.mjs`.
- `wake-policy.tests.mjs`: timestamp/community policy, numeric-status validation,
  mocked FCM HTTP 200 acceptance, actual 404 versus internal 410 and OAuth 403
  without device-token pruning passed.
- `relay-subscription.tests.mjs`: actual WebSocket REQ/EOSE behavior passed.
- `endpoint-registration.tests.mjs`: actual watcher HTTP server and local signed
  relay events with mocked outbound delivery passed. Receipts retained 201,
  429 and `unknown`, with privacy assertions. Existing registration, persistence,
  expiry, unregister and tag-cap checks passed.
- Compared deployed sources against repository sources before replacement:
  differences were limited to this receipt instrumentation.
- Staged both files and checked syntax with the deployed Node 24.20.0 runtime.
  Backed up originals and a protected registration snapshot under
  `/home/satoshi/chama-webpush-watcher/http-status-backup-20261006T014720Z/`.
- Restarted only the validated, owned watcher process with SIGTERM; systemd's
  existing restart policy started PID 1459961, replacing PID 1390606.
- Before and after: six endpoints, 126 tags, one connected relay, `ok:true`,
  `relayReady:true`. Registration-file digest unchanged across restart.
  Credentials, environment, service configuration and dependencies untouched.
- Installed source hashes match the tested repository files:

| File | SHA-256 |
| --- | --- |
| `watcher.mjs` | `6b709a4ca6cf9d3c6988ef7abd203fe431a677d36d5845a1bd8b3c55c81e0f22` |
| `delivery.mjs` | `8e201a981ac88af26898f913e8537be8e14e547d6c0e210e2b2fc343fa4a9bb2` |

No production test wake or listing was generated. Source rollback uses the
two original modules in that backup directory followed by the same validated
owned-process restart; do not overwrite the live registration store with its
snapshot, because subsequent registration changes belong to users.

## Pending real attempt

Jet will re-register the Pixel (Background alerts off/on; ntfy unrestricted),
swipe Chama away and publish one listing. Read its signed timestamp/community,
sanitized current registration metadata and corresponding receipt together.
No root cause or device pass is claimed by this deployment. Historical
status-less receipts cannot acquire a status retroactively.

Public health was independently rechecked after restart and remained ready.
Unsolicited ordinary traffic at 01:47:29–30 UTC demonstrated the installed
receipt format: Web Push `sent ... http=201`, UnifiedPush `failed ... http=unknown`.
These lines are not identified as Jet's controlled listing attempt. They show
that those UnifiedPush errors lacked an available numeric HTTP status; they do
not establish a particular provider rejection or phone-side cause.
