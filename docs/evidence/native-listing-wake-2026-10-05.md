# Cold-listing regression: read-only watcher audit

Reported by Jet during the 6.4.20 Check 1 pass on October 5: a new listing
notifies the Pixel while Chama is resident, but not after swipe-away, despite
both opt-ins. This regresses the October 1 cold new-listing receipt recorded
under Row 3. Jet classified it as non-blocking for .20, not as a successful
background-delivery result.

Audit time: 2026-10-06 00:24–00:27 UTC (October 5, EDT). Read-only SSH to the
existing VPS watcher, its health endpoint, owner-readable receipts and
sanitized registration metadata. No service, registration or transport change.
No endpoint capabilities, Web Push authentication keys or tokens are copied here.

Health: `ok:true`, six endpoints, 124 tags, one relay, one connected relay,
`relayReady:true`. The current store has one UnifiedPush endpoint with 72
interests, including `us-blf` and `ke-kes`; it is not expired. This establishes
current registered interests, not their state at an arbitrary earlier time.
The community receipt prefix for `us-blf` is `pJrL9SD`.

Three recent public, signature-verified CREATEs were independently read from
`relay.chama.community`, with `#community=us-blf`. Each is a new p2p listing,
not a child purchase. These are candidates for Jet's exact test, which has
not yet been identified by id/time.

| Signed CREATE (UTC) | Public trade id | Community receipt (UTC) | Result |
| --- | --- | --- | --- |
| Oct 5 23:18:51 | `sm_muvvfoyu_e2ae2beaf55b932c_f13hmnqf` | 23:18:53.605 | UnifiedPush **failed**, 1480 ms |
| Oct 6 00:12:03 | `sm_muvxc3p8_e2ae2beaf55b932c_17pgtrzn` | 00:12:05.247 | UnifiedPush **failed**, 1413 ms |
| Oct 6 00:12:53 | `sm_muvxd62y_e2ae2beaf55b932c_54jifp0m` | 00:12:55.036 | UnifiedPush **failed**, 1462 ms |

Each group also has three successful Web Push receipts immediately before the
UnifiedPush failure. Source records:

```text
2026-10-05T23:18:53.350Z wake pJrL9SD webpush sent 1225ms
2026-10-05T23:18:53.605Z wake pJrL9SD unifiedpush failed 1480ms
2026-10-06T00:12:04.994Z wake pJrL9SD webpush sent 1159ms
2026-10-06T00:12:05.247Z wake pJrL9SD unifiedpush failed 1413ms
2026-10-06T00:12:54.782Z wake pJrL9SD webpush sent 1209ms
2026-10-06T00:12:55.036Z wake pJrL9SD unifiedpush failed 1462ms
```

The retained log's first generic UnifiedPush failure is October 5 at
22:01:23.007 UTC. The latest successful generic UnifiedPush receipt is
22:40:24.368 UTC; failures and occasional successful sends overlap, so this
does not establish a single outage start or its cause.

The deployed watcher logs `failed` when `sendNotification` throws. It writes
the HTTP status to process stderr, but the content-free receipt mirror does
not include it. `journalctl` is denied to the deployment account and
`sudo -n journalctl` requires a password. No permission change was attempted.
Receipts also contain no endpoint identity or event id, so timing/tag correlation
and the single currently registered UnifiedPush endpoint are evidence with
limits, not proof of a particular device's historical endpoint.

For these candidate listings, the evidence points to attempted but failed
UnifiedPush dispatch, not absent community registration. A provider rejection
is not a successfully sent wake lost on the phone. Confirm Jet's listing id/time
and Pixel endpoint, then obtain the corresponding provider status before
choosing a fix. Do not infer ntfy rate limits, expiry, Android battery policy or
install-over registration loss from the generic `failed` line alone.
